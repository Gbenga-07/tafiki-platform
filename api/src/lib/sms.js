// SMS through Termii (Messaging API, DND route for transactional messages such as delivery codes).
// Without TERMII_API_KEY messages are recorded with status "logged".
const { getDb } = require('../db');
const { uuid } = require('./util');
let fetchImpl = (...a) => fetch(...a);
const setFetch = (f) => { fetchImpl = f; };
function normalisePhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('0') && d.length === 11) d = '234' + d.slice(1);
  if (d.length === 10 && !d.startsWith('0')) d = '234' + d;
  return /^234\d{10}$/.test(d) ? d : null;
}
async function sendSms({ to, text, category, ref, mask }) {
  const db = getDb(); const phone = normalisePhone(to); const id = uuid();
  const stored = mask ? text.split(mask).join('••••••') : text;
  if (!phone) { await db('sms').insert({ id, to_phone: String(to || '').slice(0, 20), body: stored.slice(0, 320), category, ref: ref || null, status: 'failed', error: 'Invalid Nigerian phone number' }); return { id, status: 'failed' }; }
  await db('sms').insert({ id, to_phone: phone, body: stored.slice(0, 320), category, ref: ref || null, status: 'queued' });
  const key = process.env.TERMII_API_KEY;
  if (!key) { await db('sms').where({ id }).update({ status: 'logged' }); return { id, status: 'logged' }; }
  try {
    const base = (process.env.TERMII_BASE_URL || 'https://api.ng.termii.com').replace(/\/$/, '');
    const res = await fetchImpl(base + '/api/sms/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: key, to: phone, from: process.env.TERMII_SENDER_ID || 'Tafiki', sms: text, type: 'plain', channel: process.env.TERMII_CHANNEL || 'dnd' }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.message_id) throw new Error(body.message || 'Termii request failed');
    await db('sms').where({ id }).update({ status: 'sent', provider_id: String(body.message_id) });
    return { id, status: 'sent' };
  } catch (e) { await db('sms').where({ id }).update({ status: 'failed', error: String(e.message).slice(0, 250) }); return { id, status: 'failed' }; }
}
module.exports = { sendSms, normalisePhone, setFetch };
