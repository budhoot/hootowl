import express from 'express';
import { adminRouter, HttpError } from './routes/admin.js';
import { twilioRouter } from './routes/twilio.js';

export function createApp({ pool, config, logger = console }) {
  const app = express();
  app.disable('x-powered-by');
  // Lets req.protocol / req.ip reflect the hosting platform's proxy.
  app.set('trust proxy', true);

  app.get('/health', async (req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  });

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
