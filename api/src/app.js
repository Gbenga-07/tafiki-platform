const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { ZodError } = require('zod');
const config = require('./config');
const { loader, HttpError } = { ...require('./lib/auth'), ...require('./lib/util') };

function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: (o, cb) => cb(null, !o || config.corsOrigins.includes(o) || !config.isProd), credentials: true }));
  app.use('/webhooks', require('./routes/webhooks')); // raw body, before JSON parsing
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());
  // Simple CSRF protection: browsers cannot send this header cross-site without passing CORS.
  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path.startsWith('/webhooks/')) return next();
    if (req.get('X-Tafiki-Client') !== '1') return next(new HttpError(403, 'Missing client header.'));
    next();
  });
  const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: config.isProd ? 30 : 1000, standardHeaders: true, legacyHeaders: false });
  app.use(loader('user'));
  app.use(loader('admin'));
  const wrap = (router) => { // pass async errors to the error handler
    router.stack.forEach((l) => { if (l.route) l.route.stack.forEach((h) => { const fn = h.handle; if (fn.length < 4) h.handle = (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }); });
    return router;
  };
  app.get('/api/health', (req, res) => res.json({ ok: true, service: 'tafiki-api', time: new Date().toISOString() }));
  app.use('/api/auth', authLimit, wrap(require('./routes/auth')));
  app.use('/api/me', wrap(require('./routes/me')));
  app.use('/api/admin/auth', authLimit, wrap(require('./routes/adminAuth')));
  app.use('/api/admin/admins', wrap(require('./routes/admins')));
  app.use('/api/admin/users', wrap(require('./routes/adminUsers')));
  app.use('/api', wrap(require('./routes/packages').router));
  app.use('/api/holdings', wrap(require('./routes/holdings')));
  app.use('/api/admin', wrap(require('./routes/adminUnits')));
  app.use('/api/me', wrap(require('./routes/money')));
  app.use('/api/store', wrap(require('./routes/store')));
  app.use('/api/driver', authLimit, wrap(require('./routes/driver')));
  app.use('/api/admin', wrap(require('./routes/adminOps')));
  app.use('/api/admin', wrap(require('./routes/adminMoney')));
  app.use('/api/admin', wrap(require('./routes/adminMisc')));
  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ZodError) return res.status(400).json({ error: err.issues[0] ? err.issues[0].message : 'Invalid request.', fields: err.issues.map((i) => i.path.join('.')) });
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong. Please try again.' : err.message, ...(err.extra || {}) });
  });
  return app;
}
module.exports = { createApp };
