// Flutterwave Standard checkout: start a payment (hosted page), verify it by our reference, and check webhooks.
// Settings in .env: FLW_SECRET_KEY (FLWSECK_TEST-... in test mode, FLWSECK-... live) and FLW_SECRET_HASH
// (the "secret hash" set on the Flutterwave dashboard webhook page; Flutterwave sends it in the verif-hash header).
const crypto = require('crypto');
let fetchImpl = (...a) => fetch(...a);
const setFetch = (f) => { fetchImpl = f; };
const secret = () => process.env.FLW_SECRET_KEY || '';
const configured = () => !!secret();
async function call(path, opts = {}) {
  if (!secret()) throw Object.assign(new Error('Online payment is not switched on yet. Please pay by bank transfer, or try again later.'), { status: 503, expose: true });
  const res = await fetchImpl('https://api.flutterwave.com/v3' + path, { ...opts, headers: { Authorization: 'Bearer ' + secret(), 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status !== 'success') throw Object.assign(new Error('Flutterwave could not start the payment' + (body.message ? ': ' + body.message : '') + '. Please try again.'), { status: 502, expose: true, provider: body });
  return body.data;
}
// Returns { link } for the hosted checkout page.
const initialize = ({ reference, amountNaira, redirectUrl, customer, meta, logo }) => call('/payments', { method: 'POST', body: JSON.stringify({
  tx_ref: reference, amount: Math.round(amountNaira * 100) / 100, currency: 'NGN', redirect_url: redirectUrl,
  payment_options: 'card,banktransfer,ussd,account', customer, meta,
  customizations: { title: 'Tafiki · FOODCORE units', description: meta && meta.holding ? `Units for stake ${meta.holding}` : 'FOODCORE units', logo },
}) });
// Our reference -> { status: 'successful' | 'failed' | 'pending', amount (naira), currency, payment_type, id }
async function verify(reference) {
  try { return await call('/transactions/verify_by_reference?tx_ref=' + encodeURIComponent(reference)); }
  catch (e) { if (e.provider && /No transaction was found/i.test(e.provider.message || '')) return { status: 'pending' }; throw e; }
}
function validWebhook(hash) {
  const want = process.env.FLW_SECRET_HASH || '';
  if (!want || !hash) return false;
  const a = Buffer.from(String(hash)), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
module.exports = { initialize, verify, validWebhook, setFetch, configured };
