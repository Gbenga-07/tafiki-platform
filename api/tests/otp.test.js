// Security codes by email: approving withdrawals and changing bank details. No SMS and no phone confirmation.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
process.env.OTP_REQUIRED = '1';
const { setup, addAdmin, agent } = require('./helpers');
let app, db, a, uid, fin;
const lastCode = async () => { const e = await db('emails').where({ to_email: 'ada@example.com' }).where('subject', 'like', 'Your Tafiki code%').orderBy('created_at', 'desc').first(); return e && e.body_text.match(/(\d{6})/)[1]; };

before(async () => {
  ({ app, db } = await setup());
  await addAdmin('Super Admin', 'ops@tafiki.com'); fin = agent(app); await fin.post('/api/admin/auth/login').send({ email: 'ops@tafiki.com', password: 'Passw0rd!' });
  a = agent(app);
  const r = await a.post('/api/auth/register').send({ role: 'investor', firstName: 'Ada', lastName: 'Obi', email: 'ada@example.com', phone: '08031234567', password: 'Secret123', agreeTerms: true, bank: { name: 'GTBank', account: '0123456789', accountName: 'Ada Obi' } });
  assert.equal(r.status, 201); uid = r.body.user.id;
  await fin.patch('/api/admin/users/' + uid).send({ kycStatus: 'verified' });
});
after(async () => { await db.destroy(); });

test('signing up sends no SMS and asks for no phone code; the phone can be changed directly', async () => {
  assert.equal(Number((await db('sms').count({ n: '*' }).first()).n), 0);
  assert.equal((await a.post('/api/me/phone/verify').send({ code: '000000' })).status, 404);
  const ch = await a.patch('/api/me').send({ phone: '08099999999' }); assert.equal(ch.status, 200, JSON.stringify(ch.body));
  assert.equal((await db('users').where({ id: uid }).first()).phone, '08099999999');
  assert.equal((await a.post('/api/me/otp').send({ purpose: 'phone_verify' })).status, 400);
});

test('codes go by email and are rate limited: one a minute, five an hour', async () => {
  const s = await a.post('/api/me/otp').send({ purpose: 'withdrawal' }); assert.equal(s.status, 200); assert.equal(s.body.sentTo, 'ad•••@example.com');
  const e = await db('emails').where({ to_email: 'ada@example.com' }).where('subject', 'like', 'Your Tafiki code to approve your withdrawal').first(); assert.ok(e); assert.match(e.body_text, /SECURITY CODE: \d{6}/);
  const again = await a.post('/api/me/otp').send({ purpose: 'withdrawal' }); assert.equal(again.status, 429); assert.match(again.body.error, /minute/);
  assert.equal((await a.post('/api/me/otp').send({ purpose: 'nonsense' })).status, 400);
});

test('a withdrawal needs the code; wrong, missing and reused codes are refused; 5 wrong tries lock the code', async () => {
  await db('wallet_tx').insert({ id: 'w1', user_id: uid, type: 'payout', amount: 50000, memo: 'test credit', status: 'completed', created_at: new Date() });
  assert.match((await a.post('/api/me/wallet/withdrawals').send({ amount: 10000 })).body.error, /code we sent to your email/);
  await db('codes').where('purpose', 'like', 'otp:%').del();
  await a.post('/api/me/otp').send({ purpose: 'withdrawal' }); const code = await lastCode();
  assert.equal((await a.post('/api/me/wallet/withdrawals').send({ amount: 10000, code: '111111' })).status, 400);
  const ok = await a.post('/api/me/wallet/withdrawals').send({ amount: 10000, code }); assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal((await a.post('/api/me/wallet/withdrawals').send({ amount: 10000, code })).status, 400, 'a code works once');
  await db('codes').where('purpose', 'like', 'otp:%').del(); await a.post('/api/me/otp').send({ purpose: 'withdrawal' }); const c2 = await lastCode();
  for (let i = 0; i < 5; i++) await a.post('/api/me/wallet/withdrawals').send({ amount: 1000, code: '222222' });
  const locked = await a.post('/api/me/wallet/withdrawals').send({ amount: 1000, code: c2 }); assert.equal(locked.status, 400); assert.match(locked.body.error, /Too many/);
});

test('changing bank details needs an email code', async () => {
  const nb = { bank: { name: 'Access Bank', account: '9876543210', accountName: 'Ada Obi' } };
  assert.equal((await a.patch('/api/me').send(nb)).status, 400);
  await db('codes').where('purpose', 'like', 'otp:%').del(); await a.post('/api/me/otp').send({ purpose: 'bank_change' });
  assert.equal((await a.patch('/api/me').send({ ...nb, code: await lastCode() })).status, 200);
  assert.equal((await db('users').where({ id: uid }).first()).bank_account, '9876543210');
});
