import express from 'express';
import twilio from 'twilio';
import { withTransaction } from '../db.js';
import { detectKeyword } from '../phone.js';
import { applyDeliveryStatus } from '../recovery/deliveryStatus.js';
import { verifyTwilioSignature } from '../twilioSignature.js';

const { VoiceResponse, MessagingResponse } = twilio.twiml;

// Dial outcomes that count as a missed call and trigger a recovery text.
const MISSED_DIAL_STATUSES = new Set(['busy', 'no-answer', 'failed']);

function sendTwiml(res, response) {
  res.type('text/xml').send(response.toString());
}

async function findRoute(db, twilioNumber) {
  const { rows } = await db.query(
    `SELECT r.id, r.client_id, r.forward_to_number, r.active
       FROM phone_routes r
      WHERE r.twilio_number = $1`,
    [twilioNumber],
  );
  return rows[0] ?? null;
}

export function twilioRouter({ pool, config }) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));
  router.use(verifyTwilioSignature({
    authToken: config.twilio.authToken,
    publicBaseUrl: config.publicBaseUrl,
  }));

  // Steps 1-3: a caller rings a client's Twilio number; forward it to the business phone.
  router.post('/voice', async (req, res) => {
    const { CallSid, From, To } = req.body;
    const route = await findRoute(pool, To);
    const response = new VoiceResponse();

    if (!route || !route.active) {
      response.say('Sorry, this number is not in service.');
      response.hangup();
      return sendTwiml(res, response);
    }

    await pool.query(
      `INSERT INTO calls (call_sid, client_id, route_id, caller_number, twilio_number)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (call_sid) DO NOTHING`,
      [CallSid, route.client_id, route.id, From ?? '', To],
    );

    const dial = response.dial({
      action: `${config.publicBaseUrl}/webhooks/twilio/dial-result`,
      method: 'POST',
      timeout: config.dialTimeoutSeconds,
    });
    dial.number(route.forward_to_number);
    sendTwiml(res, response);
  });

  // Steps 4-6: Twilio reports how the forwarded call ended. Missed calls go on the recovery queue.
  router.post('/dial-result', async (req, res) => {
    const { CallSid, From, To, DialCallStatus, DialCallDuration } = req.body;
    const missed = MISSED_DIAL_STATUSES.has(DialCallStatus);
    const duration = Number.parseInt(DialCallDuration, 10);

    await withTransaction(pool, async (db) => {
      const route = await findRoute(db, To);
      const { rows } = await db.query(
        `INSERT INTO calls (call_sid, client_id, route_id, caller_number, twilio_number,
                            dial_call_status, dial_call_duration, missed)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8
          WHERE $2::bigint IS NOT NULL OR EXISTS (SELECT 1 FROM calls WHERE call_sid = $1)
         ON CONFLICT (call_sid) DO UPDATE
            SET dial_call_status = EXCLUDED.dial_call_status,
                dial_call_duration = EXCLUDED.dial_call_duration,
                missed = EXCLUDED.missed,
                updated_at = now()
         RETURNING id, client_id, caller_number, twilio_number`,
        [CallSid, route?.client_id ?? null, route?.id ?? null, From ?? '', To,
          DialCallStatus ?? null, Number.isNaN(duration) ? null : duration, missed],
      );
      const call = rows[0];
      if (call && missed) {
        await db.query(
          `INSERT INTO recovery_queue (call_id, client_id, caller_number, twilio_number)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (call_id) DO NOTHING`,
          [call.id, call.client_id, call.caller_number, call.twilio_number],
        );
      }
    });

    const response = new VoiceResponse();
    response.hangup();
    sendTwiml(res, response);
  });

  // Steps 11-12: a caller texts the client's number. Save the reply and track STOP / START.
  router.post('/sms', async (req, res) => {
    const { MessageSid, From, To, Body } = req.body;
    const keyword = detectKeyword(Body);

    await withTransaction(pool, async (db) => {
      const route = await findRoute(db, To);
      await db.query(
        `INSERT INTO inbound_messages (message_sid, client_id, from_number, to_number, body, keyword)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (message_sid) DO NOTHING`,
        [MessageSid, route?.client_id ?? null, From, To, Body ?? '', keyword],
      );
      if (keyword) {
        await db.query(
          `INSERT INTO opt_outs (phone_number, twilio_number, opted_out)
           VALUES ($1, $2, $3)
           ON CONFLICT (phone_number, twilio_number)
           DO UPDATE SET opted_out = EXCLUDED.opted_out, updated_at = now()`,
          [From, To, keyword === 'opt_out'],
        );
      }
    });

    // Empty response: Twilio itself sends the standard STOP/START confirmation texts.
    sendTwiml(res, new MessagingResponse());
  });

  // Step 12: delivery updates for the recovery texts the worker sent.
  router.post('/sms-status', async (req, res) => {
    const { MessageSid, MessageStatus, ErrorCode } = req.body;
    if (!MessageSid || !MessageStatus) {
      return res.status(400).type('text/plain').send('Missing MessageSid or MessageStatus');
    }

    await pool.query(
      'INSERT INTO sms_status_events (message_sid, status, error_code) VALUES ($1, $2, $3)',
      [MessageSid, MessageStatus, ErrorCode || null],
    );
    await applyDeliveryStatus(pool, { messageSid: MessageSid, status: MessageStatus, errorCode: ErrorCode });
    res.sendStatus(204);
  });

  return router;
}
