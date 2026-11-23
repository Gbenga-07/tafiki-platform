const crypto = require('crypto');
const uuid = () => crypto.randomUUID();
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomCode = (digits = 6) => String(crypto.randomInt(0, 10 ** digits)).padStart(digits, '0');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const tempPassword = () => { const c = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; let s = ''; for (let i = 0; i < 12; i++) s += c[crypto.randomInt(0, c.length)]; return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8) + '!'; };
const now = () => new Date();
const addMinutes = (d, m) => new Date(d.getTime() + m * 60000);
const lower = (e) => String(e || '').trim().toLowerCase();
class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }
const bad = (msg, extra) => new HttpError(400, msg, extra);
module.exports = { uuid, sha256, randomCode, randomToken, tempPassword, now, addMinutes, lower, HttpError, bad };
