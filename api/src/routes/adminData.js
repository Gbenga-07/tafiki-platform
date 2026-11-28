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
  if (liveMoney()) throw new HttpError(403, 'Live payment keys are in use, so resetting is switched off. Set ALLOW_DATA_RESET=on in the API settings only if you are certain.');
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
  if (liveMoney()) throw new HttpError(403, 'Live payment keys are in use, so resetting is switched off.');
  const b = req.body || {}; const db = getDb();
  if (String(b.phrase || '').trim() !== PHRASE) throw bad(`Type ${PHRASE} exactly to confirm.`);
  const row = await db('codes').where({ purpose: 'data_reset', subject_type: 'admin', subject_id: req.admin.id, code_hash: sha256(String(b.token || '')) }).whereNull('used_at').first();
  if (!row || new Date(row.expires_at) < new Date()) throw bad('This reset request has expired. Start again.');
  if (!(await db('codes').where({ id: row.id }).whereNull('used_at').update({ used_at: new Date() }))) throw bad('This reset is already running.');
  const file = await snapshot(db, 'before-reset');
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

// ---- Data backups -------------------------------------------------------------------------------
// The console lists every backup: the copies saved before a reset or a restore, copies saved by hand,
// and the nightly database dumps in ~/backups. A Super Admin can download any of them, and can restore a
// console backup after two checks (password and the typed phrase). A fresh backup is always saved first.
const BACKUP_DIR = () => process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'data', 'backups');
const DUMP_DIR = () => process.env.DUMP_DIR || path.join(require('os').homedir(), 'backups');
const NAME_OK = /^[\w.-]+\.(json|sql)\.gz$/;
const RESTORE_PHRASE = 'RESTORE BACKUP';
// One file per kind of backup, replaced each time, so the list stays short:
// daily-backup, manual-backup, before-reset-backup, before-restore-backup.
const fixedName = (prefix) => `${prefix}-backup.json.gz`;
async function snapshot(db, prefix) {
  const backup = {}; for (const t of RESET_TABLES) backup[t] = await db(t).select();
  const dir = BACKUP_DIR(); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fixedName(prefix)); const tmp = file + '.tmp';
  fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify(backup)), { mode: 0o600 });
  fs.renameSync(tmp, file); // the old copy is only replaced once the new one is fully written
  pruneOld(dir, prefix);
  return file;
}
// Older dated copies of the same kind (from before backups were kept as one file each).
function pruneOld(dir, prefix) {
  let names = []; try { names = fs.readdirSync(dir); } catch (e) { return; }
  const re = new RegExp('^' + prefix.replace(/[-]/g, '\\-') + '-\\d{4}-\\d\\d-\\d\\dT.*\\.json\\.gz$');
  for (const n of names) if (re.test(n)) { try { fs.unlinkSync(path.join(dir, n)); } catch (e) { /* ignore */ } }
}
const kindOf = (n) => (/^before-reset/.test(n) ? 'Saved before a reset' : /^before-restore/.test(n) ? 'Saved before a restore' : /^manual/.test(n) ? 'Saved by hand' : /^daily/.test(n) ? 'Daily copy · updated every day' : /\.sql\.gz$/.test(n) ? 'Nightly database copy · updated every night' : 'Backup');
const summaryCache = new Map();
function summary(file, stat) {
  const key = file + ':' + stat.mtimeMs; if (summaryCache.has(key)) return summaryCache.get(key);
  let out = null;
  try { const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')); const u = d.users || [];
    out = { members: u.filter((x) => x.role === 'investor').length, marts: u.filter((x) => x.role === 'retailer').length, packages: (d.packages || []).length, stakes: (d.holdings || []).length, payments: (d.payments || []).length, emails: (d.emails || []).length };
  } catch (e) { out = null; }
  summaryCache.set(key, out); return out;
}
function listDir(dir, source) {
  let names = []; try { names = fs.readdirSync(dir).filter((n) => NAME_OK.test(n)); } catch (e) { return []; }
  return names.map((name) => { const file = path.join(dir, name); const st = fs.statSync(file);
    return { name, source, kind: kindOf(name), size: st.size, createdAt: st.mtime, restorable: source === 'console' && /\.json\.gz$/.test(name), counts: source === 'console' ? summary(file, st) : null }; });
}
const findBackup = (name) => { if (!NAME_OK.test(String(name || ''))) return null; for (const dir of [BACKUP_DIR(), DUMP_DIR()]) { const f = path.join(dir, name); if (fs.existsSync(f)) return { file: f, console: dir === BACKUP_DIR() }; } return null; };
r.get('/data/backups', superOnly, async (req, res) => {
  const all = [...listDir(BACKUP_DIR(), 'console'), ...listDir(DUMP_DIR(), 'nightly')].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ backups: all, phrase: RESTORE_PHRASE, restoreAllowed: !liveMoney() });
});
r.post('/data/backups', superOnly, async (req, res) => {
  const file = await snapshot(getDb(), 'manual');
  await activity.log(me(req), 'data.backup_saved', { type: 'system', id: 'all' }, { backup: path.basename(file) });
  res.status(201).json({ backup: path.basename(file) });
});
r.get('/data/backups/:name', superOnly, async (req, res) => {
  const f = findBackup(req.params.name); if (!f) throw new HttpError(404, 'Backup not found.');
  await activity.log(me(req), 'data.backup_downloaded', { type: 'system', id: 'all' }, { backup: req.params.name });
  res.download(f.file, req.params.name);
});
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
r.post('/data/backups/:name/restore', superOnly, async (req, res) => {
  if (liveMoney()) throw new HttpError(403, 'Live payment keys are in use, so restoring is switched off. Set ALLOW_DATA_RESET=on in the API settings only if you are certain.');
  const b = req.body || {}; const db = getDb();
  const a = await db('admins').where({ id: req.admin.id }).first();
  if (!(await pw.verify(b.password, a.password_hash))) throw bad('Your password is not correct.');
  if (String(b.phrase || '').trim() !== RESTORE_PHRASE) throw bad(`Type ${RESTORE_PHRASE} exactly to confirm.`);
  const f = findBackup(req.params.name); if (!f || !f.console || !/\.json\.gz$/.test(req.params.name)) throw new HttpError(404, 'Only console backups can be restored here. Ask Claude on the server to restore a nightly database copy.');
  let data; try { data = JSON.parse(zlib.gunzipSync(fs.readFileSync(f.file)).toString('utf8')); } catch (e) { throw bad('This backup file could not be read.'); }
  const isMy = db.client.config.client !== 'sqlite3' && db.client.config.client !== 'better-sqlite3';
  const fix = (row) => { const o = {}; for (const [k, v] of Object.entries(row)) o[k] = isMy && typeof v === 'string' && ISO.test(v) ? new Date(v) : v; return o; };
  const before = await snapshot(db, 'before-restore');
  const restored = {};
  await db.transaction(async (trx) => {
    for (const t of RESET_TABLES) await trx(t).del();
    for (const t of [...RESET_TABLES].reverse()) { const rows = (data[t] || []).map(fix); restored[t] = rows.length; for (let i = 0; i < rows.length; i += 200) await trx(t).insert(rows.slice(i, i + 200)); }
  });
  await activity.log(me(req), 'data.restored', { type: 'system', id: 'all' }, { backup: req.params.name, savedFirst: path.basename(before), restored });
  const supers = await db('admins').where({ role: 'Super Admin', status: 'active' });
  for (const s of supers) await sendEmail({ to: s.email, name: s.name.split(' ')[0], category: 'security', ref: 'restore', subject: 'Tafiki data was restored from a backup', title: 'Platform data was restored',
    lead: `**${req.admin.name}** restored the platform data from a backup. The data as it was just before the restore was saved too.`,
    blocks: [{ type: 'kv', title: 'Restore details', rows: [['Done by', `${req.admin.name} · ${req.admin.email}`], ['Time', K.when()], ['Restored from', req.params.name], ['Saved first as', path.basename(before)]] },
      { type: 'note', tone: 'bad', title: 'Not expected?', text: 'If you did not expect this, contact your Super Admins straight away.' }], help: false });
  res.json({ ok: true, restored, savedFirst: path.basename(before) });
});
// Daily copy (run hourly by jobs.js): one file, refreshed once a day.
// The nightly database copies made by the server (~/backups/*.sql.gz) are trimmed to the newest one.
const sameDay = (a, b) => a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
async function dailyBackup() {
  const file = path.join(BACKUP_DIR(), fixedName('daily'));
  let fresh = false; try { fresh = sameDay(fs.statSync(file).mtime, new Date()); } catch (e) { fresh = false; }
  if (!fresh) await snapshot(getDb(), 'daily');
  pruneNightly();
}
function pruneNightly() {
  const dir = DUMP_DIR(); let list = [];
  try { list = fs.readdirSync(dir).filter((n) => /\.sql\.gz$/.test(n)).map((n) => ({ n, st: fs.statSync(path.join(dir, n)) })); } catch (e) { return; }
  // Only trim once the newest copy looks complete, so a failed dump never leaves you with nothing.
  list.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  if (list.length < 2 || list[0].st.size < 1024) return;
  for (const x of list.slice(1)) { try { fs.unlinkSync(path.join(dir, x.n)); } catch (e) { /* ignore */ } }
}
r.dailyBackup = dailyBackup;
module.exports = r;
