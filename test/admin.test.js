import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { processNext } from '../src/recovery/worker.js';
import {
  BUSINESS_TWILIO, CALLER, config, createClient, fakeSender, setup, silentLogger, simulateCall,
} from './helpers.js';

let ctx;
before(async () => { ctx = await setup(); });
after(async () => { await ctx.close(); });
beforeEach(async () => {
  await ctx.pool.query('TRUNCATE clients, calls, recovery_queue, inbound_messages, opt_outs, sms_status_events, worker_heartbeats RESTART IDENTITY CASCADE');
});

test('admin API requires the bearer key', async () => {
  assert.equal((await ctx.admin('GET', '/clients', undefined, { key: 'wrong' })).status, 401);
  assert.equal((await ctx.admin('GET', '/clients')).status, 200);
});

test('create, list and update clients and routes', async () => {
  const client = await createClient(ctx);
  assert.equal(client.name, 'Acme Plumbing');
  assert.equal(client.recovery_enabled, true);
  assert.equal(client.routes.length, 1);
  assert.equal(client.routes[0].twilio_number, BUSINESS_TWILIO);

  const added = await ctx.admin('POST', `/clients/${client.id}/routes`, {
    twilio_number: '+15550000003', forward_to_number: '+15550000004',
  });
  assert.equal(added.status, 201);

  const list = await ctx.admin('GET', '/clients');
  assert.equal(list.body.clients[0].routes.length, 2);

  const updated = await ctx.admin('PATCH', `/clients/${client.id}`, { name: 'Acme Plumbing & Heating', booking_url: null });
  assert.equal(updated.body.client.name, 'Acme Plumbing & Heating');
  assert.equal(updated.body.client.booking_url, null);

  const disabled = await ctx.admin('POST', `/clients/${client.id}/recovery/disable`);
  assert.equal(disabled.body.client.recovery_enabled, false);

  const routes = await ctx.admin('GET', `/routes?client_id=${client.id}`);
  assert.equal(routes.body.routes.length, 2);
});

test('admin API validates input', async () => {
  assert.equal((await ctx.admin('POST', '/clients', {})).status, 400);
  const badPhone = await ctx.admin('POST', '/clients', {
    name: 'X', routes: [{ twilio_number: '555-1234', forward_to_number: '+15550000002' }],
  });
  assert.equal(badPhone.status, 400);
  assert.match(badPhone.body.error, /E\.164/);
  assert.equal((await ctx.admin('GET', '/clients')).body.clients.length, 0, 'failed create is rolled back');

  assert.equal((await ctx.admin('POST', '/clients', { name: 'X', booking_url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await ctx.admin('GET', '/clients/999')).status, 404);
  assert.equal((await ctx.admin('PATCH', '/clients/abc', { name: 'Y' })).status, 400);

  await createClient(ctx);
  const duplicate = await ctx.admin('POST', '/clients', {
    name: 'Other', routes: [{ twilio_number: BUSINESS_TWILIO, forward_to_number: '+15550000009' }],
  });
  assert.equal(duplicate.status, 409);
});

test('lead inbox shows missed calls with their recovery status and replies', async () => {
  const client = await createClient(ctx);
  await simulateCall(ctx, { dialStatus: 'completed' }); // answered: not a lead
  await simulateCall(ctx);
  await processNext({ pool: ctx.pool, sendSms: fakeSender().sendSms, config, logger: silentLogger });
  await ctx.twilioPost('/webhooks/twilio/sms', {
    MessageSid: 'SMreply', From: CALLER, To: BUSINESS_TWILIO, Body: 'Yes please call me back',
  });

  const inbox = await ctx.admin('GET', `/inbox?client_id=${client.id}`);
  assert.equal(inbox.status, 200);
  assert.equal(inbox.body.leads.length, 1);
  const [lead] = inbox.body.leads;
  assert.equal(lead.caller_number, CALLER);
  assert.equal(lead.recovery_status, 'sent');
  assert.deepEqual(lead.replies.map((r) => r.body), ['Yes please call me back']);

  const replies = await ctx.admin('GET', '/replies');
  assert.equal(replies.body.replies.length, 1);
});

test('operator can resolve items that need review', async () => {
  await createClient(ctx);
  await simulateCall(ctx);
  await processNext({
    pool: ctx.pool, config, logger: silentLogger, sendSms: async () => { throw new Error('timeout'); },
  });

  const review = await ctx.admin('GET', '/recovery?status=needs_review');
  assert.equal(review.body.recovery.length, 1);
  const { id } = review.body.recovery[0];

  assert.equal((await ctx.admin('POST', `/recovery/${id}/resolve`, { status: 'bogus' })).status, 400);
  const resolved = await ctx.admin('POST', `/recovery/${id}/resolve`, { status: 'pending' });
  assert.equal(resolved.body.recovery.status, 'pending');
  assert.equal((await ctx.admin('POST', `/recovery/${id}/resolve`, { status: 'sent' })).status, 409);

  const { sent, sendSms } = fakeSender();
  await processNext({ pool: ctx.pool, sendSms, config, logger: silentLogger });
  assert.equal(sent.length, 1, 'requeued item is sent');
});
