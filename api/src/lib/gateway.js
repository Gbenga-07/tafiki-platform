// One place that checks an online payment with whichever gateway took it (Flutterwave or Paystack), so the
// return page, the webhooks and the 24-hour release all decide the same way.
const paystack = require('./paystack');
const flutterwave = require('./flutterwave');
// -> { ok: true, channel, raw } when the gateway confirms the full amount in naira; { failed: true } when it says it failed.
async function check(pay) {
  if (pay.provider === 'flutterwave') {
    const v = await flutterwave.verify(pay.reference);
    if (v.status === 'successful' && v.currency === 'NGN' && Math.round(Number(v.amount) * 100) >= Math.round(Number(pay.amount) * 100)) return { ok: true, channel: v.payment_type || 'flutterwave', raw: v };
    if (v.status === 'failed') return { failed: true, raw: v };
    return { pending: true, raw: v };
  }
  if (pay.provider === 'paystack') {
    const v = await paystack.verify(pay.reference);
    if (v.status === 'success' && Math.round(v.amount) === Math.round(Number(pay.amount) * 100) && v.currency === 'NGN') return { ok: true, channel: v.channel, raw: v };
    if (['failed', 'abandoned'].includes(v.status)) return { failed: true, raw: v };
    return { pending: true, raw: v };
  }
  return { pending: true };
}
module.exports = { check, online: ['flutterwave', 'paystack'] };
