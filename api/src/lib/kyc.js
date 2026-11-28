// Identity verification with Smile ID (Hosted Web Integration): the server issues a web token,
// the member completes the check in Smile ID's secure widget, and Smile ID posts the result to our callback.
const smile = require('smile-identity-core');
const config = require('../config');
const { getDb } = require('../db');
const { uuid, now } = require('./util');
const { sendEmail } = require('./mailer');
const K = require('./emailkit');
const activity = require('./activity');
let tokenImpl = null; // tests can replace
const setTokenImpl = (f) => { tokenImpl = f; };
const env = () => ({ partnerId: process.env.SMILE_PARTNER_ID || '', apiKey: process.env.SMILE_API_KEY || '', server: process.env.SMILE_ENV === 'production' ? 1 : 0, callback: process.env.SMILE_CALLBACK_URL || `${config.apiUrl}/webhooks/smileid`, approved: (process.env.SMILE_APPROVED_CODES || '1012,1020,0810').split(',').map((s) => s.trim()) });
// Nigerian ID types offered in Smile ID's screen (SMILE_ID_TYPES, comma separated; "all" = whatever the Smile ID account allows).
// NIN and BVN also show Smile ID's consent screen, which the ID authorities require.
const CONSENT = ['BVN', 'BVN_MFA', 'NIN', 'NIN_V2', 'NIN_SLIP', 'V_NIN'];
const idTypes = () => { const v = (process.env.SMILE_ID_TYPES || 'NIN_V2,BVN,VOTER_ID').trim(); return /^all$/i.test(v) ? [] : v.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean); };
async function start(user, product = 'biometric_kyc', idType) {
  const e = env();
  if (!e.partnerId || !e.apiKey) throw Object.assign(new Error('Identity verification is not configured yet. Add the Smile ID keys to .env.'), { status: 503 });
  const jobId = 'tf-' + uuid();
  const tok = tokenImpl ? await tokenImpl({ user_id: user.id, job_id: jobId, product }) : await new smile.WebApi(e.partnerId, e.callback, e.apiKey, e.server).get_web_token({ user_id: user.id, job_id: jobId, product, callback_url: e.callback });
  await getDb()('kyc_checks').insert({ id: uuid(), user_id: user.id, job_id: jobId, product, id_type: idType || null, status: 'pending' });
  return { token: tok.token, partnerId: e.partnerId, jobId, product, environment: e.server ? 'live' : 'sandbox', callbackUrl: e.callback, idTypes: idTypes(), consentTypes: idTypes().filter((t) => CONSENT.includes(t)) };
}
function validCallback(body) {
  const e = env(); if (!e.apiKey || !body || !body.signature || !body.timestamp) return false;
  try { return new smile.Signature(e.partnerId, e.apiKey).confirm_signature(body.timestamp, body.signature); } catch { return false; }
}
// Approved result codes verify the member automatically; anything else goes to manual review. Never auto-rejects.

// "Your account is verified" email, after an automatic Smile ID check or a manual check by the Tafiki team
async function sendVerified(u, by) {
  const smileId = by === 'Smile ID';
  const retailer = u.role === 'retailer';
  return sendEmail({ to: u.email, name: u.name.split(' ')[0], category: 'account', ref: u.id, subject: 'Your Tafiki account is verified', title: 'Your account is verified',
    lead: smileId ? 'Smile ID has **confirmed your identity**, so your Tafiki account is now fully verified.' : 'Our team has **checked and verified your identity**, so your Tafiki account is now fully verified.',
    blocks: [{ type: 'kv', title: 'Verification', rows: [['Name', retailer ? (u.shop || u.name) : u.name], ['Membership number', u.coop_no || ''], ['Checked by', smileId ? 'Smile ID (automatic)' : 'Tafiki team (manual review)'], ['Result', 'Verified'], ['Verified on', K.when()]].filter((r) => r[1]) }],
    next: retailer ? ['Your mart portal is fully open: deliveries, delivery codes, sales and remittances.', 'Tafiki emails you when a package is assigned to your mart.']
      : ['Any units you have already paid for are now confirmed, and your **Certificate of Stake** follows by email.', 'You can now withdraw from your wallet to your bank account.', 'You can take part in every member offer from your dashboard.'],
    cta: { label: retailer ? 'Open my mart portal' : 'Go to my dashboard', url: K.link('login') } });
}
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
    await sendVerified(u, 'Smile ID');
  } else if (!ok) {
    await activity.log({ type: 'system' }, 'kyc.review', { type: 'user', id: u.id }, { provider: 'Smile ID', code, text: body.ResultText });
    await sendEmail({ to: u.email, name: u.name.split(' ')[0], category: 'account', ref: u.id, subject: 'We are reviewing your identity check', title: 'Your identity check is being reviewed',
      lead: 'Smile ID could not confirm every detail automatically, so our team is **reviewing your check** by hand. This usually takes one working day.',
      blocks: [{ type: 'kv', title: 'Identity check', rows: [['Name', u.name], ['Checked by', 'Smile ID'], ['Result', 'Manual review'], ['Submitted', K.when()]] },
        { type: 'note', tone: 'info', text: 'Common reasons: a name spelt differently on your ID, a blurred photo, or poor lighting in the selfie. You do not need to do anything yet.' }],
      next: ['Our team checks your details against your ID.', 'We email you as soon as it is done, with next steps if anything is needed.'] });
  }
  return db('kyc_checks').where({ id: chk.id }).first();
}
module.exports = { sendVerified, start, validCallback, handleResult, setTokenImpl };
