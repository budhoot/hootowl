-- Each running recovery worker updates its row every loop, so the API and the
-- dashboard can tell whether a worker is online.
CREATE TABLE worker_heartbeats (
  worker_id  TEXT        PRIMARY KEY,
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now()
);
