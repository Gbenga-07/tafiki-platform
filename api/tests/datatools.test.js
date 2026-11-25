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
