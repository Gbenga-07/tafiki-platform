// Encrypts small secrets (delivery codes) so the store portal can show them; the database never holds them in plain text.
const crypto = require('crypto');
const config = require('../config');
const key = () => crypto.createHash('sha256').update('tafiki-codes|' + config.jwtSecret).digest();
function seal(text) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key(), iv); const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]); return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.'); }
function open(box) { const [iv, tag, enc] = String(box).split('.').map((s) => Buffer.from(s, 'base64url')); const d = crypto.createDecipheriv('aes-256-gcm', key(), iv); d.setAuthTag(tag); return Buffer.concat([d.update(enc), d.final()]).toString('utf8'); }
module.exports = { seal, open };
