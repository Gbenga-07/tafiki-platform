// Settings › Admin Access: administrators, login security, sign-in history. Super Admin (settings) to change.
const express = require('express');
const { z } = require('zod');
const { getDb } = require('../db');
const { uuid, lower, bad, HttpError, tempPassword } = require('../lib/util');
const pw = require('../lib/passwords');
const { requireAdmin, requirePerm, revokeAll } = require('../lib/auth');
const { getSetting, putSetting } = require('../lib/settings');
const { ROLES, GROUPS } = require('../lib/permissions');
const { sendEmail } = require('../lib/mailer');
const activity = require('../lib/activity');
const present = require('../lib/present');
const config = require('../config');
const r = express.Router();
r.use(requireAdmin);
const me = (req) => ({ type: 'admin', id: req.admin.id });

r.get('/roles', (req, res) => res.json({ groups: GROUPS, roles: ROLES }));
r.get('/', async (req, res) => res.json({ admins: (await getDb()('admins').orderBy('created_at')).map(present.admin) }));

const Body = z.object({ name: z.string().trim().min(3).max(120), email: z.string().trim().email(), role: z.enum(Object.keys(ROLES)) });
r.post('/', requirePerm('settings'), async (req, res) => {
  const d = Body.parse(req.body); const db = getDb(); const email = lower(d.email);
  if (await db('admins').where({ email }).first()) throw new HttpError(409, 'That email is already an administrator.');
  const temp = tempPassword(); const id = uuid();
  await db('admins').insert({ id, name: d.name, email, role: d.role, password_hash: await pw.hash(temp), must_change: true });
  await activity.log(me(req), 'admin.created', { type: 'admin', id }, { role: d.role });
  await sendEmail({ to: email, name: d.name.split(' ')[0], category: 'security', subject: 'You have been added to the Tafiki Console', paragraphs: [`You now have ${d.role} access to the Tafiki Console.`, `Sign in at ${config.appUrl}${config.consolePath} with the temporary password shared with you privately, then choose your own password.`] });
  res.status(201).json({ admin: present.admin(await db('admins').where({ id }).first()), temporaryPassword: temp });
});
r.patch('/:id', requirePerm('settings'), async (req, res) => {
  const d = Body.parse(req.body); const db = getDb(); const a = await db('admins').where({ id: req.params.id }).first();
  if (!a) throw new HttpError(404, 'Administrator not found.');
  const email = lower(d.email);
  if (await db('admins').where({ email }).whereNot({ id: a.id }).first()) throw new HttpError(409, 'That email is already an administrator.');
  if (a.id === req.admin.id && d.role !== 'Super Admin') throw bad('You cannot remove your own Super Admin role.');
  await db('admins').where({ id: a.id }).update({ name: d.name, email, role: d.role });
  await activity.log(me(req), 'admin.updated', { type: 'admin', id: a.id }, { role: d.role });
  res.json({ admin: present.admin(await db('admins').where({ id: a.id }).first()) });
});
r.post('/:id/reset-password', requirePerm('settings'), async (req, res) => {
  const db = getDb(); const a = await db('admins').where({ id: req.params.id }).first();
  if (!a) throw new HttpError(404, 'Administrator not found.');
  const temp = tempPassword();
  await db('admins').where({ id: a.id }).update({ password_hash: await pw.hash(temp), must_change: true });
  await revokeAll('admin', a.id);
  await activity.log(me(req), 'admin.password_reset', { type: 'admin', id: a.id });
  res.json({ temporaryPassword: temp });
});
r.post('/:id/status', requirePerm('settings'), async (req, res) => {
  const status = req.body && req.body.status; if (!['active', 'disabled'].includes(status)) throw bad('Status must be active or disabled.');
  if (req.params.id === req.admin.id) throw bad('You cannot disable your own account.');
  const db = getDb(); const a = await db('admins').where({ id: req.params.id }).first(); if (!a) throw new HttpError(404, 'Administrator not found.');
  await db('admins').where({ id: a.id }).update({ status }); if (status === 'disabled') await revokeAll('admin', a.id);
  await activity.log(me(req), 'admin.' + status, { type: 'admin', id: a.id });
  res.json({ ok: true });
});

r.get('/security', async (req, res) => res.json({ security: await getSetting('security') }));
const Sec = z.object({ twofa: z.boolean(), timeoutMinutes: z.number().int().min(15).max(240), maxFailures: z.number().int().min(3).max(10), lockMinutes: z.number().int().min(5).max(120).optional() });
r.put('/security', requirePerm('settings'), async (req, res) => {
  const d = Sec.parse(req.body); const cur = await getSetting('security');
  const v = await putSetting('security', { ...cur, ...d });
  await activity.log(me(req), 'settings.security_updated', null, v);
  res.json({ security: v });
});
r.get('/login-events', async (req, res) => res.json({ events: await getDb()('login_events').where({ actor_type: 'admin' }).orderBy('id', 'desc').limit(100) }));
module.exports = r;
