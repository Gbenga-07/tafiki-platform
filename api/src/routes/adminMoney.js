// Console: payouts per package, withdrawals, redemptions, identity checks, analytics.
const express = require('express');
const { z } = require('zod');
const { getDb } = require('../db');
const { requireAdmin, requirePerm } = require('../lib/auth');
const payouts = require('../lib/payouts');
const r = express.Router();
r.use(requireAdmin);
const me = (req) => ({ type: 'admin', id: req.admin.id });
r.get('/payouts', async (req, res) => { let q = getDb()('payout_runs as r').join('packages as p', 'p.id', 'r.package_id').select('r.*', 'p.name as package_name').orderBy('r.created_at', 'desc'); if (req.query.packageId) q = q.where('r.package_id', req.query.packageId); res.json({ runs: await q }); });
r.get('/payouts/:packageId/preview', async (req, res) => { const c = await payouts.calculate(req.params.packageId, Number(req.query.profit || 0)); const t = await require('../lib/terms').getTerms(); res.json({ preview: c, suggestedProfit: Math.round(c.units * t.unitPrice * 0.2 * 3) }); });
r.post('/payouts/:packageId', requirePerm('payouts'), async (req, res) => { const d = z.object({ profit: z.number().int().min(0), note: z.string().max(200).optional() }).parse(req.body); res.status(201).json({ run: await payouts.run(req.params.packageId, d.profit, me(req), d.note) }); });
r.get('/withdrawals', async (req, res) => { let q = getDb()('withdrawals as w').join('users as u', 'u.id', 'w.user_id').select('w.*', 'u.name as member').orderBy('w.created_at', 'desc').limit(1000); if (req.query.status) q = q.where('w.status', req.query.status); res.json({ withdrawals: await q }); });
r.post('/withdrawals/:id/pay', requirePerm('payouts'), async (req, res) => res.json({ withdrawal: await payouts.decideWithdrawal(req.params.id, true, me(req), { transferReference: String((req.body && req.body.transferReference) || '').trim() }) }));
r.post('/withdrawals/:id/reject', requirePerm('payouts'), async (req, res) => res.json({ withdrawal: await payouts.decideWithdrawal(req.params.id, false, me(req), { reason: String((req.body && req.body.reason) || '').slice(0, 160) }) }));
r.get('/redemptions', async (req, res) => res.json({ redemptions: await getDb()('redemptions as d').join('holdings as h', 'h.id', 'd.holding_id').join('users as u', 'u.id', 'd.user_id').select('d.*', 'h.ref', 'h.units', 'u.name as member').orderBy('d.created_at', 'desc') }));
r.post('/redemptions/:id/settle', requirePerm('payouts'), async (req, res) => res.json({ redemption: await payouts.settleRedemption(req.params.id, me(req)) }));
r.get('/wallet-tx', async (req, res) => { let q = getDb()('wallet_tx').orderBy('created_at', 'desc').limit(Math.min(5000, +(req.query.limit || 2000))); if (req.query.userId) q = q.where({ user_id: req.query.userId }); res.json({ transactions: await q }); });
r.get('/kyc', async (req, res) => { let q = getDb()('kyc_checks as k').join('users as u', 'u.id', 'k.user_id').select('k.id', 'k.user_id', 'u.name', 'u.role', 'k.product', 'k.id_type', 'k.status', 'k.result_code', 'k.result_text', 'k.confidence', 'k.actions', 'k.created_at', 'k.completed_at').orderBy('k.created_at', 'desc').limit(500); if (req.query.status) q = q.where('k.status', req.query.status); res.json({ checks: await q }); });
r.get('/analytics', async (req, res) => {
  const db = getDb(); const months = []; const d = new Date(); d.setUTCDate(1);
  for (let i = 9; i >= 0; i--) { const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)); months.push(m.toISOString().slice(0, 7)); }
  const key = (x) => (x ? new Date(x).toISOString().slice(0, 7) : null);
  const conf = await db('holdings').whereIn('status', ['reserved', 'active', 'redeem']).select('amount', 'units', 'paid_at', 'user_id');
  const delivered = await db('deliveries').where({ status: 3 }).select('value', 'delivered_at', 'kind');
  const rem = await db('remittances').where({ status: 'confirmed' }).select('amount', 'confirmed_at');
  const pay = await db('payout_runs').select('investors_total', 'created_at');
  const series = (rows, dateKey, valKey) => months.map((m) => rows.filter((r) => key(r[dateKey]) === m).reduce((a, r) => a + Number(r[valKey]), 0));
  let run = conf.filter((h) => key(h.paid_at) && key(h.paid_at) < months[0]).reduce((a, h) => a + Number(h.amount), 0);
  const newCap = series(conf, 'paid_at', 'amount'); const capital = newCap.map((v) => (run += v));
  const statusRows = await db('holdings').whereNot({ status: 'cancelled' }).select('status').sum({ units: 'units' }).groupBy('status');
  res.json({ months, capitalRaised: capital, newCapital: newCap, stockDelivered: series(delivered, 'delivered_at', 'value'), remittanceConfirmed: series(rem, 'confirmed_at', 'amount'), payoutsToHolders: series(pay, 'created_at', 'investors_total'),
    totals: { capital: conf.reduce((a, h) => a + Number(h.amount), 0), units: conf.reduce((a, h) => a + h.units, 0), unitHolders: new Set(conf.map((h) => h.user_id)).size, stockDelivered: delivered.reduce((a, x) => a + Number(x.value), 0), payouts: pay.reduce((a, x) => a + Number(x.investors_total), 0) },
    unitsByStatus: Object.fromEntries(statusRows.map((s) => [s.status, Number(s.units)])) });
});
module.exports = r;
