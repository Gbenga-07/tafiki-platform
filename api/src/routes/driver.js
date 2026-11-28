// Driver delivery link: opened from the driver's phone, no account needed. Completes only with the store's code.
const express = require('express');
const { getDb } = require('../db');
const { HttpError } = require('../lib/util');
const ops = require('../lib/ops');
const r = express.Router();
async function find(token) { const d = await getDb()('deliveries').where({ driver_token: String(token || '') }).first(); if (!d) throw new HttpError(404, 'This delivery link is not valid.'); return d; }
r.get('/:token', async (req, res) => {
  const raw = await find(req.params.token); const d = raw.bundle_code ? await ops.bundleView(raw.bundle_code) : raw;
  if (d.status === 3) return res.json({ delivery: { code: d.code, stage: 3, stageName: 'Delivered', deliveredAt: d.delivered_at } });
  const s = await getDb()('users').where({ id: d.store_user_id }).first();
  res.json({ delivery: { code: d.code, stage: d.status, stageName: ops.STAGES[d.status], store: s.shop, address: s.area, phone: s.phone, lines: d.members ? (await ops.bundleLines(d.members)).map(({ name, size, qty }) => ({ name, size, qty })) : await getDb()('delivery_lines').where({ delivery_id: d.id }).select('name', 'size', 'qty'), bags: (d.members ? await ops.bundleLines(d.members) : await getDb()('delivery_lines').where({ delivery_id: d.id })).reduce((a, l) => a + Number(l.qty), 0) } });
});
r.post('/:token/complete', async (req, res) => { const d = await find(req.params.token); const nd = await ops.completeWithCode(d, req.body && req.body.code, 'driver:' + (d.driver || 'link')); res.json({ ok: true, stage: nd.status }); });
module.exports = r;
