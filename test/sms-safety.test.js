import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { processNext } from '../src/recovery/worker.js';

const validEnv = {
  ADMIN_API_KEY: 'test-admin-key-0123456789abcdef',
  DATABASE_URL: 'postgres://localhost/hootowl_test',
  PUBLIC_BASE_URL: 'https://api.example.test',
  TWILIO_ACCOUNT_SID: 'ACtest',
  TWILIO_AUTH_TOKEN: 'test-auth-token',
};

test('outbound SMS is disabled by default and accepts explicit boolean values', () => {
  assert.equal(loadConfig(validEnv).smsSendEnabled, false);
  assert.equal(loadConfig({ ...validEnv, SMS_SEND_ENABLED: 'true' }).smsSendEnabled, true);
  assert.equal(loadConfig({ ...validEnv, SMS_SEND_ENABLED: 'false' }).smsSendEnabled, false);
});

test('invalid outbound SMS setting fails configuration loading', () => {
  assert.throws(
    () => loadConfig({ ...validEnv, SMS_SEND_ENABLED: 'yes' }),
    /SMS_SEND_ENABLED must be "true" or "false"/,
  );
});

test('disabled worker leaves the recovery queue untouched and does not call Twilio', async () => {
  let databaseAccessed = false;
  let senderCalled = false;
  const result = await processNext({
    pool: {
      query: async () => {
        databaseAccessed = true;
        throw new Error('queue must not be accessed while sending is disabled');
      },
    },
    sendSms: async () => {
      senderCalled = true;
      throw new Error('sender must not run while sending is disabled');
    },
    config: { ...loadConfig(validEnv), worker: { cooldownHours: 24 } },
  });

  assert.equal(result, null);
  assert.equal(databaseAccessed, false);
  assert.equal(senderCalled, false);
});
