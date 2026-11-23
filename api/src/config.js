require('dotenv').config();
const env = process.env;
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const config = {
  env: env.NODE_ENV || 'development',
  port: +(env.PORT || 4000),
  appUrl: env.APP_URL || 'http://localhost:8080',
  apiUrl: env.API_URL || 'http://localhost:4000',
  consolePath: env.CONSOLE_PATH || '/#console',
  corsOrigins: list(env.CORS_ORIGINS),
  jwtSecret: env.JWT_SECRET || '',
  cookieDomain: env.COOKIE_DOMAIN || undefined,
  mail: { from: env.MAIL_FROM || 'Tafiki <updates@tafiki.com>', replyTo: env.MAIL_REPLY_TO || 'support@tafiki.com', host: env.SMTP_HOST, port: +(env.SMTP_PORT || 587), user: env.SMTP_USER, pass: env.SMTP_PASS },
  termsVersion: '2.0 · November 2026',
  memberSessionHours: 24 * 7,
};
config.isProd = config.env === 'production';
if (config.isProd && config.jwtSecret.length < 32) throw new Error('JWT_SECRET must be set to a long random string in production.');
if (!config.jwtSecret) config.jwtSecret = 'dev-only-secret-change-me-dev-only-secret';
module.exports = config;
