const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, addAdmin, agent, lastEmail } = require('./helpers');
let app, db;
before(async () => ({ app, db } = await setup()));
after(async () => { await db.destroy(); });

const reg = { role: 'investor', firstName: 'Ada', lastName: 'Okafor', email: 'ada@example.com', phone: '+2348030001100', password: 'Secret123', city: 'Lagos', agreeTerms: true, bank: { name: 'GTBank', account: '0123456789', accountName: 'Ada Okafor' } };

test('health', async () => { const r = await agent(app).get('/api/health'); assert.equal(r.status, 200); });

test('register requires agreeing to terms and gives a cooperative number', async () => {
  const a = agent(app);
  let r = await a.post('/api/auth/register').send({ ...reg, agreeTerms: false }); assert.equal(r.status, 400);
  r = await a.post('/api/auth/register').send(reg); assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.user.coop.number, /^FMC-\d{4}-\d{4}$/);
  assert.equal(r.body.user.kycStatus, 'pending');
  assert.equal(r.body.user.password_hash, undefined);
  const me = await a.get('/api/me'); assert.equal(me.body.user.email, 'ada@example.com');
  const dup = await agent(app).post('/api/auth/register').send(reg); assert.equal(dup.status, 409);
  assert.ok(await db('emails').where({ to_email: 'ada@example.com' }).where('subject', 'like', 'Confirm your email%').first());
});

test('mutating requests need the client header', async () => {
  const r = await agent(app).raw.post('/api/auth/login').send({ email: 'ada@example.com', password: 'Secret123' }); assert.equal(r.status, 403);
});

test('member login, wrong password lockout', async () => {
  const a = agent(app);
  assert.equal((await a.post('/api/auth/login').send({ email: 'ada@example.com', password: 'nope' })).status, 401);
  const ok = await a.post('/api/auth/login').send({ email: 'ADA@example.com', password: 'Secret123' }); assert.equal(ok.status, 200);
  for (let i = 0; i < 5; i++) await agent(app).post('/api/auth/login').send({ email: 'lock@example.com', password: 'x' });
  const l = await agent(app).post('/api/auth/login').send({ email: 'lock@example.com', password: 'x' }); assert.equal(l.status, 429);
});

test('password reset by emailed token signs out old sessions', async () => {
  const a = agent(app); await a.post('/api/auth/login').send({ email: 'ada@example.com', password: 'Secret123' });
  await agent(app).post('/api/auth/password/forgot').send({ email: 'ada@example.com' });
  const e = await lastEmail('ada@example.com'); const token = e.body_text.match(/token=([\w-]+)/)[1];
  assert.equal((await agent(app).post('/api/auth/password/reset').send({ token, password: 'NewSecret45' })).status, 200);
  assert.equal((await a.get('/api/me')).status, 401);
  assert.equal((await agent(app).post('/api/auth/login').send({ email: 'ada@example.com', password: 'NewSecret45' })).status, 200);
  assert.equal((await agent(app).post('/api/auth/password/reset').send({ token, password: 'Again12345' })).status, 400);
});

test('console login, roles and permissions', async () => {
  await addAdmin('Super Admin', 'ops@tafiki.com'); await addAdmin('Admin', 'viewer@tafiki.com'); await addAdmin('Logistics Officer', 'logi@tafiki.com');
  const sup = agent(app), view = agent(app), logi = agent(app);
  assert.equal((await sup.post('/api/admin/auth/login').send({ email: 'ops@tafiki.com', password: 'wrong' })).status, 401);
  assert.equal((await sup.post('/api/admin/auth/login').send({ email: 'ops@tafiki.com', password: 'Passw0rd!' })).status, 200);
  await view.post('/api/admin/auth/login').send({ email: 'viewer@tafiki.com', password: 'Passw0rd!' });
  await logi.post('/api/admin/auth/login').send({ email: 'logi@tafiki.com', password: 'Passw0rd!' });
  // member cookie is not an admin session
  assert.equal((await agent(app).get('/api/admin/users')).status, 401);
  const users = await view.get('/api/admin/users'); assert.equal(users.status, 200); const id = users.body.users[0].id;
  assert.equal((await view.patch('/api/admin/users/' + id).send({ phone: '+2348000000000' })).status, 403);
  assert.equal((await logi.patch('/api/admin/users/' + id).send({ phone: '+2348000000000' })).status, 403);
  const ed = await sup.patch('/api/admin/users/' + id).send({ phone: '+2348000000000', kycStatus: 'verified' }); assert.equal(ed.status, 200); assert.deepEqual(ed.body.changed.sort(), ['kyc_status', 'phone']);
  assert.match((await lastEmail('ada@example.com')).subject, /details were updated/);
  const tp = await sup.post('/api/admin/users/' + id + '/temporary-password'); assert.equal(tp.status, 200);
  assert.equal((await agent(app).post('/api/auth/login').send({ email: 'ada@example.com', password: tp.body.temporaryPassword })).body.user.mustChangePassword, true);
});

test('Super Admin manages administrators and security; two-step sign-in', async () => {
  const sup = agent(app); await sup.post('/api/admin/auth/login').send({ email: 'ops@tafiki.com', password: 'Passw0rd!' });
  const c = await sup.post('/api/admin/admins').send({ name: 'Finance Desk', email: 'finance@tafiki.com', role: 'Finance Officer' }); assert.equal(c.status, 201);
  const view = agent(app); await view.post('/api/admin/auth/login').send({ email: 'viewer@tafiki.com', password: 'Passw0rd!' });
  assert.equal((await view.post('/api/admin/admins').send({ name: 'X Y Z', email: 'x@tafiki.com', role: 'Admin' })).status, 403);
  assert.equal((await sup.put('/api/admin/admins/security').send({ twofa: true, timeoutMinutes: 30, maxFailures: 5 })).status, 200);
  const fin = agent(app);
  const s1 = await fin.post('/api/admin/auth/login').send({ email: 'finance@tafiki.com', password: c.body.temporaryPassword }); assert.equal(s1.body.step, 'code');
  const code = (await lastEmail('finance@tafiki.com')).body_text.match(/code is (\d{6})/)[1];
  assert.equal((await fin.post('/api/admin/auth/verify').send({ ticket: s1.body.ticket, code: '000000' === code ? '111111' : '000000' })).status, 400);
  const s2 = await fin.post('/api/admin/auth/verify').send({ ticket: s1.body.ticket, code }); assert.equal(s2.status, 200); assert.equal(s2.body.admin.mustChangePassword, true);
  assert.deepEqual(s2.body.permissions, ['payments', 'audit', 'payouts']);
  const dis = await sup.post('/api/admin/admins/' + c.body.admin.id + '/status').send({ status: 'disabled' }); assert.equal(dis.status, 200);
  assert.equal((await fin.get('/api/admin/auth/me')).status, 401);
  const ev = await sup.get('/api/admin/admins/login-events'); assert.ok(ev.body.events.length >= 3);
});
