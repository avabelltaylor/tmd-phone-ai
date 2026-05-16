'use strict';
/**
 * Patrice — AI Phone Receptionist for Taylor MD Formulations v3.0
 * Twilio: +1 (706) 408-9670  |  Business: 678-443-4099
 * Voice only — SMS handled via RingCentral
 *
 * v3.0 — Full Taylor-level safeguards applied:
 *  - /health endpoint + self-ping watchdog (every 4 min)
 *  - Startup confirmation email to all staff
 *  - Downtime alert after 3 consecutive failed pings
 *  - Recovery alert when service comes back online
 *  - Danielle-Neural voice at 85% speech rate with SSML pauses
 *  - "Virtual assistant" language removed — just "this is Patrice"
 *  - Universal escape detection (checkEscape) — fires on frustration signals
 *  - buildEscalationResponse — collects caller name/phone/email before offering options
 *  - Frustration counters on all confirmation loops
 *  - Post-call email via /clinic/status with 12-second recording delay
 *  - Persistent transcript storage to /data/transcripts.jsonl
 *  - Correct staff email list (5 recipients)
 *  - 3-tier pricing: Retail / Registered Customer ($5 off on $50+) / Practitioner
 *  - Loyalty program, order lookup, product AI, no dead ends
 */

require('dotenv').config();
const express = require('express');
const twilio  = require('twilio');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  twilio: {
    accountSid:  process.env.TWILIO_ACCOUNT_SID,
    authToken:   process.env.TWILIO_AUTH_TOKEN,
    phoneNumber: process.env.TWILIO_PHONE_NUMBER || '+17064089670',
  },
  shipstation: {
    apiKey:    process.env.SHIPSTATION_API_KEY,
    apiSecret: process.env.SHIPSTATION_API_SECRET,
  },
  resend: {
    apiKey: process.env.RESEND_API_KEY,
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
  },
  email: {
    from:    'Patrice at Taylor MD <noreply@taylormdformulations.com>',
    staffTo: [
      'avataylormd@gmail.com',
      'eldred_taylormd@yahoo.com',
      'info@taylormedicalgroup.net',
      'taylormedicalgroup2@gmail.com',
      'winston.taylor9115@gmail.com',
    ],
  },
  brand: {
    name:        'Taylor MD Formulations',
    website:     'taylormdformulations.com',
    contactPage: 'taylormdformulations.com/contact',
    staffEmail:  'info@taylormdformulations.com',
  },
  serviceUrl: process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : (process.env.SERVICE_URL || 'https://patrice-production.up.railway.app'),
};

const VoiceResponse = twilio.twiml.VoiceResponse;

// ─── PERSISTENT TRANSCRIPT STORAGE ───────────────────────────────────────────
const TRANSCRIPT_DIR  = '/data';
const TRANSCRIPT_FILE = path.join(TRANSCRIPT_DIR, 'transcripts.jsonl');

function ensureTranscriptDir() {
  try {
    if (!fs.existsSync(TRANSCRIPT_DIR)) fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  } catch (e) {
    console.warn('[TRANSCRIPT] Cannot create /data dir:', e.message);
  }
}
ensureTranscriptDir();

function saveTranscript(record) {
  try {
    fs.appendFileSync(TRANSCRIPT_FILE, JSON.stringify(record) + '\n', 'utf8');
  } catch (e) {
    console.warn('[TRANSCRIPT] Write failed:', e.message);
  }
}

// ─── SESSION STORE ────────────────────────────────────────────────────────────
const sessions = {};
function getSession(callSid) {
  if (!sessions[callSid]) {
    sessions[callSid] = {
      callLog: [],
      conversationHistory: [],
      callerPhone: '',
      callerName: '',
      callerEmail: '',
      noInputCount: 0,
      frustrationCount: 0,
      escalated: false,
      _startTime: Date.now(),
    };
  }
  return sessions[callSid];
}
function clearSession(callSid) {
  setTimeout(() => { delete sessions[callSid]; }, 300000);
}

// Prune sessions older than 2 hours
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const sid of Object.keys(sessions)) {
    if (sessions[sid]._startTime && sessions[sid]._startTime < cutoff) delete sessions[sid];
  }
}, 30 * 60 * 1000);

// ─── TWILIO HELPERS ───────────────────────────────────────────────────────────
/**
 * say() — uses Danielle-Neural at 85% speech rate with SSML prosody
 * Automatically adds 600ms pauses after phone numbers and URLs
 */
function say(twiml, text, callSid = null) {
  // Inject SSML pauses after phone numbers and URLs
  let ssml = text
    .replace(/(\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/g, '$1<break time="600ms"/>')
    .replace(/([\w-]+\.(?:com|net|org|edu|gov)(?:\/[\w/.-]*)?)/g, '$1<break time="600ms"/>');

  const sayNode = twiml.say({ voice: 'Polly.Danielle-Neural', language: 'en-US' });
  sayNode.prosody({ rate: '85%' }, ssml);

  if (callSid) {
    const sess = getSession(callSid);
    sess.callLog.push(`Patrice: ${text.slice(0, 200)}`);
    sess.conversationHistory.push({ role: 'assistant', content: text });
  }
}

function gather(twiml, action, opts = {}) {
  return twiml.gather({
    action,
    method: 'POST',
    input: 'speech dtmf',
    speechTimeout: '2',
    speechModel: 'phone_call',
    enhanced: 'true',
    timeout: 8,
    ...opts,
  });
}

let _twilioClient = null;
function getTwilioClient() {
  if (!_twilioClient && CONFIG.twilio.accountSid?.startsWith('AC')) {
    _twilioClient = twilio(CONFIG.twilio.accountSid, CONFIG.twilio.authToken);
  }
  return _twilioClient;
}

// ─── UNIVERSAL ESCAPE DETECTION ───────────────────────────────────────────────
/**
 * Detects frustration signals, repeated "no", staff name requests, or explicit
 * requests to speak to a human. Returns { triggered: bool, action: 'escalate'|'goodbye' }
 */
function checkEscape(speech, sess) {
  const s = (speech || '').toLowerCase().trim();

  // Explicit goodbye
  if (/^(bye|goodbye|hang up|that.?s all|no thank|nothing else|i.?m good|all set|never mind|forget it)/.test(s)) {
    return { triggered: true, action: 'goodbye' };
  }

  // Staff name requests — escalate immediately
  if (/\b(ava|dr\.?\s*ava|dr\.?\s*taylor|dr\.?\s*bell|eldred|winston|staff|manager|supervisor|owner)\b/.test(s)) {
    return { triggered: true, action: 'escalate' };
  }

  // Human / agent request
  if (/\b(human|person|agent|representative|speak to|talk to|real person|transfer|someone|anybody|operator)\b/.test(s)) {
    return { triggered: true, action: 'escalate' };
  }

  // Frustration signals
  if (/\b(frustrated|annoyed|ridiculous|useless|terrible|awful|this is stupid|not helpful|waste of time|just help me)\b/.test(s)) {
    sess.frustrationCount = (sess.frustrationCount || 0) + 1;
    if (sess.frustrationCount >= 1) return { triggered: true, action: 'escalate' };
  }

  // Repeated "no" or negative
  if (/^(no+|nope|nah|not really|not helpful|that.?s not|that doesn.?t)/.test(s)) {
    sess.frustrationCount = (sess.frustrationCount || 0) + 1;
    if (sess.frustrationCount >= 2) return { triggered: true, action: 'escalate' };
  }

  return { triggered: false };
}

// ─── ESCALATION RESPONSE ──────────────────────────────────────────────────────
/**
 * Collects caller name/phone/email before offering message or website options.
 * Mirrors Taylor's buildEscalationResponse exactly.
 */
function buildEscalationResponse(twiml, callSid, reason = '') {
  const sess = getSession(callSid);
  sess.escalated = true;
  if (reason) sess.callLog.push(`[ESCALATION: ${reason}]`);

  const msg = "I want to make sure you get the right help. Let me take down your information so our team can follow up with you. " +
    "Could you please tell me your name?";
  const g = gather(twiml, '/escalation-name', { timeout: 12, speechTimeout: '3' });
  say(g, msg, callSid);
  twiml.redirect('/no-input');
}

// ─── EMAIL (RESEND) ───────────────────────────────────────────────────────────
async function sendEmail(subject, htmlBody, textBody) {
  const key = CONFIG.resend.apiKey;
  if (!key) { console.warn('[EMAIL] No RESEND_API_KEY — skipping'); return false; }
  try {
    const r = await axios.post('https://api.resend.com/emails', {
      from: CONFIG.email.from,
      to:   CONFIG.email.staffTo,
      subject,
      html: htmlBody,
      text: textBody,
    }, {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    console.log('[EMAIL] Sent:', r.data?.id);
    return true;
  } catch (err) {
    console.error('[EMAIL] Failed:', err.response?.data || err.message);
    return false;
  }
}

async function sendCallSummary({ callerPhone, transcript, recordingUrl, duration, callSid }) {
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const recLink = recordingUrl
    ? `<p><strong>🎙 Recording:</strong> <a href="${recordingUrl}">${recordingUrl}</a></p>`
    : '<p><em>Recording not available</em></p>';
  const recText = recordingUrl ? `Recording: ${recordingUrl}` : 'Recording: not available';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;">
      <h2 style="color:#1a6b4a;border-bottom:2px solid #1a6b4a;padding-bottom:8px;">📋 TMD Call Summary — Patrice</h2>
      <p><strong>Time:</strong> ${now} ET</p>
      <p><strong>Caller:</strong> ${callerPhone}</p>
      <p><strong>Duration:</strong> ${duration ? duration + 's' : 'unknown'}</p>
      <p><strong>Call SID:</strong> ${callSid || 'unknown'}</p>
      ${recLink}
      <hr style="border:1px solid #e2e8f0;"/>
      <h3 style="color:#2d3748;">Transcript</h3>
      <div style="background:#f7fafc;padding:16px;border-radius:8px;white-space:pre-wrap;font-size:14px;line-height:1.6;">
        ${(transcript || '').replace(/\n/g, '<br>')}
      </div>
      <p style="color:#718096;font-size:12px;margin-top:16px;">Sent by Patrice — Taylor MD Formulations AI Receptionist v3.0</p>
    </div>`;
  const text = `TMD Call Summary — ${now} ET\nCaller: ${callerPhone}\nDuration: ${duration || 'unknown'}s\n${recText}\n\n${transcript || ''}`;

  await sendEmail(`TMD Call — ${now} ET | ${callerPhone}`, html, text).catch(() => {});
}

// ─── SHIPSTATION ORDER LOOKUP ─────────────────────────────────────────────────
function ssAuth() {
  const { apiKey, apiSecret } = CONFIG.shipstation;
  if (!apiKey || !apiSecret) return null;
  return 'Basic ' + Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
}

function formatStatus(status) {
  const map = {
    awaiting_payment:  'Awaiting Payment',
    awaiting_shipment: 'Processing — preparing to ship',
    shipped:           'Shipped',
    on_hold:           'On Hold',
    cancelled:         'Cancelled',
    delivered:         'Delivered',
  };
  return map[status] || status || 'Processing';
}

async function lookupOrderByEmail(email) {
  const auth = ssAuth();
  if (!auth) return null;
  try {
    const r = await axios.get('https://ssapi.shipstation.com/orders', {
      headers: { Authorization: auth },
      params: { customerEmail: email.toLowerCase(), pageSize: 5, sortBy: 'OrderDate', sortDir: 'DESC' },
      timeout: 8000,
    });
    const orders = r.data?.orders || [];
    if (!orders.length) return null;
    return orders.slice(0, 3).map(o => ({
      orderNumber: o.orderNumber,
      status: formatStatus(o.orderStatus),
      date: o.orderDate ? o.orderDate.split('T')[0] : 'Unknown',
      trackingNumber: o.shipments?.[0]?.trackingNumber || o.trackingNumber || null,
    }));
  } catch (err) {
    console.error('[SS] Email lookup failed:', err.message);
    return null;
  }
}

async function lookupOrderByPhone(phone) {
  const auth = ssAuth();
  if (!auth) return null;
  try {
    // Normalize phone to digits only, then try with and without country code
    const digits = phone.replace(/\D/g, '');
    const e164 = digits.length === 10 ? `+1${digits}` : `+${digits}`;
    const r = await axios.get('https://ssapi.shipstation.com/orders', {
      headers: { Authorization: auth },
      params: { customerName: '', pageSize: 50, sortBy: 'OrderDate', sortDir: 'DESC' },
      timeout: 8000,
    });
    const orders = r.data?.orders || [];
    // ShipStation doesn't have a direct phone filter — search by matching phone in customer data
    const matched = orders.filter(o => {
      const billPhone = (o.billTo?.phone || '').replace(/\D/g, '');
      const shipPhone = (o.shipTo?.phone || '').replace(/\D/g, '');
      return billPhone.endsWith(digits.slice(-10)) || shipPhone.endsWith(digits.slice(-10));
    });
    if (!matched.length) return null;
    return matched.slice(0, 3).map(o => ({
      orderNumber: o.orderNumber,
      status: formatStatus(o.orderStatus),
      date: o.orderDate ? o.orderDate.split('T')[0] : 'Unknown',
      trackingNumber: o.shipments?.[0]?.trackingNumber || o.trackingNumber || null,
    }));
  } catch (err) {
    console.error('[SS] Phone lookup failed:', err.message);
    return null;
  }
}

async function lookupOrderByNumber(orderNumber) {
  const auth = ssAuth();
  if (!auth) return null;
  try {
    const r = await axios.get('https://ssapi.shipstation.com/orders', {
      headers: { Authorization: auth },
      params: { orderNumber: orderNumber.toUpperCase(), pageSize: 1 },
      timeout: 8000,
    });
    const orders = r.data?.orders || [];
    if (!orders.length) return null;
    const o = orders[0];
    return [{
      orderNumber: o.orderNumber,
      status: formatStatus(o.orderStatus),
      date: o.orderDate ? o.orderDate.split('T')[0] : 'Unknown',
      trackingNumber: o.shipments?.[0]?.trackingNumber || o.trackingNumber || null,
    }];
  } catch (err) {
    console.error('[SS] Order number lookup failed:', err.message);
    return null;
  }
}

// ─── PRODUCT CATALOG — 3-TIER PRICING ────────────────────────────────────────
const PRODUCT_CATALOG = `
TAYLOR MD FORMULATIONS — PRODUCT CATALOG v3.0

PRICING TIERS:
- Retail: Standard price for all website visitors at taylormdformulations.com
- Registered Customer (My Account): $5 off per product on orders of $50 or more — create a free account at taylormdformulations.com
- Practitioner/Wholesale: Contact info@taylormdformulations.com for practitioner pricing

ADRENAL SUPPORT:
- AdrenaCare™ | Retail: $72.95 | Customer (on $50+ order): $67.95
  Restore Your Adrenal Function. Helps with: adrenal fatigue, burnout, low energy, chronic stress, cortisol depletion
- SerenCalm™ | Retail: $43.95 | Customer: $38.95
  Lower Cortisol. Clear Brain Fog. Helps with: high cortisol, brain fog, anxiety, stress, poor memory, mental clarity
- Stress B Complex™ | Retail: $40.95 | Customer: $35.95
  The B Vitamins Your Stressed Body Is Burning Through. Helps with: stress, fatigue, B vitamin deficiency, low energy, mood issues

WOMEN'S HEALTH / HORMONE:
- LaiDex™ | Retail: $34.95 | Customer: $29.95
  End Hot Flashes. Balance Hormones. Helps with: hot flashes, night sweats, menopause, perimenopause, hormone imbalance, sleep disruption
- Hormony Pro™ | Retail: $59.95 | Customer: $54.95
  Bioidentical Progesterone. Real Hormone Balance. Helps with: PMS, bloating, mood swings, cramps, low progesterone, estrogen dominance, perimenopause
- Thyroid Support™ | Retail: $39.95 | Customer: $34.95
  Support Your Thyroid. Restore Your Metabolism. Helps with: hypothyroid, slow metabolism, weight gain, hair loss, cold intolerance, fatigue, brain fog

BRAIN & COGNITIVE:
- CogHealth™ | Retail: $39.95 | Customer: $34.95
  Advanced Cognitive Support. Helps with: brain fog, memory loss, poor focus, cognitive decline, ADHD, mental fatigue
- Sertona™ | Retail: $39.95 | Customer: $34.95
  Natural Serotonin Support. Helps with: low mood, depression, anxiety, emotional imbalance, serotonin deficiency, mood swings

SLEEP:
- SleepEasy™ | Retail: $39.95 | Customer: $34.95
  Deep, Restorative Sleep. Helps with: insomnia, poor sleep, trouble falling asleep, waking at night, sleep anxiety, racing mind

GUT & DIGESTIVE HEALTH:
- Flora Repair 30 Billion™ | Retail: $41.95 | Customer: $36.95
  30 Billion CFU. Real Gut Balance. Helps with: gut imbalance, bloating, digestive issues, immune weakness, IBS, after antibiotics, leaky gut
- GreenMed Super Greens™ | Retail: $41.95 | Customer: $36.95
  Alkalize. Detoxify. Energize. Helps with: toxin buildup, poor gut health, inflammation, low energy, liver stress, detox
- Paradix™ | Retail: $42.95 | Customer: $37.95
  Heal Your Gut Lining. Helps with: leaky gut, IBS, intestinal permeability, food sensitivities, autoimmune gut conditions, bloating
- Enzyme Restore™ | Retail: $40.95 | Customer: $35.95
  Digest Your Food. Absorb Your Nutrients. Helps with: bloating after meals, gas, indigestion, poor nutrient absorption, GERD

HEART & CARDIOVASCULAR:
- Mega EPA/DHA 3400™ | Retail: $31.95 | Customer: $26.95
  The Omega-3 Dose That Actually Makes a Difference. Helps with: high triglycerides, heart disease risk, inflammation, joint pain, brain fog, cardiovascular health

WEIGHT MANAGEMENT / METABOLISM:
- Amino Restore Vanilla™ | Retail: $51.95 | Customer: $46.95
  Physician-Formulated Protein for Muscle, Metabolism, and Recovery. Helps with: muscle loss, slow recovery, body composition, weight loss
- Amino Restore Chocolate™ | Retail: $51.95 | Customer: $46.95
  Same formula as Vanilla — chocolate flavor option.
- MIC•B Rx™ | Retail: $43.95 | Customer: $38.95
  Blood Sugar and Glucose Metabolism Support. Helps with: blood sugar spikes, insulin resistance, pre-diabetes, weight gain, metabolic syndrome
- MCT Oil Rx™ | Retail: $32.95 | Customer: $27.95
  Clean Brain Fuel. Instant Energy. Fat Burning Support. Helps with: brain fog, low energy, weight management, ketone production, fat burning

HAIR HEALTH:
- Genesis™ Hair Oil | Retail: $41.95 | Customer: $36.95
  Physician-Formulated Topical Support for Thinning Hair. Helps with: hair thinning, hair loss, DHT-related hair loss, follicle stimulation

VITAMINS & MINERALS:
- Vitamin D3 10,000 IU™ | Retail: $29.95 | Customer: $24.95
  The Vitamin Deficiency That Affects Everything. Helps with: vitamin D deficiency, bone loss, immune weakness, depression, fatigue
- MaxHealth Multivitamin™ | Retail: $39.95 | Customer: $34.95
  The Multivitamin That Actually Gets Absorbed. Helps with: nutritional gaps, general wellness, fatigue, immune support
- BioFlav C 2000™ | Retail: $41.95 | Customer: $36.95
  High-Potency Vitamin C with Bioflavonoids. Helps with: frequent illness, weak immune system, slow wound healing, oxidative stress

PAIN RELIEF:
- Hemp Extract Cream™ | Retail: $74.95 | Customer: $69.95
  Physician-Formulated Topical Relief for Muscles, Joints & Inflammation. Helps with: muscle pain, joint pain, inflammation, arthritis

DR. TAYLOR'S BOOKS:
- "Are Your Hormones Making You Sick?" by Dr. Ava Bell-Taylor, M.D. — $15.00
  A woman's guide to hormone balance. Covers estrogen dominance, progesterone deficiency, hot flashes, menopause, PCOS, mood swings, fatigue.
- "The Stress Connection" by Dr. Ava Bell-Taylor, M.D. — $15.00
  2nd edition. How chronic stress, adrenal dysfunction, and cortisol imbalance drive symptoms — and how to restore balance.

LOYALTY / SAVINGS PROGRAM:
- Create a free account at taylormdformulations.com to unlock:
  * Free shipping at $50 (guests pay $75 minimum for free shipping)
  * 10% off your second order automatically
  * $5 off per product on orders of $50 or more
  * 15% off when you buy any 3 or more products
  * $5 off per product plus free shipping on every autoship/subscription order
  * Leave a product review and get $5 off your next order
  * Refer a friend — you both get $10 off when they place their first order

SHIPPING POLICY:
- Free shipping on orders over $75 (guests) or $50 (registered customers)
- Ships within 2-3 business days
- Orders placed before 2 PM ET ship same business day

RETURNS POLICY:
- 30-day satisfaction guarantee
- Contact us at taylormdformulations.com/contact for returns
- Returns cannot be processed by phone

ALL PRODUCTS:
- Physician-formulated by Dr. Ava Bell-Taylor, M.D. and Dr. Eldred B. Taylor, M.D.
- FDA Registered Facility, GMP Certified, NSF Certified
- Available at taylormdformulations.com
`;

// ─── AI SYSTEM PROMPT ─────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Patrice, the AI phone receptionist for Taylor MD Formulations — a physician-formulated supplement company founded by Dr. Ava Bell-Taylor, M.D. and Dr. Eldred B. Taylor, M.D.

You are speaking to callers over the phone. Keep responses SHORT and conversational — 1 to 3 sentences maximum. This is a phone call, not a chat.

YOUR CAPABILITIES:
1. Answer questions about any Taylor MD Formulations product
2. Help callers find the right supplement based on their symptoms
3. Provide order status (ask for email or order number starting with TMD-)
4. Share pricing tiers — retail, registered customer ($5 off on $50+ orders), practitioner
5. Explain the loyalty and savings program
6. Share shipping and returns policy
7. Provide information about Dr. Taylor's books

STRICT RULES — NEVER BREAK THESE:
- NEVER say "virtual assistant" or "AI" — you are just Patrice
- NEVER transfer a call or offer to connect to a human
- NEVER share a physical address or give directions — this is an online-only supplement company
- NEVER give out the business phone number
- If caller wants to speak to a human: collect their name and contact info, then say our team will follow up within 48 hours
- If caller is a sales rep or vendor: say "For business inquiries, please email info at taylormdformulations.com" then end the call politely
- NEVER diagnose medical conditions — always frame as "supporting" or "helping with" symptoms
- If asked for medical advice: say "I'm not able to give medical advice, but I can tell you which of our physician-formulated products may support those symptoms"
- If you cannot answer a question: say "I want to make sure you get the right answer — please email us at info at taylormdformulations.com and our team will follow up within 48 hours"
- NEVER leave a caller without a next step — always give the email address or website

DEAD-END RULE: If you cannot resolve a request, ALWAYS say:
"I want to make sure you get the help you need. Please email us at info at taylormdformulations.com and our team will follow up with you within 48 hours."

LANGUAGE RULE: Detect the caller's language and respond in that same language. Product names stay in English.

TONE: Warm, professional, confident. You represent a physician-led brand. Never sound scripted or robotic.

PRODUCT KNOWLEDGE:
${PRODUCT_CATALOG}`;

// ─── AI RESPONSE ENGINE ───────────────────────────────────────────────────────
async function getAIResponse(callSid, callerSpeech, orderContext = null) {
  const sess = getSession(callSid);
  const openaiKey = CONFIG.openai.apiKey;
  if (!openaiKey) {
    return "I want to make sure you get the help you need. Please email us at info at taylormdformulations.com and our team will follow up with you within 48 hours.";
  }

  sess.conversationHistory.push({ role: 'user', content: callerSpeech });
  sess.callLog.push(`Caller: ${callerSpeech.slice(0, 200)}`);

  let systemContent = SYSTEM_PROMPT;
  if (orderContext) systemContent += `\n\nORDER LOOKUP RESULT:\n${orderContext}`;

  const messages = [
    { role: 'system', content: systemContent },
    ...sess.conversationHistory.slice(-10),
  ];

  try {
    const r = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 150,
      temperature: 0.7,
    }, {
      headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      timeout: 8000,
    });

    const reply = r.data.choices?.[0]?.message?.content?.trim() || '';
    if (reply) {
      sess.conversationHistory.push({ role: 'assistant', content: reply });
      sess.callLog.push(`Patrice: ${reply.slice(0, 200)}`);
    }
    return reply || "I want to make sure you get the help you need. Please email us at info at taylormdformulations.com and our team will follow up with you within 48 hours.";
  } catch (err) {
    console.error('[AI] OpenAI error:', err.response?.data || err.message);
    return "I want to make sure you get the help you need. Please email us at info at taylormdformulations.com and our team will follow up with you within 48 hours.";
  }
}

// ─── INTENT DETECTION ─────────────────────────────────────────────────────────
function detectIntent(speech) {
  const s = (speech || '').toLowerCase();
  if (/order|track|ship|deliver|package|status|where.*order|my order/.test(s)) return 'order';
  if (/return|refund|exchange|money back/.test(s)) return 'return';
  if (/price|cost|how much|shipping cost|free ship|discount|save|loyalty|reward|account|register|member/.test(s)) return 'pricing';
  if (/practitioner|wholesale|distributor|bulk|clinic|doctor.*order|provider/.test(s)) return 'practitioner';
  if (/sales|vendor|partner|business inquiry|selling|represent/.test(s)) return 'sales';
  if (/human|person|agent|representative|speak to|talk to|real person|transfer|staff|team/.test(s)) return 'human';
  if (/address|location|office|store|directions|where are you|visit|in person|pick up/.test(s)) return 'address';
  if (/book|are your hormones|stress connection|dr\. taylor|doctor taylor/.test(s)) return 'book';
  if (/review|leave a review|write a review|feedback/.test(s)) return 'review';
  if (/bye|goodbye|hang up|that.s all|no thank|nothing else|i.m good|all set/.test(s)) return 'goodbye';
  return 'product';
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: 'ok',
  service: 'Patrice — Taylor MD Formulations AI Receptionist v3.0',
  phone: CONFIG.twilio.phoneNumber,
  version: '3.0',
}));

app.get('/health', (req, res) => res.json({
  status: 'healthy',
  uptime: process.uptime(),
  service: 'patrice-tmd',
  version: '3.0',
  timestamp: new Date().toISOString(),
}));

// ── INCOMING CALL GREETING ────────────────────────────────────────────────────
app.post('/voice', (req, res) => {
  const twiml       = new VoiceResponse();
  const callSid     = req.body.CallSid;
  const callerPhone = req.body.From || 'anonymous';
  const sess        = getSession(callSid);
  sess.callerPhone  = callerPhone;
  sess.callLog      = [`[Call started: ${new Date().toISOString()} | From: ${callerPhone}]`];
  sess.conversationHistory = [];
  sess.noInputCount = 0;
  sess.frustrationCount = 0;
  sess.escalated = false;
  console.log(`[CALL] Incoming from ${callerPhone} | SID: ${callSid}`);

  const greeting = "Thank you for calling Taylor MD Formulations! This is Patrice. I can help you with product questions, order status, pricing and savings, or anything about our physician-formulated supplements. How can I help you today?";
  const g = gather(twiml, '/respond', { timeout: 10, speechTimeout: '2' });
  say(g, greeting, callSid);
  twiml.redirect('/no-input');
  res.type('text/xml').send(twiml.toString());
});

// ── MAIN RESPONSE HANDLER ─────────────────────────────────────────────────────
app.post('/respond', async (req, res) => {
  const twiml       = new VoiceResponse();
  const callSid     = req.body.CallSid;
  const callerPhone = req.body.From || 'anonymous';
  const speech      = (req.body.SpeechResult || '').trim();
  const sess        = getSession(callSid);
  sess.noInputCount = 0;

  if (!speech) {
    const g = gather(twiml, '/respond', { timeout: 10 });
    say(g, "I didn't catch that — could you say that again?", callSid);
    twiml.redirect('/no-input');
    return res.type('text/xml').send(twiml.toString());
  }

  // Universal escape check first
  const esc = checkEscape(speech, sess);
  if (esc.triggered) {
    if (esc.action === 'goodbye') {
      say(twiml, "Thank you for calling Taylor MD Formulations! Have a wonderful day!", callSid);
      twiml.hangup();
      sendCallSummary({ callerPhone, transcript: sess.callLog.join('\n'), callSid }).catch(() => {});
      clearSession(callSid);
      return res.type('text/xml').send(twiml.toString());
    }
    if (esc.action === 'escalate' && !sess.escalated) {
      buildEscalationResponse(twiml, callSid, `escape triggered by: "${speech.slice(0, 60)}"`);
      return res.type('text/xml').send(twiml.toString());
    }
  }

  const intent = detectIntent(speech);
  console.log(`[RESPOND] ${callSid} | Intent: ${intent} | Speech: "${speech.slice(0, 80)}"`);

  // ── SALES CALL ────────────────────────────────────────────────────────────
  if (intent === 'sales') {
    say(twiml, "For business inquiries, please email us at info at taylormdformulations.com. Our team will review your inquiry and follow up within 48 hours. Thank you for calling!", callSid);
    sess.callLog.push('[Intent: sales call — redirected to email]');
    twiml.hangup();
    sendCallSummary({ callerPhone, transcript: sess.callLog.join('\n'), callSid }).catch(() => {});
    clearSession(callSid);
    return res.type('text/xml').send(twiml.toString());
  }

  // ── PRACTITIONER / WHOLESALE ──────────────────────────────────────────────
  if (intent === 'practitioner') {
    say(twiml,
      "For practitioner and wholesale pricing, please email us at info at taylormdformulations.com. " +
      "Include your name, practice, and the products you're interested in, and our team will follow up within 48 hours. " +
      "Is there anything else I can help you with?",
      callSid
    );
    sess.callLog.push('[Intent: practitioner/wholesale inquiry — directed to email]');
    const g = gather(twiml, '/respond', { timeout: 8 });
    say(g, '', callSid);
    twiml.redirect('/no-input');
    return res.type('text/xml').send(twiml.toString());
  }

  // ── WANTS HUMAN ──────────────────────────────────────────────────────────
  if (intent === 'human' && !sess.escalated) {
    buildEscalationResponse(twiml, callSid, 'caller requested human');
    return res.type('text/xml').send(twiml.toString());
  }

  // ── ADDRESS / DIRECTIONS ──────────────────────────────────────────────────
  if (intent === 'address') {
    say(twiml,
      "Taylor MD Formulations is an online supplement company — we don't have a retail location. " +
      "You can shop and place orders at taylormdformulations.com, or email us at info at taylormdformulations.com. " +
      "Is there anything else I can help you with?",
      callSid
    );
    const g = gather(twiml, '/respond', { timeout: 8 });
    say(g, '', callSid);
    twiml.redirect('/no-input');
    return res.type('text/xml').send(twiml.toString());
  }

  // ── RETURNS ───────────────────────────────────────────────────────────────
  if (intent === 'return') {
    say(twiml,
      "We have a 30-day satisfaction guarantee. To start a return or request a refund, please visit taylormdformulations.com slash contact " +
      "and our team will take care of you. Is there anything else I can help you with?",
      callSid
    );
    const g = gather(twiml, '/respond', { timeout: 8 });
    say(g, '', callSid);
    twiml.redirect('/no-input');
    return res.type('text/xml').send(twiml.toString());
  }

  // ── PRICING / LOYALTY ─────────────────────────────────────────────────────
  if (intent === 'pricing') {
    say(twiml,
      "Great question! All our products are available at taylormdformulations.com. " +
      "If you create a free account, registered customers save $5 per product on orders of $50 or more, " +
      "get free shipping at $50 instead of $75, and get 10% off their second order automatically. " +
      "There are also bundle discounts and autoship savings. Would you like to know the price of a specific product?",
      callSid
    );
    const g = gather(twiml, '/respond', { timeout: 10 });
    say(g, '', callSid);
    twiml.redirect('/no-input');
    return res.type('text/xml').send(twiml.toString());
  }

  // ── REVIEWS ───────────────────────────────────────────────────────────────
  if (intent === 'review') {
    say(twiml,
      "We'd love that! You can leave a review on our website at taylormdformulations.com — " +
      "and as a thank you, you'll receive $5 off your next order. " +
      "Your review helps other customers find the right supplement. Is there anything else I can help you with?",
      callSid
    );
    const g = gather(twiml, '/respond', { timeout: 8 });
    say(g, '', callSid);
    twiml.redirect('/no-input');
    return res.type('text/xml').send(twiml.toString());
  }

  // ── BOOKS ─────────────────────────────────────────────────────────────────
  if (intent === 'book') {
    say(twiml,
      "Dr. Ava Bell-Taylor has written two books available at taylormdformulations.com. " +
      "\"Are Your Hormones Making You Sick?\" covers hormone balance, estrogen dominance, menopause, and PCOS. " +
      "\"The Stress Connection\" explains how chronic stress and cortisol imbalance drive symptoms. Both are $15. " +
      "Is there anything else I can help you with?",
      callSid
    );
    const g = gather(twiml, '/respond', { timeout: 8 });
    say(g, '', callSid);
    twiml.redirect('/no-input');
    return res.type('text/xml').send(twiml.toString());
  }

  // ── GOODBYE ───────────────────────────────────────────────────────────────
  if (intent === 'goodbye') {
    say(twiml, "Thank you for calling Taylor MD Formulations! Have a wonderful day!", callSid);
    twiml.hangup();
    sendCallSummary({ callerPhone, transcript: sess.callLog.join('\n'), callSid }).catch(() => {});
    clearSession(callSid);
    return res.type('text/xml').send(twiml.toString());
  }

  // ── ORDER LOOKUP ──────────────────────────────────────────────────────────
  if (intent === 'order') {
    const emailMatch = speech.match(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/);
    const orderMatch = speech.match(/TMD[-\s]?[A-Z0-9]{6,}/i);

    if (emailMatch || orderMatch) {
      let orderData = null;
      if (orderMatch) {
        const orderNum = orderMatch[0].replace(/\s/g, '').toUpperCase();
        orderData = await lookupOrderByNumber(orderNum);
      } else if (emailMatch) {
        orderData = await lookupOrderByEmail(emailMatch[0]);
      }

      if (orderData && orderData.length > 0) {
        const orderContext = orderData.map(o =>
          `Order ${o.orderNumber}: Status = ${o.status}, Date = ${o.date}${o.trackingNumber ? ', Tracking = ' + o.trackingNumber : ''}`
        ).join('\n');
        sess.callLog.push(`[Order lookup: found ${orderData.length} order(s)]`);
        const aiReply = await getAIResponse(callSid, speech, orderContext);
        const g = gather(twiml, '/respond', { timeout: 10 });
        say(g, aiReply, callSid);
        twiml.redirect('/no-input');
      } else {
        sess.callLog.push('[Order lookup: no results found]');
        say(twiml,
          "I wasn't able to find an order with that information. Please email us at info at taylormdformulations.com " +
          "with your order details and our team will follow up within 48 hours. Is there anything else I can help you with?",
          callSid
        );
        const g = gather(twiml, '/respond', { timeout: 8 });
        say(g, '', callSid);
        twiml.redirect('/no-input');
      }
      return res.type('text/xml').send(twiml.toString());
    } else {
      say(twiml, "I can look up your order! Could you please provide your email address or your order number? Order numbers start with T-M-D.", callSid);
      const g = gather(twiml, '/order-lookup', { timeout: 15, speechTimeout: '3' });
      say(g, '', callSid);
      twiml.redirect('/no-input');
      return res.type('text/xml').send(twiml.toString());
    }
  }

  // ── PRODUCT / HEALTH / DEFAULT — AI RESPONSE ─────────────────────────────
  try {
    const aiReply = await getAIResponse(callSid, speech);
    const g = gather(twiml, '/respond', { timeout: 10 });
    say(g, aiReply, callSid);
    twiml.redirect('/no-input');
  } catch (err) {
    console.error('[RESPOND] AI error:', err.message);
    say(twiml, "I want to make sure you get the help you need. Please email us at info at taylormdformulations.com and our team will follow up with you within 48 hours.", callSid);
    const g = gather(twiml, '/respond', { timeout: 8 });
    say(g, '', callSid);
    twiml.redirect('/no-input');
  }
  res.type('text/xml').send(twiml.toString());
});

// ── ORDER LOOKUP — collect email or order number ──────────────────────────────
app.post('/order-lookup', async (req, res) => {
  const twiml   = new VoiceResponse();
  const callSid = req.body.CallSid;
  const speech  = (req.body.SpeechResult || '').trim();
  const sess    = getSession(callSid);

  if (!speech) {
    const g = gather(twiml, '/order-lookup', { timeout: 12 });
    say(g, "I didn't catch that. Please say your email address or order number starting with T-M-D.", callSid);
    twiml.redirect('/no-input');
    return res.type('text/xml').send(twiml.toString());
  }

  // ── Parse spoken email: "info at taylormdformulations dot com" → "info@taylormdformulations.com"
  function parseSpokenEmail(text) {
    // First try literal @ symbol
    const literal = text.match(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/);
    if (literal) return literal[0];
    // Try spoken format: "word at word dot com"
    const spoken = text
      .replace(/\s+at\s+/gi, '@')
      .replace(/\s+dot\s+/gi, '.')
      .replace(/\s+/g, '');
    const parsed = spoken.match(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/);
    return parsed ? parsed[0] : null;
  }

  // ── Parse spoken phone: extract 10-digit US number from speech
  function parseSpokenPhone(text) {
    const digits = text.replace(/\D/g, '');
    // Accept 10-digit or 11-digit (with leading 1)
    if (digits.length === 10) return digits;
    if (digits.length === 11 && digits[0] === '1') return digits.slice(1);
    return null;
  }

  const orderMatch = speech.match(/TMD[-\s]?[A-Z0-9]{6,}/i);
  const emailParsed = parseSpokenEmail(speech);
  const phoneParsed = parseSpokenPhone(speech);
  let orderData = null;
  let lookupKey = '';
  let lookupMethod = '';

  if (orderMatch) {
    lookupKey = orderMatch[0].replace(/\s/g, '').toUpperCase();
    lookupMethod = 'order number';
    orderData = await lookupOrderByNumber(lookupKey);
  } else if (emailParsed) {
    lookupKey = emailParsed.toLowerCase();
    lookupMethod = 'email';
    orderData = await lookupOrderByEmail(lookupKey);
  } else if (phoneParsed) {
    lookupKey = phoneParsed;
    lookupMethod = 'phone number';
    orderData = await lookupOrderByPhone(lookupKey);
  } else {
    // Could not parse — reprompt clearly instead of giving up
    sess.callLog.push(`[Order lookup: could not parse input "${speech.slice(0, 80)}"]`);
    sess.orderLookupRetry = (sess.orderLookupRetry || 0) + 1;
    if (sess.orderLookupRetry >= 2) {
      say(twiml,
        "No problem at all. I'll flag this for our team. Please email us at info at taylormdformulations.com " +
        "with your name and order details and we'll follow up within 24 hours. Is there anything else I can help you with?",
        callSid
      );
      const g = gather(twiml, '/respond', { timeout: 8 });
      say(g, '', callSid);
      twiml.redirect('/no-input');
    } else {
      const g = gather(twiml, '/order-lookup', { timeout: 15, speechTimeout: '3' });
      say(g,
        "I want to make sure I find your order. You can give me your order number — it starts with T-M-D — " +
        "your email address, or the phone number on your account. Which would you like to use?",
        callSid
      );
      twiml.redirect('/no-input');
    }
    return res.type('text/xml').send(twiml.toString());
  }

  if (orderData && orderData.length > 0) {
    const orderContext = orderData.map(o =>
      `Order ${o.orderNumber}: Status = ${o.status}, Date = ${o.date}${o.trackingNumber ? ', Tracking number = ' + o.trackingNumber : ''}`
    ).join('\n');
    sess.callLog.push(`[Order lookup for ${lookupKey}: found ${orderData.length} order(s)]`);
    const aiReply = await getAIResponse(callSid, `Order lookup result for ${lookupKey}`, orderContext);
    const g = gather(twiml, '/respond', { timeout: 10 });
    say(g, aiReply, callSid);
    twiml.redirect('/no-input');
  } else {
    sess.callLog.push(`[Order lookup for ${lookupKey}: not found]`);
    say(twiml,
      `I wasn't able to find an order for that information. Please email us at info at taylormdformulations.com ` +
      "with your order details and our team will follow up within 48 hours. Is there anything else I can help you with?",
      callSid
    );
    const g = gather(twiml, '/respond', { timeout: 8 });
    say(g, '', callSid);
    twiml.redirect('/no-input');
  }
  res.type('text/xml').send(twiml.toString());
});

// ── NO INPUT HANDLER ──────────────────────────────────────────────────────────
app.post('/no-input', (req, res) => {
  const twiml   = new VoiceResponse();
  const callSid = req.body.CallSid;
  const sess    = getSession(callSid);
  sess.noInputCount = (sess.noInputCount || 0) + 1;

  if (sess.noInputCount >= 3) {
    say(twiml,
      "I haven't been able to hear you — that's okay! You can reach us anytime by emailing info at taylormdformulations.com, " +
      "or visit taylormdformulations.com. Our team will be happy to help. Thank you for calling, and have a wonderful day!",
      callSid
    );
    twiml.hangup();
    sendCallSummary({
      callerPhone: sess.callerPhone || 'Unknown',
      transcript: (sess.callLog || []).join('\n') + '\n[Call ended: no input after 3 attempts]',
      callSid,
    }).catch(() => {});
    clearSession(callSid);
    return res.type('text/xml').send(twiml.toString());
  }

  const g = gather(twiml, '/respond', { timeout: 10 });
  say(g, "I'm here to help! You can ask me about our products, check an order, or ask about pricing and savings. What can I do for you?", callSid);
  twiml.redirect('/no-input');
  res.type('text/xml').send(twiml.toString());
});

// ── ESCALATION — collect caller name ─────────────────────────────────────────
app.post('/escalation-name', async (req, res) => {
  const twiml   = new VoiceResponse();
  const callSid = req.body.CallSid;
  const speech  = (req.body.SpeechResult || '').trim();
  const sess    = getSession(callSid);

  if (speech) {
    sess.callerName = speech;
    sess.callLog.push(`[Escalation - caller name: ${speech}]`);
    const g = gather(twiml, '/escalation-phone', { timeout: 12, speechTimeout: '3' });
    say(g, `Thank you, ${speech}. And what's the best phone number to reach you?`, callSid);
    twiml.redirect('/no-input');
  } else {
    sess.callLog.push('[Escalation - name not captured]');
    const g = gather(twiml, '/escalation-phone', { timeout: 12, speechTimeout: '3' });
    say(g, "And what's the best phone number to reach you?", callSid);
    twiml.redirect('/no-input');
  }
  res.type('text/xml').send(twiml.toString());
});

// ── ESCALATION — collect caller phone ────────────────────────────────────────
app.post('/escalation-phone', async (req, res) => {
  const twiml   = new VoiceResponse();
  const callSid = req.body.CallSid;
  const speech  = (req.body.SpeechResult || '').trim();
  const sess    = getSession(callSid);

  if (speech) {
    sess.callerPhone = speech;
    sess.callLog.push(`[Escalation - callback phone: ${speech}]`);
  }

  const g = gather(twiml, '/escalation-email', { timeout: 12, speechTimeout: '3' });
  say(g, "And your email address?", callSid);
  twiml.redirect('/no-input');
  res.type('text/xml').send(twiml.toString());
});

// ── ESCALATION — collect caller email then wrap up ────────────────────────────
app.post('/escalation-email', async (req, res) => {
  const twiml   = new VoiceResponse();
  const callSid = req.body.CallSid;
  const speech  = (req.body.SpeechResult || '').trim();
  const sess    = getSession(callSid);

  if (speech) {
    sess.callerEmail = speech;
    sess.callLog.push(`[Escalation - email: ${speech}]`);
  }

  const name = sess.callerName ? `, ${sess.callerName}` : '';
  say(twiml,
    `Thank you${name}. I've noted your information and our team will follow up with you within 48 hours. ` +
    "You can also email us directly at info at taylormdformulations.com or visit taylormdformulations.com. " +
    "Thank you for calling Taylor MD Formulations, and have a wonderful day!",
    callSid
  );
  twiml.hangup();

  // Fire summary email
  sendCallSummary({
    callerPhone: sess.callerPhone || 'Unknown',
    transcript: sess.callLog.join('\n'),
    callSid,
  }).catch(() => {});
  clearSession(callSid);
  res.type('text/xml').send(twiml.toString());
});

// ── POST-CALL STATUS CALLBACK (Twilio calls this after call ends) ─────────────
app.post('/clinic/status', async (req, res) => {
  const { CallSid: callSid, CallStatus: status, From: callerPhone, CallDuration: duration } = req.body;
  console.log(`[STATUS] ${callSid}: ${status} | Duration: ${duration}s`);
  res.sendStatus(204);

  if (!['completed', 'no-answer', 'busy', 'failed'].includes(status)) return;

  // 12-second delay to allow Twilio recording to finalize
  setTimeout(async () => {
    let recordingUrl = null;
    try {
      const client = getTwilioClient();
      if (client && callSid) {
        const recordings = await client.recordings.list({ callSid, limit: 1 });
        if (recordings.length > 0) {
          const rec = recordings[0];
          recordingUrl = `https://api.twilio.com/2010-04-01/Accounts/${CONFIG.twilio.accountSid}/Recordings/${rec.sid}.mp3`;
        }
      }
    } catch (e) {
      console.warn('[STATUS] Recording fetch failed:', e.message);
    }

    const sess = sessions[callSid];
    const transcript = sess ? sess.callLog.join('\n') : '[No transcript — session expired]';

    // Save to persistent storage
    saveTranscript({
      timestamp: new Date().toISOString(),
      callSid,
      callerPhone: callerPhone || sess?.callerPhone || 'Unknown',
      status,
      duration,
      recordingUrl,
      transcript,
    });

    await sendCallSummary({
      callerPhone: callerPhone || sess?.callerPhone || 'Unknown',
      transcript,
      recordingUrl,
      duration,
      callSid,
    });

    if (sess) clearSession(callSid);
  }, 12000);
});

// ── RECORDING STATUS CALLBACK ─────────────────────────────────────────────────
app.post('/recording-status', (req, res) => {
  console.log(`[RECORDING] ${req.body.RecordingSid}: ${req.body.RecordingStatus}`);
  res.sendStatus(204);
});

// ── CALL LOGS (admin) ─────────────────────────────────────────────────────────
app.get('/call-logs', async (req, res) => {
  try {
    const client = getTwilioClient();
    if (!client) return res.status(500).json({ error: 'Twilio not configured' });
    const limit = parseInt(req.query.limit) || 20;
    const calls = await client.calls.list({ to: CONFIG.twilio.phoneNumber, limit });
    res.json({
      total: calls.length,
      calls: calls.map(c => ({
        callSid: c.sid,
        from: c.from,
        status: c.status,
        startTime: c.startTime,
        duration: c.duration ? `${c.duration}s` : 'in progress',
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── TRANSCRIPT VIEWER (admin) ─────────────────────────────────────────────────
app.get('/transcripts', (req, res) => {
  try {
    if (!fs.existsSync(TRANSCRIPT_FILE)) return res.json({ transcripts: [], count: 0 });
    const lines = fs.readFileSync(TRANSCRIPT_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const limit = parseInt(req.query.limit) || 50;
    const recent = lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    res.json({ transcripts: recent.reverse(), count: lines.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SELF-PING WATCHDOG ───────────────────────────────────────────────────────
let consecutiveFailures = 0;
let serviceWasDown = false;

async function selfPing() {
  try {
    const r = await axios.get(`${CONFIG.serviceUrl}/health`, { timeout: 10000 });
    if (r.status === 200) {
      if (serviceWasDown) {
        serviceWasDown = false;
        consecutiveFailures = 0;
        console.log('[WATCHDOG] Service recovered');
        // Recovery alert
        const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
        sendEmail(
          '✅ Patrice is back online',
          `<p>Patrice (Taylor MD AI Receptionist) recovered at <strong>${now} ET</strong>.</p><p>Service URL: ${CONFIG.serviceUrl}</p>`,
          `Patrice recovered at ${now} ET. URL: ${CONFIG.serviceUrl}`
        ).catch(() => {});
      } else {
        consecutiveFailures = 0;
      }
    }
  } catch (err) {
    consecutiveFailures++;
    console.warn(`[WATCHDOG] Ping failed (${consecutiveFailures}):`, err.message);
    if (consecutiveFailures >= 3 && !serviceWasDown) {
      serviceWasDown = true;
      const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
      sendEmail(
        '🚨 Patrice is DOWN',
        `<p>Patrice (Taylor MD AI Receptionist) has been unreachable for ${consecutiveFailures} consecutive pings as of <strong>${now} ET</strong>.</p><p>Service URL: ${CONFIG.serviceUrl}</p><p>Check Railway dashboard immediately.</p>`,
        `ALERT: Patrice is down as of ${now} ET. URL: ${CONFIG.serviceUrl}`
      ).catch(() => {});
    }
  }
}

// Ping every 4 minutes to keep service warm and detect downtime
setInterval(selfPing, 4 * 60 * 1000);

// ─── GLOBAL ERROR GUARD ───────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err.message);
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Patrice — Taylor MD Formulations AI Receptionist v3.0 running on port ${PORT}`);

  // Startup confirmation email
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  sendEmail(
    '🟢 Patrice is online — Taylor MD AI Receptionist v3.0',
    `<div style="font-family:Arial,sans-serif;max-width:600px;">
      <h2 style="color:#1a6b4a;">🟢 Patrice Started Successfully</h2>
      <p><strong>Time:</strong> ${now} ET</p>
      <p><strong>Version:</strong> 3.0</p>
      <p><strong>Phone:</strong> ${CONFIG.twilio.phoneNumber}</p>
      <p><strong>Service URL:</strong> ${CONFIG.serviceUrl}</p>
      <p><strong>Health Check:</strong> <a href="${CONFIG.serviceUrl}/health">${CONFIG.serviceUrl}/health</a></p>
      <hr/>
      <p style="color:#718096;font-size:12px;">Patrice is ready to handle calls for Taylor MD Formulations.</p>
    </div>`,
    `Patrice v3.0 started at ${now} ET | Phone: ${CONFIG.twilio.phoneNumber} | URL: ${CONFIG.serviceUrl}`
  ).catch(() => {});
});

module.exports = app;
