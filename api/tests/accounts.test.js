// Account emails: welcome on sign-up, active on email confirmation, suspended / reactivated, closure (by the member or Tafiki).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, addAdmin, agent } = require('./helpers');
let app, db, a, uid, sup;
const mails = (to, like) => db('emails').where({ to_email: to }).where('subject', 'like', like);
before(async () => {
  ({ app, db } = await setup());
  await addAdmin('Super Admin', 'ops@tafiki.com'); sup = agent(app); await sup.post('/api/admin/auth/login').send({ email: 'ops@tafiki.com', password: 'Passw0rd!' });
  a = agent(app);
  const r = await a.post('/api/auth/register').send({ role: 'investor', firstName: 'Bola', lastName: 'Ade', email: 'bola@example.com', phone: '08031112222', password: 'Secret123', agreeTerms: true, bank: { name: 'GTBank', account: '0123456789', accountName: 'Bola Ade' } });
  assert.equal(r.status, 201); uid = r.body.user.id;
});
after(async () => { await db.destroy(); });

test('sign-up sends a welcome email with the account details and membership number', async () => {
  const w = await mails('bola@example.com', 'Welcome to Tafiki%'); assert.equal(w.length, 1);
  const u = await db('users').where({ id: uid }).first();
  assert.match(w[0].body_text, new RegExp('Membership number: ' + u.coop_no)); assert.equal(w[0].category, 'account');
});
test('the confirmation link confirms the email, signs the member in once, and sends "account is active" once', async () => {
  const m = await mails('bola@example.com', 'Confirm your email for Tafiki'); assert.equal(m.length, 1);
  const t = m[0].body_text.match(/#confirm\?t=([\w-]+)/)[1]; assert.ok(t.length > 20); assert.doesNotMatch(m[0].body_text, /CONFIRMATION CODE/);
  const fresh = agent(app); assert.equal((await fresh.get('/api/me')).status, 401);
  const c = await fresh.post('/api/auth/confirm-email').send({ token: t }); assert.equal(c.status, 200, JSON.stringify(c.body)); assert.equal(c.body.user.emailVerified, true);
  assert.equal((await fresh.get('/api/me')).status, 200, 'signed in by the link');
  assert.equal((await agent(app).post('/api/auth/confirm-email').send({ token: t })).status, 400, 'works once');
  assert.equal((await agent(app).post('/api/auth/confirm-email').send({ token: 'nope' })).status, 400);
  assert.equal((await mails('bola@example.com', 'Your Tafiki account is active')).length, 1);
  assert.equal((await a.post('/api/auth/verify-email/resend')).body.alreadyConfirmed, true);
});
test('suspend and reactivate each send an email; a suspended member cannot sign in', async () => {
  assert.equal((await sup.post('/api/admin/users/' + uid + '/status').send({ status: 'suspended', reason: 'Checking a document' })).status, 200);
  const s = await mails('bola@example.com', '%suspended'); assert.equal(s.length, 1); assert.match(s[0].body_text, /Checking a document/);
  assert.match((await agent(app).post('/api/auth/login').send({ email: 'bola@example.com', password: 'Secret123' })).body.error, /suspended/);
  await sup.post('/api/admin/users/' + uid + '/status').send({ status: 'active' });
  assert.equal((await mails('bola@example.com', '%active again')).length, 1);
});
test('closing is refused while money is owed, then closes with a statement email and blocks sign-in', async () => {
  a = agent(app); await a.post('/api/auth/login').send({ email: 'bola@example.com', password: 'Secret123' });
  await db('wallet_tx').insert({ id: 'cl1', user_id: uid, type: 'payout', amount: 5000, status: 'completed', memo: 't', created_at: new Date() });
  const chk = await a.get('/api/me/close'); assert.equal(chk.body.canClose, false); assert.match(chk.body.blockers[0], /wallet/);
  assert.equal((await a.post('/api/me/close').send({ password: 'Secret123' })).status, 400);
  await db('wallet_tx').where({ id: 'cl1' }).del();
  assert.equal((await a.post('/api/me/close').send({ password: 'wrong' })).status, 400);
  assert.equal((await a.post('/api/me/close').send({ password: 'Secret123', reason: 'Moving abroad' })).status, 200);
  const c = await mails('bola@example.com', '%account is closed%'); assert.equal(c.length, 1); assert.match(c[0].body_text, /closure statement/i); assert.ok(c[0].receipt_no);
  assert.equal((await a.get('/api/me')).status, 401, 'signed out everywhere');
  assert.match((await agent(app).post('/api/auth/login').send({ email: 'bola@example.com', password: 'Secret123' })).body.error, /closed/);
});
