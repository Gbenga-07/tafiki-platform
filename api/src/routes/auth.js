// Member accounts: register (cooperative membership), sign in, email verification, password reset.
const express = require('express');
const counters = require('../lib/counters');
const { z } = require('zod');
const config = require('../config');
const { getDb } = require('../db');
const { uuid, lower, bad, HttpError } = require('../lib/util');
const pw = require('../lib/passwords');
const { startSession, endSession, requireUser, revokeAll } = require('../lib/auth');
const lockout = require('../lib/lockout');
const codes = require('../lib/codes');
const { sendEmail } = require('../lib/mailer');
const activity = require('../lib/activity');
const present = require('../lib/present');
const r = express.Router();

const Register = z.object({
  role: z.enum(['investor', 'retailer']),
  firstName: z.string().trim().min(1).max(60), lastName: z.string().trim().min(1).max(60),
  email: z.string().trim().email().max(190), phone: z.string().trim().min(7).max(40),
  password: z.string().min(8).max(200),
  city: z.string().trim().max(80).optional(),
  shop: z.string().trim().max(120).optional(), area: z.string().trim().max(160).optional(),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  bank: z.object({ name: z.string().trim().min(2).max(80), account: z.string().regex(/^\d{10}$/), accountName: z.string().trim().min(3).max(120) }).optional(),
  agreeTerms: z.literal(true, { errorMap: () => ({ message: 'You must agree to the Terms and Conditions, including cooperative membership.' }) }),
  termsVersion: z.string().max(40).optional(),
});

// Membership numbers come from an atomic counter, so simultaneous sign-ups never get the same number.
async function nextCoopNo(db) {
  const year = new Date().getFullYear();
  const prefix = `FMC-${year}-`;
  const last = await db('users').where('coop_no', 'like', prefix + '%').max({ m: 'coop_no' }).first();
  const start = last && last.m ? parseInt(String(last.m).split('-').pop(), 10) + 1 : 1001; // used only when the year's counter is first created
  const n = await counters.next('coop_' + year, start);
  return prefix + String(n).padStart(4, '0');
}

r.post('/register', async (req, res) => {
  const d = Register.parse(req.body);
  if (!pw.strongEnough(d.password)) throw bad('Use at least 8 characters with letters and a number.');
  if (d.role === 'retailer' && !(d.shop && /^FOODCORE\s+\S/i.test(d.shop))) throw bad('Store names start with FOODCORE.');
  const db = getDb();
  const email = lower(d.email);
  if (await db('users').where({ email }).first()) throw new HttpError(409, 'An account already exists for this email. Try signing in.');
  const id = uuid();
  const coopNo = await nextCoopNo(db);
  await db('users').insert({ id, role: d.role, name: `${d.firstName} ${d.lastName}`, email, phone: d.phone, city: d.city || null, shop: d.role === 'retailer' ? d.shop : null, area: d.role === 'retailer' ? d.area || null : null, dob: d.dob || null,
    password_hash: await pw.hash(d.password), bank_name: d.bank ? d.bank.name : null, bank_account: d.bank ? d.bank.account : null, bank_account_name: d.bank ? d.bank.accountName : null,
    coop_no: coopNo, coop_agreed_at: new Date(), terms_version: d.termsVersion || config.termsVersion });
  await activity.log({ type: 'user', id }, 'member.registered', { type: 'user', id }, { role: d.role, coopNo });
  const { value } = await codes.issue('email_verify', 'user', id, { minutes: 30 });
  await sendEmail({ to: email, name: d.firstName, category: 'account', subject: 'Confirm your email for Tafiki', ref: id, paragraphs: [`Welcome to Tafiki. Your FOODCORE Multipurpose Cooperative membership number is ${coopNo}.`, `Your email confirmation code is ${value}. It expires in 30 minutes.`, 'Your identity check comes next, then you can take part in member offers.'] });
  await startSession(res, req, 'user', id, config.memberSessionHours * 60);
  const u = await db('users').where({ id }).first();
  res.status(201).json({ user: present.user(u) });
});

r.post('/verify-email', requireUser, async (req, res) => {
  const out = await codes.check('email_verify', 'user', req.user.id, req.body && req.body.code);
  if (!out.ok) throw bad(out.reason === 'wrong' ? 'That code is not correct.' : 'That code has expired. Request a new one.');
  await getDb()('users').where({ id: req.user.id }).update({ email_verified: true, updated_at: new Date() });
  res.json({ ok: true });
});
r.post('/verify-email/resend', requireUser, async (req, res) => {
  const { value } = await codes.issue('email_verify', 'user', req.user.id, { minutes: 30 });
  await sendEmail({ to: req.user.email, name: req.user.name.split(' ')[0], category: 'account', subject: 'Your Tafiki confirmation code', ref: req.user.id, paragraphs: [`Your email confirmation code is ${value}. It expires in 30 minutes.`] });
  res.json({ ok: true });
});

r.post('/login', async (req, res) => {
  const email = lower(req.body && req.body.email), password = req.body && req.body.password;
  const key = 'user:' + email;
  const locked = await lockout.isLocked(key);
  if (locked) throw new HttpError(429, 'Too many failed attempts. Try again later.', { lockedUntil: locked });
  const db = getDb();
  const u = await db('users').where({ email }).first();
  const ok = u && (await pw.verify(password, u.password_hash));
  if (!ok || u.status !== 'active') {
    await lockout.fail(key); await lockout.event('user', email || '(blank)', false, !ok ? 'Wrong email or password' : 'Account suspended', req.ip);
    throw new HttpError(401, u && ok ? 'This account is suspended. Contact support@tafiki.com.' : 'The email or password is not correct.');
  }
  await lockout.clear(key); await lockout.event('user', email, true, 'Password', req.ip);
  await startSession(res, req, 'user', u.id, config.memberSessionHours * 60);
  res.json({ user: present.user(u) });
});

r.post('/logout', async (req, res) => { await endSession(req, res, 'user'); res.json({ ok: true }); });

r.post('/password/forgot', async (req, res) => {
  const email = lower(req.body && req.body.email);
  const u = email && (await getDb()('users').where({ email }).first());
  if (u && u.status === 'active') {
    const { value } = await codes.issue('password_reset', 'user', u.id, { minutes: 30, token: true });
    await sendEmail({ to: u.email, name: u.name.split(' ')[0], category: 'security', subject: 'Reset your Tafiki password', ref: u.id, paragraphs: ['We received a request to reset your password.', `Use this link within 30 minutes: ${config.appUrl}/#reset?token=${value}`, 'If you did not ask for this, you can ignore this email.'] });
  }
  res.json({ ok: true }); // same answer either way, so emails cannot be discovered
});
r.post('/password/reset', async (req, res) => {
  const { token, password } = req.body || {};
  if (!pw.strongEnough(password)) throw bad('Use at least 8 characters with letters and a number.');
  const row = await codes.byToken('password_reset', token);
  if (!row || row.subject_type !== 'user') throw bad('This reset link has expired. Request a new one.');
  await codes.consume(row.id);
  await getDb()('users').where({ id: row.subject_id }).update({ password_hash: await pw.hash(password), must_change: false, updated_at: new Date() });
  await revokeAll('user', row.subject_id);
  await activity.log({ type: 'user', id: row.subject_id }, 'member.password_reset', { type: 'user', id: row.subject_id });
  res.json({ ok: true });
});
module.exports = r;
