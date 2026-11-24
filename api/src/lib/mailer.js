// Every email is written to the outbox table first, then sent through SMTP if configured.
// Without SMTP settings emails are recorded with status "logged" (same as the prototype).
const nodemailer = require('nodemailer');
const config = require('../config');
const { getDb } = require('../db');
const { uuid } = require('./util');
let transport = null;
function getTransport() {
  if (!config.mail.host) return null;
  if (!transport) transport = nodemailer.createTransport({ host: config.mail.host, port: config.mail.port, secure: config.mail.port === 465, auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined });
  return transport;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function layout(name, paragraphs) {
  const p = paragraphs.map((x) => `<p style="margin:0 0 12px">${esc(x)}</p>`).join('');
  return `<div style="font-family:Arial,sans-serif;background:#F4F7F0;padding:24px"><div style="max-width:560px;margin:auto;background:#fff;border:1px solid #E3EBD9;border-radius:14px;overflow:hidden"><div style="background:#1D4107;color:#fff;padding:16px 20px;font-weight:700;font-size:20px">tafiki</div><div style="padding:20px;color:#24361A;font-size:14px;line-height:1.55"><p style="margin:0 0 12px">Hello ${esc(name || 'there')},</p>${p}<p style="margin:16px 0 0">Kind regards,<br><b>Tafiki Operations</b></p></div><div style="background:#F6FAF1;padding:10px 20px;font-size:11px;color:#7A8770">FOODCORE is a product of FOODCORE Multipurpose Cooperative, licensed by the Lagos State Ministry of Commerce, Cooperatives, Trade and Investment.</div></div></div>`;
}
async function sendEmail({ to, name, category, subject, paragraphs, ref }) {
  const db = getDb();
  const id = uuid();
  const text = [`Hello ${name || 'there'},`, ...paragraphs, 'Kind regards,', 'Tafiki Operations'].join('\n\n');
  const html = layout(name, paragraphs);
  await db('emails').insert({ id, to_email: to, to_name: name || null, category, subject, body_text: text, body_html: html, ref: ref || null, status: 'queued', created_at: new Date() });
  if (require('./marts').isPlaceholderEmail(to)) { await db('emails').where({ id }).update({ status: 'skipped', error: 'Mart manager email not set yet' }); return { id, status: 'skipped' }; }
  const t = getTransport();
  if (!t) { await db('emails').where({ id }).update({ status: 'logged' }); return { id, status: 'logged' }; }
  try {
    const info = await t.sendMail({ from: config.mail.from, replyTo: config.mail.replyTo, to: name ? `"${name}" <${to}>` : to, subject, text, html });
    await db('emails').where({ id }).update({ status: 'sent', provider_id: String(info.messageId || ''), sent_at: new Date() });
    return { id, status: 'sent' };
  } catch (e) {
    await db('emails').where({ id }).update({ status: 'failed', error: String(e.message).slice(0, 250) });
    return { id, status: 'failed' };
  }
}
module.exports = { sendEmail };
