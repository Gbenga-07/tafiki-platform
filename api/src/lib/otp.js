// One-time codes by SMS through Termii: confirming a phone number, approving a withdrawal, changing bank details or phone.
// Codes are 6 digits, last 10 minutes, allow 5 tries, and are stored only as hashes. A new code cancels the last one.
const { getDb } = require('../db');
const codes = require('./codes');
const { sendSms, normalisePhone } = require('./sms');
const { bad } = require('./util');

const PURPOSES = { phone_verify: 'confirm your phone number', withdrawal: 'approve your withdrawal', bank_change: 'change your bank details', phone_change: 'confirm your new phone number' };
const required = () => !['0', 'false', 'off'].includes(String(process.env.OTP_REQUIRED || 'on').toLowerCase());
const masked = (p) => { const n = normalisePhone(p); return n ? '•••• ' + n.slice(-4) : null; };
const tooMany = (msg) => Object.assign(new Error(msg), { status: 429, expose: true });

async function send(user, purpose, toPhone) {
  if (!PURPOSES[purpose]) throw bad('Unknown code request.');
  const phone = purpose === 'phone_change' ? toPhone : user.phone;
  if (!normalisePhone(phone)) throw bad(purpose === 'phone_change' ? 'Enter a valid Nigerian phone number, e.g. 0803 000 0000.' : 'Add a valid Nigerian phone number to your account first.');
  const db = getDb(); const key = 'otp:' + purpose;
  const recent = await db('codes').where({ purpose: key, subject_type: 'user', subject_id: user.id }).where('created_at', '>', new Date(Date.now() - 3600e3)).orderBy('created_at', 'desc');
  if (recent[0] && Date.now() - new Date(recent[0].created_at).getTime() < 60e3) throw tooMany('A code was just sent. Wait a minute before asking for another.');
  if (recent.length >= 5) throw tooMany('Too many codes requested. Try again in an hour.');
  const { value } = await codes.issue(key, 'user', user.id, { minutes: 10 });
  if (purpose === 'phone_change') await db('users').where({ id: user.id }).update({ pending_phone: String(toPhone).trim().slice(0, 40) });
  await sendSms({ to: phone, text: `Your Tafiki code to ${PURPOSES[purpose]} is ${value}. It expires in 10 minutes. Never share it, not even with Tafiki staff.`, category: 'otp', ref: user.id, mask: value });
  return { sentTo: masked(phone), expiresInMinutes: 10 };
}

// Throws a clear 400 unless the code is right. A right code also confirms the phone it was sent to.
async function verify(user, purpose, code) {
  const out = await codes.check('otp:' + purpose, 'user', user.id, code);
  if (!out.ok) throw bad(out.reason === 'wrong' ? 'That code is not correct.' : out.reason === 'too_many' ? 'Too many wrong tries. Request a new code.' : 'That code has expired or was not requested. Request a new one.');
  const db = getDb();
  if (purpose === 'phone_change') { const u = await db('users').where({ id: user.id }).first(); await db('users').where({ id: user.id }).update({ phone: u.pending_phone, pending_phone: null, phone_verified_at: new Date(), updated_at: new Date() }); }
  else await db('users').where({ id: user.id }).update({ phone_verified_at: new Date() });
  return true;
}
// For money and account changes: checked only when OTP_REQUIRED is on (the default).
async function requireCode(user, purpose, code) { if (!required()) return; if (!code) throw bad('Enter the 6-digit code we sent to your phone.'); await verify(user, purpose, code); }
module.exports = { send, verify, requireCode, required, masked, PURPOSES };
