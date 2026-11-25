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
// The email look: dark green header with the category, greeting, message, optional receipt, sign-off and a footer
// that says why the email was sent and how to reach us. Plain inline styles so every mail app shows it the same.
const CAT_LABEL = { receipts: 'Receipt', payouts: 'Payment to you', wallet: 'Wallet', units: 'Your units', account: 'Account', security: 'Security', delivery: 'Delivery', remittance: 'Remittance', audit: 'Audit and cycle', operations: 'Operations' };
function layoutBase(name, paragraphs, extra, category) {
  const p = paragraphs.map((x) => `<p style="margin:0 0 12px">${esc(x)}</p>`).join('');
  const label = CAT_LABEL[category] || 'Tafiki';
  return `<div style="font-family:Arial,Helvetica,sans-serif;background:#F4F7F0;padding:24px 12px"><div style="max-width:580px;margin:auto;background:#fff;border:1px solid #E3EBD9;border-radius:16px;overflow:hidden">`
    + `<div style="background:#1D4107;padding:18px 22px"><table style="width:100%;border-collapse:collapse"><tr><td style="color:#fff;font-weight:800;font-size:22px;letter-spacing:-.3px">tafiki<span style="color:#F59A4E">.</span></td><td style="text-align:right"><span style="display:inline-block;background:rgba(255,255,255,.14);color:#E8F2DC;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:5px 10px;border-radius:999px">${esc(label)}</span></td></tr></table></div>`
    + `<div style="padding:22px;color:#24361A;font-size:14px;line-height:1.6"><p style="margin:0 0 12px">Hello ${esc(name || 'there')},</p>${p}${extra || ''}<p style="margin:18px 0 0">Kind regards,<br><b>Tafiki Operations</b></p></div>`
    + `<div style="background:#F6FAF1;border-top:1px solid #E3EBD9;padding:14px 22px;font-size:11.5px;color:#6F7E64;line-height:1.55">Questions? Reply to this email or write to support@tafiki.com. Tafiki will never ask for your password, PIN or one-time code.<br><br>FOODCORE is a product of FOODCORE Multipurpose Cooperative, licensed by the Lagos State Ministry of Commerce, Cooperatives, Trade and Investment. Tafiki Technology and Hybrid Foods and Mart Ltd are registered with the CAC.</div></div></div>`;
}
// A receipt block: title, number, date, rows of label and value, a total line and a short note.
const fmtN = (n) => '₦' + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d) => new Date(d || Date.now()).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' }) + ' WAT';
function receiptHtml(r) {
  const row = ([l, v], strong) => `<tr><td style="padding:7px 0;color:#5C6A55;border-bottom:1px solid #EEF2E8">${esc(l)}</td><td style="padding:7px 0;text-align:right;border-bottom:1px solid #EEF2E8;${strong ? 'font-weight:700;color:#1D4107;font-size:16px' : 'color:#24361A'}">${esc(v)}</td></tr>`;
  return `<div style="margin:16px 0;border:1px solid #DCE7CF;border-radius:12px;overflow:hidden"><div style="background:#F4F8EE;padding:12px 16px;display:flex;justify-content:space-between"><b style="color:#1D4107">${esc(r.title)}</b></div><div style="padding:6px 16px 12px"><table style="width:100%;border-collapse:collapse;font-size:13.5px">${row(['Receipt number', r.number])}${row(['Date', fmtDate(r.date)])}${(r.rows || []).filter((x) => x && x[1] !== undefined && x[1] !== null && x[1] !== '').map((x) => row(x)).join('')}${r.total ? row(r.total, true) : ''}</table>${r.note ? `<p style="margin:10px 0 0;font-size:12.5px;color:#6F7E64">${esc(r.note)}</p>` : ''}</div></div>`;
}
function receiptText(r) {
  const lines = [['Receipt number', r.number], ['Date', fmtDate(r.date)], ...(r.rows || []).filter((x) => x && x[1] !== undefined && x[1] !== null && x[1] !== ''), ...(r.total ? [r.total] : [])];
  return [r.title.toUpperCase(), ...lines.map(([l, v]) => `${l}: ${v}`), r.note || ''].filter(Boolean).join('\n');
}
const layout = (name, paragraphs, receipt, category) => layoutBase(name, paragraphs, receipt ? receiptHtml(receipt) : '', category);
async function nextReceiptNo(db) { const y = new Date().getFullYear(); const n = await require('./counters').next('receipt:' + y, 1); return `TFK-${y}-${String(n).padStart(6, '0')}`; }
// receipt: { title, rows: [[label, value]], total: [label, value], note, amount, direction: 'in' (paid to Tafiki) | 'out' (paid by Tafiki) }
async function sendEmail({ to, name, category, subject, paragraphs, ref, receipt }) {
  const db = getDb();
  const id = uuid();
  if (receipt && !receipt.number) receipt.number = await nextReceiptNo(db);
  if (receipt && !receipt.date) receipt.date = new Date();
  const who = await db('users').where({ email: String(to).toLowerCase() }).first('role') || (await db('users').where({ email: to }).first('role'));
  const audience = who ? (who.role === 'retailer' ? 'mart' : 'member') : (await db('admins').where({ email: String(to).toLowerCase() }).first('id')) ? 'team' : null;
  const text = [`Hello ${name || 'there'},`, ...paragraphs, ...(receipt ? [receiptText(receipt)] : []), 'Kind regards,', 'Tafiki Operations'].join('\n\n');
  const html = layout(name, paragraphs, receipt, category);
  await db('emails').insert({ id, to_email: to, to_name: name || null, category, subject: receipt ? `${subject} · ${receipt.number}` : subject, body_text: text, body_html: html, ref: ref || null, status: 'queued', created_at: new Date(),
    receipt_no: receipt ? receipt.number : null, amount: receipt && receipt.amount != null ? receipt.amount : null, direction: receipt ? receipt.direction || null : null, audience });
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
async function resend(e) {
  const db = getDb(); const t = getTransport();
  if (!t) return { status: 'logged' };
  try { const info = await t.sendMail({ from: config.mail.from, replyTo: config.mail.replyTo, to: e.to_name ? `"${e.to_name}" <${e.to_email}>` : e.to_email, subject: e.subject, text: e.body_text, html: e.body_html }); await db('emails').where({ id: e.id }).update({ status: 'sent', error: null, provider_id: String(info.messageId || ''), sent_at: new Date() }); return { status: 'sent' }; }
  catch (err) { await db('emails').where({ id: e.id }).update({ status: 'failed', error: String(err.message).slice(0, 250) }); return { status: 'failed' }; }
}
module.exports = { sendEmail, resend, fmtN, fmtDate, CAT_LABEL };
