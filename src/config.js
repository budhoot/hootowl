import 'dotenv/config';

function required(env, name) {
  const value = env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable ${name}. See .env.example.`);
  }
  return value.trim();
}

function number(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number, got "${raw}".`);
  }
  return value;
}

function boolean(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (raw.trim().toLowerCase() === 'true') return true;
  if (raw.trim().toLowerCase() === 'false') return false;
  throw new Error(`Environment variable ${name} must be "true" or "false", got "${raw}".`);
}

export function loadConfig(env = process.env) {
  const adminApiKey = required(env, 'ADMIN_API_KEY');
  if (adminApiKey.length < 24) {
    throw new Error('ADMIN_API_KEY must be at least 24 characters long.');
  }

  return {
    port: number(env, 'PORT', 3000),
    databaseUrl: required(env, 'DATABASE_URL'),
    // The public https address Twilio uses to reach this API, e.g. https://api.hootowl.net
    publicBaseUrl: required(env, 'PUBLIC_BASE_URL').replace(/\/+$/, ''),
    adminApiKey,
    smsSendEnabled: boolean(env, 'SMS_SEND_ENABLED', false),
    twilio: {
      accountSid: required(env, 'TWILIO_ACCOUNT_SID'),
      authToken: required(env, 'TWILIO_AUTH_TOKEN'),
    },
    dialTimeoutSeconds: number(env, 'DIAL_TIMEOUT_SECONDS', 20),
    worker: {
      pollIntervalMs: number(env, 'WORKER_POLL_INTERVAL_MS', 5000),
      cooldownHours: number(env, 'RECOVERY_COOLDOWN_HOURS', 24),
      stuckSendingMinutes: number(env, 'STUCK_SENDING_MINUTES', 10),
    },
  };
}
