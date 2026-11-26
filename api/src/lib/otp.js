// One-time codes by email: approving a withdrawal and changing bank details. (No SMS: Tafiki verifies by email only.)
// Codes are 6 digits, last 10 minutes, allow 5 tries, and are stored only as hashes. A new code cancels the last one.
const { getDb } = require('../db');
const codes = require('./codes');
const { bad } = require('./util');

const PURPOSES = { withdrawal: 'approve your withdrawal', bank_change: 'change your bank details' };
const required = () => !['0', 'false', 'off'].includes(String(process.env.OTP_REQUIRED || 'on').toLowerCase());
const masked = (email) => { const [n, d] = String(email || '').split('@'); return d ? `${n.slice(0, 2)}•••@${d}` : null; };
const tooMany = (msg) => Object.assign(new Error(msg), { status: 429, expose: true });

async function send(user, purpose) {
  if (!PURPOSES[purpose]) throw bad('Unknown code request.');
  const db = getDb(); const key = 'otp:' + purpose;
  const recent = await db('codes').where({ purpose: key, subject_type: 'user', subject_id: user.id }).where('created_at', '>', new Date(Date.now() - 3600e3)).orderBy('created_at', 'desc');
  if (recent[0] && Date.now() - new Date(recent[0].created_at).getTime() < 60e3) throw tooMany('A code was just sent. Wait a minute before asking for another.');
  if (recent.length >= 5) throw tooMany('Too many codes requested. Try again in an hour.');
  const { value } = await codes.issue(key, 'user', user.id, { minutes: 10 });
  const K = require('./emailkit');
  await require('./mailer').sendEmail({ to: user.email, name: K.first(user), category: 'security', ref: user.id, subject: `Your Tafiki code to ${PURPOSES[purpose]}`, title: 'Your security code',
    lead: `Your code to ${PURPOSES[purpose]} is ${value}. Enter it on Tafiki to continue.`,
    blocks: [{ type: 'code', title: 'Security code', code: value, sub: 'Expires in 10 minutes · use it once' }, { type: 'kv', title: 'Request', rows: [['Action', PURPOSES[purpose].replace(/^./, (c) => c.toUpperCase())], ['Account', user.email], ['Requested', K.when()]] },
      { type: 'note', tone: 'bad', title: 'Not you?', text: 'If you did not ask for this, do not share the code with anyone, change your password and reply to this email straight away. Tafiki staff will never ask for it.' }], help: false });
  return { sentTo: masked(user.email), expiresInMinutes: 10 };
}
// Throws a clear 400 unless the code is right.
async function verify(user, purpose, code) {
  const out = await codes.check('otp:' + purpose, 'user', user.id, code);
  if (!out.ok) throw bad(out.reason === 'wrong' ? 'That code is not correct.' : out.reason === 'too_many' ? 'Too many wrong tries. Request a new code.' : 'That code has expired or was not requested. Request a new one.');
  return true;
}
// For money and account changes: checked only when OTP_REQUIRED is on (the default).
async function requireCode(user, purpose, code) { if (!required()) return; if (!code) throw bad('Enter the 6-digit code we sent to your email.'); await verify(user, purpose, code); }
module.exports = { send, verify, requireCode, required, masked, PURPOSES };
