require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { v4: uuidv4 } = require('uuid');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');

const JWT_SECRET = process.env.JWT_SECRET || 'paypulse-dev-secret-change-in-prod';
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const STRIPE_WEBHOOK_ROUTE_SECRET =
  process.env.STRIPE_WEBHOOK_ROUTE_SECRET ||
  process.env.STRIPE_WEBHOOK_SECRET ||
  '';
const STRIPE_SIGNING_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const META_APP_ID = process.env.META_APP_ID || '';
const META_APP_SECRET = process.env.META_APP_SECRET || '';
const META_API_VERSION = process.env.META_API_VERSION || 'v23.0';
const META_REDIRECT_URI = process.env.META_REDIRECT_URI || `${BASE_URL}/api/meta/callback`;

const app = express();

// ─── SECURITY MIDDLEWARE ─────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Allow inline styles/scripts for the SPA
  crossOriginEmbedderPolicy: false
}));
app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
  credentials: true
}));

// Rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 attempts per window
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 600, // 600 requests per minute
  message: { error: 'Too many requests. Slow down.' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);

app.use(bodyParser.json({
  limit: '100kb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(bodyParser.urlencoded({ extended: true, limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── INIT DB ─────────────────────────────────────────────────────
db.initSchema()
  .then(() => db.ensureAdmin())
  .then(() => console.log('  ✓ DB schema + admin ready'))
  .catch(err => {
    console.error('  ✗ DB init error:', err.message);
    process.exit(1);
  });

let mailTransporter = null;
function getMailer() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) return null;
  if (!mailTransporter) {
    mailTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
      auth: process.env.SMTP_USER
        ? {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS || ''
          }
        : undefined
    });
  }
  return mailTransporter;
}

function safeJsonParse(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function makeEventKey(source, payload, extra = '') {
  return crypto
    .createHash('sha256')
    .update(`${source}:${extra}:${JSON.stringify(payload || {})}`)
    .digest('hex');
}

async function audit(action, context = {}) {
  try {
    await db.createAuditLog({
      actor_user_id: context.actor?.id || '',
      actor_email: context.actor?.email || '',
      customer_id: context.customer_id || '',
      target_type: context.target_type || 'system',
      target_id: context.target_id || 'system',
      action,
      details: JSON.stringify(context.details || {})
    });
  } catch (err) {
    console.error('Audit log error:', err.message);
  }
}

async function sendEmailAlert(user, subject, text) {
  try {
    if (!user?.email_notifications_enabled) return false;
    const to = user.alert_email || user.email;
    const transporter = getMailer();
    if (!to || !transporter) return false;
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to,
      subject,
      text
    });
    return true;
  } catch (err) {
    console.error('Email alert error:', err.message);
    return false;
  }
}

const DEFAULT_COMMUNICATION_TEMPLATES = {
  update_payment_method: {
    subject: 'Update your payment method',
    body: 'Hi {{customer_name}}, we need an updated card on file for {{company_name}}. Use this secure link to add or refresh your payment method: {{payment_link}}'
  },
  billing_follow_up: {
    subject: 'Quick billing follow-up',
    body: 'Hi {{customer_name}}, I wanted to follow up on your billing profile for {{company_name}}. Reply here if you want help or use your payment link: {{payment_link}}'
  },
  failed_payment_follow_up: {
    subject: 'Action needed for your recent payment',
    body: 'Hi {{customer_name}}, your recent payment for {{company_name}} did not go through. Please update your card here so we can retry: {{payment_link}}'
  }
};

function getCommunicationTemplates(user) {
  return {
    ...DEFAULT_COMMUNICATION_TEMPLATES,
    ...safeJsonParse(user?.communication_templates_json, {})
  };
}

function renderTemplate(template, vars) {
  return String(template || '').replace(/\{\{(.*?)\}\}/g, (_, key) => {
    const value = vars[key.trim()];
    return value === null || value === undefined ? '' : String(value);
  });
}

async function sendDirectEmail(to, subject, text) {
  const transporter = getMailer();
  if (!to || !transporter) return false;
  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject,
    text
  });
  return true;
}

async function buildCardSetupLink(user, customer) {
  if (!user?.stripe_secret_key) return '';
  const stripeClient = Stripe(user.stripe_secret_key);
  let stripeCustomerId = customer.stripe_customer_id;
  if (!stripeCustomerId) {
    const stripeCustomer = await stripeClient.customers.create({
      email: customer.email,
      name: customer.name,
      metadata: { paypulse_customer_id: customer.id }
    });
    stripeCustomerId = stripeCustomer.id;
    await db.updateCustomer(customer.id, {
      stripe_customer_id: stripeCustomerId
    });
  }

  const session = await stripeClient.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: { name: 'Card Authorization' },
          unit_amount: 100
        },
        quantity: 1
      }
    ],
    customer: stripeCustomerId,
    success_url: BASE_URL + '/?card_saved=1',
    cancel_url: BASE_URL + '/?card_cancelled=1',
    metadata: {
      paypulse_customer_id: customer.id,
      paypulse_user_id: user.id
    }
  });

  return session.url;
}

function metaConfigured() {
  return !!(META_APP_ID && META_APP_SECRET && META_REDIRECT_URI);
}

function encodeMetaState(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeMetaState(value) {
  try {
    return JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

async function metaFetch(pathname, params = {}, token) {
  const url = new URL(`https://graph.facebook.com/${META_API_VERSION}${pathname}`);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  if (token) url.searchParams.set('access_token', token);
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data?.error?.message || `Meta request failed (${res.status})`);
  }
  return data;
}

function parseMetaLeadActions(actions = []) {
  return actions
    .filter(action => ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'].includes(action.action_type))
    .reduce((sum, action) => sum + parseInt(action.value || 0, 10), 0);
}

async function syncMetaMetricsForCustomer(user, customerId, options = {}) {
  const customer = await db.getCustomerById(customerId);
  if (!customer || customer.user_id !== user.id) throw new Error('Customer not found');
  if (!user?.meta_access_token) throw new Error('Connect Meta first');
  const mappings = await db.getMetaCampaignMappingsByCustomer(customer.id, user.id);
  if (!mappings.length) throw new Error('Map at least one campaign first');

  const dateFrom = String(options.dateFrom || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10));
  const dateTo = String(options.dateTo || new Date().toISOString().slice(0, 10));

  await db.run(
    'DELETE FROM ad_metrics WHERE customer_id = ? AND user_id = ? AND source = ? AND date_from = ? AND date_to = ?',
    [customer.id, user.id, 'meta', dateFrom, dateTo]
  );

  const created = [];
  for (const mapping of mappings) {
    const targetId = mapping.adset_id || mapping.campaign_id;
    const insight = await metaFetch(`/${targetId}/insights`, {
      fields: 'campaign_id,campaign_name,adset_id,adset_name,spend,impressions,clicks,ctr,cpc,actions',
      time_range: JSON.stringify({ since: dateFrom, until: dateTo })
    }, user.meta_access_token);
    const row = (insight.data || [])[0];
    const leads = parseMetaLeadActions(Array.isArray(row?.actions) ? row.actions : []);
    const metricId = await db.createAdMetric({
      user_id: user.id,
      customer_id: customer.id,
      source: 'meta',
      ad_account_id: mapping.ad_account_id || '',
      ad_account_name: mapping.ad_account_name || '',
      campaign_id: row?.campaign_id || mapping.campaign_id || '',
      campaign_name: row?.campaign_name || mapping.campaign_name || '',
      adset_id: row?.adset_id || mapping.adset_id || '',
      adset_name: row?.adset_name || mapping.adset_name || '',
      date_from: dateFrom,
      date_to: dateTo,
      ad_spend: parseFloat(row?.spend || 0),
      impressions: parseInt(row?.impressions || 0, 10),
      clicks: parseInt(row?.clicks || 0, 10),
      ctr: parseFloat(row?.ctr || 0),
      cpc: parseFloat(row?.cpc || 0),
      leads,
      appointments: parseInt(customer.total_triggers || 0, 10)
    });
    created.push(metricId);
  }

  await audit('meta.sync_completed', {
    actor: { id: user.id, email: user.email },
    customer_id: customer.id,
    target_type: 'customer',
    target_id: customer.id,
    details: { date_from: dateFrom, date_to: dateTo, rows: created.length }
  });
  return { customer, count: created.length, dateFrom, dateTo };
}

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const esc = value => {
    const str = value === null || value === undefined ? '' : String(value);
    return `"${str.replace(/"/g, '""')}"`;
  };
  return [headers.join(','), ...rows.map(row => headers.map(key => esc(row[key])).join(','))].join('\n');
}

async function buildAlerts(user) {
  const now = Date.now();
  const charges = await db.getChargesByUser(user.id);
  const customers = await db.getCustomersByUser(user.id);
  const events = await db.getWebhookEventsByUser(user.id, 100);
  const notes = await db.all(
    'SELECT * FROM customer_notes WHERE user_id = ? AND recurring = 1 AND is_done = 0 ORDER BY created_at DESC',
    [user.id]
  );
  const failed24h = charges.filter(ch => ch.status === 'failed' && new Date(ch.created_at).getTime() >= now - 86400000).length;
  const webhookFailures24h = events.filter(evt => evt.status === 'failed' && new Date(evt.created_at).getTime() >= now - 86400000).length;
  const scheduledRetries = charges.filter(ch => ch.retry_status === 'scheduled').length;
  const dueFollowups = notes.filter(note => note.next_due_at && new Date(note.next_due_at).getTime() <= now).length;
  const alerts = [
    { id: 'failed_24h', level: failed24h > 0 ? 'warn' : 'info', label: 'Failed charges (24h)', value: failed24h, action: 'Review failed customers' },
    { id: 'no_card', level: customers.some(c => !c.card_on_file) ? 'warn' : 'info', label: 'Customers without card', value: customers.filter(c => !c.card_on_file).length, action: 'Collect payment methods' },
    { id: 'retry_queue', level: scheduledRetries > 0 ? 'warn' : 'info', label: 'Scheduled retries', value: scheduledRetries, action: 'Work retry queue' },
    { id: 'webhook_failures', level: webhookFailures24h > 0 ? 'warn' : 'info', label: 'Webhook failures (24h)', value: webhookFailures24h, action: 'Inspect webhook history' },
    { id: 'due_followups', level: dueFollowups > 0 ? 'warn' : 'info', label: 'Follow-up notes due', value: dueFollowups, action: 'Open customer notes' }
  ];
  if (user.role === 'admin' || user.role === 'subadmin') {
    const pending = await db.all('SELECT COUNT(*) as c FROM users WHERE role = ? AND approved = ?', ['agency', 0]);
    alerts.push({
      id: 'pending_approvals',
      level: parseInt(pending[0]?.c || pending.c || 0, 10) > 0 ? 'warn' : 'info',
      label: 'Pending approvals',
      value: parseInt(pending[0]?.c || pending.c || 0, 10),
      action: 'Review signups'
    });
  }
  return alerts;
}

// ─── AUTH MIDDLEWARE ─────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(403).json({ error: 'Invalid token' });
  }
}
function requireAdmin(req, res, next) {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'subadmin'))
    return res.status(403).json({ error: 'Admin only' });
  next();
}

function pick(obj, allowed) {
  return Object.fromEntries(
    Object.entries(obj || {}).filter(([key, value]) => allowed.includes(key) && value !== undefined)
  );
}

// ─── AUTH ────────────────────────────────────────────────────────
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword, email } = req.body;
    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: 'Current and new password required' });
    const user = await db.getUserById(req.user.id);
    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(newPassword, 10);
    const updates = { password_hash: hash };
    if (email && email !== user.email) {
      const existing = await db.getUserByEmail(email);
      if (existing) return res.status(409).json({ error: 'Email already in use' });
      updates.email = email;
    }
    await db.updateUser(req.user.id, updates);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required' });
    if (typeof email !== 'string' || typeof password !== 'string')
      return res.status(400).json({ error: 'Invalid input format' });
    if (email.length > 254 || password.length > 128)
      return res.status(400).json({ error: 'Input too long' });
    const user = await db.getUserByEmail(email.toLowerCase().trim());
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    if (!user.approved && user.role !== 'admin') return res.status(403).json({ error: 'Account pending approval. Contact your admin.' });
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        companyName: user.company_name,
        processor: user.processor
      },
      subscription:
        user.role === 'agency'
          ? {
              active: !!user.active,
              plan: user.plan,
              stripeSubscriptionId: user.stripe_subscription_id,
              hasStripe: !!user.stripe_subscription_id
            }
          : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SIGNUP (self-service, requires admin approval) ──────────────
app.post('/api/auth/signup', authLimiter, async (req, res) => {
  try {
    const { name, email, password, companyName } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'Name, email, and password required' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const existing = await db.getUserByEmail(email.toLowerCase().trim());
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' });
    const hash = bcrypt.hashSync(password, 10);
    const user = await db.createUser({
      email: email.toLowerCase().trim(),
      name,
      password_hash: hash,
      role: 'agency',
      company_name: companyName || '',
      approved: 0,
      plan: 'free'
    });
    // Notify admin
    const admins = await db.listUsers('admin');
    for (const a of admins) {
      await db.addNotification({
        user_id: a.id,
        type: 'new',
        title: `New signup pending: ${user.name}`,
        body: `${user.email} — ${user.company_name || 'No company'} needs approval`
      });
    }
    res.json({ ok: true, message: 'Account created! Awaiting admin approval.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      companyName: user.company_name,
      processor: user.processor,
      plan: user.plan,
      active: user.active,
      appointmentTrackingMode: !!user.appointment_tracking_mode,
      subscription:
        user.role === 'agency'
          ? {
              active: !!user.active,
              plan: user.plan,
              stripeSubscriptionId: user.stripe_subscription_id,
              hasStripe: !!user.stripe_subscription_id
            }
          : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function recordWebhookEventStart({ userId, customerId = '', source, eventType, eventKey, secretFragment, payload }) {
  const existing = await db.getWebhookEventByKey(userId, source, eventKey);
  if (existing) return { duplicate: true, event: existing };
  const event = await db.createWebhookEvent({
    user_id: userId,
    customer_id: customerId,
    source,
    event_type: eventType,
    event_key: eventKey,
    secret_fragment: secretFragment,
    status: 'received',
    payload: JSON.stringify(payload || {})
  });
  return { duplicate: false, event };
}

async function markWebhookEvent(eventId, status, response = {}, extra = {}) {
  if (!eventId) return null;
  return db.updateWebhookEvent(eventId, {
    status,
    response: JSON.stringify(response),
    ...extra
  });
}

// ─── POST /webhook/ghl/:secret — agency‑level webhook
app.post('/webhook/ghl/:secret', async (req, res) => {
  try {
    const user = await db.getUserByGhlSecret(req.params.secret);
    if (!user) return res.status(403).json({ error: 'Invalid secret' });

    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'Invalid payload' });
    }
    const ghlLocationId = payload.location_id || payload.locationId || '';
    const eventKey =
      req.headers['x-idempotency-key'] ||
      payload.event_id ||
      payload.id ||
      makeEventKey('ghl', payload, `${user.id}:${ghlLocationId || payload.email || 'agency'}`);
    const webhookStart = await recordWebhookEventStart({
      userId: user.id,
      source: 'ghl',
      eventType: payload.type || 'appointment.booked',
      eventKey,
      secretFragment: String(req.params.secret).slice(0, 8),
      payload
    });
    if (webhookStart.duplicate) {
      return res.json({ success: true, duplicate: true, eventId: webhookStart.event.id });
    }
    let customer = null;

    if (ghlLocationId) {
      customer = await db.getCustomerByLocationId(ghlLocationId, user.id);
    }
    if (!customer) {
      customer = await db.getCustomerByEmailAndUser((payload.email || '').toLowerCase(), user.id);
    }
    if (!customer) {
      customer = await db.createCustomer({
        user_id: user.id,
        name: payload.full_name || payload.name || (payload.email ? payload.email.split('@')[0] : `GHL ${Date.now()}`),
        email: (payload.email || `unknown-${Date.now()}@ghl.auto`).toLowerCase(),
        phone: payload.phone || '',
        whop_member_id: payload.whop_member_id || '',
        whop_payment_method_id: payload.whop_payment_method_id || '',
        stripe_customer_id: payload.stripe_customer_id || '',
        stripe_payment_method_id: payload.stripe_payment_method_id || '',
        rate_per_trigger:
          payload.rate_trigger || user.monthly_rate || 147,
        status: 'new',
        card_on_file: !!(
          payload.whop_payment_method_id || payload.stripe_payment_method_id
        ),
        ghl_location_id: ghlLocationId
      });
      await audit('customer.auto_created_from_ghl', {
        actor: user,
        customer_id: customer.id,
        target_type: 'customer',
        target_id: customer.id,
        details: { source: 'ghl', ghl_location_id: ghlLocationId, user_id: user.id }
      });
      await db.addNotification({
        user_id: user.id,
        type: 'new',
        title: `New customer — ${customer.name}`,
        body: `${customer.email} added. Location: ${
          ghlLocationId || 'unknown'
        }`
      });
    }

    if (payload.whop_payment_method_id || payload.stripe_payment_method_id) {
      await db.updateCustomer(customer.id, {
        card_on_file: 1,
        whop_member_id: payload.whop_member_id || '',
        stripe_payment_method_id: payload.stripe_payment_method_id || ''
      });
      customer = await db.getCustomerById(customer.id);
    }

    await db.updateWebhookEvent(webhookStart.event.id, { customer_id: customer.id });
    await db.addNotification({
      user_id: user.id,
      type: 'trigger',
      title: `Trigger fired — ${customer.name}`,
      body: `$${customer.rate_per_trigger} ready via GHL trigger. Location: ${
        ghlLocationId || 'N/A'
      }`
    });

    if (user.appointment_tracking_mode) {
      const appt = await db.createAppointment({
        user_id: user.id,
        customer_id: customer.id,
        status: 'booked',
        date: payload.appointment_date || '',
        time: payload.appointment_time || '',
        note: payload.note || ''
      });
      const charge = await processCharge(
        user,
        customer,
        payload.note || 'GHL Trigger (booked)',
        {
          utm_source: payload.utm_source,
          utm_medium: payload.utm_medium,
          utm_campaign: payload.utm_campaign,
          gclid: payload.gclid
        }
      );
      await markWebhookEvent(webhookStart.event.id, 'succeeded', {
        appointmentId: appt.id,
        chargeId: charge.id,
        chargeStatus: charge.status
      });
      return res.json({
        success: true,
        mode: 'appointment_tracking',
        appointmentId: appt.id,
        chargeId: charge.id,
        chargeStatus: charge.status,
        customerId: customer.id,
        locationId: ghlLocationId
      });
    }

    const charge = await processCharge(
      user,
      customer,
      payload.note || 'GHL Trigger',
      {
        utm_source: payload.utm_source,
        utm_medium: payload.utm_medium,
        utm_campaign: payload.utm_campaign,
        gclid: payload.gclid
      }
    );
    await markWebhookEvent(webhookStart.event.id, charge.status === 'failed' ? 'failed' : 'succeeded', {
      chargeId: charge.id,
      chargeStatus: charge.status
    });
    res.json({
      success: true,
      chargeId: charge.id,
      status: charge.status,
      customerId: customer.id,
      customerName: customer.name,
      chargeAmount: customer.rate_per_trigger,
      locationId: ghlLocationId
    });
  } catch (err) {
    console.error('GHL webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /webhook/ghl/:secret/:locationId — per‑client webhook
app.post('/webhook/ghl/:secret/:locationId', async (req, res) => {
  try {
    const user = await db.getUserByGhlSecret(req.params.secret);
    if (!user) return res.status(403).json({ error: 'Invalid secret' });

    const locationId = req.params.locationId;
    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'Invalid payload' });
    }
    const eventKey =
      req.headers['x-idempotency-key'] ||
      payload.event_id ||
      payload.id ||
      makeEventKey('ghl', payload, `${user.id}:${locationId}`);
    const webhookStart = await recordWebhookEventStart({
      userId: user.id,
      source: 'ghl',
      eventType: payload.type || 'appointment.booked',
      eventKey,
      secretFragment: `${String(req.params.secret).slice(0, 8)}:${locationId.slice(0, 8)}`,
      payload
    });
    if (webhookStart.duplicate) {
      return res.json({ success: true, duplicate: true, eventId: webhookStart.event.id });
    }
    let customer = await db.getCustomerByLocationId(locationId, user.id);

    if (!customer) {
      customer = await db.createCustomer({
        user_id: user.id,
        name:
          payload.full_name ||
          payload.name ||
          `GHL Location ${locationId.slice(0,8)}`,
        email:
          payload.email ||
          `location-${locationId.slice(0,8)}@ghl.auto`,
        phone: payload.phone || '',
        whop_member_id: payload.whop_member_id || '',
        whop_payment_method_id: payload.whop_payment_method_id || '',
        stripe_customer_id: payload.stripe_customer_id || '',
        stripe_payment_method_id: payload.stripe_payment_method_id || '',
        rate_per_trigger:
          payload.rate_trigger || user.monthly_rate || 147,
        status: 'new',
        card_on_file: !!(
          payload.whop_payment_method_id || payload.stripe_payment_method_id
        ),
        ghl_location_id: locationId
      });
      await audit('customer.auto_created_from_ghl', {
        actor: user,
        customer_id: customer.id,
        target_type: 'customer',
        target_id: customer.id,
        details: { source: 'ghl', ghl_location_id: locationId, user_id: user.id }
      });
      await db.addNotification({
        user_id: user.id,
        type: 'new',
        title: `New client auto-created — ${customer.name}`,
        body: `GHL Location ${locationId} mapped. Set rate and payment method.`
      });
    }

    if (
      payload.email &&
      payload.email !== customer.email &&
      !customer.email.includes('@ghl.auto')
    ) {
      await db.updateCustomer(customer.id, { email: payload.email });
    }
    if (
      payload.full_name &&
      payload.full_name !== customer.name &&
      customer.name.startsWith('GHL Location')
    ) {
      await db.updateCustomer(customer.id, { name: payload.full_name });
    }
    if (payload.whop_payment_method_id || payload.stripe_payment_method_id) {
      await db.updateCustomer(customer.id, {
        card_on_file: 1,
        whop_member_id: payload.whop_member_id || '',
        stripe_payment_method_id: payload.stripe_payment_method_id || ''
      });
      customer = await db.getCustomerById(customer.id);
    }

    await db.updateWebhookEvent(webhookStart.event.id, { customer_id: customer.id });
    await db.addNotification({
      user_id: user.id,
      type: 'trigger',
      title: `Appointment — ${customer.name}`,
      body: `GHL Location ${locationId} fired. $${customer.rate_per_trigger} charge ready.`
    });

    if (user.appointment_tracking_mode) {
      const appt = await db.createAppointment({
        user_id: user.id,
        customer_id: customer.id,
        status: 'booked',
        date: payload.appointment_date || '',
        time: payload.appointment_time || '',
        note: payload.note || ''
      });
      const charge = await processCharge(
        user,
        customer,
        payload.note || `GHL Location ${locationId} Trigger (booked)`,
        {
          utm_source: payload.utm_source,
          utm_medium: payload.utm_medium,
          utm_campaign: payload.utm_campaign,
          gclid: payload.gclid
        }
      );
      await markWebhookEvent(webhookStart.event.id, 'succeeded', {
        appointmentId: appt.id,
        chargeId: charge.id,
        chargeStatus: charge.status
      });
      return res.json({
        success: true,
        mode: 'appointment_tracking',
        appointmentId: appt.id,
        chargeId: charge.id,
        chargeStatus: charge.status,
        customerId: customer.id,
        locationId,
        customerName: customer.name
      });
    }

    const charge = await processCharge(
      user,
      customer,
      payload.note || `GHL Location ${locationId} Trigger`,
      {
        utm_source: payload.utm_source,
        utm_medium: payload.utm_medium,
        utm_campaign: payload.utm_campaign,
        gclid: payload.gclid
      }
    );
    await markWebhookEvent(webhookStart.event.id, charge.status === 'failed' ? 'failed' : 'succeeded', {
      chargeId: charge.id,
      chargeStatus: charge.status
    });
    res.json({
      success: true,
      chargeId: charge.id,
      status: charge.status,
      customerId: customer.id,
      locationId,
      customerName: customer.name
    });
  } catch (err) {
    console.error('GHL client webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── FAILED CHARGE WEBHOOK ──────────────────────────────────────
async function fireFailWebhook(user, customer, amount, reason) {
  if (!user.failed_charge_webhook_url) return;
  const companyName = customer.company_name || customer.name;
  try {
    await fetch(user.failed_charge_webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'charge.failed',
        event_type: 'charge_failed',
        customer_name: customer.name,
        customer_company: customer.company_name || '',
        customer_email: customer.email,
        amount,
        failure_reason: reason,
        customer_id: customer.id,
        // Pre-formatted SMS-friendly message for GHL mapping
        sms_message: `${customer.name}'s payment of $${amount} was declined — ${reason}. Check with them to update their card.`,
        sms_alert: `${customer.name} — payment declined`
      })
    });
  } catch (e) {
    console.error('Failed to send failure webhook:', e.message);
  }
}

async function scheduleChargeRetry(charge, reason = '') {
  const retryCount = (parseInt(charge.retry_count, 10) || 0) + 1;
  const nextRetryAt = new Date(Date.now() + Math.min(retryCount, 3) * 24 * 60 * 60 * 1000).toISOString();
  return db.updateCharge(charge.id, {
    retry_count: retryCount,
    retry_status: 'scheduled',
    next_retry_at: nextRetryAt,
    failure_reason: reason || charge.failure_reason || ''
  });
}

async function finalizeFailedCharge({ user, customer, charge, amount, reason, notificationBody, shouldWebhook = true }) {
  await db.updateCustomer(customer.id, { status: 'at_risk' });
  const updatedCharge = await scheduleChargeRetry(
    await db.updateCharge(charge.id, {
      status: 'failed',
      failure_reason: reason
    }),
    reason
  );
  await db.addNotification({
    user_id: user.id,
    type: 'fail',
    title: `Charge failed — ${customer.name}`,
    body: notificationBody || reason
  });
  await audit('charge.failed', {
    actor: user,
    customer_id: customer.id,
    target_type: 'charge',
    target_id: charge.id,
    details: { customer_id: customer.id, amount, reason, retry_status: 'scheduled' }
  });
  await sendEmailAlert(
    user,
    `PayPulse failed charge for ${customer.name}`,
    `A charge for ${customer.name} failed.\nAmount: $${amount.toFixed(2)}\nReason: ${reason}\nA retry has been scheduled automatically.`
  );
  if (shouldWebhook) {
    await fireFailWebhook(user, customer, amount, reason);
  }
  return updatedCharge;
}

// ─── CHARGE PROCESSING ────────────────────────────────────────────
async function processCharge(user, customer, note = '', utmData = {}) {
  const rate = parseFloat(customer.rate_per_trigger) || 0;
  const credit = parseFloat(customer.credit_balance) || 0;

  // Helper to merge UTM data into charge object
  const addUtm = obj => ({
    ...obj,
    utm_source: utmData.utm_source ?? '',
    utm_medium: utmData.utm_medium ?? '',
    utm_campaign: utmData.utm_campaign ?? '',
    gclid: utmData.gclid ?? ''
  });

  // Credit covers the full charge
  if (credit > 0 && credit >= rate) {
    const charge = await db.createCharge(
      addUtm({
        user_id: user.id,
        customer_id: customer.id,
        customer_name: customer.name,
        customer_email: customer.email,
        amount: rate,
        processor: user.processor,
        status: 'credited',
        note
      })
    );
    await db.updateCustomer(customer.id, {
      credit_balance: credit - rate
    });
    await db.addNotification({
      user_id: user.id,
      type: 'success',
      title: `Credit applied — ${customer.name}`,
      body: `$${rate.toFixed(2)} covered by credit balance. Remaining credit: $${(
        credit - rate
      ).toFixed(2)}`
    });
    await audit('charge.credit_applied', {
      actor: user,
      customer_id: customer.id,
      target_type: 'charge',
      target_id: charge.id,
      details: { customer_id: customer.id, amount: rate, remaining_credit: credit - rate }
    });
    return db.getChargeById(charge.id);
  }

  // Partial credit: charge the difference, reset credit to 0
  let chargeAmount = rate;
  let creditUsed = 0;
  if (credit > 0 && credit < rate) {
    chargeAmount = rate - credit;
    creditUsed = credit;
  }

  const charge = await db.createCharge(
    addUtm({
      user_id: user.id,
      customer_id: customer.id,
      customer_name: customer.name,
      customer_email: customer.email,
      amount: chargeAmount,
      processor: user.processor,
      status: 'pending',
      note:
        creditUsed > 0
          ? `${note} (credit applied: $${creditUsed.toFixed(2)})`
          : note
    })
  );

  // Reset credit balance if partial credit was used
  if (creditUsed > 0) {
    await db.updateCustomer(customer.id, { credit_balance: 0 });
  }

  if (!customer.card_on_file) {
    return finalizeFailedCharge({
      user,
      customer,
      charge,
      amount: chargeAmount,
      reason: 'No payment method on file',
      notificationBody: `$${chargeAmount.toFixed(2)} failed — No payment method on file`
    });
  }

  // Real Stripe charging
  if (user.processor === 'stripe') {
    if (!user.stripe_secret_key) {
      return finalizeFailedCharge({
        user,
        customer,
        charge,
        amount: chargeAmount,
        reason: 'No Stripe Secret Key configured',
        notificationBody: 'No Stripe Secret Key configured',
        shouldWebhook: false
      });
    }
    if (!user.stripe_secret_key.startsWith('sk_')) {
      return finalizeFailedCharge({
        user,
        customer,
        charge,
        amount: chargeAmount,
        reason: 'Invalid Stripe key — must start with sk_live_ or sk_test_',
        notificationBody: 'Invalid Stripe key — must start with sk_live_ or sk_test_'
      });
    }
    if (!customer.stripe_customer_id) {
      return finalizeFailedCharge({
        user,
        customer,
        charge,
        amount: chargeAmount,
        reason: 'No Stripe customer ID on file',
        notificationBody: 'No Stripe customer ID on file'
      });
    }

    try {
      const stripeClient = Stripe(user.stripe_secret_key);
      const piOptions = {
        amount: Math.round(chargeAmount * 100),
        currency: 'usd',
        customer: customer.stripe_customer_id,
        off_session: true,
        confirm: true,
        description: `PayPulse charge for ${customer.name}`,
        metadata: { customer_id: customer.id, user_id: user.id }
      };
      if (customer.stripe_payment_method_id) {
        piOptions.payment_method = customer.stripe_payment_method_id;
      }
      const paymentIntent = await stripeClient.paymentIntents.create(piOptions);

      if (paymentIntent.status === 'succeeded') {
        await db.updateCharge(charge.id, {
          status: 'succeeded',
          stripe_charge_id: paymentIntent.id
        });
        if (
          !customer.stripe_payment_method_id &&
          paymentIntent.payment_method
        ) {
          await db.updateCustomer(customer.id, {
            stripe_payment_method_id: paymentIntent.payment_method,
            card_on_file: 1
          });
        }
        await db.updateCustomer(customer.id, {
          total_charged:
            (parseFloat(customer.total_charged) || 0) + chargeAmount,
          total_triggers:
            (parseInt(customer.total_triggers) || 0) + 1
        });
        await db.addNotification({
          user_id: user.id,
          type: 'success',
          title: `Charge successful — ${customer.name}`,
          body: `$${chargeAmount.toFixed(2)} charged via Stripe. PI: ${
            paymentIntent.id.slice(-8)
          }`
        });
        await db.updateCharge(charge.id, {
          retry_status: 'none',
          next_retry_at: null
        });
        await audit('charge.succeeded', {
          actor: user,
          customer_id: customer.id,
          target_type: 'charge',
          target_id: charge.id,
          details: { customer_id: customer.id, amount: chargeAmount, processor: 'stripe', payment_intent: paymentIntent.id }
        });
      } else {
        await finalizeFailedCharge({
          user,
          customer,
          charge,
          amount: chargeAmount,
          reason: `PaymentIntent status: ${paymentIntent.status}`,
          notificationBody: `Stripe returned status: ${paymentIntent.status}`
        });
      }
    } catch (stripeErr) {
      console.error('Stripe charge error:', stripeErr);
      const reason = stripeErr.message || 'Unknown Stripe error';
      await finalizeFailedCharge({
        user,
        customer,
        charge,
        amount: chargeAmount,
        reason,
        notificationBody: `Stripe error: ${reason}`
      });
    }
    return db.getChargeById(charge.id);
  }

  // Whop processor — real API call
  if (customer.whop_member_id && customer.whop_payment_method_id) {
    try {
      const response = await fetch('https://api.whop.com/v1/payments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.whop_api_key}`
        },
        body: JSON.stringify({
          company_id: user.whop_company_id,
          member_id: customer.whop_member_id,
          payment_method_id: customer.whop_payment_method_id,
          total: chargeAmount,
          plan: { currency: 'usd' },
          metadata: { paypulse_customer_id: customer.id }
        })
      });

      if (response.ok) {
        const payment = await response.json();
        await db.updateCharge(charge.id, {
          status: 'succeeded',
          stripe_charge_id: payment.id
        });
        await db.updateCustomer(customer.id, {
          total_charged:
            (parseFloat(customer.total_charged) || 0) + chargeAmount,
          total_triggers:
            (parseInt(customer.total_triggers) || 0) + 1
        });
        await db.addNotification({
          user_id: user.id,
          type: 'success',
          title: `Charge successful — ${customer.name}`,
          body: `$${chargeAmount.toFixed(2)} charged via Whop. Payment: ${payment.id}`
        });
        await db.updateCharge(charge.id, {
          retry_status: 'none',
          next_retry_at: null
        });
        await audit('charge.succeeded', {
          actor: user,
          customer_id: customer.id,
          target_type: 'charge',
          target_id: charge.id,
          details: { customer_id: customer.id, amount: chargeAmount, processor: 'whop', payment_id: payment.id }
        });
      } else {
        const errorBody = await response.text();
        let failureReason;
        try {
          const errJson = JSON.parse(errorBody);
          failureReason = errJson.error || errJson.message || errorBody;
        } catch {
          failureReason = errorBody;
        }
        await finalizeFailedCharge({
          user,
          customer,
          charge,
          amount: chargeAmount,
          reason: failureReason,
          notificationBody: `Whop error: ${failureReason}`
        });
      }
    } catch (fetchErr) {
      console.error('Whop charge error:', fetchErr);
      const reason = fetchErr.message || 'Whop network error';
      await finalizeFailedCharge({
        user,
        customer,
        charge,
        amount: chargeAmount,
        reason,
        notificationBody: `Whop error: ${reason}`
      });
    }
    return db.getChargeById(charge.id);
  }

  // Fallback — simulated charge (no Whop payment method configured)
  await db.updateCharge(charge.id, {
    status: 'succeeded',
    stripe_charge_id: `sim_${uuidv4().slice(0,8)}`
  });
  await db.updateCustomer(customer.id, {
    total_charged:
      (parseFloat(customer.total_charged) || 0) + chargeAmount,
    total_triggers:
      (parseInt(customer.total_triggers) || 0) + 1
  });
  await db.addNotification({
    user_id: user.id,
    type: 'success',
    title: `Charge successful — ${customer.name}`,
    body: `$${chargeAmount.toFixed(2)} charged via ${user.processor}. ${note}`
  });
  await db.updateCharge(charge.id, {
    retry_status: 'none',
    next_retry_at: null
  });
  await audit('charge.succeeded', {
    actor: user,
    customer_id: customer.id,
    target_type: 'charge',
    target_id: charge.id,
    details: { customer_id: customer.id, amount: chargeAmount, processor: user.processor, simulated: true }
  });
  return db.getChargeById(charge.id);
}

// ─── WHOP WEBHOOK ─────────────────────────────────────────────
app.post('/webhook/whop/:secret', async (req, res) => {
  try {
    const user = await db.getUserByWhopSecret(req.params.secret);
    if (!user) return res.status(403).json({ error: 'Invalid secret' });
    const { event, data } = req.body;
    const eventKey =
      req.headers['x-idempotency-key'] ||
      data?.id ||
      data?.payment?.id ||
      makeEventKey('whop', req.body, `${user.id}:${event || 'event'}`);
    const webhookStart = await recordWebhookEventStart({
      userId: user.id,
      source: 'whop',
      eventType: event || 'unknown',
      eventKey,
      secretFragment: String(req.params.secret).slice(0, 8),
      payload: req.body
    });
    if (webhookStart.duplicate) {
      return res.json({ received: true, duplicate: true, eventId: webhookStart.event.id });
    }
    if (
      event === 'payment.succeeded' ||
      event === 'membership.went_valid'
    ) {
      const email = data.user?.email || data.customer?.email;
      const name = data.user?.name || data.customer?.name;
      let customer = await db.getCustomerByEmailAndUser(email, user.id);
      if (!customer)
        customer = await db.createCustomer({
          user_id: user.id,
          name: name || (email ? email.split('@')[0] : 'Whop Customer'),
          email,
          whop_member_id: data.user?.id || ''
        });
      await db.updateCustomer(customer.id, {
        card_on_file: 1,
        whop_member_id: data.user?.id || ''
      });
      await db.updateWebhookEvent(webhookStart.event.id, { customer_id: customer.id });
      await db.addNotification({
        user_id: user.id,
        type: 'success',
        title: `Whop payment — ${customer.name}`,
        body: 'Payment succeeded via Whop webhook.'
      });
    }
    await markWebhookEvent(webhookStart.event.id, 'succeeded', { event });
    res.json({ received: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── STRIPE WEBHOOK ───────────────────────────────────────────────
app.post('/webhook/stripe/:secret', async (req, res) => {
  try {
    if (!STRIPE_WEBHOOK_ROUTE_SECRET || req.params.secret !== STRIPE_WEBHOOK_ROUTE_SECRET) {
      return res.status(403).json({ error: 'Invalid Stripe webhook route secret' });
    }

    let event = req.body;
    const signature = req.headers['stripe-signature'];
    if (STRIPE_SIGNING_SECRET && signature) {
      const stripeForWebhook = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_webhook_placeholder');
      event = stripeForWebhook.webhooks.constructEvent(
        req.rawBody,
        signature,
        STRIPE_SIGNING_SECRET
      );
    }

    let eventRecord = null;
    const eventKey = event.id || makeEventKey('stripe', event, event.type || 'event');

    if (event.type === 'checkout.session.completed') {
      const obj = event.data.object;
      const paypulseCustomerId = obj.metadata?.paypulse_customer_id;
      const paypulseUserId = obj.metadata?.paypulse_user_id;
      if (paypulseCustomerId) {
        const customer = await db.getCustomerById(paypulseCustomerId);
        if (customer) {
          const webhookStart = await recordWebhookEventStart({
            userId: customer.user_id,
            customerId: customer.id,
            source: 'stripe',
            eventType: event.type,
            eventKey,
            secretFragment: String(req.params.secret).slice(0, 8),
            payload: event
          });
          if (webhookStart.duplicate) {
            return res.json({ received: true, duplicate: true, eventId: webhookStart.event.id });
          }
          eventRecord = webhookStart.event;
          // Retrieve the session to get payment_method and customer
          let stripeCustomerId =
            obj.customer || customer.stripe_customer_id || '';
          let paymentMethodId = '';
          if (paypulseUserId) {
            const user = await db.getUserById(paypulseUserId);
            if (user && user.stripe_secret_key) {
              try {
                const stripeClient = Stripe(user.stripe_secret_key);
                const session = await stripeClient.checkout.sessions.retrieve(
                  obj.id
                );
                stripeCustomerId =
                  session.customer || stripeCustomerId;
                if (session.payment_intent) {
                  const intent = await stripeClient.paymentIntents.retrieve(
                    session.payment_intent
                  );
                  paymentMethodId = intent.payment_method || '';
                }
              } catch (e) {
                // best effort retrieval
              }
            }
          }
          await db.updateCustomer(paypulseCustomerId, {
            stripe_customer_id: stripeCustomerId,
            stripe_payment_method_id: paymentMethodId,
            card_on_file: 1
          });
          await db.addNotification({
            user_id: customer.user_id,
            type: 'success',
            title: `Card saved — ${customer.name}`,
            body: 'Card authorization completed via Stripe Checkout.'
          });
          await audit('customer.card_saved', {
            actor: { id: customer.user_id, email: '' },
            customer_id: customer.id,
            target_type: 'customer',
            target_id: customer.id,
            details: { source: 'stripe_webhook', event_id: event.id || '' }
          });
        }
      }
    }

    if (event.type === 'payment_intent.payment_failed') {
      const obj = event.data.object;
      const paypulseCustomerId =
        obj.metadata?.paypulse_customer_id ||
        obj.metadata?.customer_id;
      if (paypulseCustomerId) {
        const customer = await db.getCustomerById(paypulseCustomerId);
        if (customer) {
          const webhookStart = await recordWebhookEventStart({
            userId: customer.user_id,
            customerId: customer.id,
            source: 'stripe',
            eventType: event.type,
            eventKey,
            secretFragment: String(req.params.secret).slice(0, 8),
            payload: event
          });
          if (webhookStart.duplicate) {
            return res.json({ received: true, duplicate: true, eventId: webhookStart.event.id });
          }
          eventRecord = webhookStart.event;
          await db.createCharge({
            id: uuidv4(),
            user_id: customer.user_id,
            customer_id: customer.id,
            customer_name: customer.name,
            customer_email: customer.email,
            amount:
              parseFloat(obj.amount_received || obj.amount || 0) / 100,
            processor: 'stripe',
            status: 'failed',
            stripe_charge_id: obj.id,
            note: 'Payment intent failed (Stripe webhook)',
            failure_reason:
              obj.last_payment_error?.message || 'Payment failed'
          });
          await db.addNotification({
            user_id: customer.user_id,
            type: 'fail',
            title: `Charge failed — ${customer.name}`,
            body: `Stripe payment intent failed: ${
              obj.last_payment_error?.message || 'Unknown'
            }`
          });
          // Also fire the fail alert to GHL
          const chargeUser = await db.getUserById(customer.user_id);
          if (chargeUser) {
            const failAmount = parseFloat(obj.amount_received || obj.amount || 0) / 100;
            await fireFailWebhook(chargeUser, customer, failAmount, obj.last_payment_error?.message || 'Payment failed');
          }
        }
      }
    }

    if (event.type === 'payment_intent.succeeded') {
      const obj = event.data.object;
      const email = obj.receipt_email;
      const allUsers = await db.listUsers('agency');
      for (const u of allUsers) {
        let customer = await db.getCustomerByEmailAndUser(email, u.id);
        if (customer) {
          const webhookStart = await recordWebhookEventStart({
            userId: customer.user_id,
            customerId: customer.id,
            source: 'stripe',
            eventType: event.type,
            eventKey,
            secretFragment: String(req.params.secret).slice(0, 8),
            payload: event
          });
          if (webhookStart.duplicate) {
            return res.json({ received: true, duplicate: true, eventId: webhookStart.event.id });
          }
          eventRecord = webhookStart.event;
          await db.updateCustomer(customer.id, {
            card_on_file: 1,
            stripe_payment_method_id: obj.payment_method || ''
          });
      await db.addNotification({
        user_id: u.id,
        type: 'success',
            title: `Stripe payment — ${customer.name}`,
            body: 'Payment intent succeeded.'
          });
          break;
        }
      }
    }

    if (event.type === 'charge.dispute.created') {
      const obj = event.data.object;
      const allUsers = await db.listUsers('agency');
      for (const u of allUsers) {
        const charges = await db.getChargesByUser(u.id);
        const match = charges.find(c => c.stripe_charge_id === obj.charge);
        if (match) {
          const webhookStart = await recordWebhookEventStart({
            userId: u.id,
            customerId: match.customer_id,
            source: 'stripe',
            eventType: event.type,
            eventKey,
            secretFragment: String(req.params.secret).slice(0, 8),
            payload: event
          });
          if (webhookStart.duplicate) {
            return res.json({ received: true, duplicate: true, eventId: webhookStart.event.id });
          }
          eventRecord = webhookStart.event;
          await db.createCharge({
            id: uuidv4(),
            user_id: u.id,
            customer_id: match.customer_id,
            customer_name: match.customer_name,
            customer_email: match.customer_email,
            amount: match.amount,
            processor: 'stripe',
            status: 'chargeback',
            stripe_charge_id: obj.id,
            note: 'Chargeback initiated',
            failure_reason: obj.reason
          });
          await db.addNotification({
            user_id: u.id,
            type: 'fail',
            title: `CHARGEBACK — ${match.customer_name}`,
            body: `$${match.amount.toFixed(2)} chargeback initiated. Reason: ${
              obj.reason
            }`
          });
          break;
        }
      }
    }
    if (eventRecord) {
      await markWebhookEvent(eventRecord.id, 'succeeded', { type: event.type, id: event.id || '' });
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Stripe webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── CRM API (AGENCY) ────────────────────────────────────────────
app.get('/api/customers', requireAuth, async (req, res) => {
  res.json(await db.getCustomersByUser(req.user.id));
});

// ─── STRIPE CUSTOMER SYNC ───────────────────────────────────────
app.get('/api/stripe/customers', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    if (!user.stripe_secret_key)
      return res.status(400).json({ error: 'Set your Stripe Secret Key in Settings first' });
    const stripe = Stripe(user.stripe_secret_key);
    const customers = [];
    let hasMore = true;
    let startingAfter = null;
    while (hasMore && customers.length < 200) {
      const params = { limit: 100 };
      if (startingAfter) params.starting_after = startingAfter;
      const list = await stripe.customers.list(params);
      customers.push(...list.data.map(c => ({
        id: c.id,
        name: c.name || c.email?.split('@')[0] || 'Unknown',
        email: c.email || '',
        phone: c.phone || '',
        card_on_file: c.invoice_settings?.default_payment_method ? true : false,
        created: c.created
      })));
      hasMore = list.has_more;
      startingAfter = list.data[list.data.length - 1]?.id;
    }
    res.json(customers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/customers', requireAuth, async (req, res) => {
  try {
    const allowed = pick(req.body, [
      'name',
      'email',
      'phone',
      'company_name',
      'status',
      'card_on_file',
      'stripe_customer_id',
      'stripe_payment_method_id',
      'whop_member_id',
      'whop_payment_method_id',
      'rate_per_trigger',
      'ghl_location_id'
    ]);
    const c = await db.createCustomer({
      ...allowed,
      user_id: req.user.id
    });
    await db.addNotification({
      user_id: req.user.id,
      type: 'new',
      title: `New customer — ${c.name}`,
      body: `${c.email} added manually.`
    });
    await audit('customer.created', {
      actor: req.user,
      customer_id: c.id,
      target_type: 'customer',
      target_id: c.id,
      details: { user_id: req.user.id, email: c.email }
    });
    res.json(c);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── IMPORT STRIPE CUSTOMERS ────────────────────────────────────
app.post('/api/customers/import-stripe', requireAuth, async (req, res) => {
  try {
    const { customerIds } = req.body;
    if (!customerIds || !customerIds.length)
      return res.status(400).json({ error: 'No customer IDs provided' });
    const user = await db.getUserById(req.user.id);
    if (!user.stripe_secret_key)
      return res.status(400).json({ error: 'Set Stripe Secret Key first' });
    const stripe = Stripe(user.stripe_secret_key);
    const imported = [];
    const skipped = [];
    for (const id of customerIds) {
      try {
        const sCust = await stripe.customers.retrieve(id);
        if (!sCust) { skipped.push(id); continue; }
        const existingByEmail = sCust.email ? await db.getCustomerByEmailAndUser(sCust.email, req.user.id) : null;
        if (existingByEmail) { skipped.push(sCust.email); continue; }
        const c = await db.createCustomer({
          user_id: req.user.id,
          name: sCust.name || sCust.email?.split('@')[0] || id.slice(-8),
          email: sCust.email || '',
          phone: sCust.phone || '',
          stripe_customer_id: sCust.id,
          stripe_payment_method_id: sCust.invoice_settings?.default_payment_method || '',
          card_on_file: sCust.invoice_settings?.default_payment_method ? 1 : 0,
          status: 'new'
        });
        imported.push(c);
      } catch (e) { skipped.push(id); }
    }
    res.json({ imported: imported.length, skipped: skipped.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/customers/:id', requireAuth, async (req, res) => {
  try {
    const c = await db.getCustomerById(req.params.id);
    if (!c || c.user_id !== req.user.id)
      return res.status(404).json({ error: 'Not found' });
    const updates = pick(req.body, [
      'name',
      'email',
      'phone',
      'company_name',
      'status',
      'card_on_file',
      'stripe_customer_id',
      'stripe_payment_method_id',
      'whop_member_id',
      'whop_payment_method_id',
      'rate_per_trigger',
      'credit_balance',
      'ghl_location_id'
    ]);
    if (
      updates.stripe_payment_method_id ||
      updates.whop_payment_method_id
    ) {
      updates.card_on_file = 1;
    }
    const updated = await db.updateCustomer(req.params.id, updates);
    await audit('customer.updated', {
      actor: req.user,
      customer_id: c.id,
      target_type: 'customer',
      target_id: c.id,
      details: { changed: Object.keys(updates), user_id: req.user.id }
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/customers/:id', requireAuth, async (req, res) => {
  const c = await db.getCustomerById(req.params.id);
  if (!c || c.user_id !== req.user.id)
    return res.status(404).json({ error: 'Not found' });
  await db.run('DELETE FROM customers WHERE id = ?', [req.params.id]);
  await audit('customer.deleted', {
    actor: req.user,
    customer_id: c.id,
    target_type: 'customer',
    target_id: c.id,
    details: { email: c.email, user_id: req.user.id }
  });
  res.json({ ok: true });
});

// Per-client webhook URL (for GHL sub-account config)
app.get('/api/customers/:id/webhook-url', requireAuth, async (req, res) => {
  const c = await db.getCustomerById(req.params.id);
  if (!c || c.user_id !== req.user.id)
    return res.status(404).json({ error: 'Not found' });
  const user = await db.getUserById(req.user.id);
  if (!c.ghl_location_id)
    return res.json({
      webhookUrl: null,
      error: 'Set GHL Location ID first'
    });
  res.json({
    webhookUrl: `${BASE_URL}/webhook/ghl/${user.ghl_webhook_secret}/${c.ghl_location_id}`
  });
});

app.post('/api/customers/:id/charge', requireAuth, async (req, res) => {
  const c = await db.getCustomerById(req.params.id);
  if (!c || c.user_id !== req.user.id)
    return res.status(404).json({ error: 'Not found' });
  const user = await db.getUserById(req.user.id);
  const charge = await processCharge(
    user,
    c,
    req.body.note || 'Manual charge'
  );
  res.json(charge);
});

// Test failed charge alert webhook (no real charge — just tests the GHL webhook)
app.post('/api/customers/:id/test-fail-alert', requireAuth, async (req, res) => {
  try {
    const customer = await db.getCustomerById(req.params.id);
    if (!customer || customer.user_id !== req.user.id)
      return res.status(404).json({ error: 'Not found' });
    const user = await db.getUserById(req.user.id);
    if (!user.failed_charge_webhook_url)
      return res.status(400).json({ error: 'No Failed Charge Webhook URL set in Settings' });
    await fireFailWebhook(user, customer, parseFloat(customer.rate_per_trigger) || 75, 'Test — simulated card decline');
    res.json({ success: true, message: `Test alert sent for ${customer.name}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── STRIPE CARD SETUP ───────────────────────────────────────────
app.post('/api/customers/:id/setup-card', requireAuth, async (req, res) => {
  try {
    const customer = await db.getCustomerById(req.params.id);
    if (!customer || customer.user_id !== req.user.id)
      return res.status(404).json({ error: 'Not found' });
    const user = await db.getUserById(req.user.id);
    if (!user.stripe_secret_key)
      return res
        .status(400)
        .json({ error: 'Set your Stripe secret key in Settings first' });
    res.json({ url: await buildCardSetupLink(user, customer) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CHARGES API ──────────────────────────────────────────────────
app.get('/api/charges', requireAuth, async (req, res) => {
  res.json(await db.getChargesByUser(req.user.id));
});

// Per-customer charges (for detail modal)
app.get('/api/customers/:id/charges', requireAuth, async (req, res) => {
  const c = await db.getCustomerById(req.params.id);
  if (!c || c.user_id !== req.user.id)
    return res.status(404).json({ error: 'Not found' });
  const charges = await db.all(
    'SELECT * FROM charges WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50',
    [req.params.id]
  );
  res.json(charges);
});

// ─── CHARGE RETRY ────────────────────────────────────────────────
app.post('/api/charges/:id/retry', requireAuth, async (req, res) => {
  try {
    const oldCharge = await db.getChargeById(req.params.id);
    if (!oldCharge || oldCharge.user_id !== req.user.id)
      return res.status(404).json({ error: 'Not found' });
    if (oldCharge.status !== 'failed')
      return res
        .status(400)
        .json({ error: 'Only failed charges can be retried' });

    const customer = await db.getCustomerById(oldCharge.customer_id);
    if (!customer) return res.status(404).json({ error: 'Not found' });
    const user = await db.getUserById(req.user.id);

    // Temporarily override rate_per_trigger so processCharge uses the original charge amount
    const originalAmount = parseFloat(oldCharge.amount) || 0;
    const chargeCustomer = { ...customer, rate_per_trigger: originalAmount };
    const newCharge = await processCharge(
      user,
      chargeCustomer,
      `Retry of charge ${oldCharge.id.slice(-8)}`
    );

    // Mark old charge as retried
    await db.updateCharge(oldCharge.id, { status: 'retried' });
    await db.updateCharge(newCharge.id, {
      retry_count: (parseInt(oldCharge.retry_count, 10) || 0) + 1,
      retry_status: newCharge.status === 'failed' ? 'scheduled' : 'completed',
      next_retry_at: newCharge.status === 'failed' ? newCharge.next_retry_at : null
    });
    await audit('charge.retry_requested', {
      actor: req.user,
      customer_id: customer.id,
      target_type: 'charge',
      target_id: newCharge.id,
      details: { previous_charge_id: oldCharge.id, customer_id: customer.id }
    });

    res.json(newCharge);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/charges/:id/schedule-retry', requireAuth, async (req, res) => {
  try {
    const charge = await db.getChargeById(req.params.id);
    if (!charge || charge.user_id !== req.user.id)
      return res.status(404).json({ error: 'Not found' });
    const nextRetryAt = req.body.nextRetryAt || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const updated = await db.updateCharge(charge.id, {
      retry_status: 'scheduled',
      next_retry_at: nextRetryAt,
      retry_count: (parseInt(charge.retry_count, 10) || 0) + 1
    });
    await audit('charge.retry_scheduled', {
      actor: req.user,
      customer_id: charge.customer_id,
      target_type: 'charge',
      target_id: charge.id,
      details: { next_retry_at: nextRetryAt, customer_id: charge.customer_id }
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/charges/:id/refund', requireAuth, async (req, res) => {
  try {
    const charge = await db.getChargeById(req.params.id);
    if (!charge || charge.user_id !== req.user.id)
      return res.status(404).json({ error: 'Not found' });
    if (charge.status !== 'succeeded')
      return res.status(400).json({ error: 'Only succeeded charges can be refunded' });
    const customer = await db.getCustomerById(charge.customer_id);
    const user = await db.getUserById(req.user.id);
    const amount = Math.min(
      parseFloat(req.body.amount || charge.amount),
      parseFloat(charge.amount || 0) - parseFloat(charge.refunded_amount || 0)
    );
    if (amount <= 0) {
      return res.status(400).json({ error: 'Nothing left to refund' });
    }

    if (user.processor === 'stripe' && user.stripe_secret_key && charge.stripe_charge_id && !String(charge.stripe_charge_id).startsWith('sim_')) {
      const stripeClient = Stripe(user.stripe_secret_key);
      await stripeClient.refunds.create({
        payment_intent: charge.stripe_charge_id,
        amount: Math.round(amount * 100)
      });
    }

    await db.updateCharge(charge.id, {
      refunded_amount: (parseFloat(charge.refunded_amount) || 0) + amount,
      refunded_at: new Date().toISOString(),
      status: amount === parseFloat(charge.amount) ? 'refunded' : charge.status
    });
    await db.createCharge({
      user_id: req.user.id,
      customer_id: customer.id,
      customer_name: customer.name,
      customer_email: customer.email,
      amount: -amount,
      processor: user.processor,
      status: 'refunded',
      note: req.body.note || `Refund for charge ${charge.id.slice(-8)}`,
      stripe_charge_id: charge.stripe_charge_id
    });
    await db.updateCustomer(customer.id, {
      total_charged: Math.max(0, (parseFloat(customer.total_charged) || 0) - amount)
    });
    await audit('charge.refunded', {
      actor: req.user,
      customer_id: customer.id,
      target_type: 'charge',
      target_id: charge.id,
      details: { customer_id: customer.id, amount, note: req.body.note || '' }
    });
    res.json({ ok: true, refunded: amount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-customer payment details (for analytics modal)
app.get('/api/customers/:id/payment-details', requireAuth, async (req, res) => {
  try {
    const c = await db.getCustomerById(req.params.id);
    if (!c || c.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Not found' });
    }
    const charges = await db.all(
      'SELECT * FROM charges WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.params.id]
    );
    const user = await db.getUserById(req.user.id);
    if (!user) {
      return res.status(500).json({ error: 'User not found' });
    }
    const webhookUrl = c.ghl_location_id
      ? `${BASE_URL}/webhook/ghl/${user.ghl_webhook_secret}/${c.ghl_location_id}`
      : null;
    const lastCharge =
      charges.length > 0 ? charges[0].created_at : null;
    const failureCount = charges.filter(ch => ch.status === 'failed').length;
    const chargebackCount = charges.filter(
      ch => ch.status === 'chargeback'
    ).length;
    const notes = await db.getCustomerNotesByCustomer(req.params.id, req.user.id);
    const webhookEvents = (await db.getWebhookEventsByUser(req.user.id, 200)).filter(evt => evt.customer_id === req.params.id);
    const auditLogs = await db.getAuditLogsByCustomer(req.params.id, req.user.id, 100);
    const communications = await db.getCommunicationLogsByCustomer(req.params.id, req.user.id, 100);
    const adMetrics = await db.getAdMetricsByCustomer(req.params.id);
    const metaMappings = await db.getMetaCampaignMappingsByCustomer(req.params.id, req.user.id);
    res.json({
      customer: c,
      charges,
      notes,
      webhookEvents,
      auditLogs,
      communications,
      adMetrics,
      metaMappings,
      communicationTemplates: getCommunicationTemplates(user),
      totalCharged: c.total_charged || 0,
      totalTriggers: c.total_triggers || 0,
      creditBalance: parseFloat(c.credit_balance) || 0,
      lastChargeDate: lastCharge,
      failureCount,
      chargebackCount,
      ratePerTrigger: c.rate_per_trigger,
      cardOnFile: !!c.card_on_file,
      ghlLocationId: c.ghl_location_id,
      webhookUrl
    });
  } catch (err) {
    console.error('Error in payment-details endpoint:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/customers/:id/timeline', requireAuth, async (req, res) => {
  try {
    const customer = await db.getCustomerById(req.params.id);
    if (!customer || customer.user_id !== req.user.id)
      return res.status(404).json({ error: 'Not found' });
    const [charges, appointments, notes, webhookEvents, auditLogs, communications] = await Promise.all([
      db.all('SELECT * FROM charges WHERE customer_id = ? ORDER BY created_at DESC LIMIT 100', [customer.id]),
      db.all('SELECT * FROM appointments WHERE customer_id = ? ORDER BY created_at DESC LIMIT 100', [customer.id]),
      db.getCustomerNotesByCustomer(customer.id, req.user.id),
      db.getWebhookEventsByUser(req.user.id, 200),
      db.getAuditLogsByCustomer(customer.id, req.user.id, 100),
      db.getCommunicationLogsByCustomer(customer.id, req.user.id, 100)
    ]);
    const timeline = [
      ...charges.map(item => ({ type: 'charge', created_at: item.created_at, title: `${item.status} charge`, body: item.note || item.failure_reason || '', meta: item })),
      ...appointments.map(item => ({ type: 'appointment', created_at: item.created_at, title: `Appointment ${item.status}`, body: item.note || '', meta: item })),
      ...notes.map(item => ({ type: 'note', created_at: item.created_at, title: `${item.category} note`, body: item.body, meta: item })),
      ...webhookEvents.filter(item => item.customer_id === customer.id).map(item => ({ type: 'webhook', created_at: item.created_at, title: `${item.source} webhook ${item.status}`, body: item.event_type || '', meta: item })),
      ...auditLogs.map(item => ({ type: 'audit', created_at: item.created_at, title: item.action, body: item.details, meta: item })),
      ...communications.map(item => ({ type: 'communication', created_at: item.created_at, title: `${item.channel} ${item.status}`, body: item.subject || item.body, meta: item }))
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json(timeline);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/customers/:id/communications', requireAuth, async (req, res) => {
  try {
    const customer = await db.getCustomerById(req.params.id);
    if (!customer || customer.user_id !== req.user.id)
      return res.status(404).json({ error: 'Not found' });
    res.json(await db.getCommunicationLogsByCustomer(customer.id, req.user.id, 100));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/customers/:id/send-communication', requireAuth, async (req, res) => {
  try {
    const customer = await db.getCustomerById(req.params.id);
    if (!customer || customer.user_id !== req.user.id)
      return res.status(404).json({ error: 'Not found' });
    const user = await db.getUserById(req.user.id);
    const templates = getCommunicationTemplates(user);
    const templateKey = req.body.templateKey || 'billing_follow_up';
    const template = templates[templateKey] || DEFAULT_COMMUNICATION_TEMPLATES.billing_follow_up;
    const paymentLink = req.body.includePaymentLink === false ? '' : await buildCardSetupLink(user, customer).catch(() => '');
    const vars = {
      customer_name: customer.name,
      customer_email: customer.email,
      company_name: user.company_name || user.name || 'your team',
      payment_link: paymentLink,
      rate_per_trigger: parseFloat(customer.rate_per_trigger || 0).toFixed(2),
      status: customer.status
    };
    const channel = req.body.channel === 'sms' ? 'sms' : 'email';
    const subject = renderTemplate(req.body.subject || template.subject || '', vars).trim();
    const body = renderTemplate(req.body.body || template.body || '', vars).trim();
    if (!body) return res.status(400).json({ error: 'Message body required' });

    let status = channel === 'sms' ? 'prepared' : 'queued';
    let delivered = false;
    if (channel === 'email') {
      if (!customer.email) return res.status(400).json({ error: 'Customer email missing' });
      delivered = await sendDirectEmail(customer.email, subject || 'Message from PayPulse', body);
      status = delivered ? 'sent' : 'prepared';
    }

    const log = await db.createCommunicationLog({
      user_id: user.id,
      customer_id: customer.id,
      channel,
      template_key: templateKey,
      subject,
      body,
      status,
      metadata: JSON.stringify({
        to: channel === 'email' ? customer.email : customer.phone || '',
        payment_link: paymentLink
      })
    });
    await audit('customer.communication_logged', {
      actor: req.user,
      customer_id: customer.id,
      target_type: 'communication',
      target_id: log.id,
      details: { customer_id: customer.id, channel, template_key: templateKey, status }
    });
    res.json({
      ok: true,
      log,
      delivered,
      delivery: channel === 'email' ? (delivered ? 'email' : 'copy') : 'copy',
      paymentLink
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/customers/:id/credits', requireAuth, async (req, res) => {
  try {
    const customer = await db.getCustomerById(req.params.id);
    if (!customer || customer.user_id !== req.user.id)
      return res.status(404).json({ error: 'Not found' });
    const amount = parseFloat(req.body.amount || 0);
    if (amount <= 0) return res.status(400).json({ error: 'Amount must be greater than 0' });
    const user = await db.getUserById(req.user.id);
    const updatedCustomer = await db.updateCustomer(customer.id, {
      credit_balance: (parseFloat(customer.credit_balance) || 0) + amount
    });
    await db.createCharge({
      user_id: user.id,
      customer_id: customer.id,
      customer_name: customer.name,
      customer_email: customer.email,
      amount,
      processor: user.processor,
      status: 'credited',
      note: req.body.note || 'Manual credit issued'
    });
    await audit('customer.credit_issued', {
      actor: req.user,
      customer_id: customer.id,
      target_type: 'customer',
      target_id: customer.id,
      details: { customer_id: customer.id, amount, note: req.body.note || '' }
    });
    res.json(updatedCustomer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/customers/:id/notes', requireAuth, async (req, res) => {
  try {
    const customer = await db.getCustomerById(req.params.id);
    if (!customer || customer.user_id !== req.user.id)
      return res.status(404).json({ error: 'Not found' });
    res.json(await db.getCustomerNotesByCustomer(customer.id, req.user.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/customers/:id/notes', requireAuth, async (req, res) => {
  try {
    const customer = await db.getCustomerById(req.params.id);
    if (!customer || customer.user_id !== req.user.id)
      return res.status(404).json({ error: 'Not found' });
    if (!req.body.body) return res.status(400).json({ error: 'Note body required' });
    const note = await db.createCustomerNote({
      user_id: req.user.id,
      customer_id: customer.id,
      body: req.body.body,
      category: req.body.category || 'internal',
      recurring: !!req.body.recurring,
      next_due_at: req.body.nextDueAt || ''
    });
    await audit('customer.note_added', {
      actor: req.user,
      customer_id: customer.id,
      target_type: 'note',
      target_id: note.id,
      details: { customer_id: customer.id, recurring: !!req.body.recurring, next_due_at: req.body.nextDueAt || '' }
    });
    res.json(note);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/notes/:id', requireAuth, async (req, res) => {
  try {
    const note = await db.getCustomerNoteById(req.params.id);
    if (!note || note.user_id !== req.user.id)
      return res.status(404).json({ error: 'Not found' });
    const updates = pick(req.body, ['body', 'category', 'recurring', 'next_due_at', 'is_done']);
    if (updates.recurring !== undefined) updates.recurring = updates.recurring ? 1 : 0;
    if (updates.is_done !== undefined) updates.is_done = updates.is_done ? 1 : 0;
    const updated = await db.updateCustomerNote(note.id, updates);
    await audit('customer.note_updated', {
      actor: req.user,
      customer_id: note.customer_id,
      target_type: 'note',
      target_id: note.id,
      details: { customer_id: note.customer_id, changed: Object.keys(updates) }
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/notes/:id', requireAuth, async (req, res) => {
  try {
    const note = await db.getCustomerNoteById(req.params.id);
    if (!note || note.user_id !== req.user.id)
      return res.status(404).json({ error: 'Not found' });
    await db.deleteCustomerNote(note.id);
    await audit('customer.note_deleted', {
      actor: req.user,
      customer_id: note.customer_id,
      target_type: 'note',
      target_id: note.id,
      details: { customer_id: note.customer_id }
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/appointments', requireAuth, async (req, res) => {
  res.json(await db.getAppointmentsByUser(req.user.id));
});

app.patch('/api/appointments/:id', requireAuth, async (req, res) => {
  const a = await db.getAppointmentById(req.params.id);
  if (!a || a.user_id !== req.user.id)
    return res.status(404).json({ error: 'Not found' });
  const oldStatus = a.status;
  await db.updateAppointment(req.params.id, {
    status: req.body.status || a.status
  });
  const updated = await db.getAppointmentById(req.params.id);
  const user = await db.getUserById(req.user.id);

  // When status changes to 'no_show': issue credit
  if (oldStatus !== updated.status && updated.status === 'no_show') {
    const customer = await db.getCustomerById(updated.customer_id);
    if (customer) {
      const currentCredit = parseFloat(customer.credit_balance) || 0;
      const rate = parseFloat(customer.rate_per_trigger) || 147;
      await db.updateCustomer(customer.id, {
        credit_balance: currentCredit + rate
      });
      await db.createCharge({
        user_id: user.id,
        customer_id: customer.id,
        customer_name: customer.name,
        customer_email: customer.email,
        amount: rate,
        processor: user.processor,
        status: 'credited',
        note: 'No-show credit'
      });
      await db.addNotification({
        user_id: user.id,
        type: 'success',
        title: `Credit issued — ${customer.name}`,
        body: `$${rate.toFixed(2)} credited for no-show`
      });
      return res.json({
        ...updated,
        creditIssued: true,
        creditAmount: rate
      });
    }
  }

  // When status changes to 'showed': already charged on booking, nothing special
  if (
    user.appointment_tracking_mode &&
    oldStatus !== updated.status &&
    updated.status === 'showed'
  ) {
    const customer = await db.getCustomerById(updated.customer_id);
    if (customer) {
      // Already charged on booking — no additional charge
      return res.json({ ...updated, alreadyCharged: true });
    }
  }
  res.json(updated);
});

// ─── NOTIFICATIONS API ────────────────────────────────────────────
app.get('/api/notifications', requireAuth, async (req, res) => {
  res.json(await db.getNotificationsByUser(req.user.id));
});

app.post('/api/notifications/read', requireAuth, async (req, res) => {
  try {
    await db.markAllRead(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/notifications/unread-count', requireAuth, (req, res) => {
  Promise.resolve(db.getUnreadCount(req.user.id))
    .then(count => res.json({ count }))
    .catch(err => res.status(500).json({ error: err.message }));
});

// ─── SETTINGS API ─────────────────────────────────────────────────
app.get('/api/settings', requireAuth, async (req, res) => {
  const user = await db.getUserById(req.user.id);
  res.json({
    companyName: user.company_name,
    processor: user.processor,
    stripeSecretKey: user.stripe_secret_key
      ? '••••••••' + user.stripe_secret_key.slice(-4)
      : '',
    stripePublishableKey: user.stripe_publishable_key,
    whopApiKey: user.whop_api_key
      ? '••••••••' + user.whop_api_key.slice(-4)
      : '',
    whopCompanyId: user.whop_company_id,
    appointmentTrackingMode: !!user.appointment_tracking_mode,
    ghlWebhookUrl: `${BASE_URL}/webhook/ghl/${user.ghl_webhook_secret}`,
    ghlWebhookSecret: user.ghl_webhook_secret,
    whopWebhookUrl: `${BASE_URL}/webhook/whop/${user.whop_webhook_secret}`,
    failedChargeWebhookUrl: user.failed_charge_webhook_url || '',
    metaConnected: !!user.meta_access_token,
    metaAdAccountId: user.meta_ad_account_id || '',
    metaAdAccountName: user.meta_ad_account_name || '',
    metaConfigured: metaConfigured(),
    metaRedirectUri: META_REDIRECT_URI || `${BASE_URL}/api/meta/callback`,
    plan: user.plan,
    monthlyRate: user.monthly_rate
  });
});

app.post('/api/settings', requireAuth, async (req, res) => {
  const updates = {};
  if (req.body.companyName !== undefined)
    updates.company_name = req.body.companyName;
  if (req.body.processor !== undefined)
    updates.processor = req.body.processor;
  if (
    req.body.stripeSecretKey &&
    !String(req.body.stripeSecretKey).startsWith('•')
  )
    updates.stripe_secret_key = req.body.stripeSecretKey;
  if (req.body.stripePublishableKey !== undefined)
    updates.stripe_publishable_key = req.body.stripePublishableKey;
  if (
    req.body.whopApiKey &&
    !String(req.body.whopApiKey).startsWith('•')
  )
    updates.whop_api_key = req.body.whopApiKey;
  if (req.body.whopCompanyId !== undefined)
    updates.whop_company_id = req.body.whopCompanyId;
  if (req.body.appointmentTrackingMode !== undefined)
    updates.appointment_tracking_mode =
      req.body.appointmentTrackingMode ? 1 : 0;
  if (req.body.failedChargeWebhookUrl !== undefined)
    updates.failed_charge_webhook_url = req.body.failedChargeWebhookUrl;
  if (req.body.metaAdAccountId !== undefined)
    updates.meta_ad_account_id = req.body.metaAdAccountId;
  if (req.body.metaAdAccountName !== undefined)
    updates.meta_ad_account_name = req.body.metaAdAccountName;
  await audit('settings.updated', {
    actor: req.user,
    target_type: 'user',
    target_id: req.user.id,
    details: { changed: Object.keys(updates) }
  });
  res.json(await db.updateUser(req.user.id, updates));
});

app.post('/api/settings/note-templates', requireAuth, async (req, res) => {
  res.json({ templates: [] });
});

app.get('/api/meta/status', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    res.json({
      configured: metaConfigured(),
      connected: !!user?.meta_access_token,
      adAccountId: user?.meta_ad_account_id || '',
      adAccountName: user?.meta_ad_account_name || '',
      tokenExpiresAt: user?.meta_token_expires_at || ''
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/meta/connect-url', requireAuth, async (req, res) => {
  try {
    if (!metaConfigured()) return res.status(400).json({ error: 'Meta app is not configured on the server' });
    const state = encodeMetaState({ userId: req.user.id, ts: Date.now() });
    const url = new URL(`https://www.facebook.com/${META_API_VERSION}/dialog/oauth`);
    url.searchParams.set('client_id', META_APP_ID);
    url.searchParams.set('redirect_uri', META_REDIRECT_URI);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', 'ads_read,business_management');
    res.json({ url: url.toString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/meta/callback', async (req, res) => {
  try {
    if (!metaConfigured()) throw new Error('Meta app is not configured on the server');
    if (req.query.error) throw new Error(String(req.query.error_description || req.query.error));
    const state = decodeMetaState(req.query.state);
    if (!state?.userId) throw new Error('Invalid Meta OAuth state');
    const code = String(req.query.code || '');
    if (!code) throw new Error('Missing Meta OAuth code');

    const tokenData = await metaFetch('/oauth/access_token', {
      client_id: META_APP_ID,
      client_secret: META_APP_SECRET,
      redirect_uri: META_REDIRECT_URI,
      code
    });

    let accessToken = tokenData.access_token;
    let expiresIn = tokenData.expires_in || 0;
    try {
      const longLived = await metaFetch('/oauth/access_token', {
        grant_type: 'fb_exchange_token',
        client_id: META_APP_ID,
        client_secret: META_APP_SECRET,
        fb_exchange_token: accessToken
      });
      accessToken = longLived.access_token || accessToken;
      expiresIn = longLived.expires_in || expiresIn;
    } catch {}

    await db.updateUser(state.userId, {
      meta_access_token: accessToken,
      meta_token_expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : ''
    });

    res.send(`<!doctype html><html><body style="font-family:system-ui;padding:24px;background:#071410;color:#e8fff6"><h2>Meta connected</h2><p>You can close this window and return to PayPulse.</p><script>window.opener&&window.opener.postMessage({type:'paypulse-meta-connected'},'*');setTimeout(()=>window.close(),700);</script></body></html>`);
  } catch (err) {
    res.status(500).send(`<!doctype html><html><body style="font-family:system-ui;padding:24px;background:#190909;color:#fff0f0"><h2>Meta connection failed</h2><p>${String(err.message || err)}</p></body></html>`);
  }
});

app.get('/api/meta/ad-accounts', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    if (!user?.meta_access_token) return res.status(400).json({ error: 'Connect Meta first' });
    const data = await metaFetch('/me/adaccounts', {
      fields: 'id,name,account_id,currency,account_status'
    }, user.meta_access_token);
    res.json(data.data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/meta/select-ad-account', requireAuth, async (req, res) => {
  try {
    const accountId = String(req.body.adAccountId || '');
    const accountName = String(req.body.adAccountName || '');
    if (!accountId) return res.status(400).json({ error: 'Ad account required' });
    await db.updateUser(req.user.id, {
      meta_ad_account_id: accountId,
      meta_ad_account_name: accountName
    });
    await audit('meta.ad_account_selected', {
      actor: req.user,
      target_type: 'meta_account',
      target_id: accountId,
      details: { account_name: accountName }
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/meta/campaigns', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    if (!user?.meta_access_token) return res.status(400).json({ error: 'Connect Meta first' });
    const adAccountId = String(req.query.adAccountId || user.meta_ad_account_id || '');
    if (!adAccountId) return res.status(400).json({ error: 'Select an ad account first' });
    const normalized = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
    const data = await metaFetch(`/${normalized}/campaigns`, {
      fields: 'id,name,status,effective_status',
      limit: 200
    }, user.meta_access_token);
    res.json(data.data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/meta/adsets', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    if (!user?.meta_access_token) return res.status(400).json({ error: 'Connect Meta first' });
    const campaignId = String(req.query.campaignId || '');
    if (!campaignId) return res.status(400).json({ error: 'Campaign required' });
    const data = await metaFetch(`/${campaignId}/adsets`, {
      fields: 'id,name,effective_status,status',
      limit: 200
    }, user.meta_access_token);
    res.json(data.data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/customers/:customerId/meta-mappings', requireAuth, async (req, res) => {
  try {
    const customer = await db.getCustomerById(req.params.customerId);
    if (!customer || customer.user_id !== req.user.id) return res.status(404).json({ error: 'Customer not found' });
    res.json(await db.getMetaCampaignMappingsByCustomer(customer.id, req.user.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/customers/:customerId/meta-mappings', requireAuth, async (req, res) => {
  try {
    const customer = await db.getCustomerById(req.params.customerId);
    if (!customer || customer.user_id !== req.user.id) return res.status(404).json({ error: 'Customer not found' });
    const mappings = Array.isArray(req.body.mappings) ? req.body.mappings : [];
    const cleaned = mappings
      .filter(item => item && item.ad_account_id && item.campaign_id)
      .map(item => ({
        ad_account_id: String(item.ad_account_id),
        ad_account_name: String(item.ad_account_name || ''),
        campaign_id: String(item.campaign_id),
        campaign_name: String(item.campaign_name || ''),
        adset_id: String(item.adset_id || ''),
        adset_name: String(item.adset_name || '')
      }));
    const saved = await db.replaceMetaCampaignMappings(customer.id, req.user.id, cleaned);
    await audit('meta.mappings_updated', {
      actor: req.user,
      customer_id: customer.id,
      target_type: 'customer',
      target_id: customer.id,
      details: { mapping_count: saved.length }
    });
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/customers/:customerId/meta-sync', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    const result = await syncMetaMetricsForCustomer(user, req.params.customerId, req.body || {});
    res.json({ ok: true, count: result.count, customerId: req.params.customerId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/meta/sync-all', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    const customers = await db.getCustomersByUser(req.user.id);
    const results = [];
    for (const customer of customers) {
      const mappings = await db.getMetaCampaignMappingsByCustomer(customer.id, req.user.id);
      if (!mappings.length) continue;
      const synced = await syncMetaMetricsForCustomer(user, customer.id, req.body || {});
      results.push({ customerId: customer.id, customerName: customer.name, count: synced.count });
    }
    res.json({ ok: true, synced: results, totalCustomers: results.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/alerts', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    res.json(await buildAlerts(user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/audit-logs', requireAuth, async (req, res) => {
  try {
    res.json(await db.getAuditLogsByUser(req.user.id, 200));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/webhook-events', requireAuth, async (req, res) => {
  try {
    res.json(await db.getWebhookEventsByUser(req.user.id, 200));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/communications', requireAuth, async (req, res) => {
  try {
    res.json(await db.getCommunicationLogsByUser(req.user.id, 200));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/forecast', requireAuth, async (req, res) => {
  try {
    const [charges, customers] = await Promise.all([
      db.getChargesByUser(req.user.id),
      db.getCustomersByUser(req.user.id)
    ]);
    const now = Date.now();
    const trailing30 = charges.filter(ch => ch.status === 'succeeded' && new Date(ch.created_at).getTime() >= now - 30 * 86400000);
    const trailing14Failures = charges.filter(ch => ch.status === 'failed' && new Date(ch.created_at).getTime() >= now - 14 * 86400000);
    const scheduledRetries = charges.filter(ch => ch.retry_status === 'scheduled');
    const trailingRevenue = trailing30.reduce((sum, ch) => sum + (parseFloat(ch.amount) || 0), 0);
    const activeCustomers = customers.filter(c => c.status === 'active');
    const atRiskCustomers = customers.filter(c => c.status === 'at_risk');
    const noCardCustomers = customers.filter(c => !c.card_on_file && c.status !== 'paused');
    const avgDailyRevenue = trailingRevenue / 30;
    const recentTriggerDays = new Set(trailing30.map(ch => String(ch.created_at).slice(0, 10))).size || 1;
    const avgRevenuePerActiveCustomer = activeCustomers.length
      ? trailingRevenue / activeCustomers.length
      : 0;
    const scheduledRetryRevenue = scheduledRetries.reduce((sum, ch) => sum + (parseFloat(ch.amount) || 0), 0);
    const atRiskExposure = atRiskCustomers.reduce((sum, customer) => sum + (parseFloat(customer.rate_per_trigger) || 0), 0);
    const noCardExposure = noCardCustomers.reduce((sum, customer) => sum + (parseFloat(customer.rate_per_trigger) || 0), 0);
    const recoveryRate = trailing14Failures.length
      ? Math.min(0.65, scheduledRetries.length / trailing14Failures.length || 0.25)
      : 0.25;
    const projectedRecoveryRevenue = scheduledRetryRevenue * recoveryRate;
    const projectedNext30Revenue = trailingRevenue + projectedRecoveryRevenue;

    res.json({
      trailing30Revenue,
      avgDailyRevenue,
      projectedNext30Revenue,
      projectedRecoveryRevenue,
      scheduledRetryRevenue,
      atRiskExposure,
      noCardExposure,
      avgRevenuePerActiveCustomer,
      activeCustomers: activeCustomers.length,
      atRiskCustomers: atRiskCustomers.length,
      noCardCustomers: noCardCustomers.length,
      recentTriggerDays,
      recoveryRate
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/margin-dashboard', requireAuth, async (req, res) => {
  try {
    const [customers, charges, adMetrics] = await Promise.all([
      db.getCustomersByUser(req.user.id),
      db.getChargesByUser(req.user.id),
      db.getAdMetricsByUser(req.user.id)
    ]);

    const byCustomer = customers.map(customer => {
      const customerCharges = charges.filter(ch => ch.customer_id === customer.id && ch.status === 'succeeded');
      const customerMetrics = adMetrics.filter(metric => metric.customer_id === customer.id);
      const spend = customerMetrics.reduce((sum, metric) => sum + (parseFloat(metric.ad_spend) || 0), 0);
      const clicks = customerMetrics.reduce((sum, metric) => sum + (parseInt(metric.clicks || 0, 10) || 0), 0);
      const impressions = customerMetrics.reduce((sum, metric) => sum + (parseInt(metric.impressions || 0, 10) || 0), 0);
      const leads = customerMetrics.reduce((sum, metric) => sum + (parseInt(metric.leads || 0, 10) || 0), 0);
      const revenue = customerCharges.reduce((sum, ch) => sum + (parseFloat(ch.amount) || 0), 0);
      const booked = parseInt(customer.total_triggers || 0, 10) || 0;
      const margin = revenue - spend;
      return {
        customerId: customer.id,
        customerName: customer.name,
        status: customer.status,
        spend,
        revenue,
        margin,
        clicks,
        impressions,
        leads,
        booked,
        ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
        cpl: leads > 0 ? spend / leads : 0,
        costPerBooked: booked > 0 ? spend / booked : 0,
        revenuePerBooked: booked > 0 ? revenue / booked : 0
      };
    }).sort((a, b) => b.margin - a.margin);

    res.json({
      totals: {
        spend: byCustomer.reduce((sum, row) => sum + row.spend, 0),
        revenue: byCustomer.reduce((sum, row) => sum + row.revenue, 0),
        margin: byCustomer.reduce((sum, row) => sum + row.margin, 0),
        booked: byCustomer.reduce((sum, row) => sum + row.booked, 0),
        leads: byCustomer.reduce((sum, row) => sum + row.leads, 0)
      },
      customers: byCustomer
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/segments', requireAuth, async (req, res) => {
  try {
    const segments = await db.getSavedSegmentsByUser(req.user.id);
    res.json(segments.map(seg => ({
      ...seg,
      filters: safeJsonParse(seg.filters_json, {})
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/segments', requireAuth, async (req, res) => {
  try {
    if (!req.body.name) return res.status(400).json({ error: 'Name required' });
    const segment = await db.createSavedSegment({
      user_id: req.user.id,
      name: req.body.name,
      filters_json: JSON.stringify(req.body.filters || {})
    });
    await audit('segment.saved', {
      actor: req.user,
      target_type: 'segment',
      target_id: segment.id,
      details: { name: req.body.name }
    });
    res.json({
      ...segment,
      filters: safeJsonParse(segment.filters_json, {})
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/segments/:id', requireAuth, async (req, res) => {
  try {
    const segment = await db.getSavedSegmentById(req.params.id);
    if (!segment || segment.user_id !== req.user.id)
      return res.status(404).json({ error: 'Not found' });
    await db.deleteSavedSegment(segment.id);
    await audit('segment.deleted', {
      actor: req.user,
      target_type: 'segment',
      target_id: segment.id,
      details: { name: segment.name }
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/export/:type', requireAuth, async (req, res) => {
  try {
    let rows = [];
    if (req.params.type === 'customers') {
      rows = await db.getCustomersByUser(req.user.id);
    } else if (req.params.type === 'charges') {
      rows = await db.getChargesByUser(req.user.id);
    } else if (req.params.type === 'failures') {
      rows = (await db.getChargesByUser(req.user.id)).filter(charge => charge.status === 'failed');
    } else if (req.params.type === 'metrics') {
      rows = await db.getAdMetricsByUser(req.user.id);
    } else {
      return res.status(404).json({ error: 'Unknown export type' });
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.type}.csv"`);
    res.send(toCsv(rows));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── STATS API ────────────────────────────────────────────────────
app.get('/api/stats', requireAuth, async (req, res) => {
  res.json(await db.getStats(req.user.id));
});

// ─── METRICS DATA ─────────────────────────────────────────────────
app.get('/api/metrics', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const charges = await db.getChargesByUser(userId);
  const customers = await db.getCustomersByUser(userId);

  const revenueByDay = {};
  const triggersByDay = {};
  const failuresByDay = {};
  const now = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const key = `${d.getUTCFullYear()}-${String(
      d.getUTCMonth() + 1
    ).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    revenueByDay[key] = 0;
    triggersByDay[key] = 0;
    failuresByDay[key] = 0;
  }

  charges.forEach(c => {
    let dateKey;
    const raw = c.created_at;
    if (!raw) return;
    if (typeof raw === 'string') {
      dateKey = raw.split(' ')[0]; // 'YYYY-MM-DD HH:MM:SS' → 'YYYY-MM-DD'
    } else {
      // JS Date object from PG — format to YYYY-MM-DD
      const d = new Date(raw);
      dateKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    }
    if (revenueByDay[dateKey] !== undefined) {
      if (c.status === 'succeeded') revenueByDay[dateKey] += c.amount;
      if (c.status === 'failed') failuresByDay[dateKey] += 1;
      if (
        c.status === 'succeeded' ||
        c.status === 'failed'
      )
        triggersByDay[dateKey] += 1;
  }
});

  const topCustomers = customers
    .map(c => ({
      name: c.name,
      totalCharged: c.total_charged,
      totalTriggers: c.total_triggers
    }))
    .sort((a, b) => b.totalCharged - a.totalCharged)
    .slice(0, 5);

  const totalCharged = charges.filter(c => c.status === 'succeeded').length;
  const totalFailed = charges.filter(c => c.status === 'failed').length;
  const totalChargebacks = charges.filter(
    c => c.status === 'chargeback'
  ).length;
  const failureRate =
    charges.length > 0
      ? ((totalFailed / charges.length) * 100).toFixed(1)
      : 0;

  res.json({
    revenueByDay,
    triggersByDay,
    failuresByDay,
    topCustomers,
    failureRate,
    totalCharged,
    totalFailed,
    totalChargebacks,
    totalRevenue: Object.values(revenueByDay).reduce((s, v) => s + v, 0),
    totalCustomers: customers.length
  });
});

// ─── ADMIN API ────────────────────────────────────────────────────
app.get('/api/admin/stats', requireAuth, requireAdmin, async (req, res) => {
  res.json(await db.getAdminStats());
});

// ─── SEED DEMO DATA (admin only, seeds into selected agency) ────
app.post('/api/admin/seed-demo/:agencyId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.agencyId;

    // Delete ALL existing customers for clean seed
    const existing = await db.getCustomersByUser(userId);
    for (const c of existing) {
      await db.run('DELETE FROM charges WHERE customer_id = ?', [c.id]);
      await db.run('DELETE FROM customers WHERE id = ?', [c.id]);
    }

    const clients = [
      { name: 'Pro Painters', company: 'Pro Painters Toronto', email: 'pro@painting.com', rate: 147, status: 'active', triggers: 7, succeeded: 7 },
      { name: 'Fresh Coat Painting', company: 'Fresh Coat Painting Inc.', email: 'info@freshcoat.com', rate: 147, status: 'active', triggers: 6, succeeded: 6 },
      { name: 'Deck Masters', company: 'Deck Masters Ottawa', email: 'info@deckmasters.com', rate: 197, status: 'active', triggers: 5, succeeded: 5 },
      { name: 'Fence Experts', company: 'Fence Experts GTA', email: 'dispatch@fenceexperts.com', rate: 197, status: 'new', triggers: 0, succeeded: 0 },
      { name: 'Precision Decks', company: 'Precision Deck & Fence', email: 'office@precisiondecks.com', rate: 197, status: 'at_risk', triggers: 3, succeeded: 2 },
    ];

    const created = [];
    for (const c of clients) {
      const customer = await db.createCustomer({
        user_id: userId,
        name: c.name,
        company_name: c.company,
        email: c.email,
        rate_per_trigger: c.rate,
        status: c.status,
        card_on_file: c.status === 'active' || c.status === 'at_risk' ? 1 : 0,
        stripe_customer_id: 'cus_demo_' + c.name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 10),
        stripe_payment_method_id: c.status === 'active' || c.status === 'at_risk' ? 'pm_demo_' + c.name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 8) : '',
      });
      created.push(customer);

      // Create historical charges spread across days since June 26
      // Slow day on July 1 — no appointments
      const today = new Date();
      const year = today.getFullYear();
      const activeDays = [`${year}-06-26`, `${year}-06-27`, `${year}-06-28`, `${year}-06-29`, `${year}-06-30`, `${year}-07-02`, `${year}-07-03`];
      const numCharges = Math.min(c.triggers, activeDays.length);
      let successCount = 0;
      let totalAmount = 0;
      for (let i = 0; i < numCharges; i++) {
        const dateStr = activeDays[i];
        const chargeDate = dateStr + ' 10:30:00';
        const succeeded = i < numCharges - 1 || c.status !== 'at_risk';
        const chargeId = uuidv4();
        const note = 'Appointment booked — ' + c.company;
        await db.run(
          'INSERT INTO charges (id, user_id, customer_id, customer_name, customer_email, amount, processor, status, stripe_charge_id, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          [chargeId, userId, customer.id, c.name, c.email, c.rate, 'stripe', succeeded ? 'succeeded' : 'failed', 'ch_' + chargeId.slice(0, 10), note, chargeDate]
        );
        if (succeeded) { successCount++; totalAmount += c.rate; }
      }
      // Update customer totals
      await db.updateCustomer(customer.id, {
        total_charged: totalAmount,
        total_triggers: successCount,
      });

      // Add a notification
      await db.addNotification({
        user_id: userId,
        type: 'new',
        title: `Demo client added — ${c.name}`,
        body: `${c.company} — $${c.rate}/trigger, ${successCount} historical charges`
      });
    }

    // Seed ad_metrics for charts (last 30 days of daily data)
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      try {
        await db.run(
          'INSERT INTO ad_metrics (id, user_id, customer_id, source, ad_spend, impressions, clicks, leads, appointments, date_from, date_to, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          [uuidv4(), userId, created[0]?.id || '', 'facebook', Math.round(Math.random()*150+50), Math.round(Math.random()*5000+500), Math.round(Math.random()*80+10), Math.round(Math.random()*8+2), Math.round(Math.random()*4+1), dateStr, dateStr, new Date().toISOString()]
        );
      } catch (e) { /* ignore dupes */ }
    }

    res.json({ created: created.length, message: `${created.length} demo clients with charges + 30-day ad metrics seeded` });
  } catch (err) {
    console.error('Seed error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/agencies', requireAuth, requireAdmin, async (req, res) => {
  const agencies = await db.listUsers('agency');
  const result = [];
  for (const u of agencies) {
    const custs = await db.getCustomersByUser(u.id);
    const stats = await db.getStats(u.id);
    result.push({
      id: u.id,
      name: u.name,
      email: u.email,
      companyName: u.company_name,
      plan: u.plan,
      monthlyRate: u.monthly_rate,
      active: !!u.active,
      processor: u.processor,
      stripeCustomerId: u.stripe_customer_id,
      stripeSubscriptionId: u.stripe_subscription_id,
      totalCustomers: custs.length,
      totalCharged: stats.totalCharged
    });
  }
  res.json(result);
});

app.patch('/api/admin/agencies/:id', requireAuth, requireAdmin, async (req, res) => {
  const updates = {};
  if (req.body.plan !== undefined) updates.plan = req.body.plan;
  if (req.body.monthlyRate !== undefined)
    updates.monthly_rate = req.body.monthlyRate;
  if (req.body.active !== undefined)
    updates.active = req.body.active ? 1 : 0;
  if (req.body.processor !== undefined)
    updates.processor = req.body.processor;
  const updated = await db.updateUser(req.params.id, updates);
  await audit('agency.updated', {
    actor: req.user,
    target_type: 'agency',
    target_id: req.params.id,
    details: { changed: Object.keys(updates) }
  });
  res.json(updated);
});

app.delete('/api/admin/agencies/:id', requireAuth, requireAdmin, async (req, res) => {
  await db.run('DELETE FROM users WHERE id = ? AND role = ?', [req.params.id, 'agency']);
  await audit('agency.deleted', {
    actor: req.user,
    target_type: 'agency',
    target_id: req.params.id,
    details: {}
  });
  res.json({ ok: true });
});

// ─── ADMIN: PENDING APPROVALS ───────────────────────────────────
app.get('/api/admin/pending', requireAuth, requireAdmin, async (req, res) => {
  const pending = await db.all('SELECT id, name, email, company_name, created_at FROM users WHERE role = ? AND approved = ? ORDER BY created_at DESC', ['agency', 0]);
  res.json(pending);
});

app.post('/api/admin/approve/:id', requireAuth, requireAdmin, async (req, res) => {
  const approvedUser = await db.updateUser(req.params.id, { approved: 1 });
  await audit('agency.approved', {
    actor: req.user,
    target_type: 'agency',
    target_id: req.params.id,
    details: { approved_email: approvedUser?.email || '' }
  });
  await sendEmailAlert(
    { ...approvedUser, email_notifications_enabled: 1, alert_email: approvedUser?.email },
    'Your PayPulse account has been approved',
    'Your PayPulse agency account is now approved. You can sign in and start using the dashboard.'
  );
  res.json({ ok: true });
});

app.post('/api/admin/reject/:id', requireAuth, requireAdmin, async (req, res) => {
  await db.run('DELETE FROM users WHERE id = ? AND role = ?', [req.params.id, 'agency']);
  await audit('agency.rejected', {
    actor: req.user,
    target_type: 'agency',
    target_id: req.params.id,
    details: {}
  });
  res.json({ ok: true });
});

// ─── AD METRICS (Facebook) ───────────────────────────────────────
app.post('/api/customers/:customerId/ad-metrics', requireAuth, async (req, res) => {
  try {
    const { customerId } = req.params;
    const customer = await db.getCustomerById(customerId);
    if (!customer || customer.user_id !== req.user.id)
      return res.status(404).json({ error: 'Customer not found' });
    const {
      source,
      campaign_name,
      date_from,
      date_to,
      ad_spend,
      impressions,
      clicks,
      leads,
      appointments
    } = req.body;
    const id = await db.createAdMetric({
      user_id: req.user.id,
      customer_id: customerId,
      source: source || 'facebook',
      campaign_name: campaign_name || '',
      date_from,
      date_to,
      ad_spend: ad_spend || 0,
      impressions: impressions || 0,
      clicks: clicks || 0,
      leads: leads || 0,
      appointments: appointments || 0
    });
    res.json({
      id,
      cpl: leads > 0 ? (ad_spend / leads).toFixed(2) : null,
      cpa: appointments > 0 ? (ad_spend / appointments).toFixed(2) : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/customers/:customerId/ad-metrics', requireAuth, async (req, res) => {
  try {
    const { customerId } = req.params;
    const customer = await db.getCustomerById(customerId);
    if (!customer || customer.user_id !== req.user.id)
      return res.status(404).json({ error: 'Customer not found' });
    const metrics = await db.getAdMetricsByCustomer(customerId);
    res.json(metrics);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/ad-metrics/:id', requireAuth, async (req, res) => {
  try {
    const metric = await db.getAdMetricById(req.params.id);
    if (!metric || metric.user_id !== req.user.id)
      return res.status(404).json({ error: 'Not found' });
    await db.deleteAdMetric(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ADMIN: SUB ADMIN MANAGEMENT ───────────────────────────────
app.get('/api/admin/subadmins', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Full admin only' });
    const users = await db.all("SELECT * FROM users WHERE role = 'subadmin' ORDER BY created_at DESC");
    res.json(users.map(u => ({ id: u.id, name: u.name, email: u.email, agencyCount: 0 })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/subadmins', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Full admin only' });
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password required' });
    const existing = await db.getUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });
    const hash = await bcrypt.hash(password, 10);
    const user = await db.createUser({ email, password_hash: hash, name, role: 'subadmin', company_name: '', plan: 'admin' });
    res.json({ id: user.id, name: user.name, email: user.email, role: 'subadmin' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/subadmins/:id', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Full admin only' });
    await db.run("DELETE FROM users WHERE id = ? AND role = 'subadmin'", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ADMIN: CREATE AGENCY ───────────────────────────────────────
app.post('/api/admin/agencies', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { email, password, name, companyName, plan, monthlyRate, processor } =
      req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required' });
    const existing = await db.getUserByEmail(email);
    if (existing)
      return res.status(409).json({ error: 'Email already registered' });
    const hash = await bcrypt.hash(password, 10);
    const user = await db.createUser({
      email: email.toLowerCase().trim(),
      password_hash: hash,
      name,
      company_name: companyName || '',
      role: 'agency',
      plan: plan || 'free',
      monthly_rate: monthlyRate ?? 0,
      processor: processor || 'stripe',
      approved: 1
    });
    await audit('agency.created', {
      actor: req.user,
      target_type: 'agency',
      target_id: user.id,
      details: { email: user.email, plan: user.plan, monthly_rate: user.monthly_rate, processor: user.processor }
    });
    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      companyName: user.company_name,
      plan: user.plan,
      monthlyRate: user.monthly_rate,
      processor: user.processor,
      stripeCustomerId: null,
      subscriptionUrl: null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── LOGOUT ───────────────────────────────────────────────────────
app.post('/api/auth/logout', (req, res) => {
  res.json({ ok: true });
});

// ─── ADMIN: AGENCY SUBSCRIPTION STATUS ──────────────────────────
app.get('/api/admin/agencies/:id/subscription', requireAuth, requireAdmin, async (req, res) => {
  const user = await db.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({
    plan: user.plan,
    monthlyRate: user.monthly_rate,
    active: !!user.active,
    stripeCustomerId: user.stripe_customer_id,
    stripeSubscriptionId: user.stripe_subscription_id
  });
});



// ─── SERVE ────────────────────────────────────────────────────────
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);
app.get('/guide', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'guide.html'))
);

// ─── GLOBAL ERROR HANDLER ────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── 404 CATCH-ALL ──────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'Not found' });
  } else {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

app.listen(PORT, () => {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@paypulse.co';
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  const jwtSecretSet = process.env.JWT_SECRET ? true : false;
  console.log(`\n╔═══════════════════════════════════════════════════════╗`);
  console.log(`║  ⚡ PAYPULSE running at http://localhost:${PORT}           ║`);
  console.log(`╠════════════════════════════════════════════════════════╣`);
  console.log(`║  Admin:       ${adminEmail} / ${adminPass}${jwtSecretSet ? '' : ' ⚠️  DEFAULT JWT SECRET'}   ║`);
  console.log(`╚═══════════════════════════════════════════════════════╝\n`);
});
