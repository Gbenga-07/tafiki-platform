// Paystack calls this when a payment succeeds. The signature proves it came from Paystack.
const express = require('express');
const { getDb } = require('../db');
const paystack = require('../lib/paystack');
const units = require('../lib/units');
const r = express.Router();
r.post('/paystack', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  if (!paystack.validSignature(raw, req.get('x-paystack-signature'))) return res.status(401).end();
  let ev; try { ev = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).end(); }
  res.status(200).end(); // acknowledge fast, then process
  try {
    if (ev.event !== 'charge.success' || !ev.data) return;
    const pay = await getDb()('payments').where({ reference: ev.data.reference }).first();
    if (!pay || pay.status === 'success') return;
    const v = await paystack.verify(pay.reference); // double-check with Paystack before releasing units
    if (v.status === 'success' && Math.round(v.amount) === Math.round(Number(pay.amount) * 100) && v.currency === 'NGN') await units.markPaymentSuccess(pay, { channel: v.channel, raw: v });
  } catch (e) { console.error('paystack webhook', e.message); }
});
module.exports = r;
