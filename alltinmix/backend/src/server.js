const config = require('./config');
const db = require('./db');
const { createApp } = require('./app');
const { processOutbox } = require('./lib/notify');
const { processSmsOutbox } = require('./lib/sms');
const orders = require('./services/orders');
const { expireOffers } = require('./routes/buyer');

async function main() {
  if (config.autoMigrate) {
    const applied = await db.migrate();
    if (applied.length) console.log('[db] applied migrations:', applied.join(', '));
  }

  const app = createApp();
  const server = app.listen(config.port, () => console.log(`${config.marketplace.brand.name} API listening on port ${config.port} (${config.env})`));

  // Background jobs: send queued emails, release unpaid stock, auto-complete delivered orders.
  const safe = (name, fn) => () => fn().catch((err) => console.error(`[job:${name}]`, err.message));
  const timers = [
    setInterval(safe('emails', () => processOutbox()), 10_000),
    setInterval(safe('sms', () => processSmsOutbox()), 10_000),
    setInterval(safe('monime-poll', () => orders.pollProviderPayments()), 20_000),
    setInterval(safe('expire-payments', () => orders.expireStalePayments()), 60_000),
    setInterval(safe('offers', expireOffers), 10 * 60_000),
    setInterval(safe('auto-complete', () => orders.autoCompleteDelivered()), 10 * 60_000),
  ];

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down`);
    timers.forEach(clearInterval);
    server.close(async () => {
      await db.pool.end().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
