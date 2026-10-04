import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { recordHeartbeat } from '../src/recovery/heartbeat.js';
import { processNext } from '../src/recovery/worker.js';
import {
  CALLER, BUSINESS_TWILIO, config, createClient, fakeSender, setup, silentLogger, simulateCall,
} from './helpers.js';

let ctx;
before(async () => { ctx = await setup(); });
after(async () => { await ctx.close(); });
beforeEach(async () => {
  await ctx.pool.query('TRUNCATE clients, calls, recovery_queue, inbound_messages, opt_outs, sms_status_events, worker_heartbeats RESTART IDENTITY CASCADE');
});

test('dashboard page is served with strict security headers', async () => {
  const root = await fetch(`${ctx.baseUrl}/`, { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/dashboard/');

  const page = await fetch(`${ctx.baseUrl}/dashboard/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>HootOwl Dashboard<\/title>/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');

  for (const file of ['app.js', 'styles.css', 'logo.png', 'favicon.ico']) {
    assert.equal((await fetch(`${ctx.baseUrl}/dashboard/${file}`)).status, 200, file);
  }
});

test('health and stats report whether the worker is online', async () => {
  let health = await (await fetch(`${ctx.baseUrl}/health`)).json();
  assert.deepEqual(health, { ok: true, worker_online: false });

  await recordHeartbeat(ctx.pool, 'test-worker');
  health = await (await fetch(`${ctx.baseUrl}/health`)).json();
  assert.equal(health.worker_online, true);

  await ctx.pool.query(`UPDATE worker_heartbeats SET last_seen = now() - interval '5 minutes'`);
  const { body } = await ctx.admin('GET', '/stats');
  assert.equal(body.worker.online, false);
});

test('stats count calls, texts, replies and items needing attention', async () => {
  const client = await createClient(ctx);
  const other = await createClient(ctx, {
    name: 'Other Co', routes: [{ twilio_number: '+15550000005', forward_to_number: '+15550000006' }],
  });
  await simulateCall(ctx, { dialStatus: 'completed' });
  await simulateCall(ctx);
  await simulateCall(ctx, { from: '+15551112222' });
  await simulateCall(ctx, { to: '+15550000005' });
  const { sendSms } = fakeSender();
  await processNext({ pool: ctx.pool, sendSms, config, logger: silentLogger });
  await processNext({
    pool: ctx.pool, config, logger: silentLogger, sendSms: async () => { throw new Error('timeout'); },
  });
  await ctx.twilioPost('/webhooks/twilio/sms', { MessageSid: 'SM1', From: CALLER, To: BUSINESS_TWILIO, Body: 'Hi' });
  await ctx.twilioPost('/webhooks/twilio/sms', { MessageSid: 'SM2', From: CALLER, To: BUSINESS_TWILIO, Body: 'STOP' });

  const all = (await ctx.admin('GET', '/stats')).body.stats;
  assert.deepEqual(all, {
    missed_calls_24h: 3, missed_calls_7d: 3, calls_7d: 4, texts_sent_7d: 1,
    replies_7d: 1, needs_attention: 1, queued: 1,
  });

  const one = (await ctx.admin('GET', `/stats?client_id=${other.id}`)).body.stats;
  assert.equal(one.missed_calls_7d, 1);
  assert.equal(one.calls_7d, 1);
  assert.ok(client.id !== other.id);
});

test('clients include a preview of the recovery text', async () => {
  const client = await createClient(ctx, { recovery_message: 'Thanks for calling {business_name}!' });
  assert.equal(client.recovery_preview,
    'Thanks for calling Acme Plumbing! Book online: https://hootowl.net/book/acme Reply STOP to opt out.');
  const list = (await ctx.admin('GET', '/clients')).body.clients;
  assert.equal(list[0].recovery_preview, client.recovery_preview);
});
