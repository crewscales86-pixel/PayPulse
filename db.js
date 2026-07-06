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
        alert_email TEXT DEFAULT '',
        email_notifications_enabled INTEGER DEFAULT 0,
        communication_templates_json TEXT DEFAULT '',
        meta_access_token TEXT DEFAULT '',
        meta_token_expires_at TEXT DEFAULT '',
        meta_ad_account_id TEXT DEFAULT '',
        meta_ad_account_name TEXT DEFAULT '',
        approved INTEGER DEFAULT 0,
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
        retry_count INTEGER DEFAULT 0,
        next_retry_at TIMESTAMPTZ NULL,
        retry_status TEXT DEFAULT 'none',
        refunded_amount REAL DEFAULT 0,
        refunded_at TIMESTAMPTZ NULL,
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
        ad_account_id TEXT DEFAULT '',
        ad_account_name TEXT DEFAULT '',
        campaign_id TEXT DEFAULT '',
        campaign_name TEXT DEFAULT '',
        adset_id TEXT DEFAULT '',
        adset_name TEXT DEFAULT '',
        date_from DATE,
        date_to DATE,
        ad_spend REAL DEFAULT 0,
        impressions INTEGER DEFAULT 0,
        clicks INTEGER DEFAULT 0,
        ctr REAL DEFAULT 0,
        cpc REAL DEFAULT 0,
        leads INTEGER DEFAULT 0,
        appointments INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        actor_user_id TEXT DEFAULT '',
        actor_email TEXT DEFAULT '',
        customer_id TEXT DEFAULT '',
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        action TEXT NOT NULL,
        details TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS webhook_events (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        source TEXT NOT NULL,
        event_type TEXT DEFAULT '',
        event_key TEXT NOT NULL,
        secret_fragment TEXT DEFAULT '',
        status TEXT DEFAULT 'received',
        payload TEXT DEFAULT '',
        response TEXT DEFAULT '',
        duplicate_of TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS customer_notes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        body TEXT NOT NULL,
        category TEXT DEFAULT 'internal',
        recurring INTEGER DEFAULT 0,
        next_due_at TIMESTAMPTZ NULL,
        is_done INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS saved_segments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        filters_json TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS meta_campaign_mappings (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        ad_account_id TEXT NOT NULL,
        ad_account_name TEXT DEFAULT '',
        campaign_id TEXT NOT NULL,
        campaign_name TEXT DEFAULT '',
        adset_id TEXT DEFAULT '',
        adset_name TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS communication_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        template_key TEXT DEFAULT '',
        subject TEXT DEFAULT '',
        body TEXT NOT NULL,
        status TEXT DEFAULT 'prepared',
        metadata TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_event_key_idx
        ON webhook_events (user_id, source, event_key);
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
                alert_email TEXT DEFAULT '',
                email_notifications_enabled INTEGER DEFAULT 0,
                communication_templates_json TEXT DEFAULT '',
                meta_access_token TEXT DEFAULT '',
                meta_token_expires_at TEXT DEFAULT '',
                meta_ad_account_id TEXT DEFAULT '',
                meta_ad_account_name TEXT DEFAULT '',
                approved INTEGER DEFAULT 0,
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
        retry_count INTEGER DEFAULT 0, next_retry_at TEXT DEFAULT '',
        retry_status TEXT DEFAULT 'none', refunded_amount REAL DEFAULT 0,
        refunded_at TEXT DEFAULT '',
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
        source TEXT DEFAULT 'facebook', ad_account_id TEXT DEFAULT '', ad_account_name TEXT DEFAULT '',
        campaign_id TEXT DEFAULT '', campaign_name TEXT DEFAULT '', adset_id TEXT DEFAULT '', adset_name TEXT DEFAULT '',
        date_from TEXT, date_to TEXT, ad_spend REAL DEFAULT 0,
        impressions INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0, ctr REAL DEFAULT 0, cpc REAL DEFAULT 0,
        leads INTEGER DEFAULT 0, appointments INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY, actor_user_id TEXT DEFAULT '', actor_email TEXT DEFAULT '',
        customer_id TEXT DEFAULT '', target_type TEXT NOT NULL, target_id TEXT NOT NULL,
        action TEXT NOT NULL, details TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS webhook_events (
        id TEXT PRIMARY KEY, customer_id TEXT DEFAULT '', user_id TEXT NOT NULL,
        source TEXT NOT NULL, event_type TEXT DEFAULT '', event_key TEXT NOT NULL,
        secret_fragment TEXT DEFAULT '', status TEXT DEFAULT 'received',
        payload TEXT DEFAULT '', response TEXT DEFAULT '', duplicate_of TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_event_key_idx
        ON webhook_events (user_id, source, event_key);
      CREATE TABLE IF NOT EXISTS customer_notes (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, customer_id TEXT NOT NULL,
        body TEXT NOT NULL, category TEXT DEFAULT 'internal', recurring INTEGER DEFAULT 0,
        next_due_at TEXT DEFAULT '', is_done INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS saved_segments (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
        filters_json TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS meta_campaign_mappings (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, customer_id TEXT NOT NULL,
        ad_account_id TEXT NOT NULL, ad_account_name TEXT DEFAULT '',
        campaign_id TEXT NOT NULL, campaign_name TEXT DEFAULT '',
        adset_id TEXT DEFAULT '', adset_name TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS communication_logs (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, customer_id TEXT NOT NULL,
        channel TEXT NOT NULL, template_key TEXT DEFAULT '',
        subject TEXT DEFAULT '', body TEXT NOT NULL,
        status TEXT DEFAULT 'prepared', metadata TEXT DEFAULT '',
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
      await pgPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS alert_email TEXT DEFAULT ''`);
      await pgPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_notifications_enabled INTEGER DEFAULT 0`);
      await pgPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS communication_templates_json TEXT DEFAULT ''`);
      await pgPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS meta_access_token TEXT DEFAULT ''`);
      await pgPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS meta_token_expires_at TEXT DEFAULT ''`);
      await pgPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS meta_ad_account_id TEXT DEFAULT ''`);
      await pgPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS meta_ad_account_name TEXT DEFAULT ''`);
    } else {
      const cols = sqliteDb.prepare("PRAGMA table_info(users)").all();
      if (!cols.find(c => c.name === 'failed_charge_webhook_url')) {
        sqliteDb.exec(`ALTER TABLE users ADD COLUMN failed_charge_webhook_url TEXT DEFAULT ''`);
      }
      if (!cols.find(c => c.name === 'alert_email')) {
        sqliteDb.exec(`ALTER TABLE users ADD COLUMN alert_email TEXT DEFAULT ''`);
      }
      if (!cols.find(c => c.name === 'email_notifications_enabled')) {
        sqliteDb.exec(`ALTER TABLE users ADD COLUMN email_notifications_enabled INTEGER DEFAULT 0`);
      }
      if (!cols.find(c => c.name === 'communication_templates_json')) {
        sqliteDb.exec(`ALTER TABLE users ADD COLUMN communication_templates_json TEXT DEFAULT ''`);
      }
      if (!cols.find(c => c.name === 'meta_access_token')) {
        sqliteDb.exec(`ALTER TABLE users ADD COLUMN meta_access_token TEXT DEFAULT ''`);
      }
      if (!cols.find(c => c.name === 'meta_token_expires_at')) {
        sqliteDb.exec(`ALTER TABLE users ADD COLUMN meta_token_expires_at TEXT DEFAULT ''`);
      }
      if (!cols.find(c => c.name === 'meta_ad_account_id')) {
        sqliteDb.exec(`ALTER TABLE users ADD COLUMN meta_ad_account_id TEXT DEFAULT ''`);
      }
      if (!cols.find(c => c.name === 'meta_ad_account_name')) {
        sqliteDb.exec(`ALTER TABLE users ADD COLUMN meta_ad_account_name TEXT DEFAULT ''`);
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

  // Migrations: add retry/refund columns to charges
  try {
    if (USE_PG) {
      await pgPool.query(`ALTER TABLE charges ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0`);
      await pgPool.query(`ALTER TABLE charges ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ NULL`);
      await pgPool.query(`ALTER TABLE charges ADD COLUMN IF NOT EXISTS retry_status TEXT DEFAULT 'none'`);
      await pgPool.query(`ALTER TABLE charges ADD COLUMN IF NOT EXISTS refunded_amount REAL DEFAULT 0`);
      await pgPool.query(`ALTER TABLE charges ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ NULL`);
    } else {
      const chargeCols = sqliteDb.prepare("PRAGMA table_info(charges)").all();
      if (!chargeCols.find(c => c.name === 'retry_count')) sqliteDb.exec(`ALTER TABLE charges ADD COLUMN retry_count INTEGER DEFAULT 0`);
      if (!chargeCols.find(c => c.name === 'next_retry_at')) sqliteDb.exec(`ALTER TABLE charges ADD COLUMN next_retry_at TEXT DEFAULT ''`);
      if (!chargeCols.find(c => c.name === 'retry_status')) sqliteDb.exec(`ALTER TABLE charges ADD COLUMN retry_status TEXT DEFAULT 'none'`);
      if (!chargeCols.find(c => c.name === 'refunded_amount')) sqliteDb.exec(`ALTER TABLE charges ADD COLUMN refunded_amount REAL DEFAULT 0`);
      if (!chargeCols.find(c => c.name === 'refunded_at')) sqliteDb.exec(`ALTER TABLE charges ADD COLUMN refunded_at TEXT DEFAULT ''`);
    }
  } catch (e) { /* ignore */ }

  // Migration: expand ad_metrics for native Meta tracking
  try {
    if (USE_PG) {
      await pgPool.query(`ALTER TABLE ad_metrics ADD COLUMN IF NOT EXISTS ad_account_id TEXT DEFAULT ''`);
      await pgPool.query(`ALTER TABLE ad_metrics ADD COLUMN IF NOT EXISTS ad_account_name TEXT DEFAULT ''`);
      await pgPool.query(`ALTER TABLE ad_metrics ADD COLUMN IF NOT EXISTS campaign_id TEXT DEFAULT ''`);
      await pgPool.query(`ALTER TABLE ad_metrics ADD COLUMN IF NOT EXISTS adset_id TEXT DEFAULT ''`);
      await pgPool.query(`ALTER TABLE ad_metrics ADD COLUMN IF NOT EXISTS adset_name TEXT DEFAULT ''`);
      await pgPool.query(`ALTER TABLE ad_metrics ADD COLUMN IF NOT EXISTS ctr REAL DEFAULT 0`);
      await pgPool.query(`ALTER TABLE ad_metrics ADD COLUMN IF NOT EXISTS cpc REAL DEFAULT 0`);
    } else {
      const cols = sqliteDb.prepare("PRAGMA table_info(ad_metrics)").all();
      if (!cols.find(c => c.name === 'ad_account_id')) sqliteDb.exec(`ALTER TABLE ad_metrics ADD COLUMN ad_account_id TEXT DEFAULT ''`);
      if (!cols.find(c => c.name === 'ad_account_name')) sqliteDb.exec(`ALTER TABLE ad_metrics ADD COLUMN ad_account_name TEXT DEFAULT ''`);
      if (!cols.find(c => c.name === 'campaign_id')) sqliteDb.exec(`ALTER TABLE ad_metrics ADD COLUMN campaign_id TEXT DEFAULT ''`);
      if (!cols.find(c => c.name === 'adset_id')) sqliteDb.exec(`ALTER TABLE ad_metrics ADD COLUMN adset_id TEXT DEFAULT ''`);
      if (!cols.find(c => c.name === 'adset_name')) sqliteDb.exec(`ALTER TABLE ad_metrics ADD COLUMN adset_name TEXT DEFAULT ''`);
      if (!cols.find(c => c.name === 'ctr')) sqliteDb.exec(`ALTER TABLE ad_metrics ADD COLUMN ctr REAL DEFAULT 0`);
      if (!cols.find(c => c.name === 'cpc')) sqliteDb.exec(`ALTER TABLE ad_metrics ADD COLUMN cpc REAL DEFAULT 0`);
    }
  } catch (e) { /* ignore */ }

  // Migration: expand meta_campaign_mappings for ad set routing
  try {
    if (USE_PG) {
      await pgPool.query(`ALTER TABLE meta_campaign_mappings ADD COLUMN IF NOT EXISTS ad_account_name TEXT DEFAULT ''`);
      await pgPool.query(`ALTER TABLE meta_campaign_mappings ADD COLUMN IF NOT EXISTS adset_id TEXT DEFAULT ''`);
      await pgPool.query(`ALTER TABLE meta_campaign_mappings ADD COLUMN IF NOT EXISTS adset_name TEXT DEFAULT ''`);
    } else {
      const cols = sqliteDb.prepare("PRAGMA table_info(meta_campaign_mappings)").all();
      if (cols.length) {
        if (!cols.find(c => c.name === 'ad_account_name')) sqliteDb.exec(`ALTER TABLE meta_campaign_mappings ADD COLUMN ad_account_name TEXT DEFAULT ''`);
        if (!cols.find(c => c.name === 'adset_id')) sqliteDb.exec(`ALTER TABLE meta_campaign_mappings ADD COLUMN adset_id TEXT DEFAULT ''`);
        if (!cols.find(c => c.name === 'adset_name')) sqliteDb.exec(`ALTER TABLE meta_campaign_mappings ADD COLUMN adset_name TEXT DEFAULT ''`);
      }
    }
  } catch (e) { /* ignore */ }

  // Migration: add approved column to users
  try {
    if (USE_PG) {
      await pgPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS approved INTEGER DEFAULT 0`);
    } else {
      const cols = sqliteDb.prepare("PRAGMA table_info(users)").all();
      if (!cols.find(c => c.name === 'approved')) {
        sqliteDb.exec(`ALTER TABLE users ADD COLUMN approved INTEGER DEFAULT 0`);
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
      `INSERT INTO users (id, email, name, password_hash, role, company_name, processor, plan, monthly_rate, ghl_webhook_secret, whop_webhook_secret, approved)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [id, data.email, data.name, data.password_hash, data.role || 'agency', data.company_name || '',
       data.processor || 'stripe', data.plan || 'free', data.monthly_rate ?? 97, ghlSecret, whopSecret, data.approved !== undefined ? (data.approved ? 1 : 0) : 1]
    ).then(() => getUserById(id));
  }
  // SQLite path: synchronous
  sqliteDb.prepare(
    `INSERT INTO users (id, email, name, password_hash, role, company_name, processor, plan, monthly_rate, ghl_webhook_secret, whop_webhook_secret, approved)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, data.email, data.name, data.password_hash, data.role || 'agency', data.company_name || '',
    data.processor || 'stripe', data.plan || 'free', data.monthly_rate ?? 97, ghlSecret, whopSecret, data.approved !== undefined ? (data.approved ? 1 : 0) : 1);
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
       data.whop_member_id || '', data.whop_payment_method_id || '', data.rate_per_trigger !== undefined ? data.rate_per_trigger : 147, data.ghl_location_id || '']
    ).then(() => getCustomerById(id));
  }
  sqliteDb.prepare(
    `INSERT INTO customers (id, user_id, name, company_name, email, phone, status, card_on_file, stripe_customer_id, stripe_payment_method_id, whop_member_id, whop_payment_method_id, rate_per_trigger, ghl_location_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, data.user_id, data.name, data.company_name || '', data.email, data.phone || '', data.status || 'new',
    data.card_on_file ? 1 : (data.stripe_payment_method_id || data.whop_payment_method_id ? 1 : 0), data.stripe_customer_id || '', data.stripe_payment_method_id || '',
    data.whop_member_id || '', data.whop_payment_method_id || '', data.rate_per_trigger !== undefined ? data.rate_per_trigger : 147, data.ghl_location_id || '');
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
      `INSERT INTO ad_metrics (id, user_id, customer_id, source, ad_account_id, ad_account_name, campaign_id, campaign_name, adset_id, adset_name, date_from, date_to, ad_spend, impressions, clicks, ctr, cpc, leads, appointments)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [id, data.user_id, data.customer_id, data.source || 'facebook', data.ad_account_id || '', data.ad_account_name || '',
       data.campaign_id || '', data.campaign_name || '', data.adset_id || '', data.adset_name || '',
       data.date_from || null, data.date_to || null, data.ad_spend || 0,
       data.impressions || 0, data.clicks || 0, data.ctr || 0, data.cpc || 0, data.leads || 0, data.appointments || 0]
    ).then(() => id);
  }
  sqliteDb.prepare(
    `INSERT INTO ad_metrics (id, user_id, customer_id, source, ad_account_id, ad_account_name, campaign_id, campaign_name, adset_id, adset_name, date_from, date_to, ad_spend, impressions, clicks, ctr, cpc, leads, appointments)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, data.user_id, data.customer_id, data.source || 'facebook', data.ad_account_id || '', data.ad_account_name || '',
    data.campaign_id || '', data.campaign_name || '', data.adset_id || '', data.adset_name || '',
    data.date_from || '', data.date_to || '', data.ad_spend || 0,
    data.impressions || 0, data.clicks || 0, data.ctr || 0, data.cpc || 0, data.leads || 0, data.appointments || 0);
  return id;
}

function getAdMetricsByCustomer(customerId) {
  return all('SELECT * FROM ad_metrics WHERE customer_id = ? ORDER BY created_at DESC', [customerId]);
}

function getAdMetricsByUser(userId) {
  return all('SELECT * FROM ad_metrics WHERE user_id = ? ORDER BY created_at DESC', [userId]);
}

function getAdMetricById(id) {
  return get('SELECT * FROM ad_metrics WHERE id = ?', [id]);
}

function deleteAdMetric(id) {
  if (USE_PG) {
    return pgPool.query('DELETE FROM ad_metrics WHERE id = $1', [id]);
  }
  sqliteDb.prepare('DELETE FROM ad_metrics WHERE id = ?').run(id);
}

// ─── AUDIT LOGS ──────────────────────────────────────────────────
function createAuditLog(data) {
  const id = uuid();
  const params = [
    id,
    data.actor_user_id || '',
    data.actor_email || '',
    data.customer_id || '',
    data.target_type,
    data.target_id,
    data.action,
    data.details || ''
  ];
  if (USE_PG) {
    return pgPool.query(
      `INSERT INTO audit_logs (id, actor_user_id, actor_email, customer_id, target_type, target_id, action, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      params
    ).then(() => id);
  }
  sqliteDb.prepare(
    `INSERT INTO audit_logs (id, actor_user_id, actor_email, customer_id, target_type, target_id, action, details)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(...params);
  return id;
}

function getAuditLogsByUser(userId, limit = 100) {
  return all('SELECT * FROM audit_logs WHERE actor_user_id = ? OR details LIKE ? ORDER BY created_at DESC LIMIT ?', [userId, `%"user_id":"${userId}"%`, limit]);
}

function getAuditLogsByCustomer(customerId, userId, limit = 100) {
  return all(
    'SELECT * FROM audit_logs WHERE customer_id = ? AND (actor_user_id = ? OR details LIKE ?) ORDER BY created_at DESC LIMIT ?',
    [customerId, userId, `%"customer_id":"${customerId}"%`, limit]
  );
}

// ─── WEBHOOK EVENTS ──────────────────────────────────────────────
function createWebhookEvent(data) {
  const id = uuid();
  const params = [
    id,
    data.customer_id || '',
    data.user_id,
    data.source,
    data.event_type || '',
    data.event_key,
    data.secret_fragment || '',
    data.status || 'received',
    data.payload || '',
    data.response || '',
    data.duplicate_of || ''
  ];
  if (USE_PG) {
    return pgPool.query(
      `INSERT INTO webhook_events (id, customer_id, user_id, source, event_type, event_key, secret_fragment, status, payload, response, duplicate_of)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      params
    ).then(() => getWebhookEventById(id));
  }
  sqliteDb.prepare(
    `INSERT INTO webhook_events (id, customer_id, user_id, source, event_type, event_key, secret_fragment, status, payload, response, duplicate_of)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(...params);
  return getWebhookEventById(id);
}

function getWebhookEventById(id) {
  return get('SELECT * FROM webhook_events WHERE id = ?', [id]);
}

function getWebhookEventByKey(userId, source, eventKey) {
  return get('SELECT * FROM webhook_events WHERE user_id = ? AND source = ? AND event_key = ?', [userId, source, eventKey]);
}

function updateWebhookEvent(id, updates) {
  const keys = Object.keys(updates);
  if (keys.length === 0) return getWebhookEventById(id);
  if (USE_PG) {
    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    return pgPool.query(`UPDATE webhook_events SET ${setClauses} WHERE id = $${keys.length + 1}`, [...keys.map(k => updates[k]), id]).then(() => getWebhookEventById(id));
  }
  const setClause = keys.map(k => `${k} = ?`).join(', ');
  sqliteDb.prepare(`UPDATE webhook_events SET ${setClause} WHERE id = ?`).run(...keys.map(k => updates[k]), id);
  return getWebhookEventById(id);
}

function getWebhookEventsByUser(userId, limit = 100) {
  return all('SELECT * FROM webhook_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [userId, limit]);
}

// ─── NOTES ───────────────────────────────────────────────────────
function createCustomerNote(data) {
  const id = uuid();
  const params = [
    id,
    data.user_id,
    data.customer_id,
    data.body,
    data.category || 'internal',
    data.recurring ? 1 : 0,
    data.next_due_at || '',
    data.is_done ? 1 : 0
  ];
  if (USE_PG) {
    return pgPool.query(
      `INSERT INTO customer_notes (id, user_id, customer_id, body, category, recurring, next_due_at, is_done)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      params
    ).then(() => getCustomerNoteById(id));
  }
  sqliteDb.prepare(
    `INSERT INTO customer_notes (id, user_id, customer_id, body, category, recurring, next_due_at, is_done)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(...params);
  return getCustomerNoteById(id);
}

function getCustomerNoteById(id) {
  return get('SELECT * FROM customer_notes WHERE id = ?', [id]);
}

function getCustomerNotesByCustomer(customerId, userId) {
  return all('SELECT * FROM customer_notes WHERE customer_id = ? AND user_id = ? ORDER BY created_at DESC', [customerId, userId]);
}

function updateCustomerNote(id, updates) {
  const keys = Object.keys(updates);
  if (keys.length === 0) return getCustomerNoteById(id);
  if (USE_PG) {
    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    return pgPool.query(`UPDATE customer_notes SET ${setClauses} WHERE id = $${keys.length + 1}`, [...keys.map(k => updates[k]), id]).then(() => getCustomerNoteById(id));
  }
  const setClause = keys.map(k => `${k} = ?`).join(', ');
  sqliteDb.prepare(`UPDATE customer_notes SET ${setClause} WHERE id = ?`).run(...keys.map(k => updates[k]), id);
  return getCustomerNoteById(id);
}

function deleteCustomerNote(id) {
  if (USE_PG) return pgPool.query('DELETE FROM customer_notes WHERE id = $1', [id]);
  sqliteDb.prepare('DELETE FROM customer_notes WHERE id = ?').run(id);
}

// ─── SEGMENTS ────────────────────────────────────────────────────
function createSavedSegment(data) {
  const id = uuid();
  const params = [id, data.user_id, data.name, data.filters_json];
  if (USE_PG) {
    return pgPool.query(
      `INSERT INTO saved_segments (id, user_id, name, filters_json) VALUES ($1,$2,$3,$4)`,
      params
    ).then(() => getSavedSegmentById(id));
  }
  sqliteDb.prepare(
    `INSERT INTO saved_segments (id, user_id, name, filters_json) VALUES (?,?,?,?)`
  ).run(...params);
  return getSavedSegmentById(id);
}

function getSavedSegmentById(id) {
  return get('SELECT * FROM saved_segments WHERE id = ?', [id]);
}

function getSavedSegmentsByUser(userId) {
  return all('SELECT * FROM saved_segments WHERE user_id = ? ORDER BY created_at DESC', [userId]);
}

function deleteSavedSegment(id) {
  if (USE_PG) return pgPool.query('DELETE FROM saved_segments WHERE id = $1', [id]);
  sqliteDb.prepare('DELETE FROM saved_segments WHERE id = ?').run(id);
}

// ─── META CAMPAIGN MAPPINGS ────────────────────────────────────
function createMetaCampaignMapping(data) {
  const id = uuid();
  const params = [id, data.user_id, data.customer_id, data.ad_account_id, data.ad_account_name || '', data.campaign_id, data.campaign_name || '', data.adset_id || '', data.adset_name || ''];
  if (USE_PG) {
    return pgPool.query(
      `INSERT INTO meta_campaign_mappings (id, user_id, customer_id, ad_account_id, ad_account_name, campaign_id, campaign_name, adset_id, adset_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      params
    ).then(() => getMetaCampaignMappingById(id));
  }
  sqliteDb.prepare(
    `INSERT INTO meta_campaign_mappings (id, user_id, customer_id, ad_account_id, ad_account_name, campaign_id, campaign_name, adset_id, adset_name)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(...params);
  return getMetaCampaignMappingById(id);
}

function getMetaCampaignMappingById(id) {
  return get('SELECT * FROM meta_campaign_mappings WHERE id = ?', [id]);
}

function getMetaCampaignMappingsByCustomer(customerId, userId) {
  return all(
    'SELECT * FROM meta_campaign_mappings WHERE customer_id = ? AND user_id = ? ORDER BY created_at DESC',
    [customerId, userId]
  );
}

async function replaceMetaCampaignMappings(customerId, userId, mappings) {
  await run('DELETE FROM meta_campaign_mappings WHERE customer_id = ? AND user_id = ?', [customerId, userId]);
  const created = [];
  for (const mapping of mappings) {
    created.push(await createMetaCampaignMapping({
      user_id: userId,
      customer_id: customerId,
      ad_account_id: mapping.ad_account_id,
      ad_account_name: mapping.ad_account_name || '',
      campaign_id: mapping.campaign_id,
      campaign_name: mapping.campaign_name || '',
      adset_id: mapping.adset_id || '',
      adset_name: mapping.adset_name || ''
    }));
  }
  return created;
}

// ─── COMMUNICATIONS ─────────────────────────────────────────────
function createCommunicationLog(data) {
  const id = uuid();
  const params = [
    id,
    data.user_id,
    data.customer_id,
    data.channel,
    data.template_key || '',
    data.subject || '',
    data.body,
    data.status || 'prepared',
    data.metadata || ''
  ];
  if (USE_PG) {
    return pgPool.query(
      `INSERT INTO communication_logs (id, user_id, customer_id, channel, template_key, subject, body, status, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      params
    ).then(() => getCommunicationLogById(id));
  }
  sqliteDb.prepare(
    `INSERT INTO communication_logs (id, user_id, customer_id, channel, template_key, subject, body, status, metadata)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(...params);
  return getCommunicationLogById(id);
}

function getCommunicationLogById(id) {
  return get('SELECT * FROM communication_logs WHERE id = ?', [id]);
}

function getCommunicationLogsByCustomer(customerId, userId, limit = 100) {
  return all(
    'SELECT * FROM communication_logs WHERE customer_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?',
    [customerId, userId, limit]
  );
}

function getCommunicationLogsByUser(userId, limit = 200) {
  return all(
    'SELECT * FROM communication_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    [userId, limit]
  );
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
    await createUser({ email: adminEmail, name: 'Admin', password_hash: hash, role: 'admin', company_name: 'PayPulse', plan: 'admin', approved: 1 });
    console.log('  ✓ Admin created: ' + adminEmail + ' / ' + adminPass);
  } else {
    console.log('  ✓ Admin exists: ' + existing.email);
  }
}



module.exports = {
  initSchema,
  all, run, get,
  createUser, getUserByEmail, getUserById, getUserByGhlSecret, getUserByWhopSecret, updateUser, listUsers,
  createCustomer, getCustomerById, getCustomersByUser, getCustomerByEmailAndUser, getCustomerByLocationId, updateCustomer,
  createCharge, getChargeById, getChargesByUser, updateCharge,
  createAppointment, getAppointmentById, getAppointmentsByUser, updateAppointment,
  addNotification, getNotificationsByUser, markAllRead, getUnreadCount,
  createAdMetric, getAdMetricById, getAdMetricsByCustomer, getAdMetricsByUser, deleteAdMetric,
  createAuditLog, getAuditLogsByUser, getAuditLogsByCustomer,
  createWebhookEvent, getWebhookEventById, getWebhookEventByKey, updateWebhookEvent, getWebhookEventsByUser,
  createCustomerNote, getCustomerNoteById, getCustomerNotesByCustomer, updateCustomerNote, deleteCustomerNote,
  createSavedSegment, getSavedSegmentById, getSavedSegmentsByUser, deleteSavedSegment,
  createMetaCampaignMapping, getMetaCampaignMappingById, getMetaCampaignMappingsByCustomer, replaceMetaCampaignMappings,
  createCommunicationLog, getCommunicationLogById, getCommunicationLogsByCustomer, getCommunicationLogsByUser,
  getStats, getAdminStats,
  ensureAdmin,
};
