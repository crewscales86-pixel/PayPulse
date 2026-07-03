const path = require('path');
const { v4: uuidv4 } = require('uuid');

// ─── DATABASE LAYER ─────────────────────────────────────────────
// Uses PostgreSQL in production (DATABASE_URL set), SQLite for local dev

const USE_PG = !!process.env.DATABASE_URL;

let pgPool = null;
let sqliteDb = null;

if (USE_PG) {
  const { Pool } = require('pg');
  pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
} else {
  const Database = require('better-sqlite3');
  sqliteDb = new Database(path.join(__dirname, 'paypulse.db'));
}

// ─── SCHEMA ─────────────────────────────────────────────────────
async function initSchema() {
  if (USE_PG) {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'agency',
        company_name TEXT DEFAULT '',
        processor TEXT DEFAULT 'stripe',
        stripe_secret_key TEXT DEFAULT '',
        stripe_publishable_key TEXT DEFAULT '',
        whop_api_key TEXT DEFAULT '',
        whop_company_id TEXT DEFAULT '',
        plan TEXT DEFAULT 'free',
        monthly_rate REAL DEFAULT 0,
        active INTEGER DEFAULT 1,
        appointment_tracking_mode INTEGER DEFAULT 0,
        stripe_customer_id TEXT DEFAULT '',
        stripe_subscription_id TEXT DEFAULT '',
        ghl_webhook_secret TEXT DEFAULT '',
        whop_webhook_secret TEXT DEFAULT '',
        failed_charge_webhook_url TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        company_name TEXT DEFAULT '',
        email TEXT NOT NULL,
        phone TEXT DEFAULT '',
        status TEXT DEFAULT 'new',
        card_on_file INTEGER DEFAULT 0,
        stripe_customer_id TEXT DEFAULT '',
        stripe_payment_method_id TEXT DEFAULT '',
        whop_member_id TEXT DEFAULT '',
        whop_payment_method_id TEXT DEFAULT '',
        rate_per_trigger REAL DEFAULT 147,
        total_charged REAL DEFAULT 0,
        total_triggers INTEGER DEFAULT 0,
        credit_balance REAL DEFAULT 0,
        ghl_location_id TEXT DEFAULT '',
        contact_created_at TIMESTAMPTZ DEFAULT NOW(),
        last_contacted_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS charges (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        customer_name TEXT DEFAULT '',
        customer_email TEXT DEFAULT '',
        amount REAL NOT NULL,
        processor TEXT DEFAULT 'stripe',
        status TEXT DEFAULT 'pending',
        stripe_charge_id TEXT DEFAULT '',
        failure_reason TEXT DEFAULT '',
        note TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        utm_source TEXT DEFAULT '',
        utm_medium TEXT DEFAULT '',
        utm_campaign TEXT DEFAULT '',
        gclid TEXT DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS appointments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        date TEXT DEFAULT '',
        time TEXT DEFAULT '',
        note TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        read INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS ad_metrics (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        source TEXT DEFAULT 'facebook',
        campaign_name TEXT DEFAULT '',
        date_from DATE,
        date_to DATE,
        ad_spend REAL DEFAULT 0,
        impressions INTEGER DEFAULT 0,
        clicks INTEGER DEFAULT 0,
        leads INTEGER DEFAULT 0,
        appointments INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS ad_metrics (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        source TEXT DEFAULT 'facebook',
        campaign_name TEXT DEFAULT '',
        date_from DATE,
        date_to DATE,
        ad_spend REAL DEFAULT 0,
        impressions INTEGER DEFAULT 0,
        clicks INTEGER DEFAULT 0,
        leads INTEGER DEFAULT 0,
        appointments INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
  } else {
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY, name TEXT NOT NULL,
                company_name TEXT DEFAULT '', email TEXT NOT NULL, password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'agency', processor TEXT DEFAULT 'stripe',
                plan TEXT DEFAULT 'free', monthly_rate REAL DEFAULT 0, active INTEGER DEFAULT 1,
                stripe_secret_key TEXT DEFAULT '', stripe_publishable_key TEXT DEFAULT '',
                stripe_customer_id TEXT DEFAULT '', stripe_subscription_id TEXT DEFAULT '',
                whop_api_key TEXT DEFAULT '', whop_company_id TEXT DEFAULT '',
                appointment_tracking_mode INTEGER DEFAULT 0,
                ghl_webhook_secret TEXT DEFAULT '', whop_webhook_secret TEXT DEFAULT '',
                failed_charge_webhook_url TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now'))
              );
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
        company_name TEXT DEFAULT '', email TEXT NOT NULL, phone TEXT DEFAULT '', status TEXT DEFAULT 'new',
        card_on_file INTEGER DEFAULT 0, stripe_customer_id TEXT DEFAULT '', stripe_payment_method_id TEXT DEFAULT '',
        whop_member_id TEXT DEFAULT '', whop_payment_method_id TEXT DEFAULT '', rate_per_trigger REAL DEFAULT 147,
        total_charged REAL DEFAULT 0, total_triggers INTEGER DEFAULT 0,
        credit_balance REAL DEFAULT 0,
        ghl_location_id TEXT DEFAULT '',
        contact_created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_contacted_at TIMESTAMP NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS charges (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, customer_id TEXT NOT NULL,
        customer_name TEXT DEFAULT '', customer_email TEXT DEFAULT '',
        amount REAL NOT NULL, processor TEXT DEFAULT 'stripe',
        status TEXT DEFAULT 'pending', stripe_charge_id TEXT DEFAULT '',
        failure_reason TEXT DEFAULT '', note TEXT DEFAULT '',
        utm_source TEXT DEFAULT '', utm_medium TEXT DEFAULT '',
        utm_campaign TEXT DEFAULT '', gclid TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS appointments (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, customer_id TEXT NOT NULL,
        status TEXT DEFAULT 'pending', date TEXT DEFAULT '', time TEXT DEFAULT '',
        note TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, read INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS ad_metrics (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, customer_id TEXT NOT NULL,
        source TEXT DEFAULT 'facebook', campaign_name TEXT DEFAULT '',
        date_from TEXT, date_to TEXT, ad_spend REAL DEFAULT 0,
        impressions INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0,
        leads INTEGER DEFAULT 0, appointments INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  // Migrations: add contact_created_at, last_contacted_at to customers
  const customerCols = ['contact_created_at', 'last_contacted_at'];
  for (const col of customerCols) {
    try {
      if (USE_PG) {
        await pgPool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS ${col} TEXT DEFAULT ''`);
      } else {
        const cols = sqliteDb.prepare("PRAGMA table_info(customers)").all();
        if (!cols.find(c => c.name === col)) {
          sqliteDb.exec(`ALTER TABLE customers ADD COLUMN ${col} TEXT DEFAULT ''`);
        }
      }
    } catch (e) {
      // ignore migration errors (column already exists etc.)
    }
  }

  // Migration: add failed_charge_webhook_url to users
  try {
    if (USE_PG) {
      await pgPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_charge_webhook_url TEXT DEFAULT ''`);
    } else {
      const cols = sqliteDb.prepare("PRAGMA table_info(users)").all();
      if (!cols.find(c => c.name === 'failed_charge_webhook_url')) {
        sqliteDb.exec(`ALTER TABLE users ADD COLUMN failed_charge_webhook_url TEXT DEFAULT ''`);
      }
    }
  } catch (e) {
    // ignore
  }

  // Migration: add utm columns to charges for SQLite
  if (!USE_PG) {
    try {
      const chargeCols = sqliteDb.prepare("PRAGMA table_info(charges)").all();
      const hasUtmSource = chargeCols.find(c => c.name === 'utm_source');
      if (!hasUtmSource) {
        sqliteDb.exec(`ALTER TABLE charges ADD COLUMN utm_source TEXT DEFAULT ''`);
        sqliteDb.exec(`ALTER TABLE charges ADD COLUMN utm_medium TEXT DEFAULT ''`);
        sqliteDb.exec(`ALTER TABLE charges ADD COLUMN utm_campaign TEXT DEFAULT ''`);
        sqliteDb.exec(`ALTER TABLE charges ADD COLUMN gclid TEXT DEFAULT ''`);
      }
    } catch (e) { /* ignore migration errors */ }
  }

  // ─── QUIZ FUNNELS SCHEMA ─────────────────────────────────────
  if (USE_PG) {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS quiz_funnels (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        niche TEXT DEFAULT '',
        slug TEXT UNIQUE NOT NULL,
        headline TEXT DEFAULT '',
        questions TEXT DEFAULT '[]',
        ghl_calendar_id TEXT DEFAULT '',
        ghl_private_token TEXT DEFAULT '',
        ghl_webhook_url TEXT DEFAULT '',
        meta_pixel_id TEXT DEFAULT '',
        success_message TEXT DEFAULT '',
        brand_color TEXT DEFAULT '#00ff88',
        active INTEGER DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS funnel_leads (
        id TEXT PRIMARY KEY,
        funnel_id TEXT NOT NULL,
        answers TEXT DEFAULT '{}',
        score REAL DEFAULT 0,
        name TEXT DEFAULT '',
        email TEXT DEFAULT '',
        phone TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
  } else {
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS quiz_funnels (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        niche TEXT DEFAULT '',
        slug TEXT UNIQUE NOT NULL,
        headline TEXT DEFAULT '',
        questions TEXT DEFAULT '[]',
        ghl_calendar_id TEXT DEFAULT '',
        ghl_private_token TEXT DEFAULT '',
        ghl_webhook_url TEXT DEFAULT '',
        meta_pixel_id TEXT DEFAULT '',
        success_message TEXT DEFAULT '',
        brand_color TEXT DEFAULT '#00ff88',
        active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS funnel_leads (
        id TEXT PRIMARY KEY,
        funnel_id TEXT NOT NULL,
        answers TEXT DEFAULT '{}',
        score REAL DEFAULT 0,
        name TEXT DEFAULT '',
        email TEXT DEFAULT '',
        phone TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  // Migration: add ghl_webhook_url to quiz_funnels for existing DBs
  try {
    if (USE_PG) {
      await pgPool.query(`ALTER TABLE quiz_funnels ADD COLUMN IF NOT EXISTS ghl_webhook_url TEXT DEFAULT ''`);
      await pgPool.query(`ALTER TABLE quiz_funnels ADD COLUMN IF NOT EXISTS meta_pixel_id TEXT DEFAULT ''`);
    } else {
      const funnelCols = sqliteDb.prepare("PRAGMA table_info(quiz_funnels)").all();
      if (!funnelCols.find(c => c.name === 'ghl_webhook_url')) {
        sqliteDb.exec(`ALTER TABLE quiz_funnels ADD COLUMN ghl_webhook_url TEXT DEFAULT ''`);
      }
      if (!funnelCols.find(c => c.name === 'meta_pixel_id')) {
        sqliteDb.exec(`ALTER TABLE quiz_funnels ADD COLUMN meta_pixel_id TEXT DEFAULT ''`);
      }
    }
  } catch (e) { /* ignore */ }
}

// ─── HELPERS ────────────────────────────────────────────────────
// Convert SQLite-style `?` placeholders to PostgreSQL `$1, $2, ...`
function convertParams(sql, params) {
  if (!USE_PG || !params.length) return { sql, params };
  let idx = 0;
  const newSql = sql.replace(/\?/g, () => `$${++idx}`);
  return { sql: newSql, params };
}

function run(sql, params = []) {
  if (USE_PG) {
    const { sql: s, params: p } = convertParams(sql, params);
    return pgPool.query(s, p);
  }
  return sqliteDb.prepare(sql).run(...params);
}

function get(sql, params = []) {
  if (USE_PG) {
    const { sql: s, params: p } = convertParams(sql, params);
    return pgPool.query(s, p).then(r => r.rows[0] || null);
  }
  return sqliteDb.prepare(sql).get(...params);
}

function all(sql, params = []) {
  if (USE_PG) {
    const { sql: s, params: p } = convertParams(sql, params);
    return pgPool.query(s, p).then(r => r.rows);
  }
  return sqliteDb.prepare(sql).all(...params);
}

function uuid() { return uuidv4(); }

// ─── USERS ──────────────────────────────────────────────────────
function createUser(data) {
  const id = uuid();
  const ghlSecret = uuid();
  const whopSecret = uuid();
  if (USE_PG) {
    // PG path: return promise
    return pgPool.query(
      `INSERT INTO users (id, email, name, password_hash, role, company_name, processor, plan, monthly_rate, ghl_webhook_secret, whop_webhook_secret)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [id, data.email, data.name, data.password_hash, data.role || 'agency', data.company_name || '',
       data.processor || 'stripe', data.plan || 'free', data.monthly_rate || 97, ghlSecret, whopSecret]
    ).then(() => getUserById(id));
  }
  // SQLite path: synchronous
  sqliteDb.prepare(
    `INSERT INTO users (id, email, name, password_hash, role, company_name, processor, plan, monthly_rate, ghl_webhook_secret, whop_webhook_secret)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, data.email, data.name, data.password_hash, data.role || 'agency', data.company_name || '',
    data.processor || 'stripe', data.plan || 'free', data.monthly_rate || 97, ghlSecret, whopSecret);
  return getUserById(id);
}

function getUserByEmail(email) { return get('SELECT * FROM users WHERE email = ?', [email]); }
function getUserById(id) { return get('SELECT * FROM users WHERE id = ?', [id]); }
function getUserByGhlSecret(secret) { return get('SELECT * FROM users WHERE ghl_webhook_secret = ?', [secret]); }
function getUserByWhopSecret(secret) { return get('SELECT * FROM users WHERE whop_webhook_secret = ?', [secret]); }

function updateUser(id, updates) {
  const keys = Object.keys(updates);
  if (keys.length === 0) return getUserById(id);
  if (USE_PG) {
    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    return pgPool.query(`UPDATE users SET ${setClauses} WHERE id = $${keys.length + 1}`, [...keys.map(k => updates[k]), id]).then(() => getUserById(id));
  }
  const setClause = keys.map(k => `${k} = ?`).join(', ');
  sqliteDb.prepare(`UPDATE users SET ${setClause} WHERE id = ?`).run(...keys.map(k => updates[k]), id);
  return getUserById(id);
}

function listUsers(role) {
  if (role) return all('SELECT * FROM users WHERE role = ?', [role]);
  return all('SELECT * FROM users');
}

// ─── CUSTOMERS ──────────────────────────────────────────────────
function createCustomer(data) {
  const id = uuid();
  if (USE_PG) {
    return pgPool.query(
      `INSERT INTO customers (id, user_id, name, company_name, email, phone, status, card_on_file, stripe_customer_id, stripe_payment_method_id, whop_member_id, whop_payment_method_id, rate_per_trigger, ghl_location_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, data.user_id, data.name, data.company_name || '', data.email, data.phone || '', data.status || 'new',
       data.card_on_file ? 1 : (data.stripe_payment_method_id || data.whop_payment_method_id ? 1 : 0), data.stripe_customer_id || '', data.stripe_payment_method_id || '',
       data.whop_member_id || '', data.whop_payment_method_id || '', data.rate_per_trigger || 147, data.ghl_location_id || '']
    ).then(() => getCustomerById(id));
  }
  sqliteDb.prepare(
    `INSERT INTO customers (id, user_id, name, company_name, email, phone, status, card_on_file, stripe_customer_id, stripe_payment_method_id, whop_member_id, whop_payment_method_id, rate_per_trigger, ghl_location_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, data.user_id, data.name, data.company_name || '', data.email, data.phone || '', data.status || 'new',
    data.card_on_file ? 1 : (data.stripe_payment_method_id || data.whop_payment_method_id ? 1 : 0), data.stripe_customer_id || '', data.stripe_payment_method_id || '',
    data.whop_member_id || '', data.whop_payment_method_id || '', data.rate_per_trigger || 147, data.ghl_location_id || '');
  return getCustomerById(id);
}

function getCustomerById(id) { return get('SELECT * FROM customers WHERE id = ?', [id]); }
function getCustomersByUser(userId) { return all('SELECT * FROM customers WHERE user_id = ? ORDER BY created_at DESC', [userId]); }
function getCustomerByEmailAndUser(email, userId) { return get('SELECT * FROM customers WHERE email = ? AND user_id = ?', [email, userId]); }
function getCustomerByLocationId(locationId, userId) { return get('SELECT * FROM customers WHERE ghl_location_id = ? AND user_id = ?', [locationId, userId]); }

function updateCustomer(id, updates) {
  const keys = Object.keys(updates);
  if (keys.length === 0) return getCustomerById(id);
  if (USE_PG) {
    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    return pgPool.query(`UPDATE customers SET ${setClauses} WHERE id = $${keys.length + 1}`, [...keys.map(k => updates[k]), id]).then(() => getCustomerById(id));
  }
  const setClause = keys.map(k => `${k} = ?`).join(', ');
  sqliteDb.prepare(`UPDATE customers SET ${setClause} WHERE id = ?`).run(...keys.map(k => updates[k]), id);
  return getCustomerById(id);
}

// ─── CHARGES ────────────────────────────────────────────────────
function createCharge(data) {
  const id = uuid();
  if (USE_PG) {
    return pgPool.query(
      `INSERT INTO charges (id, user_id, customer_id, customer_name, customer_email, amount, processor, status, stripe_charge_id, failure_reason, note, utm_source, utm_medium, utm_campaign, gclid)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [id, data.user_id, data.customer_id, data.customer_name, data.customer_email, data.amount,
       data.processor, data.status, data.stripe_charge_id || '', data.failure_reason || '', data.note || '',
       data.utm_source || '', data.utm_medium || '', data.utm_campaign || '', data.gclid || '']
    ).then(() => getChargeById(id));
  }
  sqliteDb.prepare(
    `INSERT INTO charges (id, user_id, customer_id, customer_name, customer_email, amount, processor, status, stripe_charge_id, failure_reason, note, utm_source, utm_medium, utm_campaign, gclid)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, data.user_id, data.customer_id, data.customer_name, data.customer_email, data.amount,
    data.processor, data.status, data.stripe_charge_id || '', data.failure_reason || '', data.note || '',
    data.utm_source || '', data.utm_medium || '', data.utm_campaign || '', data.gclid || '');
  return getChargeById(id);
}

function getChargeById(id) { return get('SELECT * FROM charges WHERE id = ?', [id]); }
function getChargesByUser(userId) { return all('SELECT * FROM charges WHERE user_id = ? ORDER BY created_at DESC', [userId]); }

function updateCharge(id, updates) {
  const keys = Object.keys(updates);
  if (keys.length === 0) return getChargeById(id);
  if (USE_PG) {
    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    return pgPool.query(`UPDATE charges SET ${setClauses} WHERE id = $${keys.length + 1}`, [...keys.map(k => updates[k]), id]).then(() => getChargeById(id));
  }
  const setClause = keys.map(k => `${k} = ?`).join(', ');
  sqliteDb.prepare(`UPDATE charges SET ${setClause} WHERE id = ?`).run(...keys.map(k => updates[k]), id);
  return getChargeById(id);
}

// ─── APPOINTMENTS ───────────────────────────────────────────────
function createAppointment(data) {
  const id = uuid();
  if (USE_PG) {
    return pgPool.query(
      `INSERT INTO appointments (id, user_id, customer_id, status, date, time, note) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, data.user_id, data.customer_id, data.status || 'pending', data.date || '', data.time || '', data.note || '']
    ).then(() => getAppointmentById(id));
  }
  sqliteDb.prepare(
    `INSERT INTO appointments (id, user_id, customer_id, status, date, time, note) VALUES (?,?,?,?,?,?,?)`
  ).run(id, data.user_id, data.customer_id, data.status || 'pending', data.date || '', data.time || '', data.note || '');
  return getAppointmentById(id);
}

function getAppointmentById(id) { return get('SELECT * FROM appointments WHERE id = ?', [id]); }
function getAppointmentsByUser(userId) { return all('SELECT * FROM appointments WHERE user_id = ? ORDER BY created_at DESC', [userId]); }

function updateAppointment(id, updates) {
  const keys = Object.keys(updates);
  if (keys.length === 0) return getAppointmentById(id);
  if (USE_PG) {
    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    return pgPool.query(`UPDATE appointments SET ${setClauses} WHERE id = $${keys.length + 1}`, [...keys.map(k => updates[k]), id]).then(() => getAppointmentById(id));
  }
  const setClause = keys.map(k => `${k} = ?`).join(', ');
  sqliteDb.prepare(`UPDATE appointments SET ${setClause} WHERE id = ?`).run(...keys.map(k => updates[k]), id);
  return getAppointmentById(id);
}

// ─── NOTIFICATIONS ──────────────────────────────────────────────
function addNotification(data) {
  const id = uuid();
  if (USE_PG) {
    return pgPool.query(
      `INSERT INTO notifications (id, user_id, type, title, body) VALUES ($1,$2,$3,$4,$5)`,
      [id, data.user_id, data.type, data.title, data.body]
    ).then(() => id);
  }
  sqliteDb.prepare(
    `INSERT INTO notifications (id, user_id, type, title, body) VALUES (?,?,?,?,?)`
  ).run(id, data.user_id, data.type, data.title, data.body);
  return id;
}

function getNotificationsByUser(userId) { return all('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC', [userId]); }
function markAllRead(userId) { return run('UPDATE notifications SET read = 1 WHERE user_id = ?', [userId]); }
function getUnreadCount(userId) {
  if (USE_PG) return pgPool.query('SELECT COUNT(*) as c FROM notifications WHERE user_id = $1 AND read = 0', [userId]).then(r => parseInt(r.rows[0].c));
  return sqliteDb.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND read = 0').get(userId).c;
}

// ─── AD METRICS (Facebook) ──────────────────────────────────────
function createAdMetric(data) {
  const id = uuid();
  if (USE_PG) {
    return pgPool.query(
      `INSERT INTO ad_metrics (id, user_id, customer_id, source, campaign_name, date_from, date_to, ad_spend, impressions, clicks, leads, appointments)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, data.user_id, data.customer_id, data.source || 'facebook', data.campaign_name || '',
       data.date_from || null, data.date_to || null, data.ad_spend || 0,
       data.impressions || 0, data.clicks || 0, data.leads || 0, data.appointments || 0]
    ).then(() => id);
  }
  sqliteDb.prepare(
    `INSERT INTO ad_metrics (id, user_id, customer_id, source, campaign_name, date_from, date_to, ad_spend, impressions, clicks, leads, appointments)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, data.user_id, data.customer_id, data.source || 'facebook', data.campaign_name || '',
    data.date_from || '', data.date_to || '', data.ad_spend || 0,
    data.impressions || 0, data.clicks || 0, data.leads || 0, data.appointments || 0);
  return id;
}

function getAdMetricsByCustomer(customerId) {
  return all('SELECT * FROM ad_metrics WHERE customer_id = ? ORDER BY created_at DESC', [customerId]);
}

function getAdMetricsByUser(userId) {
  return all('SELECT * FROM ad_metrics WHERE user_id = ? ORDER BY created_at DESC', [userId]);
}

function deleteAdMetric(id) {
  if (USE_PG) {
    return pgPool.query('DELETE FROM ad_metrics WHERE id = $1', [id]);
  }
  sqliteDb.prepare('DELETE FROM ad_metrics WHERE id = ?').run(id);
}

// ─── STATS ──────────────────────────────────────────────────────
function getStats(userId) {
  if (USE_PG) {
    return (async () => {
      const charged = await pgPool.query("SELECT COALESCE(SUM(amount), 0) as s FROM charges WHERE user_id = $1 AND status = 'succeeded'", [userId]);
      const failed = await pgPool.query("SELECT COUNT(*) as c FROM charges WHERE user_id = $1 AND status = 'failed'", [userId]);
      const chargebacks = await pgPool.query("SELECT COUNT(*) as c FROM charges WHERE user_id = $1 AND status = 'chargeback'", [userId]);
      const customers = await pgPool.query('SELECT COUNT(*) as c FROM customers WHERE user_id = $1', [userId]);
      const cards = await pgPool.query('SELECT COUNT(*) as c FROM customers WHERE user_id = $1 AND card_on_file = 1', [userId]);
      const triggers = await pgPool.query('SELECT COUNT(*) as c FROM charges WHERE user_id = $1', [userId]);
      return {
        totalCustomers: parseInt(customers.rows[0].c),
        cardsOnFile: parseInt(cards.rows[0].c),
        totalCharged: parseFloat(charged.rows[0].s),
        totalFailed: parseInt(failed.rows[0].c),
        totalChargebacks: parseInt(chargebacks.rows[0].c),
        totalTriggers: parseInt(triggers.rows[0].c)
      };
    })();
  }
  const totalCharged = sqliteDb.prepare("SELECT COALESCE(SUM(amount), 0) as s FROM charges WHERE user_id = ? AND status = 'succeeded'").get(userId).s;
  const totalFailed = sqliteDb.prepare("SELECT COUNT(*) as c FROM charges WHERE user_id = ? AND status = 'failed'").get(userId).c;
  const totalChargebacks = sqliteDb.prepare("SELECT COUNT(*) as c FROM charges WHERE user_id = ? AND status = 'chargeback'").get(userId).c;
  const totalCustomers = sqliteDb.prepare('SELECT COUNT(*) as c FROM customers WHERE user_id = ?').get(userId).c;
  const cardsOnFile = sqliteDb.prepare('SELECT COUNT(*) as c FROM customers WHERE user_id = ? AND card_on_file = 1').get(userId).c;
  const totalTriggers = sqliteDb.prepare('SELECT COUNT(*) as c FROM charges WHERE user_id = ?').get(userId).c;
  return { totalCustomers, cardsOnFile, totalCharged, totalFailed, totalChargebacks, totalTriggers };
}

function getAdminStats() {
  if (USE_PG) {
    return (async () => {
      const agencies = await pgPool.query("SELECT COUNT(*) as c FROM users WHERE role = 'agency'");
      const active = await pgPool.query("SELECT COUNT(*) as c FROM users WHERE role = 'agency' AND active = 1");
      const mrr = await pgPool.query("SELECT COALESCE(SUM(monthly_rate), 0) as s FROM users WHERE role = 'agency' AND active = 1");
      const charges = await pgPool.query("SELECT COALESCE(SUM(amount), 0) as s FROM charges WHERE status = 'succeeded'");
      const customers = await pgPool.query('SELECT COUNT(*) as c FROM customers');
      return {
        totalAgencies: parseInt(agencies.rows[0].c),
        activeAgencies: parseInt(active.rows[0].c),
        totalRevenue: parseFloat(mrr.rows[0].s),
        totalCharges: parseFloat(charges.rows[0].s),
        totalCustomers: parseInt(customers.rows[0].c)
      };
    })();
  }
  const totalAgencies = sqliteDb.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'agency'").get().c;
  const activeAgencies = sqliteDb.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'agency' AND active = 1").get().c;
  const totalRevenue = sqliteDb.prepare("SELECT COALESCE(SUM(monthly_rate), 0) as s FROM users WHERE role = 'agency' AND active = 1").get().s;
  const totalCharges = sqliteDb.prepare("SELECT COALESCE(SUM(amount), 0) as s FROM charges WHERE status = 'succeeded'").get().s;
  const totalCustomers = sqliteDb.prepare('SELECT COUNT(*) as c FROM customers').get().c;
  return { totalAgencies, activeAgencies, totalRevenue, totalCharges, totalCustomers };
}

async function ensureAdmin() {
  const existing = await get("SELECT * FROM users WHERE email = ? LIMIT 1", [process.env.ADMIN_EMAIL || 'admin@paypulse.co']);
  if (!existing) {
    const bcrypt = require('bcrypt');
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@paypulse.co';
    const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
    const hash = bcrypt.hashSync(adminPass, 10);
    await createUser({ email: adminEmail, name: 'Admin', password_hash: hash, role: 'admin', company_name: 'PayPulse', plan: 'admin' });
    console.log('  ✓ Admin created: ' + adminEmail + ' / ' + adminPass);
  } else {
    console.log('  ✓ Admin exists: ' + existing.email);
  }
}

// ─── QUIZ FUNNELS ────────────────────────────────────────────────
function createFunnel(data) {
  const id = uuid();
  const slug = data.slug || id.slice(0, 8);
  const now = USE_PG ? 'NOW()' : "datetime('now')";
  const cols = ['id','user_id','name','niche','slug','headline','questions','ghl_calendar_id','ghl_private_token','ghl_webhook_url','meta_pixel_id','success_message','brand_color','active'];
  const vals = [id, data.user_id, data.name, data.niche||'', slug, data.headline||'', JSON.stringify(data.questions||[]), data.ghl_calendar_id||'', data.ghl_private_token||'', data.ghl_webhook_url||'', data.meta_pixel_id||'', data.success_message||'', data.brand_color||'#00ff88', data.active!==undefined ? (data.active?1:0) : 1];
  const placeholders = vals.map(() => '?').join(',');
  const pgPlaceholders = vals.map((_,i) => `$${i+1}`).join(',');
  if (USE_PG) {
    return pgPool.query(`INSERT INTO quiz_funnels (${cols.join(',')}) VALUES (${pgPlaceholders})`, vals).then(() => getFunnelById(id));
  }
  sqliteDb.prepare(`INSERT INTO quiz_funnels (${cols.join(',')}) VALUES (${placeholders})`).run(...vals);
  return getFunnelById(id);
}
function getFunnelById(id) { return get('SELECT * FROM quiz_funnels WHERE id = ?', [id]); }
function getUserFunnels(userId) { return all('SELECT * FROM quiz_funnels WHERE user_id = ? ORDER BY created_at DESC', [userId]); }
function getFunnelBySlug(slug) { return get('SELECT * FROM quiz_funnels WHERE slug = ?', [slug]); }
function updateFunnel(id, updates) {
  const keys = Object.keys(updates);
  if (keys.length === 0) return getFunnelById(id);
  const data = {};
  for (const k of keys) {
    if (k === 'questions') data[k] = JSON.stringify(updates[k]);
    else if (k === 'active') data[k] = updates[k] ? 1 : 0;
    else data[k] = updates[k];
  }
  const finalKeys = Object.keys(data);
  if (USE_PG) {
    const setClauses = finalKeys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    return pgPool.query(`UPDATE quiz_funnels SET ${setClauses} WHERE id = $${finalKeys.length + 1}`, [...finalKeys.map(k => data[k]), id]).then(() => getFunnelById(id));
  }
  const setClause = finalKeys.map(k => `${k} = ?`).join(', ');
  sqliteDb.prepare(`UPDATE quiz_funnels SET ${setClause} WHERE id = ?`).run(...finalKeys.map(k => data[k]), id);
  return getFunnelById(id);
}
function deleteFunnel(id) {
  if (USE_PG) {
    return pgPool.query('DELETE FROM quiz_funnels WHERE id = $1', [id]).then(() => pgPool.query('DELETE FROM funnel_leads WHERE funnel_id = $1', [id]));
  }
  sqliteDb.prepare('DELETE FROM quiz_funnels WHERE id = ?').run(id);
  sqliteDb.prepare('DELETE FROM funnel_leads WHERE funnel_id = ?').run(id);
}

// ─── FUNNEL LEADS ──────────────────────────────────────────────
function createFunnelLead(data) {
  const id = uuid();
  const cols = ['id','funnel_id','answers','score','name','email','phone'];
  const vals = [id, data.funnel_id, JSON.stringify(data.answers||{}), data.score||0, data.name||'', data.email||'', data.phone||''];
  if (USE_PG) {
    const pgPlaceholders = vals.map((_,i) => `$${i+1}`).join(',');
    return pgPool.query(`INSERT INTO funnel_leads (${cols.join(',')}) VALUES (${pgPlaceholders})`, vals).then(() => id);
  }
  sqliteDb.prepare(`INSERT INTO funnel_leads (${cols.join(',')}) VALUES (${vals.map(()=>'?').join(',')})`).run(...vals);
  return id;
}
function getFunnelLeads(funnelId) {
  return all('SELECT * FROM funnel_leads WHERE funnel_id = ? ORDER BY created_at DESC', [funnelId]);
}

module.exports = {
  initSchema,
  all, run, get,
  createUser, getUserByEmail, getUserById, getUserByGhlSecret, getUserByWhopSecret, updateUser, listUsers,
  createCustomer, getCustomerById, getCustomersByUser, getCustomerByEmailAndUser, getCustomerByLocationId, updateCustomer,
  createCharge, getChargeById, getChargesByUser, updateCharge,
  createAppointment, getAppointmentById, getAppointmentsByUser, updateAppointment,
  addNotification, getNotificationsByUser, markAllRead, getUnreadCount,
  createAdMetric, getAdMetricsByCustomer, getAdMetricsByUser, deleteAdMetric,
  getStats, getAdminStats,
  ensureAdmin,
  createFunnel, getFunnelById, getUserFunnels, getFunnelBySlug, updateFunnel, deleteFunnel,
  createFunnelLead, getFunnelLeads,
};
