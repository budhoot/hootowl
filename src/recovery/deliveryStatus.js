// Twilio status callbacks can arrive out of order. Once a message reaches a final state we only
// allow 'delivered' -> 'read'; anything else would move the status backwards.
const FINAL_STATUSES = ['delivered', 'undelivered', 'failed', 'read', 'canceled'];

export async function applyDeliveryStatus(db, { messageSid, status, errorCode }) {
  await db.query(
    `UPDATE recovery_queue
        SET delivery_status = $2,
            error_code = COALESCE($3, error_code),
            delivery_updated_at = now(),
            updated_at = now()
      WHERE message_sid = $1
        AND (delivery_status IS NULL
             OR delivery_status <> ALL($4::text[])
             OR (delivery_status = 'delivered' AND $2 = 'read'))`,
    [messageSid, status, errorCode || null, FINAL_STATUSES],
  );
}

// A status callback can beat the worker's "save send result" write. After the worker stores the
// message SID it replays the callbacks that already arrived for it, in order.
export async function replayDeliveryStatuses(db, messageSid) {
  const { rows } = await db.query(
    'SELECT status, error_code FROM sms_status_events WHERE message_sid = $1 ORDER BY id',
    [messageSid],
  );
  for (const row of rows) {
    await applyDeliveryStatus(db, { messageSid, status: row.status, errorCode: row.error_code });
  }
}
