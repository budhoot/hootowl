-- HootOwl Lead Rescue: initial schema.
-- Phone numbers are stored in E.164 format, e.g. +15551234567.

-- A HootOwl customer (a business whose missed calls we recover).
CREATE TABLE clients (
  id               BIGSERIAL PRIMARY KEY,
  name             TEXT        NOT NULL,
  booking_url      TEXT,
  -- Optional custom text. Placeholders: {business_name}, {booking_url}.
  recovery_message TEXT,
  -- active = false pauses all recovery texts for this client.
  active           BOOLEAN     NOT NULL DEFAULT TRUE,
  recovery_enabled BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A Twilio number that forwards to a client's real business phone.
CREATE TABLE phone_routes (
  id                BIGSERIAL PRIMARY KEY,
  client_id         BIGINT      NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  twilio_number     TEXT        NOT NULL UNIQUE,
  forward_to_number TEXT        NOT NULL,
  -- active = false makes the number answer "not in service" instead of forwarding.
  active            BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX phone_routes_client_idx ON phone_routes (client_id);

-- Every inbound call that reached a known route.
CREATE TABLE calls (
  id                 BIGSERIAL PRIMARY KEY,
  call_sid           TEXT        NOT NULL UNIQUE,
  client_id          BIGINT      NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  route_id           BIGINT      REFERENCES phone_routes(id) ON DELETE SET NULL,
  caller_number      TEXT        NOT NULL,
  twilio_number      TEXT        NOT NULL,
  -- From Twilio's <Dial> action callback: completed, answered, busy, no-answer, failed, canceled.
  dial_call_status   TEXT,
  dial_call_duration INTEGER,
  missed             BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX calls_client_created_idx ON calls (client_id, created_at DESC);

-- One recovery text per missed call. The worker drains rows with status 'pending'.
--   pending      -> waiting for the worker
--   sending      -> claimed by the worker, Twilio request in flight
--   sent         -> Twilio accepted the message (message_sid is set)
--   skipped      -> not sent on purpose (see skip_reason)
--   failed       -> Twilio rejected the request; nothing was sent
--   needs_review -> outcome unknown; an operator must check. Never resent automatically.
CREATE TABLE recovery_queue (
  id                  BIGSERIAL PRIMARY KEY,
  call_id             BIGINT      NOT NULL UNIQUE REFERENCES calls(id) ON DELETE CASCADE,
  client_id           BIGINT      NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  caller_number       TEXT        NOT NULL,
  twilio_number       TEXT        NOT NULL,
  status              TEXT        NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'failed', 'needs_review')),
  skip_reason         TEXT,
  message_body        TEXT,
  message_sid         TEXT        UNIQUE,
  delivery_status     TEXT,
  error_code          TEXT,
  error_message       TEXT,
  claimed_at          TIMESTAMPTZ,
  sent_at             TIMESTAMPTZ,
  delivery_updated_at TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX recovery_queue_pending_idx ON recovery_queue (created_at, id) WHERE status = 'pending';
CREATE INDEX recovery_queue_cooldown_idx ON recovery_queue (client_id, caller_number, claimed_at);

-- Every Twilio delivery-status callback, kept as an audit trail.
CREATE TABLE sms_status_events (
  id          BIGSERIAL PRIMARY KEY,
  message_sid TEXT        NOT NULL,
  status      TEXT        NOT NULL,
  error_code  TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sms_status_events_sid_idx ON sms_status_events (message_sid, id);

-- Texts that callers send to a client's Twilio number.
CREATE TABLE inbound_messages (
  id            BIGSERIAL PRIMARY KEY,
  message_sid   TEXT        NOT NULL UNIQUE,
  client_id     BIGINT      REFERENCES clients(id) ON DELETE SET NULL,
  from_number   TEXT        NOT NULL,
  to_number     TEXT        NOT NULL,
  body          TEXT        NOT NULL DEFAULT '',
  -- 'opt_out', 'opt_in' or NULL for a normal reply.
  keyword       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX inbound_messages_lookup_idx ON inbound_messages (to_number, from_number, created_at);
CREATE INDEX inbound_messages_client_idx ON inbound_messages (client_id, created_at DESC);

-- STOP / START state per caller and sending number (matches how Twilio tracks opt-outs).
CREATE TABLE opt_outs (
  phone_number  TEXT        NOT NULL,
  twilio_number TEXT        NOT NULL,
  opted_out     BOOLEAN     NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (phone_number, twilio_number)
);
