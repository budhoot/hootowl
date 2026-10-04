import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);

await migrate(pool);

const server = createApp({ pool, config }).listen(config.port, () => {
  console.log(`HootOwl API listening on port ${config.port}`);
  console.log(`Twilio voice webhook: ${config.publicBaseUrl}/webhooks/twilio/voice`);
  console.log(`Twilio SMS webhook:   ${config.publicBaseUrl}/webhooks/twilio/sms`);
});

function shutdown() {
  console.log('Shutting down API...');
  server.close(() => pool.end().then(() => process.exit(0)));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
