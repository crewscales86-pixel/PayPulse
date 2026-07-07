require('dotenv').config();

const { startWorkerProcess } = require('./server');

async function startWorker() {
  await startWorkerProcess();
}

startWorker().catch(err => {
  console.error('PayPulse worker failed to start:', err.message);
  process.exit(1);
});
