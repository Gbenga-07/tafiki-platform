// Console: packages, unit holdings, transfer confirmations, investment terms and the unit package.
const express = require('express');
const { z } = require('zod');
const { getDb } = require('../db');
const { uuid, bad, HttpError } = require('../lib/util');
const { requireAdmin, requirePerm } = require('../lib/auth');
const { getTerms, getUnitPackage, packValue, putSetting, getSetting } = require('../lib/terms');
const units = require('../lib/units');
const { shape } = require('./packages');
const activity = require('../lib/activity');
const { sendEmail } = require('../lib/mailer');
const r = express.Router();
r.use(requireAdmin);
const me = (req) => ({ type: 'admin', id: req.admin.id });

r.get('/packages', async (req, res) => { const ps = await getDb()('packages').orderBy('created_at'); res.json({ packages: await Promise.all(ps.map(async (p) => ({ ...(await shape(p)), storeUserId: p.store_user_id }))) }); });
const Pkg = z.object({ name: z.string().trim().regex(/^FOODCORE\s+\S/i, 'Package names start with FOODCORE.').max(120), area: z.string().trim().min(3).max(160), city: z.string().trim().min(2).max(80), state: z.string().trim().max(40).optional(), route: z.string().trim().max(80).optional(), targetOpen: z.string().trim().max(40).optional(), unitsTotal: z.number().int().min(1).max(200).optional() });
r.post('/packages', requirePerm('packages'), async (req, res) => {
  const d = Pkg.parse(req.body); const t = await getTerms(); const id = uuid();
  await getDb()('packages').insert({ id, name: d.name, area: d.area, city: d.city, state: d.state || 'Oyo', route: d.route || null, target_open: d.targetOpen || null, units_total: d.unitsTotal || t.unitsPerPackage });
  await activity.log(me(req), 'package.created', { type: 'package', id }, { name: d.name });
  res.status(201).json({ package: await shape(await getDb()('packages').where({ id }).first()) });
});
r.patch('/packages/:id', requirePerm('packages'), async (req, res) => {
  const d = Pkg.partial().parse(req.body); const db = getDb(); const p = await db('packages').where({ id: req.params.id }).first(); if (!p) throw new HttpError(404, 'Package not found.');
  const upd = {}; for (const [k, c] of [['name', 'name'], ['area', 'area'], ['city', 'city'], ['state', 'state'], ['route', 'route'], ['targetOpen', 'target_open']]) if (d[k] !== undefined) upd[c] = d[k];
  if (d.unitsTotal !== undefined) { const taken = await units.unitsTaken(p.id); if (d.unitsTotal < taken) throw bad(`${taken} units are already taken.`); upd.units_total = d.unitsTotal; }
  if (Object.keys(upd).length) await db('packages').where({ id: p.id }).update(upd);
  await activity.log(me(req), 'package.updated', { type: 'package', id: p.id }, upd);
  res.json({ package: await shape(await db('packages').where({ id: p.id }).first()) });
});
r.post('/packages/:id/open', requirePerm('packages'), async (req, res) => { const p = await units.openPackage(req.params.id, req.body && req.body.storeUserId, me(req)); const ds = await require('../lib/ops').deliveriesForPackage(p.id, me(req)); res.json({ package: await shape(p), deliveries: ds.map((d) => d.code) }); });

r.get('/holdings', async (req, res) => {
  let q = getDb()('holdings as h').join('users as u', 'u.id', 'h.user_id').join('packages as p', 'p.id', 'h.package_id')
    .select('h.*', 'u.name as holder', 'u.email as holder_email', 'u.kyc_status', 'p.name as package_name').orderBy('h.created_at', 'desc').limit(1000);
  if (req.query.status) q = q.where('h.status', req.query.status);
  if (req.query.packageId) q = q.where('h.package_id', req.query.packageId);
  res.json({ holdings: await q });
});
r.get('/payments', async (req, res) => {
  let q = getDb()('payments as y').join('holdings as h', 'h.id', 'y.holding_id').join('users as u', 'u.id', 'y.user_id').select('y.id', 'y.reference', 'y.provider', 'y.amount', 'y.status', 'y.channel', 'y.created_at', 'y.verified_at', 'h.ref', 'h.units', 'u.name as payer').orderBy('y.created_at', 'desc').limit(1000);
  if (req.query.status) q = q.where('y.status', req.query.status);
  res.json({ payments: await q });
});
r.post('/payments/:id/confirm', requirePerm('payments'), async (req, res) => {
  const pay = await getDb()('payments').where({ id: req.params.id }).first(); if (!pay) throw new HttpError(404, 'Payment not found.');
  if (pay.provider !== 'transfer' || !['pending_review', 'initialized'].includes(pay.status)) throw bad('Only bank transfers waiting for review can be confirmed here.');
  const h = await units.markPaymentSuccess(pay, { channel: 'bank_transfer', by: req.admin.id });
  await activity.log(me(req), 'payment.confirmed', { type: 'payment', id: pay.id }, { reference: pay.reference });
  res.json({ holding: { id: h.id, ref: h.ref, status: h.status } });
});
r.post('/payments/:id/reject', requirePerm('payments'), async (req, res) => {
  const db = getDb(); const pay = await db('payments').where({ id: req.params.id }).first(); if (!pay) throw new HttpError(404, 'Payment not found.');
  if (pay.status === 'success') throw bad('A successful payment cannot be rejected here.');
  const reason = String((req.body && req.body.reason) || 'Transfer not found in the escrow account').slice(0, 120);
  await db('payments').where({ id: pay.id }).update({ status: 'rejected', confirmed_by: req.admin.id });
  await db('holdings').where({ id: pay.holding_id }).update({ status: 'cancelled', cancel_reason: reason });
  const h = await db('holdings').where({ id: pay.holding_id }).first(); const u = await db('users').where({ id: h.user_id }).first();
  await sendEmail({ to: u.email, name: u.name.split(' ')[0], category: 'units', ref: h.ref, subject: `We could not confirm the payment for ${h.ref}`, paragraphs: [`We could not confirm your payment (reference ${pay.reference}): ${reason}.`, 'If you have sent the money, reply with your proof of transfer and we will check again.'] });
  await activity.log(me(req), 'payment.rejected', { type: 'payment', id: pay.id }, { reason });
  res.json({ ok: true });
});

r.get('/settings/terms', async (req, res) => res.json({ terms: await getTerms(), escrow: await getSetting('escrow') }));
const Terms = z.object({ unitPrice: z.number().int().min(10000), unitsPerPackage: z.number().int().min(1).max(200), targetPerCycle: z.number().min(0).max(0.5), cycleDays: z.number().int().min(7).max(365), coverFloor: z.number().min(1).max(3), reservePct: z.number().min(0).max(0.5), capPct: z.number().min(0).max(1), minHoldMonths: z.number().int().min(0).max(60), reservationHours: z.number().int().min(1).max(168) }).partial();
r.put('/settings/terms', requirePerm('settings'), async (req, res) => {
  const d = Terms.parse(req.body.terms || {}); const t = await putSetting('terms', { ...(await getTerms()), ...d });
  if (req.body.escrow) await putSetting('escrow', { ...(await getSetting('escrow')), ...z.object({ bank: z.string().max(80), accountNumber: z.string().max(20), accountName: z.string().max(120) }).partial().parse(req.body.escrow) });
  await activity.log(me(req), 'settings.terms_updated', null, d);
  res.json({ terms: t, escrow: await getSetting('escrow') });
});
r.get('/settings/unit-package', async (req, res) => { const p = await getUnitPackage(); res.json({ unitPackage: { ...p, value: packValue(p) } }); });
const Item = z.object({ sku: z.string().trim().min(1).max(40), name: z.string().trim().min(2).max(80), brand: z.string().trim().max(40), size: z.string().trim().max(20), bags: z.number().int().min(1), cost: z.number().int().min(1) });
r.put('/settings/unit-package', requirePerm('packages'), async (req, res) => {
  const items = z.array(Item).min(1).max(20).parse(req.body.items); const t = await getTerms();
  const value = items.reduce((a, i) => a + i.bags * i.cost, 0);
  if (value !== t.unitPrice) throw bad(`The stock adds up to ₦${value.toLocaleString('en-NG')}. It must equal the unit price of ₦${t.unitPrice.toLocaleString('en-NG')}.`);
  await putSetting('unit_package', { items, updatedAt: new Date().toISOString() });
  await activity.log(me(req), 'settings.unit_package_updated', null, { items: items.length, value });
  res.json({ unitPackage: { items, value } });
});
module.exports = r;
