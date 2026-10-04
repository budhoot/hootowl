import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { withTransaction } from '../db.js';
import { isE164 } from '../phone.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireAdminKey(adminApiKey) {
  const expected = Buffer.from(`Bearer ${adminApiKey}`);
  return (req, res, next) => {
    const given = Buffer.from(req.get('Authorization') ?? '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return res.status(401).json({ error: 'Missing or invalid admin API key' });
    }
    next();
  };
}

// ---- input validation helpers ----

function id(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id');
  return n;
}

function phone(value, field) {
  if (!isE164(value)) throw new HttpError(400, `${field} must be an E.164 phone number like +15551234567`);
  return value;
}

function bool(value, field) {
  if (typeof value !== 'boolean') throw new HttpError(400, `${field} must be true or false`);
  return value;
}

function text(value, field, { allowNull = false } = {}) {
  if (value === null && allowNull) return null;
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} must be a non-empty string`);
  return value.trim();
}

function url(value, field) {
  if (value === null) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(400, `${field} must be a full URL like https://hootowl.net/book`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new HttpError(400, `${field} must start with http(s)://`);
  return value;
}

function paging(query) {
  const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 50, 1), 200);
  const offset = Math.max(Number.parseInt(query.offset, 10) || 0, 0);
  return { limit, offset };
}

function optionalClientId(query) {
  return query.client_id === undefined ? null : id(query.client_id);
}

// Picks the allowed fields that are present in the request body and validates each one.
function pickFields(body, validators) {
  const fields = {};
  for (const [key, validate] of Object.entries(validators)) {
    if (body[key] !== undefined) fields[key] = validate(body[key], key);
  }
  return fields;
}

const clientFieldValidators = {
  name: (v, f) => text(v, f),
  booking_url: url,
  recovery_message: (v, f) => text(v, f, { allowNull: true }),
  active: bool,
  recovery_enabled: bool,
};

const routeFieldValidators = {
  forward_to_number: phone,
  active: bool,
};

// Builds "SET a = $2, b = $3" from validated fields (parameter $1 is the row id).
function setClause(fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) throw new HttpError(400, 'No fields to update');
  return {
    sql: keys.map((key, i) => `${key} = $${i + 2}`).join(', '),
    values: keys.map((key) => fields[key]),
  };
}

const CLIENT_SELECT = `
  SELECT c.*,
         COALESCE((SELECT json_agg(r ORDER BY r.id) FROM phone_routes r WHERE r.client_id = c.id), '[]') AS routes
    FROM clients c`;

export function adminRouter({ pool, config }) {
  const router = express.Router();
  router.use(requireAdminKey(config.adminApiKey));
  router.use(express.json());

  async function getClient(db, clientId) {
    const { rows } = await db.query(`${CLIENT_SELECT} WHERE c.id = $1`, [clientId]);
    if (!rows[0]) throw new HttpError(404, 'Client not found');
    return rows[0];
  }

  async function insertRoute(db, clientId, body) {
    const { rows } = await db.query(
      `INSERT INTO phone_routes (client_id, twilio_number, forward_to_number, active)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [
        clientId,
        phone(body?.twilio_number, 'twilio_number'),
        phone(body?.forward_to_number, 'forward_to_number'),
        body?.active === undefined ? true : bool(body.active, 'active'),
      ],
    );
    return rows[0];
  }

  // ---- clients ----

  router.get('/clients', async (req, res) => {
    const { rows } = await pool.query(`${CLIENT_SELECT} ORDER BY c.id`);
    res.json({ clients: rows });
  });

  router.post('/clients', async (req, res) => {
    const body = req.body ?? {};
    const fields = pickFields(body, clientFieldValidators);
    if (!fields.name) throw new HttpError(400, 'name is required');
    if (body.routes !== undefined && !Array.isArray(body.routes)) throw new HttpError(400, 'routes must be a list');

    const client = await withTransaction(pool, async (db) => {
      const keys = Object.keys(fields);
      const { rows } = await db.query(
        `INSERT INTO clients (${keys.join(', ')})
         VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        keys.map((key) => fields[key]),
      );
      for (const route of body.routes ?? []) await insertRoute(db, rows[0].id, route);
      return getClient(db, rows[0].id);
    });
    res.status(201).json({ client });
  });

  router.get('/clients/:id', async (req, res) => {
    res.json({ client: await getClient(pool, id(req.params.id)) });
  });

  router.patch('/clients/:id', async (req, res) => {
    const clientId = id(req.params.id);
    const { sql, values } = setClause(pickFields(req.body ?? {}, clientFieldValidators));
    const { rowCount } = await pool.query(
      `UPDATE clients SET ${sql}, updated_at = now() WHERE id = $1`,
      [clientId, ...values],
    );
    if (rowCount === 0) throw new HttpError(404, 'Client not found');
    res.json({ client: await getClient(pool, clientId) });
  });

  for (const [action, enabled] of [['enable', true], ['disable', false]]) {
    router.post(`/clients/:id/recovery/${action}`, async (req, res) => {
      const clientId = id(req.params.id);
      const { rowCount } = await pool.query(
        'UPDATE clients SET recovery_enabled = $2, updated_at = now() WHERE id = $1',
        [clientId, enabled],
      );
      if (rowCount === 0) throw new HttpError(404, 'Client not found');
      res.json({ client: await getClient(pool, clientId) });
    });
  }

  // ---- phone-number routes ----

  router.post('/clients/:id/routes', async (req, res) => {
    const clientId = id(req.params.id);
    await getClient(pool, clientId);
    res.status(201).json({ route: await insertRoute(pool, clientId, req.body) });
  });

  router.get('/routes', async (req, res) => {
    const clientId = optionalClientId(req.query);
    const { rows } = await pool.query(
      `SELECT r.*, c.name AS client_name
         FROM phone_routes r JOIN clients c ON c.id = r.client_id
        WHERE $1::bigint IS NULL OR r.client_id = $1
        ORDER BY r.id`,
      [clientId],
    );
    res.json({ routes: rows });
  });

  router.patch('/routes/:id', async (req, res) => {
    const { sql, values } = setClause(pickFields(req.body ?? {}, routeFieldValidators));
    const { rows } = await pool.query(
      `UPDATE phone_routes SET ${sql}, updated_at = now() WHERE id = $1 RETURNING *`,
      [id(req.params.id), ...values],
    );
    if (!rows[0]) throw new HttpError(404, 'Route not found');
    res.json({ route: rows[0] });
  });

  // ---- lead inbox ----

  // Missed calls, newest first, with the recovery text status and any replies from that caller.
  router.get('/inbox', async (req, res) => {
    const clientId = optionalClientId(req.query);
    const { limit, offset } = paging(req.query);
    const { rows } = await pool.query(
      `SELECT c.id AS call_id, c.client_id, cl.name AS client_name,
              c.caller_number, c.twilio_number, c.dial_call_status, c.created_at AS called_at,
              q.id AS recovery_id, q.status AS recovery_status, q.skip_reason, q.message_body,
              q.message_sid, q.delivery_status, q.error_code, q.error_message, q.sent_at,
              COALESCE((
                SELECT json_agg(json_build_object(
                         'id', m.id, 'body', m.body, 'keyword', m.keyword, 'received_at', m.created_at)
                         ORDER BY m.id)
                  FROM inbound_messages m
                 WHERE m.from_number = c.caller_number
                   AND m.to_number = c.twilio_number
                   AND m.created_at >= c.created_at
              ), '[]') AS replies
         FROM calls c
         JOIN clients cl ON cl.id = c.client_id
         LEFT JOIN recovery_queue q ON q.call_id = c.id
        WHERE c.missed AND ($1::bigint IS NULL OR c.client_id = $1)
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT $2 OFFSET $3`,
      [clientId, limit, offset],
    );
    res.json({ leads: rows, limit, offset });
  });

  router.get('/replies', async (req, res) => {
    const clientId = optionalClientId(req.query);
    const { limit, offset } = paging(req.query);
    const { rows } = await pool.query(
      `SELECT m.*, cl.name AS client_name
         FROM inbound_messages m
         LEFT JOIN clients cl ON cl.id = m.client_id
        WHERE $1::bigint IS NULL OR m.client_id = $1
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $2 OFFSET $3`,
      [clientId, limit, offset],
    );
    res.json({ replies: rows, limit, offset });
  });

  // ---- recovery queue review ----

  router.get('/recovery', async (req, res) => {
    const clientId = optionalClientId(req.query);
    const status = req.query.status ?? null;
    const { limit, offset } = paging(req.query);
    const { rows } = await pool.query(
      `SELECT q.*, cl.name AS client_name
         FROM recovery_queue q JOIN clients cl ON cl.id = q.client_id
        WHERE ($1::bigint IS NULL OR q.client_id = $1)
          AND ($2::text IS NULL OR q.status = $2)
        ORDER BY q.created_at DESC, q.id DESC
        LIMIT $3 OFFSET $4`,
      [clientId, status, limit, offset],
    );
    res.json({ recovery: rows, limit, offset });
  });

  // An operator settles a text whose outcome was unknown or that failed:
  //   'sent'    -> confirmed in the Twilio console that it went out
  //   'failed'  -> confirmed it did not go out; leave it
  //   'pending' -> put it back on the queue so the worker tries again
  router.post('/recovery/:id/resolve', async (req, res) => {
    const status = req.body?.status;
    if (!['sent', 'failed', 'pending'].includes(status)) {
      throw new HttpError(400, "status must be 'sent', 'failed' or 'pending'");
    }
    const { rows } = await pool.query(
      `UPDATE recovery_queue
          SET status = $2,
              claimed_at = CASE WHEN $2 = 'pending' THEN NULL ELSE claimed_at END,
              updated_at = now()
        WHERE id = $1 AND status IN ('needs_review', 'failed')
        RETURNING *`,
      [id(req.params.id), status],
    );
    if (!rows[0]) throw new HttpError(409, "Only 'needs_review' or 'failed' items can be resolved");
    res.json({ recovery: rows[0] });
  });

  return router;
}
