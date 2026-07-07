require('dotenv').config();

const fs = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const db = require('./db');

const gzip = promisify(zlib.gzip);
const BACKUP_ENABLED =
  String(process.env.BACKUP_ENABLED || 'true').toLowerCase() !== 'false';
const BACKUP_DIR = path.join(
  __dirname,
  process.env.BACKUP_DIR || 'backups'
);
const BACKUP_RETENTION_DAYS = Math.max(
  parseInt(process.env.BACKUP_RETENTION_DAYS || '14', 10) || 14,
  1
);
const BACKUP_TABLES = [
  'users',
  'customers',
  'charges',
  'appointments',
  'notifications',
  'ad_metrics',
  'audit_logs',
  'webhook_events',
  'customer_notes',
  'saved_segments',
  'meta_campaign_mappings',
  'communication_logs',
  'background_jobs'
];

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function ensureBackupDir() {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
}

async function buildSnapshot() {
  const snapshot = {
    createdAt: new Date().toISOString(),
    database: process.env.DATABASE_URL ? 'postgres' : 'sqlite',
    tables: {}
  };

  for (const table of BACKUP_TABLES) {
    snapshot.tables[table] = await db.all(`SELECT * FROM ${table} ORDER BY created_at DESC`);
  }

  return snapshot;
}

async function pruneOldBackups() {
  await ensureBackupDir();
  const files = await fs.readdir(BACKUP_DIR);
  const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  for (const file of files) {
    const fullPath = path.join(BACKUP_DIR, file);
    const stats = await fs.stat(fullPath);
    if (stats.mtimeMs < cutoff) {
      await fs.unlink(fullPath);
    }
  }
}

async function createBackupSnapshot() {
  if (!BACKUP_ENABLED) {
    return { skipped: true, reason: 'BACKUP_ENABLED=false' };
  }

  await db.initSchema();
  await ensureBackupDir();
  const snapshot = await buildSnapshot();
  const json = JSON.stringify(snapshot);
  const compressed = await gzip(json, { level: 9 });
  const filePath = path.join(
    BACKUP_DIR,
    `paypulse-backup-${timestampForFile()}.json.gz`
  );
  await fs.writeFile(filePath, compressed);
  await pruneOldBackups();

  return {
    skipped: false,
    filePath,
    bytes: compressed.length,
    tableCounts: Object.fromEntries(
      Object.entries(snapshot.tables).map(([table, rows]) => [table, rows.length])
    )
  };
}

if (require.main === module) {
  createBackupSnapshot()
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(err => {
      console.error('Backup failed:', err.message);
      process.exit(1);
    });
}

module.exports = {
  BACKUP_ENABLED,
  BACKUP_DIR,
  BACKUP_RETENTION_DAYS,
  createBackupSnapshot,
  pruneOldBackups
};
