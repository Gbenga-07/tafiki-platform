const express = require('express');
const { z } = require('zod');
const { getDb } = require('../db');
const { bad } = require('../lib/util');
const pw = require('../lib/passwords');
const { requireUser, revokeAll, startSession } = require('../lib/auth');
const config = require('../config');
const activity = require('../lib/activity');
const present = require('../lib/present');
const otp = require('../lib/otp');
const r = express.Router();
r.use(requireUser);
r.get('/', (req, res) => res.json({ user: present.user(req.user) }));
// Notifications: the member's or mart's important account updates (the same ones they are emailed), newest first
r.get('/notifications', async (req, res) => {
  const rows = await getDb()('emails').where({ to_email: req.user.email, notify: true }).orderBy('created_at', 'desc').limit(150).select('id', 'category', 'subject', 'lead', 'created_at', 'receipt_no');
  const seen = req.user.notes_seen_at ? new Date(req.user.notes_seen_at).getTime() : 0;
  const notes = rows.map((e) => ({ id: e.id, category: e.category, title: String(e.subject || '').replace(/ · [A-Z]+-[\w-]+$/, ''), text: e.lead || '', at: e.created_at, receiptNo: e.receipt_no || null, unread: new Date(e.created_at).getTime() > seen }));
  res.json({ notes, unread: notes.filter((n) => n.unread).length });
});
r.post('/notifications/seen', async (req, res) => {
  const db = getDb(); // marks seen up to the newest notification itself, so one arriving a moment later still shows as new
  const last = await db('emails').where({ to_email: req.user.email, notify: true }).orderBy('created_at', 'desc').first('created_at');
  if (last) await db('users').where({ id: req.user.id }).update({ notes_seen_at: last.created_at });
  res.json({ ok: true });
});
const Update = z.object({ phone: z.string().trim().min(7).max(40).optional(), city: z.string().trim().max(80).optional(),
  bank: z.object({ name: z.string().trim().min(2).max(80), account: z.string().regex(/^\d{10}$/), accountName: z.string().trim().min(3).max(120) }).optional() });
// Email codes: { purpose: withdrawal | bank_change }
r.post('/otp', async (req, res) => { const b = req.body || {}; res.json(await otp.send(req.user, b.purpose)); });
r.patch('/', async (req, res) => {
  const d = Update.parse(req.body);
  if (d.bank && req.user.bank_account && (d.bank.account !== req.user.bank_account || d.bank.name !== req.user.bank_name)) await otp.requireCode(req.user, 'bank_change', req.body.code);
  const upd = { updated_at: new Date() };
  if (d.phone && d.phone !== req.user.phone) upd.phone = d.phone; if (d.city !== undefined) upd.city = d.city;
  if (d.bank) Object.assign(upd, { bank_name: d.bank.name, bank_account: d.bank.account, bank_account_name: d.bank.accountName });
  await getDb()('users').where({ id: req.user.id }).update(upd);
  await activity.log({ type: 'user', id: req.user.id }, 'member.updated_profile', { type: 'user', id: req.user.id }, { fields: Object.keys(d) });
  res.json({ user: present.user(await getDb()('users').where({ id: req.user.id }).first()) });
});
r.post('/password', async (req, res) => {
  const { current, next } = req.body || {};
  if (!(await pw.verify(current, req.user.password_hash))) throw bad('Your current password is not correct.');
  if (!pw.strongEnough(next)) throw bad('Use at least 8 characters with letters and a number.');
  await getDb()('users').where({ id: req.user.id }).update({ password_hash: await pw.hash(next), must_change: false, updated_at: new Date() });
  await revokeAll('user', req.user.id);
  await startSession(res, req, 'user', req.user.id, config.memberSessionHours * 60);
  await activity.log({ type: 'user', id: req.user.id }, 'member.changed_password', { type: 'user', id: req.user.id });
  res.json({ ok: true });
});
// Close my account: password required; refused with the reasons while units, wallet money or payments are outstanding.
r.get('/close', async (req, res) => res.json({ canClose: !(await require('../lib/accounts').blockers(req.user)).length, blockers: await require('../lib/accounts').blockers(req.user) }));
r.post('/close', async (req, res) => {
  const b = req.body || {};
  if (!(await pw.verify(b.password, req.user.password_hash))) throw bad('Your password is not correct.');
  await require('../lib/accounts').close(req.user, { type: 'user', id: req.user.id }, b.reason);
  res.json({ ok: true });
});
module.exports = r;
