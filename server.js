'use strict';
/**
 * Patrice — AI Phone Receptionist for Taylor MD Formulations
 * Handles inbound calls to +17064089670
 *
 * Capabilities:
 *  - Product questions (full catalog knowledge)
 *  - Order status lookup via ShipStation API
 *  - Shipping policy, returns policy
 *  - Dr. Taylor's books
 *  - Post-call summary email to staff
 *
 * Does NOT:
 *  - Transfer calls to humans
 *  - Share physical address or directions
 *  - Accept sales calls (redirects to email)
 *  - Operate as a medical practice (retail supplements only)
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
  email: {
    from:    'Patrice at Taylor MD Formulations <noreply@taylormdformulations.com>',
    staffTo: ['infotaylormdformulations@gmail.com'],
  },
  brand: {
    name:        'Taylor MD Formulations',
    website:     'taylormdformulations.com',
    contactPage: 'taylormdformulations.com/contact',
    staffEmail:  'info@taylormdformulations.com',
    phone:       '678-443-4099',
  },
};

const VoiceResponse = twilio.twiml.VoiceResponse;

// ─── SESSION STORE ────────────────────────────────────────────────────────────
const sessions = {};
function getSession(callSid) {
  if (!sessions[callSid]) sessions[callSid] = { callLog: [], conversationHistory: [] };
  return sessions[callSid];
}
function clearSession(callSid) { delete sessions[callSid]; }

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

function getTwilioClient() {
  const { accountSid, authToken } = CONFIG.twilio;
  if (!accountSid || !authToken) return null;
  return twilio(accountSid, authToken);
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
    }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 10000 });
    console.log('[EMAIL] Sent:', r.data?.id);
    return true;
  } catch (err) {
    console.error('[EMAIL] Failed:', err.response?.data || err.message);
    return false;
  }
}

async function sendCallSummary(callerPhone, summary, callSid = null) {
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
      <p style="color:#718096;font-size:12px;margin-top:16px;">Sent by Patrice — Taylor MD Formulations AI Receptionist</p>
    </div>`;
  await sendEmail(`TMD Call Summary — ${now} ET | Caller: ${callerPhone}`, html, text).catch(() => {});
}

// ─── SHIPSTATION ORDER LOOKUP ─────────────────────────────────────────────────
function ssAuth() {
  const { apiKey, apiSecret } = CONFIG.shipstation;
  if (!apiKey || !apiSecret) return null;
  return 'Basic ' + Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
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

function formatStatus(status) {
  const map = {
    awaiting_payment: 'Awaiting Payment',
    awaiting_shipment: 'Processing — preparing to ship',
    shipped: 'Shipped',
    on_hold: 'On Hold',
    cancelled: 'Cancelled',
    delivered: 'Delivered',
  };
  return map[status] || status || 'Processing';
}

// ─── PRODUCT CATALOG (KNOWLEDGE BASE) ────────────────────────────────────────
const PRODUCT_CATALOG = `
TAYLOR MD FORMULATIONS — FULL PRODUCT CATALOG

HORMONE & ADRENAL SUPPORT:
- AdrenaCare™ ($69.95): Comprehensive adrenal support. Helps with: fatigue, adrenal exhaustion, low cortisol, burnout, chronic stress, low energy, hormonal imbalance
- SerenCalm™ ($38.95): Lower cortisol, clear brain fog, think sharper. Helps with: high cortisol, brain fog, anxiety, stress, poor memory, scattered thinking
- Stress B Complex™ ($37.95): High-potency B vitamins for stress. Helps with: stress, fatigue, B vitamin deficiency, low energy, nerve pain, mood issues, anxiety, depression
- Hormony Pro™ ($59.95): Natural hormone balance without a prescription. Helps with: hormone imbalance, menopause, perimenopause, hot flashes, night sweats, PMS, estrogen dominance, low progesterone
- LibidoRx™ ($49.95): Restore desire and enhance intimacy naturally. Helps with: low libido, low sex drive, sexual dysfunction, hormonal low desire, menopause libido

BRAIN & COGNITIVE:
- CogHealth™ ($59.95): Sharpen focus, protect memory, prevent cognitive decline. Helps with: brain fog, memory loss, poor focus, cognitive decline, ADHD, mental fatigue, concentration problems
- NeuroCalmRx™ ($49.95): Calm the nervous system, reduce anxiety, restore balance. Helps with: anxiety, panic attacks, nervous system dysregulation, PTSD, hypervigilance, emotional dysregulation

SLEEP:
- SleepEasy™ ($38.95): Fall asleep faster, stay asleep longer, wake up restored. Helps with: insomnia, poor sleep, trouble falling asleep, waking at night, sleep anxiety, racing mind at bedtime

GUT & DIGESTIVE HEALTH:
- Flora Repair™ ($36.95): 30 Billion CFU probiotic for real gut balance. Helps with: gut imbalance, bloating, digestive issues, immune weakness, inflammation, IBS, after antibiotics, leaky gut
- Paradix™ ($34.95): Digestive enzymes that actually work. Helps with: bloating after meals, gas, indigestion, food sensitivities, GERD, poor nutrient absorption
- Enzyme Restore™ ($44.95): Heal gut lining and restore digestive integrity. Helps with: leaky gut, intestinal permeability, food sensitivities, autoimmune conditions, gut inflammation, IBS, Crohn's
- GreenMed Rx™ ($42.95): Detox, alkalize, flood your body with phytonutrients. Helps with: toxin buildup, poor gut health, inflammation, low energy, liver stress, weight gain

METABOLISM & WEIGHT:
- Metabolic Rx™ ($49.95): Accelerate fat burning, regulate blood sugar, boost metabolism. Helps with: weight gain, slow metabolism, insulin resistance, blood sugar issues, belly fat, sugar cravings, pre-diabetes
- Thyroid Support™ ($39.95): Nourish your thyroid, restore your metabolism. Helps with: hypothyroid, slow metabolism, weight gain, hair loss, cold intolerance, fatigue, brain fog, constipation
- Amino Restore™ ($49.95): Rebuild muscle, accelerate recovery, preserve lean mass. Helps with: muscle loss, slow recovery, low muscle mass, post-workout soreness, body composition

HEART & CARDIOVASCULAR:
- Heart Guard™ ($49.95): Protect your heart, lower inflammation, support circulation. Helps with: heart disease risk, high blood pressure, high cholesterol, poor circulation, cardiovascular health
- CoQ10 200mg™ ($34.95): Cellular energy, heart protection, statin support. Helps with: fatigue, heart disease, statin side effects, muscle pain from statins, low cellular energy
- Mega EPA/DHA 3400™ ($26.95): The omega-3 dose that actually makes a difference. Helps with: high triglycerides, heart disease risk, inflammation, joint pain, brain fog, dry skin

IMMUNE & BONE:
- Immune Shield™ ($39.95): Fortify your immune system year-round. Helps with: frequent colds, weak immunity, slow recovery from illness, autoimmune support, seasonal allergies
- Bone Density™ ($39.95): Build stronger bones, prevent osteoporosis. Helps with: osteoporosis, osteopenia, bone loss, fracture risk, menopause bone loss, calcium deficiency
- BioFlav C 2000™ ($29.95): 2,000mg Vitamin C with bioflavonoids. Helps with: frequent illness, weak immune system, slow wound healing, oxidative stress, collagen loss

SKIN, HAIR & NAILS:
- Skin Glow™ ($44.95): Collagen, hyaluronic acid, biotin — glow from within. Helps with: dry skin, aging skin, wrinkles, hair loss, brittle nails, skin aging, collagen loss

FOUNDATIONAL SUPPLEMENTS:
- MaxHealth Multivitamin™ ($44.95): The complete daily foundation. Helps with: nutritional gaps, general wellness, fatigue, immune support, daily foundation
- Vitamin D3/K2™ ($24.95): Vitamin D deficiency solution with K2 for safety. Helps with: vitamin D deficiency, bone loss, immune weakness, depression, fatigue, muscle weakness
- Magnesium Glycinate™ ($28.95): The most deficient mineral in America, replenished. Helps with: muscle cramps, poor sleep, anxiety, constipation, headaches, migraines, high blood pressure
- Iron Plus™ ($29.95): Non-constipating iron with Vitamin C for absorption. Helps with: iron deficiency, anemia, fatigue, hair loss, pale skin, shortness of breath, restless legs

JOINT & PAIN:
- Joint Flex™ ($44.95): Move without pain, rebuild cartilage, reduce inflammation. Helps with: joint pain, arthritis, knee pain, hip pain, back pain, stiffness, cartilage loss

DR. TAYLOR'S BOOKS:
- "Are Your Hormones Making You Sick?" by Dr. Eldred B. Taylor & Dr. Ava Bell-Taylor ($15.00): A woman's guide to better health through hormonal balance. Covers estrogen dominance, progesterone deficiency, hormonal weight gain, mood swings, fatigue, hot flashes, menopause, PCOS.
- "The Stress Connection" by Dr. Eldred B. Taylor & Dr. Ava Bell-Taylor ($15.00): 2nd edition. Explains how chronic stress, adrenal dysfunction, and cortisol imbalance drive a wide range of symptoms — and how to restore balance.

SHIPPING POLICY:
- Free shipping on orders over $75
- Standard shipping: $6.95
- Express shipping: $19.95
- Ships within 2-3 business days
- Order number format: TMD-XXXXXXXXXX

RETURNS POLICY:
- 30-day satisfaction guarantee
- Contact us at taylormdformulations.com/contact for returns
- We do not accept returns by phone — all return requests must go through the website

ALL PRODUCTS:
- Physician-formulated by Dr. Ava Bell-Taylor, M.D. and Dr. Eldred B. Taylor, M.D.
- GMP certified
- Available at taylormdformulations.com
`;

// ─── AI RESPONSE ENGINE ───────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Patrice, the AI phone receptionist for Taylor MD Formulations — a physician-formulated supplement company founded by Dr. Ava Bell-Taylor, M.D. and Dr. Eldred B. Taylor, M.D.

You are speaking to callers over the phone. Keep responses SHORT and conversational — 1-3 sentences maximum. This is a phone call, not a chat.

YOUR CAPABILITIES:
1. Answer questions about any Taylor MD Formulations product
2. Help callers find the right supplement based on their symptoms
3. Provide order status (ask for email or order number starting with TMD-)
4. Share shipping and returns policy
5. Provide information about Dr. Taylor's books

STRICT RULES — NEVER BREAK THESE:
- NEVER transfer a call or offer to connect to a human
- NEVER share a physical address or give directions
- NEVER give out the office phone number (678-443-4099) — this is a retail supplement company, not a medical practice
- If caller wants to speak to a human: direct them to taylormdformulations.com/contact or email info@taylormdformulations.com
- If caller is a sales rep or vendor: say "For business inquiries, please email info@taylormdformulations.com" then end the call politely
- NEVER diagnose medical conditions — always frame as "supporting" or "helping with" symptoms
- If asked about medical advice, say "I'm not able to give medical advice, but I can tell you which of our physician-formulated products may support those symptoms"

LANGUAGE RULE: Detect the caller's language and respond in that same language. Product names stay in English.

PRODUCT KNOWLEDGE:
${PRODUCT_CATALOG}`;

async function getAIResponse(callSid, callerSpeech, orderContext = null) {
  const sess = getSession(callSid);
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    return "I'm sorry, I'm having a technical issue right now. Please visit taylormdformulations.com or email info@taylormdformulations.com for assistance.";
  }

  // Add caller speech to history
  sess.conversationHistory.push({ role: 'user', content: callerSpeech });
  sess.callLog.push(`Caller: ${callerSpeech.slice(0, 200)}`);

  // Build messages
  let systemContent = SYSTEM_PROMPT;
  if (orderContext) {
    systemContent += `\n\nORDER LOOKUP RESULT:\n${orderContext}`;
  }

  const messages = [
    { role: 'system', content: systemContent },
    ...sess.conversationHistory.slice(-10), // keep last 10 turns for context
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
    return reply || "I'm sorry, could you repeat that?";
  } catch (err) {
    console.error('[AI] OpenAI error:', err.response?.data || err.message);
    return "I'm having a brief technical issue. Please visit taylormdformulations.com or email info@taylormdformulations.com for help.";
  }
}

// ─── INTENT DETECTION (keyword-based, fast) ───────────────────────────────────
function detectIntent(speech) {
  const s = (speech || '').toLowerCase();
  if (/order|track|ship|deliver|package|status|where.*order|my order/.test(s)) return 'order';
  if (/return|refund|exchange|money back/.test(s)) return 'return';
  if (/price|cost|how much|shipping cost|free ship/.test(s)) return 'pricing';
  if (/sales|vendor|partner|wholesale|distributor|business/.test(s)) return 'sales';
  if (/human|person|agent|representative|speak to|talk to|real person|transfer/.test(s)) return 'human';
  if (/address|location|office|store|directions|where are you|visit/.test(s)) return 'address';
  if (/book|dr\. taylor|doctor taylor|stress connection|hormones making you sick/.test(s)) return 'book';
  if (/bye|goodbye|hang up|that.s all|no thank|nothing else|i.m good/.test(s)) return 'goodbye';
  return 'product'; // default — product/health question
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => res.json({
  status: 'ok',
  service: 'Patrice — Taylor MD Formulations AI Receptionist v1.0',
  phone: CONFIG.twilio.phoneNumber,
}));

app.get('/health', (req, res) => res.json({ status: 'healthy', uptime: process.uptime() }));

// Twilio status callback
app.post('/status', async (req, res) => {
  const { CallSid: callSid, CallStatus: status, From: callerPhone } = req.body;
  console.log(`[STATUS] ${callSid}: ${status}`);

  // Send post-call summary when call ends
  if (['completed', 'no-answer', 'busy', 'failed'].includes(status) && callSid) {
    const sess = sessions[callSid];
    if (sess && sess.callLog && sess.callLog.length > 0) {
      const summary = sess.callLog.join('\n');
      sendCallSummary(callerPhone || 'Unknown', summary, callSid).catch(() => {});
      clearSession(callSid);
    }
  }
  res.sendStatus(204);
});

// ── INCOMING CALL GREETING ────────────────────────────────────────────────────
app.post('/voice', (req, res) => {
  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;
  const callerPhone = req.body.From || 'anonymous';

  const sess = getSession(callSid);
  sess.callerPhone = callerPhone;
  sess._startTime = Date.now();
  sess.callLog = [];
  sess.conversationHistory = [];

  console.log(`[CALL] Incoming from ${callerPhone} | SID: ${callSid}`);

  const greeting = "Thank you for calling Taylor MD Formulations! This is Patrice, your virtual assistant. I can help you with product questions, order status, or anything about our physician-formulated supplements. How can I help you today?";
  const g = gather(twiml, '/respond', { timeout: 10, speechTimeout: '2' });
  say(g, greeting, callSid);
  twiml.redirect('/no-input');

  res.type('text/xml').send(twiml.toString());
});

// ── NO INPUT HANDLER ──────────────────────────────────────────────────────────
app.post('/no-input', (req, res) => {
  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;
  const g = gather(twiml, '/respond', { timeout: 10 });
  say(g, "I'm here to help! You can ask me about our products, check an order status, or ask about shipping. What can I do for you?", callSid);
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

// ── MAIN RESPONSE HANDLER ─────────────────────────────────────────────────────
app.post('/respond', async (req, res) => {
  const twiml = new VoiceResponse();
  const callSid  = req.body.CallSid;
  const callerPhone = req.body.From || 'anonymous';
  const speech   = (req.body.SpeechResult || '').trim();
  const sess     = getSession(callSid);

  if (!speech) {
    const g = gather(twiml, '/respond', { timeout: 10 });
    say(g, "I didn't catch that — could you say that again?", callSid);
    twiml.redirect('/no-input');
    return res.type('text/xml').send(twiml.toString());
  }

  const intent = detectIntent(speech);
  console.log(`[RESPOND] ${callSid} | Intent: ${intent} | Speech: "${speech.slice(0, 80)}"`);

  // ── SALES CALL ──────────────────────────────────────────────────────────────
  if (intent === 'sales') {
    say(twiml, "For business inquiries, please email us at info at taylormdformulations.com. Thank you for calling!", callSid);
    sess.callLog.push(`[Intent: sales call — redirected to email]`);
    twiml.hangup();
    sendCallSummary(callerPhone, sess.callLog.join('\n')).catch(() => {});
    clearSession(callSid);
    return res.type('text/xml').send(twiml.toString());
  }

  // ── WANTS HUMAN ────────────────────────────────────────────────────────────
  if (intent === 'human') {
    say(twiml, "I understand you'd like to speak with someone. You can reach our team at taylormdformulations.com/contact, or email us at info at taylormdformulations.com. Our team typically responds within one business day. Is there anything else I can help you with?", callSid);
    const g = gather(twiml, '/respond', { timeout: 8 });
    say(g, "", callSid);
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // ── ADDRESS / DIRECTIONS ────────────────────────────────────────────────────
  if (intent === 'address') {
    say(twiml, "Taylor MD Formulations is an online supplement company — we don't have a retail location to visit. You can shop and place orders at taylormdformulations.com, or email us at info at taylormdformulations.com. Is there anything else I can help you with?", callSid);
    const g = gather(twiml, '/respond', { timeout: 8 });
    say(g, "", callSid);
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // ── RETURNS ─────────────────────────────────────────────────────────────────
  if (intent === 'return') {
    say(twiml, "We have a 30-day satisfaction guarantee. To start a return or request a refund, please visit taylormdformulations.com/contact and our team will take care of you. Is there anything else I can help you with?", callSid);
    const g = gather(twiml, '/respond', { timeout: 8 });
    say(g, "", callSid);
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // ── GOODBYE ─────────────────────────────────────────────────────────────────
  if (intent === 'goodbye') {
    say(twiml, "Thank you for calling Taylor MD Formulations! Have a wonderful day!", callSid);
    twiml.hangup();
    sendCallSummary(callerPhone, sess.callLog.join('\n')).catch(() => {});
    clearSession(callSid);
    return res.type('text/xml').send(twiml.toString());
  }

  // ── ORDER LOOKUP ─────────────────────────────────────────────────────────────
  if (intent === 'order') {
    // Check if we already have an email or order number in session
    const emailMatch = speech.match(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/);
    const orderMatch = speech.match(/TMD[-\s]?[A-Z0-9]{8,}/i);

    if (emailMatch || orderMatch) {
      // Try to look up the order
      let orderData = null;
      if (orderMatch) {
        const orderNum = orderMatch[0].replace(/\s/g, '').toUpperCase();
        orderData = await lookupOrderByNumber(orderNum);
      } else if (emailMatch) {
        orderData = await lookupOrderByEmail(emailMatch[0]);
      }

      let orderContext = null;
      if (orderData && orderData.length > 0) {
        orderContext = orderData.map(o =>
          `Order ${o.orderNumber}: Status = ${o.status}, Date = ${o.date}${o.trackingNumber ? ', Tracking = ' + o.trackingNumber : ''}`
        ).join('\n');
        sess.callLog.push(`[Order lookup: found ${orderData.length} order(s)]`);
      } else {
        orderContext = 'No orders found for the provided information.';
        sess.callLog.push(`[Order lookup: no results]`);
      }

      const aiReply = await getAIResponse(callSid, speech, orderContext);
      const g = gather(twiml, '/respond', { timeout: 10 });
      say(g, aiReply, callSid);
      twiml.redirect('/no-input');
      return res.type('text/xml').send(twiml.toString());
    } else {
      // Ask for email or order number
      say(twiml, "I can look up your order! Could you please provide your email address or your order number? Order numbers start with T-M-D.", callSid);
      const g = gather(twiml, '/order-lookup', { timeout: 15, speechTimeout: '3' });
      say(g, "", callSid);
      twiml.redirect('/no-input');
      return res.type('text/xml').send(twiml.toString());
    }
  }

  // ── PRODUCT / HEALTH / BOOK / PRICING — AI RESPONSE ──────────────────────
  const aiReply = await getAIResponse(callSid, speech);
  const g = gather(twiml, '/respond', { timeout: 10 });
  say(g, aiReply, callSid);
  twiml.redirect('/no-input');
  res.type('text/xml').send(twiml.toString());
});

// ── ORDER LOOKUP (collect email/order number) ─────────────────────────────────
app.post('/order-lookup', async (req, res) => {
  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;
  const callerPhone = req.body.From || 'anonymous';
  const speech = (req.body.SpeechResult || '').trim();
  const sess = getSession(callSid);

  if (!speech) {
    const g = gather(twiml, '/order-lookup', { timeout: 12 });
    say(g, "I didn't catch that. Please say your email address or order number starting with T-M-D.", callSid);
    twiml.redirect('/no-input');
    return res.type('text/xml').send(twiml.toString());
  }

  const emailMatch = speech.match(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/);
  const orderMatch = speech.match(/TMD[-\s]?[A-Z0-9]{8,}/i);

  let orderData = null;
  let lookupKey = '';

  if (orderMatch) {
    lookupKey = orderMatch[0].replace(/\s/g, '').toUpperCase();
    orderData = await lookupOrderByNumber(lookupKey);
  } else if (emailMatch) {
    lookupKey = emailMatch[0];
    orderData = await lookupOrderByEmail(lookupKey);
  } else {
    // Couldn't parse — try AI to help
    const aiReply = await getAIResponse(callSid, `The caller said: "${speech}" when asked for their email or order number. Help them.`);
    const g = gather(twiml, '/order-lookup', { timeout: 12 });
    say(g, aiReply, callSid);
    twiml.redirect('/no-input');
    return res.type('text/xml').send(twiml.toString());
  }

  let orderContext = '';
  if (orderData && orderData.length > 0) {
    orderContext = orderData.map(o =>
      `Order ${o.orderNumber}: Status = ${o.status}, Date = ${o.date}${o.trackingNumber ? ', Tracking number = ' + o.trackingNumber : ''}`
    ).join('\n');
    sess.callLog.push(`[Order lookup for ${lookupKey}: found ${orderData.length} order(s)]`);
  } else {
    orderContext = `No orders found for: ${lookupKey}`;
    sess.callLog.push(`[Order lookup for ${lookupKey}: not found]`);
  }

  const aiReply = await getAIResponse(callSid, `Order lookup result for ${lookupKey}`, orderContext);
  const g = gather(twiml, '/respond', { timeout: 10 });
  say(g, aiReply, callSid);
  twiml.redirect('/no-input');
  res.type('text/xml').send(twiml.toString());
});

// ── CALL LOGS ─────────────────────────────────────────────────────────────────
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

// ─── START SERVER ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Patrice — Taylor MD Formulations AI Receptionist v1.0 running on port ${PORT}`);
});

module.exports = app;
