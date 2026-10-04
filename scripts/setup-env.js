// Creates your private .env file (and database-setup.sql) with strong random passwords.
// Usage: npm run setup
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
const sqlPath = path.join(root, 'database-setup.sql');

if (existsSync(envPath)) {
  console.log('.env already exists, so nothing was changed.');
  console.log('To change a password, open .env in a text editor, edit the line and save.');
  process.exit(0);
}

// base64url only uses A-Z a-z 0-9 - _ so it is safe inside a DATABASE_URL.
const secret = (bytes) => randomBytes(bytes).toString('base64url');
const dbPassword = secret(24);
const adminApiKey = secret(32);

const env = (await readFile(path.join(root, '.env.example'), 'utf8'))
  .replace(/^# Do NOT put real.*\n(#.*\n)*/m, '# Your private settings. Never commit or share this file.\n')
  .replaceAll('hootowl:change-me@', `hootowl:${dbPassword}@`)
  .replace(/^ADMIN_API_KEY=.*$/m, `ADMIN_API_KEY=${adminApiKey}`);

const sql = `-- Run this once as the "postgres" superuser (for example in pgAdmin's Query Tool).
-- It creates the database user and databases that match your .env file.
-- Delete this file afterwards: it contains your database password.

CREATE ROLE hootowl WITH LOGIN PASSWORD '${dbPassword}';
CREATE DATABASE hootowl OWNER hootowl;
CREATE DATABASE hootowl_test OWNER hootowl;

-- To change the password later, run:
--   ALTER ROLE hootowl WITH PASSWORD 'new-password';
-- and put the same new password in both DATABASE_URL lines of .env.
`;

await writeFile(envPath, env, { flag: 'wx' });
await writeFile(sqlPath, sql, { flag: 'wx' });

console.log('Created .env with a new database password and ADMIN_API_KEY.');
console.log('Created database-setup.sql. Run it in pgAdmin, then delete it.');
console.log('');
console.log('Still to do in .env:');
console.log('  - TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN (from console.twilio.com)');
console.log('  - PUBLIC_BASE_URL (your ngrok or production https address)');
