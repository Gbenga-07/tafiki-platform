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
  const file = await updateBackup(db, 'before-reset');
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
// The console lists the one Tafiki backup (see below) and the newest nightly database dump in ~/backups.
// A Super Admin can download either, and can restore the Tafiki backup after two checks (password and the
// typed phrase). The current data is always added to the backup first.
const BACKUP_DIR = () => process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'data', 'backups');
const DUMP_DIR = () => process.env.DUMP_DIR || path.join(require('os').homedir(), 'backups');
const NAME_OK = /^[\w.-]+\.(json|sql)\.gz$/;
const RESTORE_PHRASE = 'RESTORE BACKUP';
// THE Tafiki backup: one file (tafiki-backup.json.gz) that is updated, never duplicated.
// Every update adds new rows and refreshes changed ones; rows that were later deleted stay in it.
// So day 1 holds day 1's data, day 2 holds day 1 + day 2, and so on: one complete, growing copy.
// It is updated once a day, when a Super Admin taps Back Up Now, and just before any reset or restore.
const STORE = 'tafiki-backup.json.gz';
const storePath = () => path.join(BACKUP_DIR(), STORE);
const LEGACY = /^(daily|manual|before-reset|before-restore)-.*\.json\.gz$/;
const plain = (x) => JSON.parse(JSON.stringify(x));
function loadStore() {
  try { const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(storePath())).toString('utf8')); if (d && d.version === 2 && d.tables) return d; } catch (e) { /* new store */ }
  return { version: 2, startedAt: null, updatedAt: null, lastDaily: null, updates: [], tables: {} };
}
function saveStore(st) {
  const dir = BACKUP_DIR(); fs.mkdirSync(dir, { recursive: true });
  const file = storePath(); const tmp = file + '.tmp';
  fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify(st)), { mode: 0o600 });
  fs.renameSync(tmp, file); // the previous version is only replaced once the updated one is fully written
  return file;
}
// Merge a set of tables into the store. A row is keyed by its id; if an id was reused for a different
// row (different created_at), both are kept. A row is only overwritten by a copy at least as new.
function mergeInto(st, data, when) {
  for (const t of RESET_TABLES) {
    const tab = st.tables[t] || (st.tables[t] = {});
    for (const raw of data[t] || []) {
      const row = plain(raw); let key = String(row.id);
      let n = 1; while (tab[key] && tab[key].r.created_at && row.created_at && tab[key].r.created_at !== row.created_at) key = String(row.id) + '~' + (n++);
      const old = tab[key];
      if (!old) tab[key] = { r: row, f: when, l: when };
      else { if (when >= old.l) { old.r = row; old.l = when; } if (when < old.f) old.f = when; }
    }
  }
}
const readTables = async (db) => { const o = {}; for (const t of RESET_TABLES) o[t] = await db(t).select(); return o; };
async function updateBackup(db, reason) {
  const st = loadStore(); const now = new Date().toISOString();
  // Fold in the separate dated copies made by the older version (oldest first), then file them away.
  const dir = BACKUP_DIR(); let legacy = [];
  try { legacy = fs.readdirSync(dir).filter((n) => LEGACY.test(n)).map((n) => ({ n, m: fs.statSync(path.join(dir, n)).mtime.toISOString() })).sort((a, b) => (a.m < b.m ? -1 : 1)); } catch (e) { legacy = []; }
  const folded = [];
  for (const x of legacy) { try { const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, x.n))).toString('utf8')); mergeInto(st, d, x.m); if (!st.startedAt || x.m < st.startedAt) st.startedAt = x.m; folded.push(x.n); } catch (e) { /* unreadable: leave it where it is */ } }
  mergeInto(st, await readTables(db), now);
  st.startedAt = st.startedAt || now; st.updatedAt = now; if (reason === 'daily') st.lastDaily = now.slice(0, 10);
  st.updates.push({ at: now, reason }); st.updates = st.updates.slice(-90);
  const file = saveStore(st);
  if (folded.length) { const into = path.join(dir, 'merged'); fs.mkdirSync(into, { recursive: true }); for (const n of folded) { try { fs.renameSync(path.join(dir, n), path.join(into, n)); } catch (e) { /* ignore */ } } }
  return file;
}
const REASON = { daily: 'daily update', manual: 'Back Up Now', 'before-reset': 'before a reset', 'before-restore': 'before a restore' };
const summaryCache = new Map();
function summary(file, stat) {
  const key = file + ':' + stat.mtimeMs; if (summaryCache.has(key)) return summaryCache.get(key);
  let out = null;
  try { const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
    const rows = (t) => Object.values((d.tables || {})[t] || {});
    const n = (t, f) => rows(t).filter((x) => !f || f(x.r)).length;
    const gone = (t, f) => rows(t).filter((x) => (!f || f(x.r)) && x.l < d.updatedAt).length;
    const last = (d.updates || [])[d.updates.length - 1];
    out = { members: n('users', (u) => u.role === 'investor'), marts: n('users', (u) => u.role === 'retailer'), packages: n('packages'), stakes: n('holdings'), payments: n('payments'), emails: n('emails'),
      deletedKept: RESET_TABLES.reduce((a, t) => a + gone(t), 0), deletedMembers: gone('users', (u) => u.role === 'investor'),
      startedAt: d.startedAt, updates: (d.updates || []).length, lastReason: last ? REASON[last.reason] || last.reason : null };
  } catch (e) { out = null; }
  summaryCache.set(key, out); return out;
}
function listConsole() {
  const file = storePath(); let st; try { st = fs.statSync(file); } catch (e) { return []; }
  return [{ name: STORE, source: 'console', kind: 'Tafiki backup · updated every day', size: st.size, createdAt: st.mtime, restorable: true, counts: summary(file, st) }];
}
// Nightly database copies come from the server's own cron job. Only the newest is listed; nothing is deleted.
function listNightly() {
  const dir = DUMP_DIR(); let names = []; try { names = fs.readdirSync(dir).filter((n) => NAME_OK.test(n) && /\.sql\.gz$/.test(n)); } catch (e) { return []; }
  const all = names.map((name) => ({ name, st: fs.statSync(path.join(dir, name)) })).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  return all.slice(0, 1).map(({ name, st }) => ({ name, source: 'nightly', kind: 'Nightly database copy', size: st.size, createdAt: st.mtime, restorable: false, counts: null, olderCopies: all.length - 1 }));
}
const findBackup = (name) => { if (!NAME_OK.test(String(name || ''))) return null; for (const dir of [BACKUP_DIR(), DUMP_DIR()]) { const f = path.join(dir, name); if (fs.existsSync(f)) return { file: f, console: dir === BACKUP_DIR() }; } return null; };
r.get('/data/backups', superOnly, async (req, res) => {
  res.json({ backups: [...listConsole(), ...listNightly()], phrase: RESTORE_PHRASE, restoreAllowed: !liveMoney() });
});
r.post('/data/backups', superOnly, async (req, res) => {
  const file = await updateBackup(getDb(), 'manual');
  await activity.log(me(req), 'data.backup_saved', { type: 'system', id: 'all' }, { backup: path.basename(file) });
  res.status(201).json({ backup: path.basename(file) });
});
r.get('/data/backups/:name', superOnly, async (req, res) => {
  const f = findBackup(req.params.name); if (!f) throw new HttpError(404, 'Backup not found.');
  await activity.log(me(req), 'data.backup_downloaded', { type: 'system', id: 'all' }, { backup: req.params.name });
  res.download(f.file, req.params.name);
});
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
// Restore: the current data is first added to the backup, then every table is rebuilt from it, so
// deleted rows come back and nothing current is lost. Where two rows clash (the same id or the same
// email), the most recently seen one wins and the other stays in the backup file.
r.post('/data/backups/:name/restore', superOnly, async (req, res) => {
  if (liveMoney()) throw new HttpError(403, 'Live payment keys are in use, so restoring is switched off. Set ALLOW_DATA_RESET=on in the API settings only if you are certain.');
  const b = req.body || {}; const db = getDb();
  const a = await db('admins').where({ id: req.admin.id }).first();
  if (!(await pw.verify(b.password, a.password_hash))) throw bad('Your password is not correct.');
  if (String(b.phrase || '').trim() !== RESTORE_PHRASE) throw bad(`Type ${RESTORE_PHRASE} exactly to confirm.`);
  if (req.params.name !== STORE || !fs.existsSync(storePath())) throw new HttpError(404, 'Only the Tafiki backup can be restored here. Ask Claude on the server to restore a nightly database copy.');
  await updateBackup(db, 'before-restore');
  const st = loadStore();
  const isMy = db.client.config.client !== 'sqlite3' && db.client.config.client !== 'better-sqlite3';
  const fix = (row) => { const o = {}; for (const [k, v] of Object.entries(row)) o[k] = isMy && typeof v === 'string' && ISO.test(v) ? new Date(v) : v; return o; };
  const restored = {}; let skipped = 0;
  await db.transaction(async (trx) => {
    for (const t of RESET_TABLES) await trx(t).del();
    for (const t of [...RESET_TABLES].reverse()) {
      const rows = Object.values(st.tables[t] || {}).sort((x, y) => (x.l < y.l ? 1 : x.l > y.l ? -1 : 0)).map((x) => fix(x.r));
      restored[t] = 0;
      for (let i = 0; i < rows.length; i += 200) {
        const part = rows.slice(i, i + 200);
        try { await trx(t).insert(part); restored[t] += part.length; } catch (e) {
          for (const row of part) { try { await trx(t).insert(row); restored[t] += 1; } catch (e2) { skipped += 1; } }
        }
      }
    }
  });
  await activity.log(me(req), 'data.restored', { type: 'system', id: 'all' }, { backup: STORE, restored, skipped });
  const supers = await db('admins').where({ role: 'Super Admin', status: 'active' });
  for (const s of supers) await sendEmail({ to: s.email, name: s.name.split(' ')[0], category: 'security', ref: 'restore', subject: 'Tafiki data was restored from the backup', title: 'Platform data was restored',
    lead: `**${req.admin.name}** restored the platform data from the Tafiki backup. The current data was added to the backup first, so nothing current was lost, and deleted data came back.`,
    blocks: [{ type: 'kv', title: 'Restore details', rows: [['Done by', `${req.admin.name} · ${req.admin.email}`], ['Time', K.when()], ['Restored from', STORE], ['Rows that clashed and stayed in the file', String(skipped)]] },
      { type: 'note', tone: 'bad', title: 'Not expected?', text: 'If you did not expect this, contact your Super Admins straight away.' }], help: false });
  res.json({ ok: true, restored, skipped });
});
// Daily update (jobs.js calls this every hour): the same file, updated once a day.
let lastDaily = null;
async function dailyBackup() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastDaily === null) lastDaily = loadStore().lastDaily || '';
  if (lastDaily === today) return;
  await updateBackup(getDb(), 'daily'); lastDaily = today;
}
dailyBackup.resetMemo = () => { lastDaily = null; };
r.dailyBackup = dailyBackup;
module.exports = r;
