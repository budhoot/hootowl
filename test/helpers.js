import 'dotenv/config';
import twilio from 'twilio';
import { createApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) {
  throw new Error('Set TEST_DATABASE_URL to an empty test database (it is wiped on every run).');
}

export const config = {
  port: 0,
  databaseUrl: TEST_DATABASE_URL,
  publicBaseUrl: 'https://api.example.test',
  adminApiKey: 'test-admin-key-0123456789abcdef',
  smsSendEnabled: true,
  twilio: { accountSid: 'ACtest', authToken: 'test-auth-token' },
  dialTimeoutSeconds: 20,
  worker: { pollIntervalMs: 10, cooldownHours: 24, stuckSendingMinutes: 10 },
};

export const silentLogger = { log() {}, error() {} };

export async function setup() {
  const pool = createPool(TEST_DATABASE_URL);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool, () => {});
  const server = createApp({ pool, config, logger: silentLogger }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    pool,
    baseUrl,
    // Sends a form POST signed exactly like Twilio would sign it.
    async twilioPost(path, params, { signature } = {}) {
      const sig = signature ?? twilio.getExpectedTwilioSignature(
        config.twilio.authToken, config.publicBaseUrl + path, params,
      );
      const res = await fetch(baseUrl + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig },
        body: new URLSearchParams(params),
      });
      return { status: res.status, text: await res.text() };
    },
    async admin(method, path, body, { key = config.adminApiKey } = {}) {
      const res = await fetch(`${baseUrl}/admin${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
    },
  };
}

// Fake Twilio messages.create that records calls and returns sequential SIDs.
export function fakeSender() {
  const sent = [];
  const sendSms = async (params) => {
    sent.push(params);
    return { sid: `SM${String(sent.length).padStart(32, '0')}`, status: 'queued' };
  };
  return { sent, sendSms };
}

export const BUSINESS_TWILIO = '+15550000001';
export const BUSINESS_PHONE = '+15550000002';
export const CALLER = '+15557654321';

export async function createClient(ctx, overrides = {}) {
  const res = await ctx.admin('POST', '/clients', {
    name: 'Acme Plumbing',
    booking_url: 'https://hootowl.net/book/acme',
    routes: [{ twilio_number: BUSINESS_TWILIO, forward_to_number: BUSINESS_PHONE }],
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`createClient failed: ${JSON.stringify(res.body)}`);
  return res.body.client;
}

let callCounter = 0;
// Simulates a full inbound call: voice webhook, then the <Dial> outcome callback.
export async function simulateCall(ctx, { from = CALLER, to = BUSINESS_TWILIO, dialStatus = 'no-answer' } = {}) {
  callCounter += 1;
  const CallSid = `CA${String(callCounter).padStart(32, '0')}`;
  await ctx.twilioPost('/webhooks/twilio/voice', { CallSid, From: from, To: to });
  await ctx.twilioPost('/webhooks/twilio/dial-result', {
    CallSid, From: from, To: to, DialCallStatus: dialStatus, DialCallDuration: '0',
  });
  return CallSid;
}
