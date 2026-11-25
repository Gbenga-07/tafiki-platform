// Super Admin data tools: export the platform data (the console turns it into a PDF report) and reset all data.
// Reset takes two confirmations (password, then a one-time token plus the typed phrase), backs everything up first,
// keeps the console admins, settings and counters, and is refused once live Paystack keys are in use
// unless ALLOW_DATA_RESET=on.
const express = require('express');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { getDb } = require('../db');
const { requireAdmin } = require('../lib/auth');
const { bad, HttpError, randomToken, sha256, uuid } = require('../lib/util');
const pw = require('../lib/passwords');
const activity = require('../lib/activity');
const { sendEmail } = require('../lib/mailer');
const K = require('../lib/emailkit');
const r = express.Router();
r.use(requireAdmin);
const superOnly = (req, res, next) => (req.admin.role === 'Super Admin' ? next() : next(new HttpError(403, 'Only a Super Admin can do this.')));
const me = (req) => ({ type: 'admin', id: req.admin.id });

// Cleared by a reset, children before parents. Kept: admins, settings, counters, sessions, login records.
const RESET_TABLES = ['delivery_log', 'delivery_lines', 'deliveries', 'sales_reports', 'remittances', 'store_cycles', 'wallet_tx', 'withdrawals', 'redemptions', 'payout_runs', 'memberships', 'payments', 'kyc_checks', 'holdings', 'packages', 'sms', 'emails', 'codes', 'activity_log', 'users'];
const PHRASE = 'RESET ALL DATA';
const liveMoney = () => (/^sk_live_/.test(process.env.PAYSTACK_SECRET_KEY || '') || /^FLWSECK-/.test(process.env.FLW_SECRET_KEY || '')) && String(process.env.ALLOW_DATA_RESET || '').toLowerCase() !== 'on';

async function counts(db) { const o = {}; for (const t of RESET_TABLES) o[t] = Number((await db(t).count({ n: '*' }).first()).n); return o; }

// Data for the PDF report (no password hashes, codes, tokens or email bodies).
r.get('/data/export', superOnly, async (req, res) => {
  const db = getDb();
  const users = await db('users').select('id', 'role', 'name', 'email', 'phone', 'city', 'shop', 'area', 'kyc_status', 'status', 'coop_no', 'membership_until', 'phone_verified_at', 'created_at').orderBy('created_at');
  const out = {
    generatedAt: new Date(), generatedBy: req.admin.name,
    users, packages: await db('packages').orderBy('name'),
    holdings: await db('holdings as h').join('users as u', 'u.id', 'h.user_id').join('packages as p', 'p.id', 'h.package_id').select('h.ref', 'u.name as member', 'p.name as mart', 'h.units', 'h.amount', 'h.status', 'h.paid_at', 'h.cert_no').orderBy('h.created_at'),
    payments: await db('payments as p').join('users as u', 'u.id', 'p.user_id').select('p.reference', 'u.name as member', 'p.amount', 'p.fee_amount', 'p.provider as method', 'p.status', 'p.created_at').orderBy('p.created_at'),
    payouts: await db('payout_runs as r').join('packages as p', 'p.id', 'r.package_id').select('p.name as mart', 'r.cycle_no', 'r.profit', 'r.per_unit', 'r.investors_total', 'r.created_at').orderBy('r.created_at'),
    withdrawals: await db('withdrawals as w').join('users as u', 'u.id', 'w.user_id').select('w.ref', 'u.name as member', 'w.amount', 'w.bank_name', 'w.status', 'w.created_at').orderBy('w.created_at'),
    redemptions: await db('redemptions as d').join('users as u', 'u.id', 'd.user_id').select('u.name as member', 'd.amount', 'd.status', 'd.created_at').orderBy('d.created_at'),
    remittances: await db('remittances as m').join('users as u', 'u.id', 'm.store_user_id').select('m.ref', 'u.shop as mart', 'm.amount', 'm.status', 'm.created_at').orderBy('m.created_at'),
    deliveries: await db('deliveries as d').join('users as u', 'u.id', 'd.store_user_id').select('d.code', 'u.shop as mart', 'd.kind', 'd.value', 'd.status', 'd.delivered_at').orderBy('d.created_at'),
    emails: await db('emails').select('audience', 'category').count({ n: '*' }).groupBy('audience', 'category'),
    counts: await counts(db),
  };
  await activity.log(me(req), 'data.exported', { type: 'system', id: 'all' });
  res.json(out);
});

// Step 1 of reset: password. Returns a one-time token valid for 10 minutes and what will be deleted.
r.post('/data/reset/start', superOnly, async (req, res) => {
  if (liveMoney()) throw new HttpError(403, 'Live Paystack keys are in use, so resetting is switched off. Set ALLOW_DATA_RESET=on in the API settings only if you are certain.');
  const db = getDb(); const a = await db('admins').where({ id: req.admin.id }).first();
  if (!(await pw.verify(req.body && req.body.password, a.password_hash))) throw bad('Your password is not correct.');
  const token = randomToken();
  await db('codes').where({ purpose: 'data_reset', subject_type: 'admin', subject_id: a.id }).whereNull('used_at').update({ used_at: new Date() });
  await db('codes').insert({ id: uuid(), purpose: 'data_reset', subject_type: 'admin', subject_id: a.id, code_hash: sha256(token), expires_at: new Date(Date.now() + 10 * 60000), created_at: new Date() });
  await activity.log(me(req), 'data.reset_started', { type: 'system', id: 'all' });
  res.json({ token, phrase: PHRASE, counts: await counts(db), expiresInMinutes: 10 });
});

// Step 2: token + the typed phrase. Backs up every cleared table, then deletes in one transaction.
r.post('/data/reset/confirm', superOnly, async (req, res) => {
  if (liveMoney()) throw new HttpError(403, 'Live Paystack keys are in use, so resetting is switched off.');
  const b = req.body || {}; const db = getDb();
  if (String(b.phrase || '').trim() !== PHRASE) throw bad(`Type ${PHRASE} exactly to confirm.`);
  const row = await db('codes').where({ purpose: 'data_reset', subject_type: 'admin', subject_id: req.admin.id, code_hash: sha256(String(b.token || '')) }).whereNull('used_at').first();
  if (!row || new Date(row.expires_at) < new Date()) throw bad('This reset request has expired. Start again.');
  if (!(await db('codes').where({ id: row.id }).whereNull('used_at').update({ used_at: new Date() }))) throw bad('This reset is already running.');
  const backup = {}; for (const t of RESET_TABLES) backup[t] = await db(t).select();
  const dir = path.join(__dirname, '..', '..', 'data', 'backups'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `before-reset-${new Date().toISOString().replace(/[:.]/g, '-')}.json.gz`);
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(backup)), { mode: 0o600 });
  const removed = {};
  await db.transaction(async (trx) => { for (const t of RESET_TABLES) removed[t] = await trx(t).del(); });
  await activity.log(me(req), 'data.reset', { type: 'system', id: 'all' }, { removed, backup: path.basename(file) });
  const supers = await db('admins').where({ role: 'Super Admin', status: 'active' });
  for (const s of supers) await sendEmail({ to: s.email, name: s.name.split(' ')[0], category: 'security', ref: 'reset', subject: 'All Tafiki data was reset', title: 'All platform data was reset',
    lead: `**${req.admin.name}** reset all platform data. Members, marts, packages, payments, wallets, deliveries and emails were removed. Console admins and settings were kept.`,
    blocks: [{ type: 'kv', title: 'Reset details', rows: [['Done by', `${req.admin.name} · ${req.admin.email}`], ['Time', K.when()], ['Backup saved as', path.basename(file)]] },
      { type: 'note', tone: 'bad', title: 'Not expected?', text: 'If you did not expect this, contact your Super Admins straight away. The backup above can restore the data.' }], help: false });
  res.json({ ok: true, removed, backup: path.basename(file) });
});
module.exports = r;
