require('dotenv').config();

const {
  bootstrap,
  startBackgroundJobs
} = require('./server');
const { BACKUP_ENABLED, createBackupSnapshot } = require('./backup');

const BACKUP_INTERVAL_HOURS = Math.max(
  parseInt(process.env.BACKUP_INTERVAL_HOURS || '24', 10) || 24,
  1
);

let backupTimer = null;

function startBackupScheduler() {
  if (!BACKUP_ENABLED || backupTimer) return;
  const runBackup = async () => {
    try {
      const result = await createBackupSnapshot();
      if (!result.skipped) {
        console.log(`Backup created: ${result.filePath}`);
      }
    } catch (err) {
      console.error('Backup scheduler error:', err.message);
    }
  };
  backupTimer = setInterval(runBackup, BACKUP_INTERVAL_HOURS * 60 * 60 * 1000);
  runBackup();
}

async function startWorker() {
  await bootstrap();
  startBackgroundJobs({ keepAlive: true });
  startBackupScheduler();
  console.log(`PayPulse worker running with poll interval ${process.env.BACKGROUND_JOB_POLL_MS || 30000}ms and backup interval ${BACKUP_INTERVAL_HOURS}h`);
}

startWorker().catch(err => {
  console.error('PayPulse worker failed to start:', err.message);
  process.exit(1);
});
