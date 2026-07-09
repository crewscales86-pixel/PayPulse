#!/usr/bin/env node

const DEFAULT_BASE_URL = process.env.PAYPULSE_BASE_URL || 'http://localhost:3000';
const ADMIN_EMAIL = process.env.PAYPULSE_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'paypulsesupport@proton.me';
const ADMIN_PASSWORD = process.env.PAYPULSE_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '';

const baseUrl = DEFAULT_BASE_URL.replace(/\/$/, '');
const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const agencyEmail = `bugbash-agency-${runId}@example.com`;
const signupEmail = `bugbash-signup-${runId}@example.com`;
const password = `BugBash-${runId}!`;
const createdAgencyIds = [];
let agencyToken = '';
let adminToken = '';
let customerId = '';

function logStep(name) {
  console.log(`✓ ${name}`);
}

async function request(path, options = {}) {
  const token = options.token;
  const expected = options.expected ?? [200];
  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  const expectedList = Array.isArray(expected) ? expected : [expected];
  if (!expectedList.includes(res.status)) {
    throw new Error(`${options.method || 'GET'} ${path} returned ${res.status}: ${text}`);
  }
  return { res, data };
}

async function login(email, pass) {
  const { data } = await request('/api/auth/login', {
    method: 'POST',
    body: { email, password: pass }
  });
  if (!data.token) throw new Error(`Login did not return token for ${email}`);
  return data;
}

async function cleanup() {
  if (!adminToken) return;
  for (const id of createdAgencyIds.reverse()) {
    try {
      await request(`/api/admin/agencies/${id}`, {
        method: 'DELETE',
        token: adminToken,
        expected: [200, 404]
      });
    } catch (err) {
      console.warn(`cleanup warning for agency ${id}: ${err.message}`);
    }
  }
}

async function main() {
  console.log(`Running PayPulse bug bash against ${baseUrl}`);
  if (!ADMIN_PASSWORD) {
    throw new Error('Set PAYPULSE_ADMIN_PASSWORD or ADMIN_PASSWORD before running bug bash');
  }

  const adminLogin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  adminToken = adminLogin.token;
  if (adminLogin.user.role !== 'admin') throw new Error('Admin login did not return admin role');
  logStep('admin login');

  const createdAgency = await request('/api/admin/agencies', {
    method: 'POST',
    token: adminToken,
    body: {
      email: agencyEmail,
      password,
      name: 'Bug Bash Agency',
      companyName: 'Bug Bash Co',
      plan: 'standard',
      monthlyRate: 97,
      processor: 'stripe'
    }
  });
  createdAgencyIds.push(createdAgency.data.id);
  logStep('admin creates agency');

  const agencyLogin = await login(agencyEmail, password);
  agencyToken = agencyLogin.token;
  logStep('agency login');

  await request('/api/settings', {
    method: 'POST',
    token: agencyToken,
    body: { appointmentTrackingMode: true, processor: 'stripe' }
  });
  const settings = (await request('/api/settings', { token: agencyToken })).data;
  if (!settings.ghlWebhookSecret) throw new Error('Settings did not return GHL webhook secret');
  logStep('settings and appointment tracking');

  const stripeImport = await request('/api/customers/import-stripe', {
    method: 'POST',
    token: agencyToken,
    body: { customerIds: ['cus_bugbash_fake'] },
    expected: [400]
  });
  if (!String(stripeImport.data.error || '').includes('Stripe Secret Key')) {
    throw new Error('Stripe import validation did not return missing key error');
  }
  logStep('Stripe import validation');

  const locationId = `loc-${runId}`;
  const customer = await request('/api/customers', {
    method: 'POST',
    token: agencyToken,
    body: {
      name: 'Bug Bash Customer',
      email: `bugbash-customer-${runId}@example.com`,
      phone: '+15555550123',
      rate_per_trigger: 50,
      status: 'new',
      ghl_location_id: locationId
    }
  });
  customerId = customer.data.id;
  if (!customerId) throw new Error('Customer create did not return id');
  logStep('customer add');

  const moved = await request(`/api/customers/${customerId}`, {
    method: 'PATCH',
    token: agencyToken,
    body: { status: 'active' }
  });
  if (moved.data.status !== 'active') throw new Error('Pipeline move did not persist active status');
  logStep('pipeline move');

  const manualCharge = await request(`/api/customers/${customerId}/charge`, {
    method: 'POST',
    token: agencyToken,
    body: { note: 'Bug bash manual charge' }
  });
  if (manualCharge.data.status !== 'failed') throw new Error(`Manual charge expected failed, got ${manualCharge.data.status}`);
  logStep('manual charge failure path');

  const retry = await request(`/api/charges/${manualCharge.data.id}/retry`, {
    method: 'POST',
    token: agencyToken,
    body: {}
  });
  if (retry.data.status !== 'failed') throw new Error(`Retry expected failed no-card path, got ${retry.data.status}`);
  if (retry.data.retry_status === 'scheduled') throw new Error('Retry should not create scheduled retry state');
  logStep('manual retry path');

  const credit = await request(`/api/customers/${customerId}/credits`, {
    method: 'POST',
    token: agencyToken,
    body: { amount: 50, note: 'Bug bash credit' }
  });
  if ((Number(credit.data.credit_balance) || 0) < 50) throw new Error('Credit was not added to customer balance');
  logStep('credit add');

  const note = await request(`/api/customers/${customerId}/notes`, {
    method: 'POST',
    token: agencyToken,
    body: { body: 'Bug bash note', recurring: true, nextDueAt: new Date().toISOString() }
  });
  if (!note.data.id) throw new Error('Note create did not return id');
  await request(`/api/notes/${note.data.id}`, {
    method: 'PATCH',
    token: agencyToken,
    body: { is_done: true }
  });
  await request(`/api/notes/${note.data.id}`, {
    method: 'DELETE',
    token: agencyToken
  });
  logStep('notes create/update/delete');

  const bookedNoShow = await request(`/webhook/ghl/${settings.ghlWebhookSecret}/${locationId}`, {
    method: 'POST',
    body: {
      event_id: `bugbash-noshow-${runId}`,
      type: 'appointment.booked',
      appointment_id: `appt-noshow-${runId}`,
      appointment_date: '2026-07-08',
      appointment_time: '10:00',
      email: `bugbash-customer-${runId}@example.com`,
      full_name: 'Bug Bash Customer',
      location_id: locationId
    }
  });
  if (!bookedNoShow.data.appointmentId) throw new Error('GHL webhook did not create appointment');
  const noShow = await request(`/api/appointments/${bookedNoShow.data.appointmentId}`, {
    method: 'PATCH',
    token: agencyToken,
    body: { status: 'no_show' }
  });
  if (!noShow.data.creditIssued) throw new Error('No-show did not issue credit');
  logStep('GHL webhook and no-show credit');

  const bookedShowed = await request(`/webhook/ghl/${settings.ghlWebhookSecret}/${locationId}`, {
    method: 'POST',
    body: {
      event_id: `bugbash-showed-${runId}`,
      type: 'appointment.booked',
      appointment_id: `appt-showed-${runId}`,
      appointment_date: '2026-07-08',
      appointment_time: '11:00',
      email: `bugbash-customer-${runId}@example.com`,
      full_name: 'Bug Bash Customer',
      location_id: locationId
    }
  });
  const showed = await request(`/api/appointments/${bookedShowed.data.appointmentId}`, {
    method: 'PATCH',
    token: agencyToken,
    body: { status: 'showed' }
  });
  if (!['credited', 'failed', 'succeeded'].includes(showed.data.chargeStatus)) {
    throw new Error(`Showed appointment returned unexpected charge status: ${showed.data.chargeStatus}`);
  }
  logStep('showed appointment billing path');

  await request('/api/auth/signup', {
    method: 'POST',
    body: {
      name: 'Bug Bash Signup',
      email: signupEmail,
      password,
      companyName: 'Bug Bash Pending'
    }
  });
  const pending = await request('/api/admin/pending', { token: adminToken });
  const pendingUser = pending.data.find(user => user.email === signupEmail);
  if (!pendingUser) throw new Error('Pending signup not visible to admin');
  await request(`/api/admin/approve/${pendingUser.id}`, {
    method: 'POST',
    token: adminToken
  });
  createdAgencyIds.push(pendingUser.id);
  const approvedLogin = await login(signupEmail, password);
  if (approvedLogin.user.role !== 'agency') throw new Error('Approved agency could not log in');
  logStep('signup and admin approval');

  await request(`/api/customers/${customerId}`, {
    method: 'DELETE',
    token: agencyToken
  });
  customerId = '';
  logStep('customer cleanup');

  await cleanup();
  console.log('Bug bash passed.');
}

main()
  .catch(async err => {
    console.error(`Bug bash failed: ${err.message}`);
    await cleanup();
    process.exit(1);
  });
