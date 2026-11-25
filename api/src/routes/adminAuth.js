// Console sign-in (separate from the website), two-step verification, own password.
const express = require('express');
const { getDb } = require('../db');
const { lower, bad, HttpError, randomToken, sha256, addMinutes, now } = require('../lib/util');
const pw = require('../lib/passwords');
const { startSession, endSession, requireAdmin, revokeAll } = require('../lib/auth');
const { getSetting } = require('../lib/settings');
const lockout = require('../lib/lockout');
const codes = require('../lib/codes');
const { sendEmail } = require('../lib/mailer');
const K = require('../lib/emailkit');
const activity = require('../lib/activity');
const present = require('../lib/present');
const { ROLES } = require('../lib/permissions');
const r = express.Router();

async function finish(req, res, a, how) {
  const sec = await getSetting('security');
  await getDb()('admins').where({ id: a.id }).update({ last_login_at: now() });
  await lockout.event('admin', a.email, true, how, req.ip);
  await startSession(res, req, 'admin', a.id, sec.timeoutMinutes);
  await activity.log({ type: 'admin', id: a.id }, 'admin.signed_in', { type: 'admin', id: a.id });
  res.json({ admin: present.admin(a), permissions: ROLES[a.role] || [] });
}

r.post('/login', async (req, res) => {
  const email = lower(req.body && req.body.email);
  const key = 'admin:' + email;
  const locked = await lockout.isLocked(key);
  if (locked) throw new HttpError(429, 'Too many failed attempts. Try again later.', { lockedUntil: locked });
  const a = await getDb()('admins').where({ email }).first();
  const ok = a && (await pw.verify(req.body && req.body.password, a.password_hash));
  if (!ok || a.status !== 'active') {
    await lockout.fail(key); await lockout.event('admin', email || '(blank)', false, ok ? 'Account disabled' : 'Wrong email or password', req.ip);
    throw new HttpError(401, ok ? 'This administrator account is disabled.' : 'The email or password is not correct.');
  }
  await lockout.clear(key);
  const sec = await getSetting('security');
  if (sec.twofa) {
    const { value } = await codes.issue('admin_2fa', 'admin', a.id, { minutes: 10 });
    await sendEmail({ to: a.email, name: a.name.split(' ')[0], category: 'security', subject: 'Your Tafiki Console verification code', title: 'Your sign-in code',
      lead: `Your verification code is ${value}. Enter it in the Tafiki Console to finish signing in.`,
      blocks: [{ type: 'code', title: 'Verification code', code: value, sub: 'Expires in 10 minutes · use it once' }, { type: 'kv', title: 'Sign-in attempt', rows: [['Account', a.email], ['Role', a.role], ['Time', K.when()], ['From', req.ip || '']] },
        { type: 'note', tone: 'bad', title: 'Not you?', text: 'If you did not try to sign in, **tell a Super Admin straight away**. Never share this code, not even with Tafiki staff.' }], help: false });
    const ticket = randomToken(24);
    await getDb()('codes').insert({ id: require('../lib/util').uuid(), purpose: 'admin_ticket', subject_type: 'admin', subject_id: a.id, code_hash: sha256(ticket), expires_at: addMinutes(now(), 10) });
    return res.json({ step: 'code', ticket });
  }
  await finish(req, res, a, 'Password');
});

r.post('/verify', async (req, res) => {
  const { ticket, code } = req.body || {};
  const t = await codes.byToken('admin_ticket', ticket);
  if (!t) throw bad('Your sign-in has expired. Start again.');
  const out = await codes.check('admin_2fa', 'admin', t.subject_id, code);
  if (!out.ok) { const a = await getDb()('admins').where({ id: t.subject_id }).first(); await lockout.event('admin', a ? a.email : '?', false, 'Wrong verification code', req.ip); throw bad(out.reason === 'wrong' ? 'That code is not correct.' : 'That code has expired. Sign in again.'); }
  await codes.consume(t.id);
  const a = await getDb()('admins').where({ id: t.subject_id }).first();
  if (!a || a.status !== 'active') throw new HttpError(401, 'This administrator account is disabled.');
  await finish(req, res, a, 'Password and code');
});

r.post('/logout', async (req, res) => { if (req.admin) await activity.log({ type: 'admin', id: req.admin.id }, 'admin.signed_out'); await endSession(req, res, 'admin'); res.json({ ok: true }); });
r.get('/me', requireAdmin, (req, res) => res.json({ admin: present.admin(req.admin), permissions: ROLES[req.admin.role] || [] }));
r.post('/me/password', requireAdmin, async (req, res) => {
  const { current, next } = req.body || {};
  if (!(await pw.verify(current, req.admin.password_hash))) throw bad('Your current password is not correct.');
  if (!pw.strongEnough(next)) throw bad('Use at least 8 characters with letters and a number.');
  await getDb()('admins').where({ id: req.admin.id }).update({ password_hash: await pw.hash(next), must_change: false });
  await activity.log({ type: 'admin', id: req.admin.id }, 'admin.changed_password', { type: 'admin', id: req.admin.id });
  res.json({ ok: true });
});
module.exports = r;
