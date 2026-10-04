import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { createPool, withTransaction } from './db.js';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// Applies every migrations/*.sql file that has not run yet, in filename order.
export async function migrate(pool, log = console.log) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    await withTransaction(pool, async (client) => {
      // Lock so two processes starting at once cannot apply the same migration twice.
      await client.query('LOCK TABLE schema_migrations IN EXCLUSIVE MODE');
      const { rowCount } = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (rowCount > 0) return;
      await client.query(await readFile(path.join(migrationsDir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      log(`Applied migration ${file}`);
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL. See .env.example.');
    process.exit(1);
  }
  const pool = createPool(process.env.DATABASE_URL);
  try {
    await migrate(pool);
    console.log('Database is up to date.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
