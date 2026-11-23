const express = require('express');
const { z } = require('zod');
const { getDb } = require('../db');
const { bad } = require('../lib/util');
const pw = require('../lib/passwords');
const { requireUser, revokeAll, startSession } = require('../lib/auth');
const config = require('../config');
const activity = require('../lib/activity');
const present = require('../lib/present');
const r = express.Router();
r.use(requireUser);
r.get('/', (req, res) => res.json({ user: present.user(req.user) }));
const Update = z.object({ phone: z.string().trim().min(7).max(40).optional(), city: z.string().trim().max(80).optional(),
  bank: z.object({ name: z.string().trim().min(2).max(80), account: z.string().regex(/^\d{10}$/), accountName: z.string().trim().min(3).max(120) }).optional() });
r.patch('/', async (req, res) => {
  const d = Update.parse(req.body);
  const upd = { updated_at: new Date() };
  if (d.phone) upd.phone = d.phone; if (d.city !== undefined) upd.city = d.city;
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
module.exports = r;
