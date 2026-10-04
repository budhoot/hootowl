import os from 'node:os';

export const workerId = `${os.hostname()}:${process.pid}`;

export async function recordHeartbeat(pool, id = workerId) {
  await pool.query(
    `INSERT INTO worker_heartbeats (worker_id, last_seen) VALUES ($1, now())
     ON CONFLICT (worker_id) DO UPDATE SET last_seen = now()`,
    [id],
  );
}

export async function removeHeartbeat(pool, id = workerId) {
  await pool.query('DELETE FROM worker_heartbeats WHERE worker_id = $1', [id]);
}

// A worker counts as online if it checked in within three poll intervals (at least 60 s).
export async function workerStatus(pool, config) {
  const thresholdSeconds = Math.max(60, (config.worker.pollIntervalMs * 3) / 1000);
  const { rows } = await pool.query(
    `SELECT max(last_seen) AS last_seen,
            coalesce(max(last_seen) > now() - make_interval(secs => $1), false) AS online
       FROM worker_heartbeats`,
    [thresholdSeconds],
  );
  return { online: rows[0].online, last_seen: rows[0].last_seen };
}
