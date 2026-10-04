import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { workerStatus } from './recovery/heartbeat.js';
import { adminRouter, HttpError } from './routes/admin.js';
import { twilioRouter } from './routes/twilio.js';

const dashboardDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'dashboard');

// The dashboard only loads its own files and only talks to this API.
function dashboardSecurityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
  next();
}

export function createApp({ pool, config, logger = console }) {
  const app = express();
  app.disable('x-powered-by');
  // Lets req.protocol / req.ip reflect the hosting platform's proxy.
  app.set('trust proxy', true);

  app.get('/health', async (req, res) => {
    const worker = await workerStatus(pool, config);
    res.json({ ok: true, worker_online: worker.online });
  });

  app.get('/', (req, res) => res.redirect('/dashboard/'));
  app.use('/dashboard', dashboardSecurityHeaders, express.static(dashboardDir));

  app.use('/webhooks/twilio', twilioRouter({ pool, config }));
  app.use('/admin', adminRouter({ pool, config }));

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' });
    if (err.code === '23505') return res.status(409).json({ error: 'Already exists', detail: err.detail });
    logger.error(`${req.method} ${req.originalUrl} failed:`, err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
