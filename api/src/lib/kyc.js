// Identity verification with Smile ID (Hosted Web Integration): the server issues a web token,
// the member completes the check in Smile ID's secure widget, and Smile ID posts the result to our callback.
const smile = require('smile-identity-core');
const config = require('../config');
const { getDb } = require('../db');
const { uuid, now } = require('./util');
const { sendEmail } = require('./mailer');
const activity = require('./activity');
let tokenImpl = null; // tests can replace
const setTokenImpl = (f) => { tokenImpl = f; };
const env = () => ({ partnerId: process.env.SMILE_PARTNER_ID || '', apiKey: process.env.SMILE_API_KEY || '', server: process.env.SMILE_ENV === 'production' ? 1 : 0, callback: process.env.SMILE_CALLBACK_URL || `${config.apiUrl}/webhooks/smileid`, approved: (process.env.SMILE_APPROVED_CODES || '1012,1020,0810').split(',').map((s) => s.trim()) });
async function start(user, product = 'biometric_kyc', idType) {
  const e = env();
  if (!e.partnerId || !e.apiKey) throw Object.assign(new Error('Identity verification is not configured yet. Add the Smile ID keys to .env.'), { status: 503 });
  const jobId = 'tf-' + uuid();
  const tok = tokenImpl ? await tokenImpl({ user_id: user.id, job_id: jobId, product }) : await new smile.WebApi(e.partnerId, e.callback, e.apiKey, e.server).get_web_token({ user_id: user.id, job_id: jobId, product, callback_url: e.callback });
  await getDb()('kyc_checks').insert({ id: uuid(), user_id: user.id, job_id: jobId, product, id_type: idType || null, status: 'pending' });
  return { token: tok.token, partnerId: e.partnerId, jobId, product, environment: e.server ? 'live' : 'sandbox', callbackUrl: e.callback };
}
function validCallback(body) {
  const e = env(); if (!e.apiKey || !body || !body.signature || !body.timestamp) return false;
  try { return new smile.Signature(e.partnerId, e.apiKey).confirm_signature(body.timestamp, body.signature); } catch { return false; }
}
// Approved result codes verify the member automatically; anything else goes to manual review. Never auto-rejects.
async function handleResult(body) {
  const db = getDb(); const e = env();
  const jobId = body.PartnerParams && body.PartnerParams.job_id; if (!jobId) return null;
  const chk = await db('kyc_checks').where({ job_id: jobId }).first(); if (!chk || chk.status === 'verified') return chk;
  const code = String(body.ResultCode || ''); const ok = e.approved.includes(code);
  await db('kyc_checks').where({ id: chk.id }).update({ status: ok ? 'verified' : 'review', smile_job_id: body.SmileJobID || null, result_code: code, result_text: String(body.ResultText || '').slice(0, 160), confidence: Number.isFinite(+body.ConfidenceValue) ? Math.round(+body.ConfidenceValue) : null, actions: JSON.stringify(body.Actions || {}), raw: JSON.stringify(body).slice(0, 60000), completed_at: now(), id_type: (body.IDType || chk.id_type || null) });
  const u = await db('users').where({ id: chk.user_id }).first();
  if (ok && u.kyc_status !== 'verified') {
    await db('users').where({ id: u.id }).update({ kyc_status: 'verified', updated_at: new Date() });
    await activity.log({ type: 'system' }, 'kyc.verified', { type: 'user', id: u.id }, { provider: 'Smile ID', code });
    await require('./units').onKycVerified(u.id, { type: 'system' });
    await sendEmail({ to: u.email, name: u.name.split(' ')[0], category: 'account', ref: u.id, subject: 'Your identity is verified', paragraphs: ['Smile ID has confirmed your identity. You can now take part in every member offer, and any units you have paid for are now confirmed.'] });
  } else if (!ok) {
    await activity.log({ type: 'system' }, 'kyc.review', { type: 'user', id: u.id }, { provider: 'Smile ID', code, text: body.ResultText });
    await sendEmail({ to: u.email, name: u.name.split(' ')[0], category: 'account', ref: u.id, subject: 'We are reviewing your identity check', paragraphs: ['Smile ID could not confirm every detail automatically, so our team is reviewing your check. This usually takes one working day. We will email you when it is done.'] });
  }
  return db('kyc_checks').where({ id: chk.id }).first();
}
module.exports = { start, validCallback, handleResult, setTokenImpl };
