require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const db = require('./db');
const { v4: uuidv4 } = require('uuid');

const JWT_SECRET = process.env.JWT_SECRET || 'paypulse-dev-secret-change-in-prod';
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;



const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── INIT DB ─────────────────────────────────────────────────────
db.initSchema().then(() => db.ensureAdmin()).catch(console.error);

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { return res.status(403).json({ error: 'Invalid token' }); }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// ─── AUTH ──────────────────────────────────────────────────────────
// Registration is admin-only. Public signup is disabled.
// Use POST /api/admin/agencies to create accounts (admin auth required).

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword, email } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password required' });
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = db.getUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, companyName: user.company_name, processor: user.processor },
      subscription: user.role === 'agency' ? {
        active: !!user.active,
        plan: user.plan,
        stripeSubscriptionId: user.stripe_subscription_id,
        hasStripe: !!user.stripe_subscription_id
      } : null
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  try {
    const user = db.getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json({
      id: user.id, name: user.name, email: user.email, role: user.role,
      companyName: user.company_name, processor: user.processor, plan: user.plan,
      active: user.active, appointmentTrackingMode: !!user.appointment_tracking_mode,
      subscription: user.role === 'agency' ? {
        active: !!user.active,
        plan: user.plan,
        stripeSubscriptionId: user.stripe_subscription_id,
        hasStripe: !!user.stripe_subscription_id
      } : null
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// POST /webhook/ghl/:secret — legacy agency-level webhook (matches by email)
app.post('/webhook/ghl/:secret', async (req, res) => {
  const user = db.getUserByGhlSecret(req.params.secret);
  if (!user) return res.status(403).json({ error: 'Invalid secret' });

  const payload = req.body;
  // Try location-based routing first (GHL sends location_id in payload)
  const ghlLocationId = payload.location_id || payload.locationId || '';
  let customer = null;

  if (ghlLocationId) {
    customer = db.getCustomerByLocationId(ghlLocationId, user.id);
  }

  // Fallback to email match
  if (!customer) {
    customer = db.getCustomerByEmailAndUser(payload.email, user.id);
  }

  if (!customer) {
    customer = db.createCustomer({
      user_id: user.id, name: payload.full_name || payload.name || payload.email.split('@')[0], email: payload.email,
      phone: payload.phone || '', whop_member_id: payload.whop_member_id || '', whop_payment_method_id: payload.whop_payment_method_id || '',
      stripe_customer_id: payload.stripe_customer_id || '', stripe_payment_method_id: payload.stripe_payment_method_id || '',
      rate_per_trigger: payload.rate_per_trigger || user.monthly_rate || 147, status: 'new',
      card_on_file: !!(payload.whop_payment_method_id || payload.stripe_payment_method_id),
      ghl_location_id: ghlLocationId
    });
    db.addNotification({ user_id: user.id, type: 'new', title: `New customer — ${customer.name}`, body: `${customer.email} added. Location: ${ghlLocationId || 'unknown'}` });
  }

  // Update card status if payment method provided
  if (payload.whop_payment_method_id || payload.stripe_payment_method_id) {
    db.updateCustomer(customer.id, { card_on_file: 1, whop_payment_method_id: payload.whop_payment_method_id || '', stripe_payment_method_id: payload.stripe_payment_method_id || '' });
    customer = db.getCustomerById(customer.id);
  }

  db.addNotification({ user_id: user.id, type: 'trigger', title: `Trigger fired — ${customer.name}`, body: `$${customer.rate_per_trigger} ready via GHL trigger. Location: ${ghlLocationId || 'N/A'}` });

  if (user.appointment_tracking_mode) {
    const appt = db.createAppointment({ user_id: user.id, customer_id: customer.id, status: 'pending', date: payload.appointment_date || '', time: payload.appointment_time || '', note: payload.note || '' });
    return res.json({ success: true, mode: 'appointment_tracking', appointmentId: appt.id, customerId: customer.id, locationId: ghlLocationId });
  }

  const charge = await processCharge(user, customer, payload.note || 'GHL Trigger');
  res.json({ success: true, chargeId: charge.id, status: charge.status, customerId: customer.id, locationId: ghlLocationId });
});

// POST /webhook/ghl/:secret/:locationId — per-client webhook (routes by GHL Location ID)
app.post('/webhook/ghl/:secret/:locationId', async (req, res) => {
  const user = db.getUserByGhlSecret(req.params.secret);
  if (!user) return res.status(403).json({ error: 'Invalid secret' });

  const locationId = req.params.locationId;
  const payload = req.body;

  // Route directly to the client by location ID
  let customer = db.getCustomerByLocationId(locationId, user.id);

  if (!customer) {
    // Auto-create customer with this location ID
    customer = db.createCustomer({
      user_id: user.id, name: payload.full_name || payload.name || `GHL Location ${locationId.slice(0,8)}`,
      email: payload.email || `location-${locationId.slice(0,8)}@ghl.auto`,
      phone: payload.phone || '', whop_member_id: payload.whop_member_id || '', whop_payment_method_id: payload.whop_payment_method_id || '',
      stripe_customer_id: payload.stripe_customer_id || '', stripe_payment_method_id: payload.stripe_payment_method_id || '',
      rate_per_trigger: payload.rate_per_trigger || user.monthly_rate || 147, status: 'new',
      card_on_file: !!(payload.whop_payment_method_id || payload.stripe_payment_method_id),
      ghl_location_id: locationId
    });
    db.addNotification({ user_id: user.id, type: 'new', title: `New client auto-created — ${customer.name}`, body: `GHL Location ${locationId} mapped. Set rate and payment method.` });
  }

  // Update customer details from payload if provided
  if (payload.email && payload.email !== customer.email && !customer.email.includes('@ghl.auto')) {
    db.updateCustomer(customer.id, { email: payload.email });
  }
  if (payload.full_name && payload.full_name !== customer.name && customer.name.startsWith('GHL Location')) {
    db.updateCustomer(customer.id, { name: payload.full_name });
  }
  if (payload.whop_payment_method_id || payload.stripe_payment_method_id) {
    db.updateCustomer(customer.id, { card_on_file: 1, whop_payment_method_id: payload.whop_payment_method_id || '', stripe_payment_method_id: payload.stripe_payment_method_id || '' });
    customer = db.getCustomerById(customer.id);
  }

  db.addNotification({ user_id: user.id, type: 'trigger', title: `Appointment — ${customer.name}`, body: `GHL Location ${locationId} fired. $${customer.rate_per_trigger} charge ready.` });

  if (user.appointment_tracking_mode) {
    const appt = db.createAppointment({ user_id: user.id, customer_id: customer.id, status: 'pending', date: payload.appointment_date || '', time: payload.appointment_time || '', note: payload.note || '' });
    return res.json({ success: true, mode: 'appointment_tracking', appointmentId: appt.id, customerId: customer.id, locationId, customerName: customer.name });
  }

  const charge = await processCharge(user, customer, payload.note || `GHL Location ${locationId} Trigger`);
  res.json({ success: true, chargeId: charge.id, status: charge.status, customerId: customer.id, locationId, customerName: customer.name });
});

// ─── CHARGE PROCESSING ────────────────────────────────────────────
async function processCharge(user, customer, note = '') {
  const charge = db.createCharge({
    user_id: user.id, customer_id: customer.id, customer_name: customer.name, customer_email: customer.email,
    amount: customer.rate_per_trigger, processor: user.processor, status: 'pending', note
  });

  if (!customer.card_on_file) {
    db.updateCustomer(customer.id, { status: 'at_risk' });
    db.updateCharge(charge.id, { status: 'failed', failure_reason: 'No payment method on file' });
    db.addNotification({ user_id: user.id, type: 'fail', title: `Charge failed — ${customer.name}`, body: `$${customer.rate_per_trigger} failed — No payment method on file` });
    return db.getChargeById(charge.id);
  }

  // SIMULATED CHARGE (Whop / manual billing)
  // In production, you'd integrate real Whop/Stripe charges here
  db.updateCharge(charge.id, { status: 'succeeded', stripe_charge_id: `sim_${uuidv4().slice(0,8)}` });
  db.updateCustomer(customer.id, { total_charged: customer.total_charged + customer.rate_per_trigger, total_triggers: customer.total_triggers + 1 });
  db.addNotification({ user_id: user.id, type: 'success', title: `Charge successful — ${customer.name}`, body: `$${customer.rate_per_trigger.toFixed(2)} charged via ${user.processor}. ${note}` });
  return db.getChargeById(charge.id);
}

// ─── WHOP WEBHOOK ─────────────────────────────────────────────────
app.post('/webhook/whop/:secret', (req, res) => {
  const user = db.getUserByWhopSecret(req.params.secret);
  if (!user) return res.status(403).json({ error: 'Invalid secret' });
  const { event, data } = req.body;
  if (event === 'payment.succeeded' || event === 'membership.went_valid') {
    const email = data.user?.email || data.customer?.email;
    const name = data.user?.name || data.customer?.name;
    let customer = db.getCustomerByEmailAndUser(email, user.id);
    if (!customer) customer = db.createCustomer({ user_id: user.id, name: name || email.split('@')[0], email, whop_member_id: data.user?.id || '' });
    db.updateCustomer(customer.id, { card_on_file: 1, whop_member_id: data.user?.id || '' });
    db.addNotification({ user_id: user.id, type: 'success', title: `Whop payment — ${customer.name}`, body: 'Payment succeeded via Whop webhook.' });
  }
  res.json({ received: true });
});

// ─── STRIPE WEBHOOK ───────────────────────────────────────────────
app.post('/webhook/stripe/:secret', (req, res) => {
  const user = db.getUserByWhopSecret(req.params.secret);
  // Actually we'd want stripe webhook per user differently, but for now:
  const event = req.body;
  if (event.type === 'payment_intent.succeeded') {
    const obj = event.data.object;
    const email = obj.receipt_email;
    const allUsers = db.listUsers('agency');
    for (const u of allUsers) {
      let customer = db.getCustomerByEmailAndUser(email, u.id);
      if (customer) {
        db.updateCustomer(customer.id, { card_on_file: 1, stripe_payment_method_id: obj.payment_method || '' });
        db.addNotification({ user_id: u.id, type: 'success', title: `Stripe payment — ${customer.name}`, body: 'Payment intent succeeded.' });
        break;
      }
    }
  }
  if (event.type === 'charge.dispute.created') {
    // Chargeback
    const obj = event.data.object;
    const allUsers = db.listUsers('agency');
    for (const u of allUsers) {
      const charges = db.getChargesByUser(u.id);
      const match = charges.find(c => c.stripe_charge_id === obj.charge);
      if (match) {
        db.createCharge({ id: uuidv4(), user_id: u.id, customer_id: match.customer_id, customer_name: match.customer_name, customer_email: match.customer_email,
          amount: match.amount, processor: 'stripe', status: 'chargeback', stripe_charge_id: obj.id, note: 'Chargeback initiated', failure_reason: obj.reason });
        db.addNotification({ user_id: u.id, type: 'fail', title: `CHARGEBACK — ${match.customer_name}`, body: `$${match.amount.toFixed(2)} chargeback initiated. Reason: ${obj.reason}` });
        break;
      }
    }
  }
  res.json({ received: true });
});

// ─── CRM API (AGENCY) ────────────────────────────────────────────
app.get('/api/customers', requireAuth, (req, res) => {
  res.json(db.getCustomersByUser(req.user.id));
});

app.post('/api/customers', requireAuth, (req, res) => {
  try {
    const c = db.createCustomer({ ...req.body, user_id: req.user.id });
    db.addNotification({ user_id: req.user.id, type: 'new', title: `New customer — ${c.name}`, body: `${c.email} added manually.` });
    res.json(c);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/customers/:id', requireAuth, (req, res) => {
  const c = db.getCustomerById(req.params.id);
  if (!c || c.user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  res.json(db.updateCustomer(req.params.id, req.body));
});

app.delete('/api/customers/:id', requireAuth, (req, res) => {
  const c = db.getCustomerById(req.params.id);
  if (!c || c.user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  db.db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Per-client webhook URL (for GHL sub-account config)
app.get('/api/customers/:id/webhook-url', requireAuth, (req, res) => {
  const c = db.getCustomerById(req.params.id);
  if (!c || c.user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  const user = db.getUserById(req.user.id);
  if (!c.ghl_location_id) return res.json({ webhookUrl: null, error: 'Set GHL Location ID first' });
  res.json({ webhookUrl: `${BASE_URL}/webhook/ghl/${user.ghl_webhook_secret}/${c.ghl_location_id}` });
});

app.post('/api/customers/:id/charge', requireAuth, async (req, res) => {
  const c = db.getCustomerById(req.params.id);
  if (!c || c.user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  const user = db.getUserById(req.user.id);
  const charge = await processCharge(user, c, req.body.note || 'Manual charge');
  res.json(charge);
});

// ─── CHARGES API ──────────────────────────────────────────────────
app.get('/api/charges', requireAuth, (req, res) => {
  res.json(db.getChargesByUser(req.user.id));
});

// ─── APPOINTMENTS API ─────────────────────────────────────────────
app.get('/api/appointments', requireAuth, (req, res) => {
  res.json(db.getAppointmentsByUser(req.user.id));
});

app.patch('/api/appointments/:id', requireAuth, (req, res) => {
  const a = db.getAppointmentById(req.params.id);
  if (!a || a.user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  const oldStatus = a.status;
  db.updateAppointment(req.params.id, { status: req.body.status || a.status });
  const updated = db.getAppointmentById(req.params.id);
  const user = db.getUserById(req.user.id);
  if (user.appointment_tracking_mode && oldStatus !== updated.status && updated.status === 'showed') {
    const customer = db.getCustomerById(updated.customer_id);
    if (customer) processCharge(user, customer, `Appointment showed — ${updated.date}`);
  }
  res.json(updated);
});

// ─── NOTIFICATIONS API ────────────────────────────────────────────
app.get('/api/notifications', requireAuth, (req, res) => {
  res.json(db.getNotificationsByUser(req.user.id));
});

app.post('/api/notifications/read', requireAuth, (req, res) => {
  db.markAllRead(req.user.id);
  res.json({ ok: true });
});

app.get('/api/notifications/unread-count', requireAuth, (req, res) => {
  res.json({ count: db.getUnreadCount(req.user.id) });
});

// ─── SETTINGS API ─────────────────────────────────────────────────
app.get('/api/settings', requireAuth, (req, res) => {
  const user = db.getUserById(req.user.id);
  res.json({
    companyName: user.company_name, processor: user.processor,
    stripeSecretKey: user.stripe_secret_key ? '••••••••' + user.stripe_secret_key.slice(-4) : '',
    stripePublishableKey: user.stripe_publishable_key,
    whopApiKey: user.whop_api_key ? '••••••••' + user.whop_api_key.slice(-4) : '',
    whopCompanyId: user.whop_company_id,
    appointmentTrackingMode: !!user.appointment_tracking_mode,
    ghlWebhookUrl: `${BASE_URL}/webhook/ghl/${user.ghl_webhook_secret}`,
    ghlWebhookSecret: user.ghl_webhook_secret,
    whopWebhookUrl: `${BASE_URL}/webhook/whop/${user.whop_webhook_secret}`,
    plan: user.plan,
    monthlyRate: user.monthly_rate
  });
});

app.post('/api/settings', requireAuth, (req, res) => {
  const updates = {};
  if (req.body.companyName !== undefined) updates.company_name = req.body.companyName;
  if (req.body.processor !== undefined) updates.processor = req.body.processor;
  if (req.body.stripeSecretKey) updates.stripe_secret_key = req.body.stripeSecretKey;
  if (req.body.stripePublishableKey !== undefined) updates.stripe_publishable_key = req.body.stripePublishableKey;
  if (req.body.whopApiKey) updates.whop_api_key = req.body.whopApiKey;
  if (req.body.whopCompanyId !== undefined) updates.whop_company_id = req.body.whopCompanyId;
  if (req.body.appointmentTrackingMode !== undefined) updates.appointment_tracking_mode = req.body.appointmentTrackingMode ? 1 : 0;
  res.json(db.updateUser(req.user.id, updates));
});

app.post('/api/settings/note-templates', requireAuth, (req, res) => {
  // Store in a simple JSON field or separate table — for now skip for brevity
  res.json({ templates: [] });
});

// ─── STATS API ────────────────────────────────────────────────────
app.get('/api/stats', requireAuth, (req, res) => {
  res.json(db.getStats(req.user.id));
});

// ─── METRICS DATA ─────────────────────────────────────────────────
app.get('/api/metrics', requireAuth, (req, res) => {
  const userId = req.user.id;
  const charges = db.getChargesByUser(userId);
  const customers = db.getCustomersByUser(userId);

  // Revenue by day (last 30) — UTC keys
  const revenueByDay = {};
  const triggersByDay = {};
  const failuresByDay = {};
  const now = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now); d.setUTCDate(d.getUTCDate() - i);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    revenueByDay[key] = 0; triggersByDay[key] = 0; failuresByDay[key] = 0;
  }

  charges.forEach(c => {
    const dateKey = (c.created_at || '').split(' ')[0];
    if (revenueByDay[dateKey] !== undefined) {
      if (c.status === 'succeeded') revenueByDay[dateKey] += c.amount;
      if (c.status === 'failed') failuresByDay[dateKey] += 1;
      if (c.status === 'succeeded' || c.status === 'failed') triggersByDay[dateKey] += 1;
    }
  });

  // Top customers
  const topCustomers = customers
    .map(c => ({ name: c.name, totalCharged: c.total_charged, totalTriggers: c.total_triggers }))
    .sort((a, b) => b.totalCharged - a.totalCharged)
    .slice(0, 5);

  // Failure rate
  const totalCharged = charges.filter(c => c.status === 'succeeded').length;
  const totalFailed = charges.filter(c => c.status === 'failed').length;
  const totalChargebacks = charges.filter(c => c.status === 'chargeback').length;
  const failureRate = charges.length > 0 ? ((totalFailed / charges.length) * 100).toFixed(1) : 0;

  res.json({
    revenueByDay, triggersByDay, failuresByDay,
    topCustomers, failureRate,
    totalCharged, totalFailed, totalChargebacks,
    totalRevenue: Object.values(revenueByDay).reduce((s, v) => s + v, 0),
    totalCustomers: customers.length
  });
});

// ─── ADMIN API ────────────────────────────────────────────────────
app.get('/api/admin/stats', requireAuth, requireAdmin, (req, res) => {
  res.json(db.getAdminStats());
});

app.get('/api/admin/agencies', requireAuth, requireAdmin, (req, res) => {
  const agencies = db.listUsers('agency');
  res.json(agencies.map(u => ({
    id: u.id, name: u.name, email: u.email, companyName: u.company_name, plan: u.plan,
    monthlyRate: u.monthly_rate, active: !!u.active, processor: u.processor,
    stripeCustomerId: u.stripe_customer_id, stripeSubscriptionId: u.stripe_subscription_id,
    totalCustomers: db.getCustomersByUser(u.id).length,
    totalCharged: db.getStats(u.id).totalCharged
  })));
});

app.patch('/api/admin/agencies/:id', requireAuth, requireAdmin, (req, res) => {
  const updates = {};
  if (req.body.plan !== undefined) updates.plan = req.body.plan;
  if (req.body.monthlyRate !== undefined) updates.monthly_rate = req.body.monthlyRate;
  if (req.body.active !== undefined) updates.active = req.body.active ? 1 : 0;
  if (req.body.processor !== undefined) updates.processor = req.body.processor;
  res.json(db.updateUser(req.params.id, updates));
});

app.delete('/api/admin/agencies/:id', requireAuth, requireAdmin, (req, res) => {
  db.db.prepare('DELETE FROM users WHERE id = ? AND role = ?').run(req.params.id, 'agency');
  res.json({ ok: true });
});

// ─── AD METRICS (Facebook) ───────────────────────────────────────
app.post('/api/customers/:customerId/ad-metrics', requireAuth, async (req, res) => {
  try {
    const { customerId } = req.params;
    const customer = await db.getCustomerById(customerId);
    if (!customer || customer.user_id !== req.user.id) return res.status(404).json({ error: 'Customer not found' });

    const { source, campaign_name, date_from, date_to, ad_spend, impressions, clicks, leads, appointments } = req.body;
    const id = await db.createAdMetric({
      user_id: req.user.id, customer_id: customerId,
      source: source || 'facebook', campaign_name: campaign_name || '',
      date_from, date_to, ad_spend: ad_spend || 0,
      impressions: impressions || 0, clicks: clicks || 0,
      leads: leads || 0, appointments: appointments || 0
    });
    res.json({ id, cpl: leads > 0 ? (ad_spend / leads).toFixed(2) : null, cpa: appointments > 0 ? (ad_spend / appointments).toFixed(2) : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/customers/:customerId/ad-metrics', requireAuth, async (req, res) => {
  try {
    const { customerId } = req.params;
    const customer = await db.getCustomerById(customerId);
    if (!customer || customer.user_id !== req.user.id) return res.status(404).json({ error: 'Customer not found' });
    const metrics = await db.getAdMetricsByCustomer(customerId);
    res.json(metrics);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/ad-metrics/:id', requireAuth, async (req, res) => {
  try {
    await db.deleteAdMetric(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ADMIN: CREATE AGENCY ───────────────────────────────────────
app.post('/api/admin/agencies', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { email, password, name, companyName, plan, monthlyRate, processor } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const existing = db.getUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 10);
    const user = db.createUser({
      email, password_hash: hash, name, companyName, role: 'agency',
      plan: 'free', monthlyRate: 0,
      processor: 'stripe',
    });

    // Stripe subscription creation removed — handle billing personally

    res.json({
      id: user.id, email: user.email, name: user.name,
      companyName: user.companyName, plan: 'free',
      monthlyRate: 0, processor: 'stripe',
      stripeCustomerId: null, subscriptionUrl: null
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ADMIN: AGENCY SUBSCRIPTION STATUS ──────────────────────────
app.get('/api/admin/agencies/:id/subscription', requireAuth, requireAdmin, (req, res) => {
  const user = db.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({
    plan: user.plan, monthlyRate: user.monthly_rate, active: !!user.active,
    stripeCustomerId: user.stripe_customer_id, stripeSubscriptionId: user.stripe_subscription_id
  });
});

// ─── SERVE ────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Seed admin on first boot
db.ensureAdmin();

app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  ⚡ PAYPULSE running at http://localhost:${PORT}           ║`);
  console.log(`╠═══════════════════════════════════════════════════════╣`);
  console.log(`║  Sign up:     http://localhost:${PORT}                      ║`);
  console.log(`║  Admin:       admin@paypulse.co / admin123            ║`);
  console.log(`╚═══════════════════════════════════════════════════════╝\n`);
});
