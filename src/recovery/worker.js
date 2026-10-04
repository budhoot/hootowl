import { withTransaction } from '../db.js';
import { isE164 } from '../phone.js';
import { replayDeliveryStatuses } from './deliveryStatus.js';
import { buildRecoveryMessage } from './message.js';

// Step 7: claim the oldest pending item and decide whether it may be sent.
// Runs in one transaction so two workers never send to the same caller at once.
async function claimNext(pool, { cooldownHours }) {
  return withTransaction(pool, async (db) => {
    const { rows } = await db.query(
      `SELECT q.id, q.client_id, q.caller_number, q.twilio_number,
              c.name, c.booking_url, c.recovery_message, c.active, c.recovery_enabled
         FROM recovery_queue q
         JOIN clients c ON c.id = q.client_id
        WHERE q.status = 'pending'
        ORDER BY q.created_at, q.id
        LIMIT 1
        FOR UPDATE OF q SKIP LOCKED`,
    );
    const item = rows[0];
    if (!item) return null;

    // Serialize per client + caller so the cooldown check below cannot race another worker.
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${item.client_id}:${item.caller_number}`]);

    const skipReason = await findSkipReason(db, item, cooldownHours);
    if (skipReason) {
      await db.query(
        `UPDATE recovery_queue SET status = 'skipped', skip_reason = $2, updated_at = now() WHERE id = $1`,
        [item.id, skipReason],
      );
      return { ...item, skipReason };
    }

    const body = buildRecoveryMessage(item);
    await db.query(
      `UPDATE recovery_queue
          SET status = 'sending', message_body = $2, claimed_at = now(), updated_at = now()
        WHERE id = $1`,
      [item.id, body],
    );
    return { ...item, body };
  });
}

async function findSkipReason(db, item, cooldownHours) {
  if (!item.active) return 'client_inactive';
  if (!item.recovery_enabled) return 'recovery_disabled';
  if (!isE164(item.caller_number)) return 'caller_number_unavailable';

  const optOut = await db.query(
    'SELECT opted_out FROM opt_outs WHERE phone_number = $1 AND twilio_number = $2',
    [item.caller_number, item.twilio_number],
  );
  if (optOut.rows[0]?.opted_out) return 'opted_out';

  // 24-hour caller cooldown: one recovery text per caller per client per window.
  // 'needs_review' counts because that text may well have gone out.
  const recent = await db.query(
    `SELECT 1 FROM recovery_queue
      WHERE client_id = $1 AND caller_number = $2 AND id <> $3
        AND status IN ('sending', 'sent', 'needs_review')
        AND claimed_at > now() - make_interval(hours => $4)
      LIMIT 1`,
    [item.client_id, item.caller_number, item.id, cooldownHours],
  );
  if (recent.rowCount > 0) return 'cooldown';

  return null;
}

// A Twilio RestException with a 4xx status means Twilio rejected the request and created no
// message. Anything else (timeout, network error, 5xx) leaves us unsure whether it was sent.
function isDefiniteRejection(err) {
  return Number.isInteger(err?.status) && err.status >= 400 && err.status < 500;
}

// Steps 8-9: send one recovery text and save the result. Returns what happened, or null if the
// queue is empty.
export async function processNext({ pool, sendSms, config, logger = console }) {
  const item = await claimNext(pool, config.worker);
  if (!item) return null;

  if (item.skipReason) {
    logger.log(`Recovery #${item.id}: skipped (${item.skipReason})`);
    return { id: item.id, status: 'skipped', skipReason: item.skipReason };
  }

  let message;
  try {
    message = await sendSms({
      to: item.caller_number,
      from: item.twilio_number,
      body: item.body,
      statusCallback: `${config.publicBaseUrl}/webhooks/twilio/sms-status`,
    });
  } catch (err) {
    const status = isDefiniteRejection(err) ? 'failed' : 'needs_review';
    await pool.query(
      `UPDATE recovery_queue
          SET status = $2, error_code = $3, error_message = $4, updated_at = now()
        WHERE id = $1`,
      [item.id, status, err.code == null ? null : String(err.code), err.message ?? String(err)],
    );
    logger.error(`Recovery #${item.id}: ${status} - ${err.message ?? err}`);
    return { id: item.id, status };
  }

  // If this write fails the row stays 'sending' and the stuck-send sweep moves it to review.
  await pool.query(
    `UPDATE recovery_queue
        SET status = 'sent', message_sid = $2, delivery_status = COALESCE(delivery_status, $3),
            sent_at = now(), updated_at = now()
      WHERE id = $1`,
    [item.id, message.sid, message.status ?? null],
  );
  await replayDeliveryStatuses(pool, message.sid);
  logger.log(`Recovery #${item.id}: sent ${message.sid}`);
  return { id: item.id, status: 'sent', messageSid: message.sid };
}

// Items left in 'sending' (e.g. the worker crashed mid-send) have an unknown outcome.
// They go to review instead of being resent, so nobody gets a duplicate text.
export async function sweepStuckSends({ pool, config, logger = console }) {
  const { rows } = await pool.query(
    `UPDATE recovery_queue
        SET status = 'needs_review',
            error_message = 'Worker stopped before the send result was saved',
            updated_at = now()
      WHERE status = 'sending' AND claimed_at < now() - make_interval(mins => $1)
      RETURNING id`,
    [config.worker.stuckSendingMinutes],
  );
  for (const row of rows) logger.error(`Recovery #${row.id}: send outcome unknown, needs review`);
  return rows.length;
}
