import pg from 'pg';

// Return BIGINT/BIGSERIAL columns (type 20) as JS numbers instead of strings.
// Our ids and counts stay far below Number.MAX_SAFE_INTEGER.
pg.types.setTypeParser(20, (value) => Number.parseInt(value, 10));

export function createPool(databaseUrl) {
  return new pg.Pool({ connectionString: databaseUrl });
}

export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
