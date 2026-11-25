// Admin views of members and stores, editing details and resetting passwords.
const express = require('express');
const { z } = require('zod');
const { getDb } = require('../db');
const { lower, bad, HttpError, tempPassword } = require('../lib/util');
const pw = require('../lib/passwords');
const { requireAdmin, requirePerm, revokeAll } = require('../lib/auth');
const codes = require('../lib/codes');
const { sendEmail } = require('../lib/mailer');
const activity = require('../lib/activity');
const present = require('../lib/present');
const config = require('../config');
const r = express.Router();
r.use(requireAdmin);
const me = (req) => ({ type: 'admin', id: req.admin.id });

r.get('/', async (req, res) => {
  const { role, kyc, q } = req.query; const db = getDb();
  let x = db('users').orderBy('created_at', 'desc').limit(500);
  if (role) x = x.where({ role }); if (kyc) x = x.where({ kyc_status: kyc });
  if (q) x = x.where((b) => b.where('name', 'like', `%${q}%`).orWhere('email', 'like', `%${q}%`).orWhere('shop', 'like', `%${q}%`));
  res.json({ users: (await x).map(present.user) });
});
r.get('/:id', async (req, res) => {
  const u = await getDb()('users').where({ id: req.params.id }).first(); if (!u) throw new HttpError(404, 'Member not found.');
  const log = await getDb()('activity_log').where({ target_type: 'user', target_id: u.id }).orderBy('id', 'desc').limit(50);
  res.json({ user: present.userFull(u), activity: log });
});
const LABELS = { name: 'name', email: 'email', phone: 'phone', city: 'city', shop: 'mart name', area: 'mart address', bank_name: 'bank', bank_account: 'account number', bank_account_name: 'account name', kyc_status: 'verification status' };
const Edit = z.object({ name: z.string().trim().min(3).max(120).optional(), email: z.string().trim().email().optional(), phone: z.string().trim().max(40).optional(), city: z.string().trim().max(80).optional(),
  shop: z.string().trim().max(120).optional(), area: z.string().trim().max(160).optional(), kycStatus: z.enum(['pending', 'verified', 'rejected']).optional(),
  bank: z.object({ name: z.string().trim().max(80), account: z.string().regex(/^(\d{10})?$/), accountName: z.string().trim().max(120) }).optional() });
r.patch('/:id', requirePerm('members'), async (req, res) => {
  const d = Edit.parse(req.body); const db = getDb(); const u = await db('users').where({ id: req.params.id }).first();
  if (!u) throw new HttpError(404, 'Member not found.');
  const upd = {};
  for (const k of ['name', 'phone', 'city', 'shop', 'area']) if (d[k] !== undefined) upd[k] = d[k];
  if (d.email) upd.email = lower(d.email);
  if (d.kycStatus) upd.kyc_status = d.kycStatus;
  if (d.bank) Object.assign(upd, { bank_name: d.bank.name || null, bank_account: d.bank.account || null, bank_account_name: d.bank.accountName || null });
  if (upd.shop && u.role === 'retailer' && !/^FOODCORE\s+\S/i.test(upd.shop)) throw bad('Mart names start with FOODCORE.');
  if (upd.email && upd.email !== u.email && (await db('users').where({ email: upd.email }).first())) throw new HttpError(409, 'That email is used by another account.');
  const changed = Object.keys(upd).filter((k) => String(u[k] ?? '') !== String(upd[k] ?? ''));
  if (!changed.length) return res.json({ user: present.userFull(u), changed: [] });
  await db('users').where({ id: u.id }).update({ ...upd, updated_at: new Date() });
  await activity.log(me(req), 'member.edited_by_admin', { type: 'user', id: u.id }, { fields: changed });
  if (changed.includes('kyc_status') && upd.kyc_status === 'verified') await require('../lib/units').onKycVerified(u.id, me(req));
  if (upd.email && require('../lib/marts').isPlaceholderEmail(u.email) && !require('../lib/marts').isPlaceholderEmail(upd.email)) {
    await sendEmail({ to: upd.email, name: (upd.name || u.name).split(' ')[0], category: 'account', subject: `You now manage ${upd.shop || u.shop} on Tafiki`, ref: u.id, paragraphs: [`Tafiki has set you up as the manager of ${upd.shop || u.shop}.`, `To sign in, go to ${config.appUrl}/#login, choose "Forgot your password?" and enter this email to set your password.`, 'Your mart portal shows incoming deliveries, delivery codes, sales and remittances.'] });
    return res.json({ user: present.userFull(await db('users').where({ id: u.id }).first()), changed });
  }
  const fields = changed.map((k) => LABELS[k]).join(', ');
  for (const to of [...new Set([u.email, upd.email || u.email])]) await sendEmail({ to, name: u.name.split(' ')[0], category: 'account', subject: 'Your Tafiki account details were updated', ref: u.id, paragraphs: [`The following details on your account were updated by Tafiki: ${fields}.`, 'If you did not request this, contact support@tafiki.com straight away.'] });
  res.json({ user: present.userFull(await db('users').where({ id: u.id }).first()), changed });
});
r.post('/:id/reset-link', requirePerm('members'), async (req, res) => {
  const u = await getDb()('users').where({ id: req.params.id }).first(); if (!u) throw new HttpError(404, 'Member not found.');
  const { value } = await codes.issue('password_reset', 'user', u.id, { minutes: 30, token: true });
  await sendEmail({ to: u.email, name: u.name.split(' ')[0], category: 'security', subject: 'Reset your Tafiki password', ref: u.id, paragraphs: ['A password reset was started for your account by Tafiki support.', `Use this link within 30 minutes: ${config.appUrl}/#reset?token=${value}`, 'If you did not ask for this, contact support@tafiki.com.'] });
  await activity.log(me(req), 'member.reset_link_sent', { type: 'user', id: u.id });
  res.json({ ok: true });
});
r.post('/:id/temporary-password', requirePerm('members'), async (req, res) => {
  const db = getDb(); const u = await db('users').where({ id: req.params.id }).first(); if (!u) throw new HttpError(404, 'Member not found.');
  const temp = tempPassword();
  await db('users').where({ id: u.id }).update({ password_hash: await pw.hash(temp), must_change: true, updated_at: new Date() });
  await revokeAll('user', u.id);
  await activity.log(me(req), 'member.temporary_password_set', { type: 'user', id: u.id });
  await sendEmail({ to: u.email, name: u.name.split(' ')[0], category: 'security', subject: 'Your Tafiki password was reset', ref: u.id, paragraphs: ['An administrator reset your password. Use the temporary password shared with you, then choose a new one when you sign in.'] });
  res.json({ temporaryPassword: temp });
});
r.post('/:id/status', requirePerm('members'), async (req, res) => {
  const status = req.body && req.body.status; const reason = req.body && req.body.reason ? String(req.body.reason).slice(0, 200) : null;
  if (!['active', 'suspended', 'closed'].includes(status)) throw bad('Status must be active, suspended or closed.');
  const db = getDb(); const u = await db('users').where({ id: req.params.id }).first(); if (!u) throw new HttpError(404, 'Member not found.');
  if (status === 'closed') { await require('../lib/accounts').close(u, me(req), reason); return res.json({ ok: true }); }
  if (u.status === status) return res.json({ ok: true });
  await db('users').where({ id: u.id }).update({ status, updated_at: new Date() }); if (status === 'suspended') await revokeAll('user', u.id);
  await activity.log(me(req), 'member.' + status, { type: 'user', id: u.id }, { reason });
  await require('../lib/accounts').statusChanged(u, status, reason);
  res.json({ ok: true });
});
module.exports = r;
