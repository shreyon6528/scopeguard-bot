      require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const Stripe = require('stripe');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || '');

const FREE_MESSAGE_LIMIT = 5;
const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.DOMAIN || `http://localhost:${PORT}`;

const usage = new Map();

function getUsage(sessionId) {
  if (!usage.has(sessionId)) usage.set(sessionId, { count: 0, paid: false });
  return usage.get(sessionId);
}

app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature check failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const sessionId = session.client_reference_id;
    if (sessionId) {
      const u = getUsage(sessionId);
      u.paid = true;
      console.log(`Marked session ${sessionId} as paid.`);
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

app.use((req, res, next) => {
  let sessionId = req.cookies.sgid;
  if (!sessionId) {
    sessionId = uuidv4();
    res.cookie('sgid', sessionId, {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 365,
      sameSite: 'lax',
    });
  }
  req.sessionId = sessionId;
  next();
});

const SYSTEM_PROMPT = `You are Scope Guard, a chat assistant for freelancers and consultants.

The user will paste a message from a client, or describe a request that feels
like it's outside the agreed project scope. Your job:
1. Identify whether it sounds like scope creep (a new ask not in the original deliverables).
2. If it does, write a short, professional reply the freelancer can send back — polite, firm, non-confrontational, that frames the extra work as a paid add-on rather than a favor.
3. Suggest a fair price range or time estimate for the add-on when there's enough info to guess (keep it a range, not a fake-precise number).
4. If the user's message isn't about scope/client boundaries at all, gently steer the conversation back: ask them to paste the client message or describe the situation.

Keep replies compact — a short reply script plus a one-line price/time suggestion. No long essays.`;

app.post('/api/chat', async (req, res) => {
  const { message, history } = req.body;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Missing message' });
  }

  const u = getUsage(req.sessionId);

  if (!u.paid && u.count >= FREE_MESSAGE_LIMIT) {
    return res.status(402).json({
      error: 'paywall',
      message: "You've used your 5 free messages. Upgrade to keep going.",
    });
  }

  try {
    const history_ = (Array.isArray(history) ? history : []).slice(-10);

    const contents = history_
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }))
      .concat([{ role: 'user', parts: [{ text: message }] }]);

    const model = 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        generationConfig: { maxOutputTokens: 500 },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Gemini API error:', response.status, errText);
      return res.status(502).json({ error: 'The AI service failed. Try again shortly.' });
    }

    const data = await response.json();
    const reply = (data.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || '')
      .join('\n')
      .trim();

    if (!u.paid) u.count += 1;

    return res.json({
      reply,
      remainingFree: u.paid ? null : Math.max(0, FREE_MESSAGE_LIMIT - u.count),
      paid: u.paid,
    });
  } catch (err) {
    console.error('Chat error:', err);
    return res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
});

app.get('/api/status', (req, res) => {
  const u = getUsage(req.sessionId);
  res.json({ remainingFree: u.paid ? null : Math.max(0, FREE_MESSAGE_LIMIT - u.count), paid: u.paid });
});

app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, qua
