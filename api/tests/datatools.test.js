// Super Admin data tools: export for the PDF report, and reset all data with two confirmations and a backup.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const path = require('path'); const zlib = require('zlib');
const { setup, addAdmin, agent } = require('./helpers');
let app, db, sup, fin;
before(async () => {
  ({ app, db } = await setup());
  await addAdmin('Super Admin', 'ops@tafiki.com'); await addAdmin('Finance Officer', 'fin@tafiki.com');
  sup = agent(app); await sup.post('/api/admin/auth/login').send({ email: 'ops@tafiki.com', password: 'Passw0rd!' });
  fin = agent(app); await fin.post('/api/admin/auth/login').send({ email: 'fin@tafiki.com', password: 'Passw0rd!' });
  await sup.post('/api/admin/packages').send({ name: 'FOODCORE Mart Ikotun', area: 'Ikotun', city: 'Lagos', unitsTotal: 40 });
  await agent(app).post('/api/auth/register').send({ role: 'investor', firstName: 'Ada', lastName: 'Obi', email: 'ada@example.com', phone: '08031234567', password: 'Secret123', agreeTerms: true });
});
after(async () => { await db.destroy(); delete process.env.PAYSTACK_SECRET_KEY; });

test('only a Super Admin can export; the export has no secrets', async () => {
  assert.equal((await fin.get('/api/admin/data/export')).status, 403);
  const r = await sup.get('/api/admin/data/export'); assert.equal(r.status, 200);
  assert.ok(r.body.users.some((u) => u.email === 'ada@example.com')); assert.equal(r.body.packages.length, 1);
  const txt = JSON.stringify(r.body); assert.ok(!/password_hash|code_hash|code_enc|body_html/.test(txt));
});

test('backups: Super Admin saves, lists, downloads and restores deleted data; a copy is saved before restoring', async () => {
  const os = require('os'); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tafiki-bk-')); process.env.BACKUP_DIR = dir; process.env.DUMP_DIR = path.join(dir, 'none');
  try {
    assert.equal((await fin.get('/api/admin/data/backups')).status, 403);
    const saved = await sup.post('/api/admin/data/backups'); assert.equal(saved.status, 201);
    const l = await sup.get('/api/admin/data/backups'); assert.equal(l.status, 200);
    const b = l.body.backups.find((x) => x.name === saved.body.backup); assert.ok(b && b.restorable); assert.equal(b.kind, 'Saved by hand'); assert.equal(b.counts.members, 1); assert.equal(b.counts.packages, 1);
    const dl = await sup.get('/api/admin/data/backups/' + saved.body.backup).buffer(true).parse((res, cb) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
    assert.equal(dl.status, 200); assert.ok(JSON.parse(zlib.gunzipSync(dl.body)).users.some((u) => u.email === 'ada@example.com'));
    assert.equal((await sup.get('/api/admin/data/backups/..%2F..%2F.env')).status, 404);
    await db('packages').del(); assert.equal(Number((await db('packages').count({ n: '*' }).first()).n), 0);
    assert.equal((await sup.post('/api/admin/data/backups/' + saved.body.backup + '/restore').send({ password: 'wrong', phrase: 'RESTORE BACKUP' })).status, 400);
    assert.equal((await sup.post('/api/admin/data/backups/' + saved.body.backup + '/restore').send({ password: 'Passw0rd!', phrase: 'restore' })).status, 400);
    const rs = await sup.post('/api/admin/data/backups/' + saved.body.backup + '/restore').send({ password: 'Passw0rd!', phrase: 'RESTORE BACKUP' }); assert.equal(rs.status, 200, JSON.stringify(rs.body));
    assert.equal(Number((await db('packages').count({ n: '*' }).first()).n), 1, 'deleted package is back');
    assert.ok(await db('users').where({ email: 'ada@example.com' }).first());
    assert.ok((await sup.get('/api/admin/data/backups')).body.backups.some((x) => x.kind === 'Saved before a restore' && x.counts.packages === 0));
    const daily = require('../src/routes/adminData').dailyBackup; await daily(); await daily();
    assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('daily-')).length, 1, 'one daily copy a day');
  } finally { delete process.env.BACKUP_DIR; delete process.env.DUMP_DIR; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('reset needs the password, then the token and the exact phrase; it backs up, clears data and keeps admins and settings', async () => {
  assert.equal((await fin.post('/api/admin/data/reset/start').send({ password: 'Passw0rd!' })).status, 403);
  assert.equal((await sup.post('/api/admin/data/reset/start').send({ password: 'wrong' })).status, 400);
  const s = await sup.post('/api/admin/data/reset/start').send({ password: 'Passw0rd!' }); assert.equal(s.status, 200); assert.ok(s.body.counts.users >= 2);
  assert.equal((await sup.post('/api/admin/data/reset/confirm').send({ token: s.body.token, phrase: 'reset' })).status, 400);
  assert.equal((await sup.post('/api/admin/data/reset/confirm').send({ token: 'nope', phrase: 'RESET ALL DATA' })).status, 400);
  const two = await Promise.all([sup.post('/api/admin/data/reset/confirm').send({ token: s.body.token, phrase: 'RESET ALL DATA' }), sup.post('/api/admin/data/reset/confirm').send({ token: s.body.token, phrase: 'RESET ALL DATA' })]);
  assert.equal(two.filter((x) => x.status === 200).length, 1, 'runs once');
  const ok = two.find((x) => x.status === 200).body;
  assert.equal(Number((await db('users').count({ n: '*' }).first()).n), 0); assert.equal(Number((await db('packages').count({ n: '*' }).first()).n), 0);
  assert.equal(Number((await db('admins').count({ n: '*' }).first()).n), 2, 'admins kept');
  const f = path.join(__dirname, '..', 'data', 'backups', ok.backup); const back = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)));
  assert.ok(back.users.some((u) => u.email === 'ada@example.com'), 'backup holds the old data'); fs.unlinkSync(f);
  assert.ok(await db('emails').where('subject', 'like', 'All Tafiki data was reset%').first(), 'Super Admins emailed');
  assert.equal((await sup.get('/api/admin/auth/me')).status, 200, 'still signed in');
});

test('with live Paystack keys reset is refused unless ALLOW_DATA_RESET=on', async () => {
  process.env.PAYSTACK_SECRET_KEY = 'sk_live_x';
  assert.equal((await sup.post('/api/admin/data/reset/start').send({ password: 'Passw0rd!' })).status, 403);
});

test('email template library: every template lists without its HTML, and each opens in the approved design', async () => {
  const lib = require('../assets/email-templates.json'); assert.ok(lib.templates.length >= 40, 'library has ' + lib.templates.length);
  assert.ok(lib.templates.every((t) => t.audience !== 'mart' || !/investor/i.test(t.html)), 'no investor wording in mart emails');
  assert.ok(lib.templates.every((t) => !/Multipurpose|Hybrid Foods/i.test(t.html)), 'current cooperative name only');
  const l = await fin.get('/api/admin/email-templates'); assert.equal(l.status, 200); assert.equal(l.body.templates.length, lib.templates.length); assert.ok(!l.body.templates[0].html);
  const one = await fin.get('/api/admin/email-templates/' + l.body.templates[0].id); assert.match(one.body.template.html, /<!DOCTYPE html>/i);
  assert.equal((await agent(app).get('/api/admin/email-templates')).status, 401);
});
