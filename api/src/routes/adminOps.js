// Console: deliveries, stores, audits, remittances, reconciliation.
const express = require('express');
const { z } = require('zod');
const config = require('../config');
const { getDb } = require('../db');
const { HttpError, bad } = require('../lib/util');
const { requireAdmin, requirePerm } = require('../lib/auth');
const ops = require('../lib/ops');
const { getUnitPackage } = require('../lib/terms');
const activity = require('../lib/activity');
const r = express.Router();
r.use(requireAdmin);
const me = (req) => ({ type: 'admin', id: req.admin.id });
const getD = async (id) => { const d = await getDb()('deliveries').where({ id }).first(); if (!d) throw new HttpError(404, 'Delivery not found.'); return d; };
const shape = async (d, full) => { const db = getDb(); const s = await db('users').where({ id: d.store_user_id }).first(); const out = { id: d.id, code: d.code, kind: d.kind, cycle: d.cycle, store: { id: s.id, name: s.shop }, stage: d.status, stageName: ops.STAGES[d.status], driver: d.driver, vehicle: d.vehicle, auto: !!d.auto, value: Number(d.value), codeAttempts: d.code_attempts, overrideReason: d.override_reason, deliveredAt: d.delivered_at, createdAt: d.created_at };
  if (full) Object.assign(out, { lines: await db('delivery_lines').where({ delivery_id: d.id }), log: await db('delivery_log').where({ delivery_id: d.id }).orderBy('id'), driverLink: `${config.appUrl}/#driver?t=${d.driver_token}` }); return out; };

r.get('/deliveries', async (req, res) => {
  let q = getDb()('deliveries').orderBy('created_at', 'desc').limit(Math.min(1000, +(req.query.limit || 300)));
  if (req.query.open === '1') q = q.where('status', '<', 3); if (req.query.storeId) q = q.where({ store_user_id: req.query.storeId }); if (req.query.kind) q = q.where({ kind: req.query.kind });
  res.json({ deliveries: await Promise.all((await q).map((d) => shape(d, req.query.full === '1'))) });
});
r.get('/deliveries/:id', async (req, res) => res.json({ delivery: await shape(await getD(req.params.id), true) }));
r.post('/deliveries', requirePerm('logistics'), async (req, res) => {
  const d = z.object({ storeUserId: z.string(), items: z.array(z.object({ sku: z.string(), qty: z.number().int().min(1) })).min(1) }).parse(req.body);
  const store = await getDb()('users').where({ id: d.storeUserId, role: 'retailer' }).first(); if (!store) throw bad('Choose a FOODCORE Mart.');
  const pk = await getUnitPackage();
  const lines = d.items.map((i) => { const it = pk.items.find((x) => x.sku === i.sku); if (!it) throw bad('Unknown product ' + i.sku); return { sku: it.sku, name: it.name, size: it.size, brand: it.brand, qty: i.qty, unit_cost: it.cost }; });
  const nd = await ops.createDelivery({ kind: 'store_order', storeUserId: store.id, lines }, me(req));
  res.status(201).json({ delivery: await shape(nd, true) });
});
r.post('/deliveries/:id/advance', requirePerm('logistics'), async (req, res) => {
  const from = req.body && Number.isInteger(req.body.fromStage) ? req.body.fromStage : undefined; // stops a double click moving two stages
  const nd = await ops.advance(req.params.id, me(req), 'Moved by admin', from);
  if (!nd) throw new HttpError(409, 'This delivery has already moved on. Refresh to see its stage.');
  res.json({ delivery: await shape(nd, true) });
});
r.patch('/deliveries/:id', requirePerm('logistics'), async (req, res) => {
  const d = z.object({ driver: z.string().trim().max(80).optional(), vehicle: z.string().trim().max(40).optional(), auto: z.boolean().optional() }).parse(req.body); await getD(req.params.id);
  await getDb()('deliveries').where({ id: req.params.id }).update(d); await activity.log(me(req), 'delivery.updated', { type: 'delivery', id: req.params.id }, d);
  res.json({ delivery: await shape(await getD(req.params.id), true) });
});
r.post('/deliveries/:id/delay', requirePerm('logistics'), async (req, res) => {
  const minutes = z.number().int().min(15).max(7 * 24 * 60).parse(req.body && req.body.minutes); const d = await getD(req.params.id);
  await getDb()('deliveries').where({ id: d.id }).update({ delay_minutes: d.delay_minutes + minutes });
  await activity.log(me(req), 'delivery.delayed', { type: 'delivery', id: d.id }, { minutes, reason: req.body.reason || null });
  res.json({ ok: true });
});
r.post('/deliveries/:id/complete', requirePerm('logistics'), async (req, res) => { const nd = await ops.completeWithCode(await getD(req.params.id), req.body && req.body.code, 'admin:' + req.admin.id); res.json({ delivery: await shape(nd, true) }); });
r.post('/deliveries/:id/override', requirePerm('logistics'), async (req, res) => {
  const reason = z.string().trim().min(10, 'Give a clear reason of at least 10 characters.').max(160).parse(req.body && req.body.reason); const d = await getD(req.params.id);
  if (d.status === 3) throw bad('This delivery is already complete.');
  const nd = await ops.markDelivered(d, { override: reason, by: 'admin:' + req.admin.id }, me(req)); res.json({ delivery: await shape(nd, true) });
});
r.post('/deliveries/:id/reissue-code', requirePerm('logistics'), async (req, res) => { await ops.reissueCode(req.params.id, me(req)); res.json({ ok: true }); });

r.get('/stores', async (req, res) => { const ss = await getDb()('users').where({ role: 'retailer' }).orderBy('shop'); res.json({ stores: await Promise.all(ss.map(async (s) => ({ id: s.id, name: s.shop, manager: s.name, area: s.area, kycStatus: s.kyc_status, account: await ops.storeAccount(s.id) }))) }); });
r.get('/stores/:id', async (req, res) => {
  const db = getDb(); const s = await db('users').where({ id: req.params.id, role: 'retailer' }).first(); if (!s) throw new HttpError(404, 'Mart not found.');
  res.json({ store: { id: s.id, name: s.shop, manager: s.name, area: s.area, phone: s.phone, email: s.email }, account: await ops.storeAccount(s.id), cycles: await db('store_cycles').where({ store_user_id: s.id }).orderBy('k', 'desc'), remittances: await db('remittances').where({ store_user_id: s.id }).orderBy('created_at', 'desc'), sales: await db('sales_reports').where({ store_user_id: s.id }).orderBy('id', 'desc').limit(50), packages: await db('packages').where({ store_user_id: s.id }) });
});
r.post('/stores/:id/audit', requirePerm('audit'), async (req, res) => res.json({ cycle: await ops.recordAudit(req.params.id, z.number().int().min(0).parse(req.body && req.body.auditedValue), me(req)) }));
r.post('/stores/:id/reconcile', requirePerm('audit'), async (req, res) => res.json({ cycle: await ops.reconcile(req.params.id, me(req)) }));
r.get('/remittances', async (req, res) => { let q = getDb()('remittances as m').join('users as u', 'u.id', 'm.store_user_id').select('m.*', 'u.shop as store').orderBy('m.created_at', 'desc').limit(1000); if (req.query.status) q = q.where('m.status', req.query.status); res.json({ remittances: await q }); });
r.post('/remittances/:id/confirm', requirePerm('audit'), async (req, res) => res.json({ remittance: await ops.decideRemittance(req.params.id, true, me(req)) }));
r.post('/remittances/:id/reject', requirePerm('audit'), async (req, res) => res.json({ remittance: await ops.decideRemittance(req.params.id, false, me(req), String((req.body && req.body.reason) || '').slice(0, 160)) }));
module.exports = r;
