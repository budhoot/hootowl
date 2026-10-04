import { setTimeout as sleep } from 'node:timers/promises';
import twilio from 'twilio';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';
import { recordHeartbeat, removeHeartbeat } from './recovery/heartbeat.js';
import { processNext, sweepStuckSends } from './recovery/worker.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken, { timeout: 30_000 });
const sendSms = (params) => twilioClient.messages.create(params);

let running = true;
function stop() {
  console.log('Stopping worker after the current item...');
  running = false;
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await migrate(pool);
// Forget workers that stopped without cleaning up (e.g. the computer was switched off).
await pool.query(`DELETE FROM worker_heartbeats WHERE last_seen < now() - interval '1 day'`);
console.log(`Recovery worker started (checking every ${config.worker.pollIntervalMs} ms)`);

while (running) {
  try {
    await recordHeartbeat(pool);
    await sweepStuckSends({ pool, config });
    // Drain the queue, then wait before checking again.
    while (running && (await processNext({ pool, sendSms, config }))) {
      await recordHeartbeat(pool);
    }
  } catch (err) {
    console.error('Worker loop error:', err);
  }
  if (running) await sleep(config.worker.pollIntervalMs);
}

await removeHeartbeat(pool).catch(() => {});
await pool.end();
console.log('Worker stopped.');
