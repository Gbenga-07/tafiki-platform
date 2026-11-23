const bcrypt = require('bcryptjs');
const ROUNDS = process.env.NODE_ENV === 'test' ? 4 : 12;
const hash = (p) => bcrypt.hash(p, ROUNDS);
const verify = (p, h) => bcrypt.compare(String(p || ''), h || '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva');
// At least 8 characters with a letter and a number.
const strongEnough = (p) => typeof p === 'string' && p.length >= 8 && /[A-Za-z]/.test(p) && /\d/.test(p);
module.exports = { hash, verify, strongEnough };
