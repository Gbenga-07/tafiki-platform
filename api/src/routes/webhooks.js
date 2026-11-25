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
// Flutterwave calls this when a payment completes. The verif-hash header must match FLW_SECRET_HASH, and the payment
// is always re-checked with Flutterwave before units are released.
r.post('/flutterwave', express.json({ limit: '1mb' }), async (req, res) => {
  const flutterwave = require('../lib/flutterwave'); const gateway = require('../lib/gateway');
  if (!flutterwave.validWebhook(req.get('verif-hash'))) return res.status(401).end();
  res.status(200).end();
  try {
    const d = (req.body && req.body.data) || {}; if (!d.tx_ref) return;
    const pay = await getDb()('payments').where({ reference: d.tx_ref, provider: 'flutterwave' }).first();
    if (!pay || pay.status === 'success') return;
    const v = await gateway.check(pay);
    if (v.ok) await units.markPaymentSuccess(pay, { channel: v.channel, raw: v.raw });
    else if (v.failed) await getDb()('payments').where({ id: pay.id, status: 'initialized' }).update({ status: 'failed' });
  } catch (e) { console.error('flutterwave webhook', e.message); }
});
// Smile ID posts identity results here. The signature and timestamp prove they came from Smile ID.
r.post('/smileid', express.json({ limit: '2mb' }), async (req, res) => {
  const kyc = require('../lib/kyc');
  if (!kyc.validCallback(req.body)) return res.status(401).end();
  res.status(200).json({ ok: true });
  try { await kyc.handleResult(req.body); } catch (e) { console.error('smileid webhook', e.message); }
});
module.exports = r;
