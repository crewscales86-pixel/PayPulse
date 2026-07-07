require('dotenv').config();

const {
  bootstrap,
  startBackgroundJobs
} = require('./server');

async function startWorker() {
  await bootstrap();
  startBackgroundJobs({ keepAlive: true });
  console.log(`PayPulse worker running with poll interval ${process.env.BACKGROUND_JOB_POLL_MS || 30000}ms`);
}

startWorker().catch(err => {
  console.error('PayPulse worker failed to start:', err.message);
  process.exit(1);
});
