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
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// **bold** in message text becomes bold in the email; everything else is escaped.
const rich = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b style="color:#1D4107">$1</b>');
const plain = (s) => String(s == null ? '' : s).replace(/\*\*(.+?)\*\*/g, '$1');
const fmtN = (n) => '₦' + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d) => new Date(d || Date.now()).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' }) + ' WAT';

/* ---------------------------------------------------------------------------------------------
   The Tafiki email. Same look as the console preview: green header with the Tafiki logo and the
   category, a greeting, the message, detail panels, a progress tracker where it helps, what happens
   next, a help line quoting the reference, a signature with the logo, and the cooperative footer.
   Built with tables and inline styles so Gmail, Outlook and phone mail apps all show it the same.
   --------------------------------------------------------------------------------------------- */
const CAT_LABEL = { receipts: 'Receipt', payouts: 'Payment to you', wallet: 'Wallet', units: 'Your units', account: 'Account', security: 'Security', delivery: 'Delivery update', remittance: 'Remittance', audit: 'Audit and cycle', operations: 'Operations' };
const C = { ink: '#24361A', dark: '#1D4107', mid: '#4A5C40', mute: '#7A8770', line: '#E6EEDD', soft: '#F6FAF1', page: '#EEF3E8', ok: '#2B5A12', warn: '#8A5A00', warnBg: '#FFF7E6', bad: '#9B2C1F', badBg: '#FDF0EE' };
const asset = (f) => String(config.appUrl || 'https://tafiki.com').replace(/\/+$/, '') + '/img/' + f;
const T = 'border-collapse:collapse;width:100%';
const FONT = "'Figtree','Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const panel = (title, inner) => `<table role="presentation" style="${T};border:1px solid ${C.line};border-radius:12px;margin:0 0 14px;overflow:hidden" cellpadding="0" cellspacing="0"><tr><td style="background:${C.soft};padding:8px 14px;font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${C.mid};border-bottom:1px solid ${C.line}">${esc(title)}</td></tr><tr><td style="padding:0">${inner}</td></tr></table>`;
const kvRows = (rows) => rows.filter((r) => r && r[1] !== undefined && r[1] !== null && r[1] !== '').map(([k, v], i) => `<tr><td style="padding:8px 14px;color:${C.mute};width:40%;vertical-align:top;text-transform:capitalize;${i ? `border-top:1px solid #F0F4EA` : ''}">${esc(k)}</td><td style="padding:8px 14px;color:${C.dark};font-weight:600;vertical-align:top;${i ? `border-top:1px solid #F0F4EA` : ''}">${rich(v)}</td></tr>`).join('');
const BLOCK = {
  kv: (b) => panel(b.title || 'Details', `<table role="presentation" style="${T};font-size:13.5px">${kvRows(b.rows || [])}</table>`),
  items: (b) => { const right = (i) => (b.right || []).includes(i);
    const head = `<tr>${(b.head || []).map((h, i) => `<th style="padding:8px 14px;font-size:10.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:${C.mute};background:#F2F7EC;text-align:${right(i) ? 'right' : 'left'}">${esc(h)}</th>`).join('')}</tr>`;
    const row = (r, tot) => `<tr>${r.map((c, i) => `<td style="padding:8px 14px;border-top:1px solid #F0F4EA;text-align:${right(i) ? 'right' : 'left'};${tot ? `font-weight:700;color:${C.dark};background:#FAFCF7` : `color:${C.ink}`}">${i === 0 && !tot && Array.isArray(c) ? `<b>${esc(c[0])}</b> <span style="color:${C.mute};font-size:12px">${esc(c[1] || '')}</span>` : rich(c)}</td>`).join('')}</tr>`;
    return panel(b.title || 'Items', `<table role="presentation" style="${T};font-size:13.5px">${head}${(b.rows || []).map((r) => row(r)).join('')}${b.total ? row(b.total, true) : ''}</table>`); },
  steps: (b) => { const n = b.steps.length;
    const cell = (s, i) => { const on = s.state === 'done' || s.state === 'now'; return `<td style="width:${Math.floor(100 / n)}%;text-align:center;vertical-align:top;padding:12px 4px"><div style="width:24px;height:24px;line-height:24px;border-radius:12px;margin:0 auto 5px;font-size:11px;font-weight:700;background:${on ? C.ok : '#EEF2E8'};color:${on ? '#fff' : C.mute};${s.state === 'now' ? 'box-shadow:0 0 0 3px #CFE3BB' : ''}">${on ? '&#10003;' : i + 1}</div><div style="font-size:11.5px;font-weight:700;color:${C.dark}">${esc(s.label)}</div><div style="font-size:10.5px;color:${C.mute};line-height:1.35;margin-top:2px">${esc(s.sub || (s.state === 'done' ? 'Completed' : s.state === 'now' ? 'Now' : 'Pending'))}</div></td>`; };
    return panel(b.title || 'Progress', `<table role="presentation" style="${T}"><tr>${b.steps.map(cell).join('')}</tr></table>`); },
  list: (b) => panel(b.title || 'What Happens Next', `<ul style="margin:0;padding:10px 14px 10px 32px;font-size:13.5px;color:${C.ink};line-height:1.55">${(b.items || []).map((x) => `<li style="margin:3px 0">${rich(x)}</li>`).join('')}</ul>`),
  code: (b) => `<table role="presentation" style="${T};margin:4px 0 16px"><tr><td style="text-align:center;background:${C.soft};border:1px dashed #BFD3A8;border-radius:12px;padding:16px"><div style="font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${C.mid}">${esc(b.title || 'Your code')}</div><div style="font:700 30px/1.2 'Courier New',monospace;letter-spacing:.28em;color:${C.dark};margin:6px 0 4px">${esc(b.code)}</div>${b.sub ? `<div style="font-size:12px;color:${C.mute}">${esc(b.sub)}</div>` : ''}</td></tr></table>`,
  note: (b) => { const t = { warn: ['#FFF8EB', '#E2B85C', C.warn], bad: ['#FDF3F1', '#DE9A8D', C.bad], info: ['#FAFCF7', '#A5C783', C.mid], ok: ['#FAFCF7', '#A5C783', C.mid] }[b.tone || 'info'];
    return `<table role="presentation" style="${T};margin:0 0 14px"><tr><td style="background:${t[0]};border-left:3px solid ${t[1]};border-radius:0 8px 8px 0;padding:9px 13px;font-size:12.5px;color:${t[2]};line-height:1.55">${b.title ? `<b>${esc(b.title)}.</b> ` : ''}${rich(b.text)}</td></tr></table>`; },
  button: (b) => `<p style="margin:2px 0 14px;font-size:14px"><a href="${esc(b.url)}" style="color:${C.dark};font-weight:700;text-decoration:underline">${esc(b.label)} &rarr;</a></p>`,
};
function heroHtml(h) {
  return panel(h.label, `<table role="presentation" style="${T}"><tr><td style="padding:12px 14px"><div style="font:700 22px/1.25 ${FONT};color:${C.dark}">${esc(h.value)}</div>${h.sub ? `<div style="font-size:12.5px;color:${C.mute};margin-top:2px">${rich(h.sub)}</div>` : ''}</td></tr></table>`);
}
function receiptBlock(r) {
  const rows = [['Receipt number', r.number], ['Date', fmtDate(r.date)], ...(r.rows || [])];
  const inner = `<table role="presentation" style="${T};font-size:13.5px">${kvRows(rows)}${r.total ? `<tr><td style="padding:10px 14px;border-top:2px solid ${C.line};color:${C.dark};font-weight:700;text-transform:capitalize">${esc(r.total[0])}</td><td style="padding:10px 14px;border-top:2px solid ${C.line};color:${C.dark};font-weight:800;font-size:16px">${esc(r.total[1])}</td></tr>` : ''}</table>${r.note ? `<div style="padding:0 14px 12px;font-size:12px;color:${C.mute};line-height:1.5">${rich(r.note)}</div>` : ''}`;
  return panel(r.title, inner);
}
const SIG = { 'Tafiki Operations': 'Tafiki Distribution Centre · tafiki.com', 'Tafiki Finance': 'Payments and Collections · tafiki.com', 'Tafiki Member Services': 'FOODCORE Multipurpose Cooperative · tafiki.com', 'Tafiki Security': 'Account protection · tafiki.com' };
const TEAM_BY_CAT = { receipts: 'Tafiki Finance', payouts: 'Tafiki Finance', wallet: 'Tafiki Finance', remittance: 'Tafiki Finance', units: 'Tafiki Member Services', account: 'Tafiki Member Services', security: 'Tafiki Security', delivery: 'Tafiki Operations', audit: 'Tafiki Operations', operations: 'Tafiki Operations' };
function layout(m) {
  const label = m.tag || CAT_LABEL[m.category] || 'Tafiki';
  const team = m.team || TEAM_BY_CAT[m.category] || 'Tafiki Operations';
  const paras = (m.paragraphs || []).map((x) => `<p style="margin:0 0 10px">${rich(x)}</p>`).join('');
  const blocks = (m.blocks || []).filter(Boolean).map((b) => (BLOCK[b.type] || BLOCK.kv)(b)).join('');
  const next = m.next && m.next.length ? BLOCK.list({ title: 'What Happens Next', items: m.next }) : '';
  const help = m.help !== false ? `<table role="presentation" style="${T};margin:0 0 14px"><tr><td style="background:#FAFCF7;border-left:3px solid #A5C783;border-radius:0 8px 8px 0;padding:8px 12px;font-size:12.5px;color:${C.mid};line-height:1.5">${rich(m.help || `Questions? Reply to this email${m.ref && !/^[0-9a-f-]{30,}$/.test(m.ref) ? ` quoting **${m.ref}**` : ''}, or contact ${team} at **support@tafiki.com**.`)}</td></tr></table>` : '';
  const foot = m.audience === 'team' ? 'This is an internal alert from the Tafiki Console. Do not forward it outside the team. FOODCORE is a product of FOODCORE Multipurpose Cooperative, licensed by the Lagos State Ministry of Commerce, Cooperatives, Trade and Investment.'
    : `This is an automated ${String(CAT_LABEL[m.category] || 'account update').toLowerCase().replace(/^(account|security|wallet|remittance|operations|your units)$/, '$1 update').replace('your units update', 'units update').replace('payment to you', 'payment advice')} from Tafiki Technology. Tafiki will never ask for your password, PIN or one-time code. FOODCORE is a product of FOODCORE Multipurpose Cooperative, licensed by the Lagos State Ministry of Commerce, Cooperatives, Trade and Investment.${m.audience === 'mart' ? '' : ' FOODCORE stock units are issued by the cooperative.'}`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(m.subject || 'Tafiki')}</title></head>`
    + `<body style="margin:0;padding:0;background:#F4F7F0">${m.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(m.preheader)}</div>` : ''}`
    + `<table role="presentation" style="${T};background:#F4F7F0" cellpadding="0" cellspacing="0"><tr><td style="padding:20px 10px">`
    + `<table role="presentation" style="border-collapse:collapse;width:100%;max-width:600px;margin:0 auto;background:#fff;border:1px solid #E3EBD9;border-radius:14px;overflow:hidden;font-family:${FONT}" cellpadding="0" cellspacing="0">`
    + `<tr><td style="background:${C.dark};padding:14px 18px"><table role="presentation" style="${T}"><tr><td><img src="${asset('email-logo-light.png')}" width="105" height="30" alt="Tafiki" style="display:block;border:0;height:30px;width:auto;color:#fff;font-weight:800;font-size:22px"></td><td style="text-align:right;font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#BFD8A4">${esc(label)}</td></tr></table></td></tr>`
    + `<tr><td style="padding:16px 18px 4px;color:${C.ink};font-size:14px;line-height:1.55">`
    + `<p style="margin:0 0 10px">Hello ${esc(m.name || 'there')},</p>${m.lead ? `<p style="margin:0 0 12px">${rich(m.lead)}</p>` : ''}${paras}${m.hero ? heroHtml(m.hero) : ''}${blocks}${m.receipt ? receiptBlock(m.receipt) : ''}${next}${m.cta ? BLOCK.button(m.cta) : ''}${help}`
    + `<table role="presentation" style="${T};border-top:1px solid #EEF2E8;margin-top:4px"><tr><td style="padding:12px 0 16px;font-size:14px;color:${C.ink}"><p style="margin:0 0 8px">Kind regards,</p><img src="${asset('email-logo.png')}" width="91" height="26" alt="Tafiki" style="display:block;border:0;height:26px;width:auto;margin:0 0 6px"><b style="display:block;color:${C.dark}">${esc(team)}</b><span style="display:block;font-size:12px;color:${C.mute}">${esc(SIG[team] || 'tafiki.com')}</span></td></tr></table>`
    + `</td></tr>`
    + `<tr><td style="background:${C.soft};border-top:1px solid ${C.line};padding:10px 18px;font-size:11px;color:${C.mute};line-height:1.55">${esc(foot)}</td></tr>`
    + `</table></td></tr></table></body></html>`;
}
function textVersion(m) {
  const out = [m.title || '', `Hello ${m.name || 'there'},`, plain(m.lead || ''), m.hero ? `${m.hero.label}: ${m.hero.value}${m.hero.sub ? ' (' + plain(m.hero.sub) + ')' : ''}` : '', ...(m.paragraphs || []).map(plain)];
  for (const b of (m.blocks || []).filter(Boolean)) {
    if (b.type === 'code') out.push(`${(b.title || 'Your code').toUpperCase()}: ${b.code}${b.sub ? ' (' + b.sub + ')' : ''}`);
    else if (b.type === 'note') out.push((b.title ? b.title + ': ' : '') + plain(b.text));
    else if (b.type === 'button') out.push(`${b.label}: ${b.url}`);
    else if (b.type === 'items') out.push([(b.title || 'Items').toUpperCase(), ...(b.rows || []).map((r) => r.map((c) => (Array.isArray(c) ? c.join(' ') : plain(c))).join(' | ')), ...(b.total ? [b.total.map(plain).join(' | ')] : [])].join('\n'));
    else if (b.type === 'steps') out.push([(b.title || 'Progress').toUpperCase(), ...b.steps.map((s) => `${s.state === 'done' || s.state === 'now' ? '[x]' : '[ ]'} ${s.label}${s.sub ? ' - ' + s.sub : ''}`)].join('\n'));
    else if (b.type === 'list') out.push([(b.title || 'What happens next').toUpperCase(), ...(b.items || []).map((x, i) => `${i + 1}. ${plain(x)}`)].join('\n'));
    else out.push([(b.title || 'Details').toUpperCase(), ...(b.rows || []).filter((r) => r && r[1] !== undefined && r[1] !== null && r[1] !== '').map(([k, v]) => `${k}: ${plain(v)}`)].join('\n'));
  }
  if (m.receipt) { const r = m.receipt; out.push([r.title.toUpperCase(), `Receipt number: ${r.number}`, `Date: ${fmtDate(r.date)}`, ...(r.rows || []).filter((x) => x && x[1] !== undefined && x[1] !== null && x[1] !== '').map(([k, v]) => `${k}: ${plain(v)}`), ...(r.total ? [`${r.total[0]}: ${r.total[1]}`] : []), r.note ? plain(r.note) : ''].filter(Boolean).join('\n')); }
  if (m.next && m.next.length) out.push(['WHAT HAPPENS NEXT', ...m.next.map((x, i) => `${i + 1}. ${plain(x)}`)].join('\n'));
  if (m.cta) out.push(`${m.cta.label}: ${m.cta.url}`);
  out.push(`Questions? Reply to this email${m.ref && !/^[0-9a-f-]{30,}$/.test(m.ref) ? ' quoting ' + m.ref : ''}, or write to support@tafiki.com.`, 'Kind regards,', m.team || TEAM_BY_CAT[m.category] || 'Tafiki Operations', 'tafiki.com');
  return out.filter((x) => x && String(x).trim()).join('\n\n');
}
async function nextReceiptNo(db) { const y = new Date().getFullYear(); const n = await require('./counters').next('receipt:' + y, 1); return `TFK-${y}-${String(n).padStart(6, '0')}`; }
// receipt: { title, rows: [[label, value]], total: [label, value], note, amount, direction: 'in' (paid to Tafiki) | 'out' (paid by Tafiki) }
// m: { to, name, category, subject, ref, title, lead, hero:{label,value,sub,tone}, paragraphs:[], blocks:[{type:'kv'|'items'|'steps'|'list'|'code'|'note'|'button',...}],
//      receipt:{ title, rows, total, note, amount, direction }, next:[], cta:{label,url}, help, team, preheader }
async function sendEmail(m) {
  const { to, name, category, subject, ref, receipt } = m; m.paragraphs = m.paragraphs || [];
  const db = getDb();
  const id = uuid();
  if (receipt && !receipt.number) receipt.number = await nextReceiptNo(db);
  if (receipt && !receipt.date) receipt.date = new Date();
  const who = await db('users').where({ email: String(to).toLowerCase() }).first('role') || (await db('users').where({ email: to }).first('role'));
  const audience = who ? (who.role === 'retailer' ? 'mart' : 'member') : (await db('admins').where({ email: String(to).toLowerCase() }).first('id')) ? 'team' : null;
  m.audience = audience;
  const text = textVersion(m);
  const html = layout(m);
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
module.exports = { sendEmail, resend, fmtN, fmtDate, CAT_LABEL, layout, textVersion };
