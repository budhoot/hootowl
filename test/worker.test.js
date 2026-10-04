import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { processNext, sweepStuckSends } from '../src/recovery/worker.js';
import {
  BUSINESS_TWILIO, CALLER, config, createClient, fakeSender, setup, silentLogger, simulateCall,
} from './helpers.js';

let ctx;
before(async () => { ctx = await setup(); });
after(async () => { await ctx.close(); });
beforeEach(async () => {
  await ctx.pool.query('TRUNCATE clients, calls, recovery_queue, inbound_messages, opt_outs, sms_status_events, worker_heartbeats RESTART IDENTITY CASCADE');
});

const run = (sendSms) => processNext({ pool: ctx.pool, sendSms, config, logger: silentLogger });

async function queueRow(id = 1) {
  const { rows } = await ctx.pool.query('SELECT * FROM recovery_queue WHERE id = $1', [id]);
  return rows[0];
}

test('worker texts a missed caller and records the message SID', async () => {
  await createClient(ctx);
  await simulateCall(ctx);
  const { sent, sendSms } = fakeSender();

  const result = await run(sendSms);
  assert.equal(result.status, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, CALLER);
  assert.equal(sent[0].from, BUSINESS_TWILIO);
  assert.equal(sent[0].statusCallback, `${config.publicBaseUrl}/webhooks/twilio/sms-status`);
  assert.match(sent[0].body, /Acme Plumbing/);
  assert.match(sent[0].body, /https:\/\/hootowl\.net\/book\/acme/);
  assert.match(sent[0].body, /Reply STOP to opt out/);

  const row = await queueRow();
  assert.equal(row.status, 'sent');
  assert.equal(row.message_sid, result.messageSid);
  assert.equal(row.delivery_status, 'queued');
  assert.equal(await run(sendSms), null, 'queue is now empty');
});

test('delivery callbacks update status and never move backwards', async () => {
  await createClient(ctx);
  await simulateCall(ctx);
  const { messageSid } = await run(fakeSender().sendSms);
  const status = (MessageStatus, extra = {}) => ctx.twilioPost('/webhooks/twilio/sms-status', {
    MessageSid: messageSid, MessageStatus, ...extra,
  });

  assert.equal((await status('sent')).status, 204);
  await status('delivered');
  await status('sent'); // late, out-of-order callback
  assert.equal((await queueRow()).delivery_status, 'delivered');

  await status('read');
  assert.equal((await queueRow()).delivery_status, 'read');
});

test('a delivery callback that arrives before the send result is saved is not lost', async () => {
  await createClient(ctx);
  await simulateCall(ctx);
  const sendSms = async () => {
    // Twilio calls back while our messages.create request is still returning.
    await ctx.twilioPost('/webhooks/twilio/sms-status', {
      MessageSid: 'SMfast', MessageStatus: 'undelivered', ErrorCode: '30003',
    });
    return { sid: 'SMfast', status: 'queued' };
  };
  await run(sendSms);
  const row = await queueRow();
  assert.equal(row.delivery_status, 'undelivered');
  assert.equal(row.error_code, '30003');
});

test('worker skips callers who texted STOP', async () => {
  await createClient(ctx);
  await ctx.twilioPost('/webhooks/twilio/sms', { MessageSid: 'SM1', From: CALLER, To: BUSINESS_TWILIO, Body: 'STOP' });
  await simulateCall(ctx);
  const { sent, sendSms } = fakeSender();

  assert.deepEqual(await run(sendSms), { id: 1, status: 'skipped', skipReason: 'opted_out' });
  assert.equal(sent.length, 0);
});

test('worker applies the 24-hour caller cooldown', async () => {
  await createClient(ctx);
  await simulateCall(ctx);
  await simulateCall(ctx);
  await simulateCall(ctx, { from: '+15551112222' });
  const { sent, sendSms } = fakeSender();

  assert.equal((await run(sendSms)).status, 'sent');
  assert.equal((await run(sendSms)).skipReason, 'cooldown');
  assert.equal((await run(sendSms)).status, 'sent', 'a different caller is not affected');
  assert.equal(sent.length, 2);

  // Once the earlier text is older than 24 hours the same caller can be texted again.
  await ctx.pool.query(`UPDATE recovery_queue SET claimed_at = now() - interval '25 hours'`);
  await simulateCall(ctx);
  assert.equal((await run(sendSms)).status, 'sent');
});

test('worker skips inactive clients, disabled recovery and hidden caller IDs', async () => {
  const client = await createClient(ctx);
  const { sent, sendSms } = fakeSender();

  await ctx.admin('POST', `/clients/${client.id}/recovery/disable`);
  await simulateCall(ctx);
  assert.equal((await run(sendSms)).skipReason, 'recovery_disabled');

  await ctx.admin('PATCH', `/clients/${client.id}`, { recovery_enabled: true, active: false });
  await simulateCall(ctx);
  assert.equal((await run(sendSms)).skipReason, 'client_inactive');

  await ctx.admin('PATCH', `/clients/${client.id}`, { active: true });
  await simulateCall(ctx, { from: 'anonymous' });
  assert.equal((await run(sendSms)).skipReason, 'caller_number_unavailable');

  assert.equal(sent.length, 0);
});

test('a Twilio rejection is marked failed; an unknown outcome needs review and is not resent', async () => {
  await createClient(ctx);
  await simulateCall(ctx);
  await simulateCall(ctx, { from: '+15551112222' });

  const rejected = Object.assign(new Error('Invalid To number'), { status: 400, code: 21211 });
  assert.equal((await run(async () => { throw rejected; })).status, 'failed');
  const failedRow = await queueRow(1);
  assert.equal(failedRow.error_code, '21211');

  const timeout = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  assert.equal((await run(async () => { throw timeout; })).status, 'needs_review');

  const { sent, sendSms } = fakeSender();
  assert.equal(await run(sendSms), null, 'nothing is retried automatically');
  assert.equal(sent.length, 0);
});

test('sends left in progress by a crashed worker are moved to review', async () => {
  await createClient(ctx);
  await simulateCall(ctx);
  await ctx.pool.query(`UPDATE recovery_queue SET status = 'sending', claimed_at = now() - interval '1 hour'`);

  assert.equal(await sweepStuckSends({ pool: ctx.pool, config, logger: silentLogger }), 1);
  assert.equal((await queueRow()).status, 'needs_review');
});

test('two workers running at once never double-text the same caller', async () => {
  await createClient(ctx);
  for (let i = 0; i < 5; i += 1) await simulateCall(ctx);
  const { sent, sendSms } = fakeSender();

  await Promise.all([run(sendSms), run(sendSms), run(sendSms), run(sendSms), run(sendSms)]);
  assert.equal(sent.length, 1);
  const { rows } = await ctx.pool.query(`SELECT status, count(*)::int AS n FROM recovery_queue GROUP BY status ORDER BY status`);
  assert.deepEqual(rows, [{ status: 'sent', n: 1 }, { status: 'skipped', n: 4 }]);
});
