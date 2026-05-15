'use strict';
/**
 * Patrice — AI Phone Receptionist for Taylor MD Formulations v2.0
 * Twilio: +1 (706) 408-9670  |  Business: 678-443-4099
 * Voice only — SMS handled via RingCentral
 *
 * v2.0 changes:
 *  - Zero dead ends: every unresolved path gives info@taylormdformulations.com + 48h follow-up
 *  - 3-tier pricing: Retail / Registered Customer ($5 off on $50+) / Practitioner
 *  - Loyalty program talking points
 *  - No-input counter (3 strikes → graceful goodbye with email)
 *  - Human request → email + 48h (not just website link)
 *  - All gather() calls followed by redirect (no more hangup after gather)
 *  - Post-call summary email to staff
 *  - Practitioner / wholesale intent detection
 *  - Review reward talking point
 */

require('dotenv').config();
const express = require('express');
const twilio  = require('twilio');
const axios   = require('axios');

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
    from:    'Patrice at Taylor MD Formulations <noreply@taylormdformulations.com>',
    staffTo: ['info@taylormdformulations.com', 'ebtaylormd@gmail.com'],
  },
  brand: {
    name:        'Taylor MD Formulations',
    website:     'taylormdformulations.com',
    contactPage: 'taylormdformulations.com/contact',
    staffEmail:  'info@taylormdformulations.com',
  },
};

const VoiceResponse = twilio.twiml.VoiceResponse;

// ─── SESSION STORE ────────────────────────────────────────────────────────────
const sessions = {};
function getSession(callSid) {
  if (!sessions[callSid]) {
    sessions[callSid] = {
      callLog: [],
      conversationHistory: [],
      callerPhone: '',
      noInputCount: 0,
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
function say(twiml, text, callSid = null) {
  twiml.say({ voice: 'Polly.Joanna-Neural', language: 'en-US' }, text);
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

// ─── DEAD-END HANDLER ─────────────────────────────────────────────────────────
// Called whenever Patrice cannot resolve a request
function deadEndMessage() {
  return (
    "I want to make sure you get the help you need. Please email us at info at taylormdformulations.com — " +
    "that's info at taylor M D formulations dot com — and a member of our team will follow up with you within 48 hours. " +
    "Is there anything else I can help you with today?"
  );
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

async function sendCallSummary(callerPhone, summary) {
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const text = `📋 TMD Call Summary — ${now} ET\n📱 Caller: ${callerPhone}\n─────────────────────\n${summary}`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:#1a6b4a;border-bottom:2px solid #1a6b4a;padding-bottom:8px;">📋 TMD Call Summary</h2>
      <p><strong>Time:</strong> ${now} ET</p>
      <p><strong>Caller:</strong> ${callerPhone}</p>
      <hr style="border:1px solid #e2e8f0;"/>
      <div style="background:#f7fafc;padding:16px;border-radius:8px;white-space:pre-wrap;font-size:14px;">
        ${summary.replace(/\n/g, '<br>')}
      </div>
      <p style="color:#718096;font-size:12px;margin-top:16px;">Sent by Patrice — Taylor MD Formulations AI Receptionist v2.0</p>
    </div>`;
  await sendEmail(`TMD Call Summary — ${now} ET | Caller: ${callerPhone}`, html, text).catch(() => {});
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
TAYLOR MD FORMULATIONS — PRODUCT CATALOG v2.0

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

LOYALTY / SAVINGS PROGRAM (tell callers about this!):
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
- Order number format: TMD-XXXXXXXXXX

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
- NEVER transfer a call or offer to connect to a human
- NEVER share a physical address or give directions — this is an online-only supplement company
- NEVER give out the business phone number
- If caller wants to speak to a human: say "You can email our team at info at taylormdformulations.com and someone will follow up with you within 48 hours"
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
    return deadEndMessage();
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
    return reply || deadEndMessage();
  } catch (err) {
    console.error('[AI] OpenAI error:', err.response?.data || err.message);
    return deadEndMessage();
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
  service: 'Patrice — Taylor MD Formulations AI Receptionist v2.0',
  phone: CONFIG.twilio.phoneNumber,
}));
app.get('/health', (req, res) => res.json({ status: 'healthy', uptime: process.uptime() }));

// ── Twilio status callback ────────────────────────────────────────────────────
app.post('/status', async (req, res) => {
  const { CallSid: callSid, CallStatus: status, From: callerPhone } = req.body;
  console.log(`[STATUS] ${callSid}: ${status}`);
  if (['completed', 'no-answer', 'busy', 'failed'].includes(status) && callSid) {
    const sess = sessions[callSid];
    if (sess && sess.callLog && sess.callLog.length > 0) {
      const summary = sess.callLog.join('\n');
      sendCallSummary(callerPhone || 'Unknown', summary).catch(() => {});
      clearSession(callSid);
    }
  }
  res.sendStatus(204);
});

// ── INCOMING CALL GREETING ────────────────────────────────────────────────────
app.post('/voice', (req, res) => {
  const twiml       = new VoiceResponse();
  const callSid     = req.body.CallSid;
  const callerPhone = req.body.From || 'anonymous';
  const sess        = getSession(callSid);
  sess.callerPhone  = callerPhone;
  sess.callLog      = [];
  sess.conversationHistory = [];
  sess.noInputCount = 0;
  console.log(`[CALL] Incoming from ${callerPhone} | SID: ${callSid}`);
  const greeting = "Thank you for calling Taylor MD Formulations! This is Patrice, your virtual assistant. I can help you with product questions, order status, pricing and savings, or anything about our physician-formulated supplements. How can I help you today?";
  const g = gather(twiml, '/respond', { timeout: 10, speechTimeout: '2' });
  say(g, greeting, callSid);
  twiml.redirect('/no-input');
  res.type('text/xml').send(twiml.toString());
});

// ── NO INPUT HANDLER ──────────────────────────────────────────────────────────
app.post('/no-input', (req, res) => {
  const twiml   = new VoiceResponse();
  const callSid = req.body.CallSid;
  const sess    = getSession(callSid);
  sess.noInputCount = (sess.noInputCount || 0) + 1;

  if (sess.noInputCount >= 3) {
    // Three strikes — give email and hang up gracefully
    say(twiml,
      "I haven't been able to hear you — that's okay! You can reach us anytime by emailing info at taylormdformulations.com, " +
      "or visit taylormdformulations.com. Our team will be happy to help. Thank you for calling, and have a wonderful day!",
      callSid
    );
    twiml.hangup();
    sendCallSummary(sess.callerPhone || 'Unknown', (sess.callLog || []).join('\n') + '\n[Call ended: no input after 3 attempts]').catch(() => {});
    clearSession(callSid);
    return res.type('text/xml').send(twiml.toString());
  }

  const g = gather(twiml, '/respond', { timeout: 10 });
  say(g, "I'm here to help! You can ask me about our products, check an order, or ask about pricing and savings. What can I do for you?", callSid);
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
  sess.noInputCount = 0; // reset on any speech

  if (!speech) {
    const g = gather(twiml, '/respond', { timeout: 10 });
    say(g, "I didn't catch that — could you say that again?", callSid);
    twiml.redirect('/no-input');
    return res.type('text/xml').send(twiml.toString());
  }

  const intent = detectIntent(speech);
  console.log(`[RESPOND] ${callSid} | Intent: ${intent} | Speech: "${speech.slice(0, 80)}"`);

  // ── SALES CALL ────────────────────────────────────────────────────────────
  if (intent === 'sales') {
    say(twiml, "For business inquiries, please email us at info at taylormdformulations.com. Our team will review your inquiry and follow up within 48 hours. Thank you for calling!", callSid);
    sess.callLog.push('[Intent: sales call — redirected to email]');
    twiml.hangup();
    sendCallSummary(callerPhone, sess.callLog.join('\n')).catch(() => {});
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
  if (intent === 'human') {
    say(twiml,
      "I completely understand. You can reach our team directly by emailing info at taylormdformulations.com — " +
      "that's info at taylor M D formulations dot com — and someone will follow up with you within 48 hours. " +
      "Is there anything else I can help you with today?",
      callSid
    );
    const g = gather(twiml, '/respond', { timeout: 8 });
    say(g, '', callSid);
    twiml.redirect('/no-input');
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
    sendCallSummary(callerPhone, sess.callLog.join('\n')).catch(() => {});
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
        // Order not found — dead end with email
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
      // Ask for email or order number
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
    say(twiml, deadEndMessage(), callSid);
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

  const emailMatch = speech.match(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/);
  const orderMatch = speech.match(/TMD[-\s]?[A-Z0-9]{6,}/i);
  let orderData = null;
  let lookupKey = '';

  if (orderMatch) {
    lookupKey = orderMatch[0].replace(/\s/g, '').toUpperCase();
    orderData = await lookupOrderByNumber(lookupKey);
  } else if (emailMatch) {
    lookupKey = emailMatch[0];
    orderData = await lookupOrderByEmail(lookupKey);
  } else {
    // Cannot parse — dead end with email
    sess.callLog.push(`[Order lookup: could not parse input "${speech.slice(0, 80)}"]`);
    say(twiml, deadEndMessage(), callSid);
    const g = gather(twiml, '/respond', { timeout: 8 });
    say(g, '', callSid);
    twiml.redirect('/no-input');
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
    // Not found — dead end with email
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

// ─── GLOBAL ERROR GUARD ───────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err.message);
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Patrice — Taylor MD Formulations AI Receptionist v2.0 running on port ${PORT}`);
});

module.exports = app;
