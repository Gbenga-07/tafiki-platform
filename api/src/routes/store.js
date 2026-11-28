// FOODCORE store portal: account, deliveries and delivery codes, sales reports, remittances, cycles.
const express = require('express');
const { z } = require('zod');
const { getDb } = require('../db');
const { HttpError } = require('../lib/util');
const { requireUser } = require('../lib/auth');
const ops = require('../lib/ops');
const box = require('../lib/secretbox');
const r = express.Router();
r.use(requireUser, (req, res, next) => (req.user.role === 'retailer' ? next() : next(new HttpError(403, 'This is for FOODCORE Mart accounts.'))));
const shapeD = async (d, withCode) => ({ id: d.members ? d.code : d.id, code: d.code, stakes: d.members ? d.members.length : undefined, confirmedBy: d.confirmed_by || null, issue: d.issue_at ? { at: d.issue_at, by: d.issue_by, note: d.issue_note, lines: JSON.parse(d.issue_lines || '[]') } : null, kind: d.kind, cycle: d.cycle, stage: d.status, stageName: ops.STAGES[d.status], driver: d.driver, vehicle: d.vehicle, value: Number(d.value), deliveredAt: d.delivered_at, createdAt: d.created_at,
  lines: d.members ? (await ops.bundleLines(d.members)).map(({ sku, name, size, brand, qty }) => ({ sku, name, size, brand, qty })) : await getDb()('delivery_lines').where({ delivery_id: d.id }).select('sku', 'name', 'size', 'brand', 'qty'), log: await getDb()('delivery_log').where({ delivery_id: d.id }).select('stage', 'at'),
  });
r.get('/account', async (req, res) => res.json({ account: await ops.storeAccount(req.user.id), packages: await getDb()('packages').where({ store_user_id: req.user.id }).select('id', 'name', 'area', 'city', 'state', 'route', 'stage', 'units_total', 'opened_at', 'target_open'), units: Number((await getDb()('holdings').whereIn('package_id', getDb()('packages').where({ store_user_id: req.user.id }).select('id')).whereIn('status', ['active', 'redeem']).sum({ s: 'units' }).first()).s) || 0 }));
// a bundle (the stock for every stake, sent together) shows as one delivery with one code
const bundled = async (d) => (d.bundle_code ? ops.bundleView(d.bundle_code) : d);
r.get('/deliveries', async (req, res) => { const ds = await getDb()('deliveries').where({ store_user_id: req.user.id }).orderBy('created_at', 'desc').limit(300); const rows = []; const seen = new Set();
  for (const d of ds) { if (d.bundle_code) { if (seen.has(d.bundle_code)) continue; seen.add(d.bundle_code); } rows.push(await bundled(d)); }
  res.json({ deliveries: await Promise.all(rows.map((d) => shapeD(d, false))) }); });
r.get('/deliveries/:id', async (req, res) => { const raw = /^BD-\d+$/.test(req.params.id) ? await getDb()('deliveries').where({ bundle_code: req.params.id, store_user_id: req.user.id }).first() : await getDb()('deliveries').where({ id: req.params.id, store_user_id: req.user.id }).first(); if (!raw) throw new HttpError(404, 'Not found.'); res.json({ delivery: await shapeD(await bundled(raw), true) }); });
const findMine = async (req) => { const id = req.params.id; const raw = /^BD-\d+$/.test(id) ? await getDb()('deliveries').where({ bundle_code: id, store_user_id: req.user.id }).first() : await getDb()('deliveries').where({ id, store_user_id: req.user.id }).first(); if (!raw) throw new HttpError(404, 'Not found.'); return bundled(raw); };
// the mart counted the bags: "All received" completes the delivery; "Report a problem" holds it for Tafiki to resolve
r.post('/deliveries/:id/receive', async (req, res) => {
  const b = z.object({ ok: z.literal(true).optional(), issue: z.object({ note: z.string().max(480).optional(), lines: z.array(z.object({ sku: z.string(), received: z.number().int().min(0) })).optional() }).optional() }).parse(req.body || {});
  const d = await findMine(req);
  if (b.issue) await ops.martReportIssue(d, req.user, b.issue); else if (b.ok) await ops.martReceive(d, req.user); else throw new HttpError(400, 'Choose All received or Report a problem.');
  res.json({ delivery: await shapeD(await findMine(req), true) });
});
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
