// SMS codes through Termii: confirming a phone, approving withdrawals, changing bank details and phone number.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
process.env.OTP_REQUIRED = '1';
process.env.TERMII_API_KEY = 'termii_test_key';
const { setup, addAdmin, agent } = require('./helpers');
const sms = require('../src/lib/sms');
const texts = []; sms.setFetch(async (url, o) => { texts.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ message_id: 'm' + texts.length }) }; });
const lastCode = (to) => { const t = [...texts].reverse().find((x) => !to || x.to === to); return t && t.sms.match(/(\d{6})/)[1]; };
let app, db, a, uid, fin;

before(async () => {
  ({ app, db } = await setup());
  await addAdmin('Super Admin', 'ops@tafiki.com'); fin = agent(app); await fin.post('/api/admin/auth/login').send({ email: 'ops@tafiki.com', password: 'Passw0rd!' });
  a = agent(app);
  const r = await a.post('/api/auth/register').send({ role: 'investor', firstName: 'Ada', lastName: 'Obi', email: 'ada@example.com', phone: '08031234567', password: 'Secret123', agreeTerms: true, bank: { name: 'GTBank', account: '0123456789', accountName: 'Ada Obi' } });
  assert.equal(r.status, 201); uid = r.body.user.id;
  await fin.patch('/api/admin/users/' + uid).send({ kycStatus: 'verified' });
});
after(async () => { await db.destroy(); });

test('signing up texts a code to the phone; the code confirms it; the code is masked in the SMS log', async () => {
  const t = texts.find((x) => x.to === '2348031234567'); assert.ok(t, 'code SMS sent'); assert.match(t.sms, /confirm your phone number is \d{6}/); assert.equal(t.channel, 'dnd');
  const row = await db('sms').where({ category: 'otp' }).first(); assert.ok(!/\d{6}/.test(row.body), 'stored masked');
  assert.equal((await a.get('/api/me')).body.user.phoneVerified, false);
  assert.equal((await a.post('/api/me/phone/verify').send({ code: '000000' })).status, 400);
  const ok = await a.post('/api/me/phone/verify').send({ code: lastCode('2348031234567') }); assert.equal(ok.status, 200); assert.equal(ok.body.user.phoneVerified, true);
});

test('codes are rate limited: one a minute, five an hour', async () => {
  await db('codes').where('purpose', 'like', 'otp:%').del();
  assert.equal((await a.post('/api/me/otp').send({ purpose: 'withdrawal' })).status, 200);
  const again = await a.post('/api/me/otp').send({ purpose: 'withdrawal' }); assert.equal(again.status, 429); assert.match(again.body.error, /minute/);
  assert.equal((await a.post('/api/me/otp').send({ purpose: 'nonsense' })).status, 400);
});

test('a withdrawal needs the code; wrong, missing and reused codes are refused; 5 wrong tries lock the code', async () => {
  await db('wallet_tx').insert({ id: 'w1', user_id: uid, type: 'payout', amount: 50000, memo: 'test credit', status: 'completed', created_at: new Date() });
  assert.match((await a.post('/api/me/wallet/withdrawals').send({ amount: 10000 })).body.error, /6-digit code/);
  await db('codes').where('purpose', 'like', 'otp:%').del();
  const s = await a.post('/api/me/otp').send({ purpose: 'withdrawal' }); assert.equal(s.body.sentTo, '•••• 4567');
  const code = lastCode();
  assert.equal((await a.post('/api/me/wallet/withdrawals').send({ amount: 10000, code: '111111' })).status, 400);
  const ok = await a.post('/api/me/wallet/withdrawals').send({ amount: 10000, code }); assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal((await a.post('/api/me/wallet/withdrawals').send({ amount: 10000, code })).status, 400, 'a code works once');
  await db('codes').where('purpose', 'like', 'otp:%').del(); await a.post('/api/me/otp').send({ purpose: 'withdrawal' }); const c2 = lastCode();
  for (let i = 0; i < 5; i++) await a.post('/api/me/wallet/withdrawals').send({ amount: 1000, code: '222222' });
  const locked = await a.post('/api/me/wallet/withdrawals').send({ amount: 1000, code: c2 }); assert.equal(locked.status, 400); assert.match(locked.body.error, /Too many/);
});

test('changing bank details needs a code; changing the phone needs a code sent to the new number', async () => {
  const nb = { bank: { name: 'Access Bank', account: '9876543210', accountName: 'Ada Obi' } };
  assert.equal((await a.patch('/api/me').send(nb)).status, 400);
  await db('codes').where('purpose', 'like', 'otp:%').del(); await a.post('/api/me/otp').send({ purpose: 'bank_change' });
  assert.equal((await a.patch('/api/me').send({ ...nb, code: lastCode() })).status, 200);
  assert.equal((await db('users').where({ id: uid }).first()).bank_account, '9876543210');
  assert.equal((await a.patch('/api/me').send({ phone: '08099999999' })).status, 400);
  await a.post('/api/me/otp').send({ purpose: 'phone_change', phone: '08099999999' });
  assert.ok(texts[texts.length - 1].to === '2348099999999', 'sent to the new number');
  const ch = await a.post('/api/me/phone/change').send({ code: lastCode('2348099999999') }); assert.equal(ch.status, 200); assert.equal(ch.body.user.phone, '08099999999'); assert.equal(ch.body.user.phoneVerified, true);
});

test('without a Termii key (test mode) nothing is sent and the console SMS log shows the code', async () => {
  delete process.env.TERMII_API_KEY; const n = texts.length;
  await db('codes').where('purpose', 'like', 'otp:%').del(); await a.post('/api/me/otp').send({ purpose: 'withdrawal' });
  assert.equal(texts.length, n);
  const row = await db('sms').where({ category: 'otp', status: 'logged' }).orderBy('created_at', 'desc').first(); assert.match(row.body, /\d{6}/);
  process.env.TERMII_API_KEY = 'termii_test_key';
});
