// Paystack: initialize a checkout, verify a reference, check webhook signatures.
const crypto = require('crypto');
let fetchImpl = (...a) => fetch(...a);
const setFetch = (f) => { fetchImpl = f; };
const secret = () => process.env.PAYSTACK_SECRET_KEY || '';
async function call(path, opts = {}) {
  if (!secret()) throw Object.assign(new Error('Paystack is not configured. Add PAYSTACK_SECRET_KEY to .env.'), { status: 503 });
  const res = await fetchImpl('https://api.paystack.co' + path, { ...opts, headers: { Authorization: 'Bearer ' + secret(), 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status === false) throw Object.assign(new Error(body.message || 'Paystack request failed.'), { status: 502 });
  return body.data;
}
const initialize = ({ email, amountNaira, reference, callbackUrl, channels, metadata }) =>
  call('/transaction/initialize', { method: 'POST', body: JSON.stringify({ email, amount: Math.round(amountNaira * 100), reference, callback_url: callbackUrl, channels, metadata }) });
const verify = (reference) => call('/transaction/verify/' + encodeURIComponent(reference));
function validSignature(rawBody, signature) {
  if (!secret() || !signature) return false;
  const h = crypto.createHmac('sha512', secret()).update(rawBody).digest('hex');
  return h.length === String(signature).length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(String(signature)));
}
module.exports = { initialize, verify, validSignature, setFetch };
