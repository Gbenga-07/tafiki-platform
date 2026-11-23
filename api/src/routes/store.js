// FOODCORE store portal: account, deliveries and delivery codes, sales reports, remittances, cycles.
const express = require('express');
const { z } = require('zod');
const { getDb } = require('../db');
const { HttpError } = require('../lib/util');
const { requireUser } = require('../lib/auth');
const ops = require('../lib/ops');
const box = require('../lib/secretbox');
const r = express.Router();
r.use(requireUser, (req, res, next) => (req.user.role === 'retailer' ? next() : next(new HttpError(403, 'This is for FOODCORE store accounts.'))));
const shapeD = async (d, withCode) => ({ id: d.id, code: d.code, kind: d.kind, cycle: d.cycle, stage: d.status, stageName: ops.STAGES[d.status], driver: d.driver, vehicle: d.vehicle, value: Number(d.value), deliveredAt: d.delivered_at, createdAt: d.created_at,
  lines: await getDb()('delivery_lines').where({ delivery_id: d.id }).select('sku', 'name', 'size', 'brand', 'qty'), log: await getDb()('delivery_log').where({ delivery_id: d.id }).select('stage', 'at'),
  deliveryCode: withCode && d.status < 3 ? box.open(d.code_enc) : undefined });
r.get('/account', async (req, res) => res.json({ account: await ops.storeAccount(req.user.id) }));
r.get('/deliveries', async (req, res) => { const ds = await getDb()('deliveries').where({ store_user_id: req.user.id }).orderBy('created_at', 'desc').limit(300); res.json({ deliveries: await Promise.all(ds.map((d) => shapeD(d, false))) }); });
r.get('/deliveries/:id', async (req, res) => { const d = await getDb()('deliveries').where({ id: req.params.id, store_user_id: req.user.id }).first(); if (!d) throw new HttpError(404, 'Not found.'); res.json({ delivery: await shapeD(d, true) }); });
r.post('/sales', async (req, res) => {
  const d = z.object({ amount: z.number().int().min(0), note: z.string().max(200).optional() }).parse(req.body);
  const c = await getDb()('store_cycles').where({ store_user_id: req.user.id }).orderBy('k', 'desc').first(); if (!c) throw new HttpError(400, 'Your first cycle starts when your first stock is delivered.');
  await getDb()('sales_reports').insert({ store_user_id: req.user.id, cycle_k: c.k, amount: d.amount, note: d.note || null, created_at: new Date() });
  res.status(201).json({ ok: true });
});
r.get('/sales', async (req, res) => res.json({ sales: await getDb()('sales_reports').where({ store_user_id: req.user.id }).orderBy('id', 'desc') }));
r.post('/remittances', async (req, res) => { const d = z.object({ amount: z.number().int().min(1), bankReference: z.string().trim().max(80).optional() }).parse(req.body); res.status(201).json({ remittance: await ops.reportRemittance(req.user, d.amount, d.bankReference) }); });
r.get('/remittances', async (req, res) => res.json({ remittances: await getDb()('remittances').where({ store_user_id: req.user.id }).orderBy('created_at', 'desc') }));
r.get('/cycles', async (req, res) => res.json({ cycles: await getDb()('store_cycles').where({ store_user_id: req.user.id }).orderBy('k', 'desc') }));
module.exports = r;
