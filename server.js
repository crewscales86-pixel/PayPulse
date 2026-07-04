require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const db = require('./db');
const { v4: uuidv4 } = require('uuid');
const Stripe = require('stripe');

const JWT_SECRET = process.env.JWT_SECRET || 'paypulse-dev-secret-change-in-prod';
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

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
  max: 10, // 10 attempts per window
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // 120 requests per minute
  message: { error: 'Too many requests. Slow down.' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);

app.use(bodyParser.json({ limit: '100kb' }));
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

// ─── POST /webhook/ghl/:secret — agency‑level webhook
app.post('/webhook/ghl/:secret', async (req, res) => {
  try {
    const user = await db.getUserByGhlSecret(req.params.secret);
    if (!user) return res.status(403).json({ error: 'Invalid secret' });

    const payload = req.body;
    const ghlLocationId = payload.location_id || payload.locationId || '';
    let customer = null;

    if (ghlLocationId) {
      customer = await db.getCustomerByLocationId(ghlLocationId, user.id);
    }
    if (!customer) {
      customer = await db.getCustomerByEmailAndUser(payload.email, user.id);
    }
    if (!customer) {
      customer = await db.createCustomer({
        user_id: user.id,
        name: payload.full_name || payload.name || payload.email.split('@')[0],
        email: payload.email,
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

    db.addNotification({
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

    db.addNotification({
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
    res.json({
      success: true,
      chargeId: charge.id,
      status: charge.status,
      customerId: customer.id,
      locationId,
      customerName: customer.name
    });
  } catch (err) {
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
    await db.updateCustomer(customer.id, { status: 'at_risk' });
    await db.updateCharge(charge.id, {
      status: 'failed',
      failure_reason: 'No payment method on file'
    });
    await db.addNotification({
      user_id: user.id,
      type: 'fail',
      title: `Charge failed — ${customer.name}`,
      body: `$${chargeAmount.toFixed(2)} failed — No payment method on file`
    });
    await fireFailWebhook(user, customer, chargeAmount, 'No payment method on file');
    return db.getChargeById(charge.id);
  }

  // Real Stripe charging
  if (user.processor === 'stripe') {
    if (!user.stripe_secret_key) {
      await db.updateCharge(charge.id, {
        status: 'failed',
        failure_reason: 'No Stripe Secret Key configured'
      });
      await db.addNotification({
        user_id: user.id,
        type: 'fail',
        title: `Charge failed — ${customer.name}`,
        body: 'No Stripe Secret Key configured'
      });
      return db.getChargeById(charge.id);
    }
    if (!user.stripe_secret_key.startsWith('sk_')) {
      await db.updateCharge(charge.id, {
        status: 'failed',
        failure_reason:
          'Invalid Stripe key — must start with sk_live_ or sk_test_'
      });
      await db.addNotification({
        user_id: user.id,
        type: 'fail',
        title: `Charge failed — ${customer.name}`,
        body:
          'Invalid Stripe key — must start with sk_live_ or sk_test_'
      });
      await db.updateCustomer(customer.id, { status: 'at_risk' });
      await fireFailWebhook(user, customer, chargeAmount, 'Invalid Stripe key');
      return db.getChargeById(charge.id);
    }
    if (!customer.stripe_customer_id) {
      await db.updateCharge(charge.id, {
        status: 'failed',
        failure_reason: 'No Stripe customer ID on file'
      });
      await db.addNotification({
        user_id: user.id,
        type: 'fail',
        title: `Charge failed — ${customer.name}`,
        body: 'No Stripe customer ID on file'
      });
      await db.updateCustomer(customer.id, { status: 'at_risk' });
      await fireFailWebhook(user, customer, chargeAmount, 'No Stripe customer ID on file');
      return db.getChargeById(charge.id);
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
      } else {
        await db.updateCharge(charge.id, {
          status: 'failed',
          failure_reason: `PaymentIntent status: ${paymentIntent.status}`
        });
        await db.addNotification({
          user_id: user.id,
          type: 'fail',
          title: `Charge failed — ${customer.name}`,
          body: `Stripe returned status: ${paymentIntent.status}`
        });
      }
    } catch (stripeErr) {
      console.error('Stripe charge error:', stripeErr);
      const reason = stripeErr.message || 'Unknown Stripe error';
      await db.updateCharge(charge.id, {
        status: 'failed',
        failure_reason: reason
      });
      await db.addNotification({
        user_id: user.id,
        type: 'fail',
        title: `Charge failed — ${customer.name}`,
        body: `Stripe error: ${reason}`
      });
      await db.updateCustomer(customer.id, { status: 'at_risk' });
      await fireFailWebhook(user, customer, chargeAmount, reason);
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
      } else {
        const errorBody = await response.text();
        let failureReason;
        try {
          const errJson = JSON.parse(errorBody);
          failureReason = errJson.error || errJson.message || errorBody;
        } catch {
          failureReason = errorBody;
        }
        await db.updateCharge(charge.id, {
          status: 'failed',
          failure_reason: failureReason
        });
        await db.updateCustomer(customer.id, { status: 'at_risk' });
        await db.addNotification({
          user_id: user.id,
          type: 'fail',
          title: `Charge failed — ${customer.name}`,
          body: `Whop error: ${failureReason}`
        });
        await fireFailWebhook(user, customer, chargeAmount, failureReason);
      }
    } catch (fetchErr) {
      console.error('Whop charge error:', fetchErr);
      const reason = fetchErr.message || 'Whop network error';
      await db.updateCharge(charge.id, {
        status: 'failed',
        failure_reason: reason
      });
      await db.updateCustomer(customer.id, { status: 'at_risk' });
      await db.addNotification({
        user_id: user.id,
        type: 'fail',
        title: `Charge failed — ${customer.name}`,
        body: `Whop error: ${reason}`
      });
      await fireFailWebhook(user, customer, chargeAmount, reason);
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
  return db.getChargeById(charge.id);
}

// ─── WHOP WEBHOOK ─────────────────────────────────────────────
app.post('/webhook/whop/:secret', async (req, res) => {
  try {
    const user = await db.getUserByWhopSecret(req.params.secret);
    if (!user) return res.status(403).json({ error: 'Invalid secret' });
    const { event, data } = req.body;
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
          name: name || email.split('@')[0],
          email,
          whop_member_id: data.user?.id || ''
        });
      await db.updateCustomer(customer.id, {
        card_on_file: 1,
        whop_member_id: data.user?.id || ''
      });
      await db.addNotification({
        user_id: user.id,
        type: 'success',
        title: `Whop payment — ${customer.name}`,
        body: 'Payment succeeded via Whop webhook.'
      });
    }
    res.json({ received: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── STRIPE WEBHOOK ───────────────────────────────────────────────
app.post('/webhook/stripe/:secret', async (req, res) => {
  try {
    const event = req.body;

    if (event.type === 'checkout.session.completed') {
      const obj = event.data.object;
      const paypulseCustomerId = obj.metadata?.paypulse_customer_id;
      const paypulseUserId = obj.metadata?.paypulse_user_id;
      if (paypulseCustomerId) {
        const customer = await db.getCustomerById(paypulseCustomerId);
        if (customer) {
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
          db.updateCustomer(customer.id, {
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
          db.createCharge({
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
    res.json({ received: true });
  } catch (err) {
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
    const c = await db.createCustomer({
      ...req.body,
      user_id: req.user.id
    });
    await db.addNotification({
      user_id: req.user.id,
      type: 'new',
      title: `New customer — ${c.name}`,
      body: `${c.email} added manually.`
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
  const c = await db.getCustomerById(req.params.id);
  if (!c || c.user_id !== req.user.id)
    return res.status(404).json({ error: 'Not found' });
  const updates = { ...req.body };
  if (
    updates.stripe_payment_method_id ||
    updates.whop_payment_method_id
  ) {
    updates.card_on_file = 1;
  }
  res.json(await db.updateCustomer(req.params.id, updates));
});

app.delete('/api/customers/:id', requireAuth, async (req, res) => {
  const c = await db.getCustomerById(req.params.id);
  if (!c || c.user_id !== req.user.id)
    return res.status(404).json({ error: 'Not found' });
  await db.run('DELETE FROM customers WHERE id = ?', [req.params.id]);
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

    res.json({ url: session.url });
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

    res.json(newCharge);
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
    res.json({
      customer: c,
      charges,
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

app.post('/api/notifications/read', requireAuth, (req, res) => {
  db.markAllRead(req.user.id);
  res.json({ ok: true });
});

app.get('/api/notifications/unread-count', requireAuth, (req, res) => {
  res.json({ count: db.getUnreadCount(req.user.id) });
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
  res.json(await db.updateUser(req.user.id, updates));
});

app.post('/api/settings/note-templates', requireAuth, (req, res) => {
  res.json({ templates: [] });
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
    const dateKey = (c.created_at ? String(c.created_at) : '').split(' ')[0];
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

// ─── SEED DEMO DATA ─────────────────────────────────────────────
app.post('/api/admin/seed-demo/:agencyId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.agencyId;
    const user = await db.getUserById(userId);
    if (!user) return res.status(404).json({ error: 'Agency not found' });
    if (user.role === 'admin') return res.status(400).json({ error: 'Seed into an agency account, not admin' });

    // Delete existing demo data for clean seed
    const existing = await db.getCustomersByUser(userId);
    for (const c of existing) {
      if (c.email && c.email.includes('@plumbing.com') || c.email.includes('@premierroofing') || c.email.includes('@greenway') || c.email.includes('@brightelectric') || c.email.includes('@apexhvac')) {
        if (db.sqliteDb) {
          db.sqliteDb.prepare('DELETE FROM charges WHERE customer_id = ?').run(c.id);
          db.sqliteDb.prepare('DELETE FROM customers WHERE id = ?').run(c.id);
        } else {
          await db.pgPool.query('DELETE FROM charges WHERE customer_id = $1', [c.id]);
          await db.pgPool.query('DELETE FROM customers WHERE id = $1', [c.id]);
        }
      }
    }

    const clients = [
      { name: "Mike's Plumbing", company: "Mike's Plumbing Inc.", email: 'mike@plumbing.com', rate: 97, status: 'active', triggers: 14 },
      { name: 'Premier Roofing', company: 'Premier Roofing LLC', email: 'info@premierroofing.com', rate: 147, status: 'active', triggers: 15 },
      { name: 'Greenway Landscaping', company: 'Greenway Landscaping Co.', email: 'tim@greenway.com', rate: 75, status: 'active', triggers: 13 },
      { name: 'Bright Electric', company: 'Bright Electric Services', email: 'dispatch@brightelectric.com', rate: 125, status: 'new', triggers: 1 },
      { name: 'Apex HVAC', company: 'Apex Heating & Cooling', email: 'office@apexhvac.com', rate: 147, status: 'at_risk', triggers: 4 },
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
        card_on_file: c.status === 'active' ? 1 : 0,
        stripe_customer_id: 'cus_demo_' + c.name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 10),
        stripe_payment_method_id: c.status === 'active' ? 'pm_demo_' + c.name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 8) : '',
      });
      created.push(customer);

      // Create historical charges with proper YYYY-MM-DD HH:MM:SS format
      const numCharges = Math.min(c.triggers, 12);
      let successCount = 0;
      let totalAmount = 0;
      for (let i = 0; i < numCharges; i++) {
        const daysAgo = Math.floor(Math.random() * 45) + 1 + i;
        const d = new Date(Date.now() - daysAgo * 86400000);
        const chargeDate = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
        const succeeded = i < numCharges - 1 || c.status !== 'at_risk';
        const chargeId = uuidv4();
        const notes = ['Initial setup fee — welcome!', 'Weekly retainer — ' + c.company, 'Monthly retainer — ' + c.company, 'Lead generation fee', 'Performance bonus'];
        const note = notes[i % notes.length];
        if (db.sqliteDb) {
          db.sqliteDb.prepare(
            `INSERT INTO charges (id, user_id, customer_id, customer_name, customer_email, amount, processor, status, stripe_charge_id, note, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`
          ).run(chargeId, userId, customer.id, c.name, c.email, c.rate, 'stripe', succeeded ? 'succeeded' : 'failed', 'ch_' + chargeId.slice(0, 10), note, chargeDate);
        } else {
          await db.pgPool.query(
            `INSERT INTO charges (id, user_id, customer_id, customer_name, customer_email, amount, processor, status, stripe_charge_id, note, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [chargeId, userId, customer.id, c.name, c.email, c.rate, 'stripe', succeeded ? 'succeeded' : 'failed', 'ch_' + chargeId.slice(0, 10), note, chargeDate]
          );
        }
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
    if (db.sqliteDb) {
      for (let i = 29; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000);
        const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        db.sqliteDb.prepare(
          `INSERT OR IGNORE INTO ad_metrics (id, user_id, customer_id, source, ad_spend, impressions, clicks, leads, appointments, date_from, date_to, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(uuidv4(), userId, created[0]?.id || '', 'facebook', Math.round(Math.random()*150+50), Math.round(Math.random()*5000+500), Math.round(Math.random()*80+10), Math.round(Math.random()*8+2), Math.round(Math.random()*4+1), dateStr, dateStr, new Date().toISOString());
      }
    } else {
      const metrics = [];
      for (let i = 29; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000);
        const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        metrics.push(
          db.pgPool.query(
            `INSERT INTO ad_metrics (id, user_id, customer_id, source, ad_spend, impressions, clicks, leads, appointments, date_from, date_to, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
            [uuidv4(), userId, created[0]?.id || '', 'facebook', Math.round(Math.random()*150+50), Math.round(Math.random()*5000+500), Math.round(Math.random()*80+10), Math.round(Math.random()*8+2), Math.round(Math.random()*4+1), dateStr, dateStr, new Date().toISOString()]
          )
        );
      }
      await Promise.all(metrics);
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
  res.json(await db.updateUser(req.params.id, updates));
});

app.delete('/api/admin/agencies/:id', requireAuth, requireAdmin, async (req, res) => {
  await db.run('DELETE FROM users WHERE id = ? AND role = ?', [req.params.id, 'agency']);
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
    const id = db.createAdMetric({
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
    db.deleteAdMetric(req.params.id);
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
      email,
      password_hash: hash,
      name,
      company_name: companyName || '',
      role: 'agency',
      plan: 'free',
      monthlyRate: 0,
      processor: 'stripe'
    });
    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      companyName: user.companyName,
      plan: 'free',
      monthlyRate: 0,
      processor: 'stripe',
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