import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import {
  BUSINESS_PHONE, BUSINESS_TWILIO, CALLER, config, createClient, setup, simulateCall,
} from './helpers.js';

let ctx;
before(async () => { ctx = await setup(); });
after(async () => { await ctx.close(); });
beforeEach(async () => {
  await ctx.pool.query('TRUNCATE clients, calls, recovery_queue, inbound_messages, opt_outs, sms_status_events RESTART IDENTITY CASCADE');
});

test('all four Twilio webhooks reject unsigned or wrongly signed requests', async () => {
  for (const path of ['voice', 'dial-result', 'sms', 'sms-status']) {
    const res = await ctx.twilioPost(`/webhooks/twilio/${path}`, { CallSid: 'CA1' }, { signature: 'bogus' });
    assert.equal(res.status, 403, path);
  }
});

test('voice webhook forwards a known number to the business phone', async () => {
  await createClient(ctx);
  const res = await ctx.twilioPost('/webhooks/twilio/voice', { CallSid: 'CA1', From: CALLER, To: BUSINESS_TWILIO });
  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(`<Number>\\${BUSINESS_PHONE}</Number>`));
  assert.match(res.text, new RegExp(`action="${config.publicBaseUrl}/webhooks/twilio/dial-result"`));
  const { rows } = await ctx.pool.query('SELECT caller_number FROM calls');
  assert.deepEqual(rows, [{ caller_number: CALLER }]);
});

test('voice webhook answers "not in service" for unknown or inactive numbers', async () => {
  const unknown = await ctx.twilioPost('/webhooks/twilio/voice', { CallSid: 'CA1', From: CALLER, To: '+15559999999' });
  assert.match(unknown.text, /not in service/);
  assert.doesNotMatch(unknown.text, /<Dial/);

  const client = await createClient(ctx);
  await ctx.admin('PATCH', `/routes/${client.routes[0].id}`, { active: false });
  const inactive = await ctx.twilioPost('/webhooks/twilio/voice', { CallSid: 'CA2', From: CALLER, To: BUSINESS_TWILIO });
  assert.match(inactive.text, /not in service/);
});

test('busy, no-answer and failed calls are queued for recovery; answered calls are not', async () => {
  await createClient(ctx);
  for (const dialStatus of ['busy', 'no-answer', 'failed', 'completed', 'answered', 'canceled']) {
    await simulateCall(ctx, { dialStatus });
  }
  const { rows } = await ctx.pool.query(
    `SELECT c.dial_call_status, q.status FROM calls c LEFT JOIN recovery_queue q ON q.call_id = c.id ORDER BY c.id`,
  );
  assert.deepEqual(rows.map((r) => [r.dial_call_status, r.status]), [
    ['busy', 'pending'], ['no-answer', 'pending'], ['failed', 'pending'],
    ['completed', null], ['answered', null], ['canceled', null],
  ]);
});

test('a repeated dial-result callback does not queue the call twice', async () => {
  await createClient(ctx);
  const CallSid = await simulateCall(ctx);
  await ctx.twilioPost('/webhooks/twilio/dial-result', {
    CallSid, From: CALLER, To: BUSINESS_TWILIO, DialCallStatus: 'no-answer',
  });
  const { rows } = await ctx.pool.query('SELECT count(*)::int AS n FROM recovery_queue');
  assert.equal(rows[0].n, 1);
});

test('SMS webhook stores replies and tracks STOP / START', async () => {
  const client = await createClient(ctx);
  const send = (sid, Body) => ctx.twilioPost('/webhooks/twilio/sms', {
    MessageSid: sid, From: CALLER, To: BUSINESS_TWILIO, Body,
  });

  const res = await send('SM1', 'Hi, can you come Tuesday?');
  assert.equal(res.status, 200);
  assert.match(res.text, /<Response\/>/);
  await send('SM1', 'Hi, can you come Tuesday?'); // Twilio retry: stored once
  await send('SM2', ' stop ');

  let optOut = await ctx.pool.query('SELECT opted_out FROM opt_outs');
  assert.deepEqual(optOut.rows, [{ opted_out: true }]);

  await send('SM3', 'START');
  optOut = await ctx.pool.query('SELECT opted_out FROM opt_outs');
  assert.deepEqual(optOut.rows, [{ opted_out: false }]);

  const { rows } = await ctx.pool.query('SELECT message_sid, client_id, keyword FROM inbound_messages ORDER BY id');
  assert.deepEqual(rows, [
    { message_sid: 'SM1', client_id: client.id, keyword: null },
    { message_sid: 'SM2', client_id: client.id, keyword: 'opt_out' },
    { message_sid: 'SM3', client_id: client.id, keyword: 'opt_in' },
  ]);
});
