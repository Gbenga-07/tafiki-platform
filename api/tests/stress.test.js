// Stress and abuse tests. Concurrency tests are meaningful on MySQL/MariaDB (npm run test:mysql).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
process.env.PAYSTACK_SECRET_KEY = 'sk_test_x';
const { setup, addAdmin, agent } = require('./helpers');
const paystack = require('../src/lib/paystack');
const units = require('../src/lib/units');
const ops = require('../src/lib/ops');
const isMy = process.env.TEST_DB === 'mysql';
let app, db, sup, fin, logi, aud, storeA, storeIdA, storeB;
const paid = {};
paystack.setFetch(async (url, opts) => {
  if (url.includes('/initialize')) { const b = JSON.parse(opts.body); return { ok: true, json: async () => ({ status: true, data: { authorization_url: 'https://checkout.paystack.com/x', access_code: 'a' } }) }; }
  const ref = decodeURIComponent(url.split('/').pop()); return { ok: true, json: async () => ({ status: true, data: { status: paid[ref] ? 'success' : 'abandoned', amount: paid[ref] || 0, currency: 'NGN', channel: 'card' } }) };
});
const mkInvestor = async (i, verified = true) => {
  const a = agent(app); const r = await a.post('/api/auth/register').send({ role: 'investor', firstName: 'Inv', lastName: 'Number' + i, email: `inv${i}@example.com`, phone: '0803000' + String(1000 + i), password: 'Secret123', agreeTerms: true, bank: { name: 'GTBank', account: '0123456789', accountName: 'Inv ' + i } });
  if (verified) await db('users').where({ id: r.body.user.id }).update({ kyc_status: 'verified' });
  return { a, id: r.body.user.id };
};
before(async () => {
  ({ app, db } = await setup());
  for (const [r, e] of [['Super Admin', 'ops'], ['Finance Officer', 'fin'], ['Logistics Officer', 'logi'], ['Auditor', 'aud']]) await addAdmin(r, e + '@tafiki.com');
  sup = agent(app); await sup.post('/api/admin/auth/login').send({ email: 'ops@tafiki.com', password: 'Passw0rd!' });
  fin = agent(app); await fin.post('/api/admin/auth/login').send({ email: 'fin@tafiki.com', password: 'Passw0rd!' });
  logi = agent(app); await logi.post('/api/admin/auth/login').send({ email: 'logi@tafiki.com', password: 'Passw0rd!' });
  aud = agent(app); await aud.post('/api/admin/auth/login').send({ email: 'aud@tafiki.com', password: 'Passw0rd!' });
  storeA = agent(app); storeIdA = (await storeA.post('/api/auth/register').send({ role: 'retailer', firstName: 'Store', lastName: 'Alpha', email: 'a@store.com', phone: '08030009001', password: 'Secret123', shop: 'FOODCORE Alpha', area: 'Alpha', agreeTerms: true })).body.user.id;
  storeB = agent(app); await storeB.post('/api/auth/register').send({ role: 'retailer', firstName: 'Store', lastName: 'Beta', email: 'b@store.com', phone: '08030009002', password: 'Secret123', shop: 'FOODCORE Beta', area: 'Beta', agreeTerms: true });
});
after(async () => { await db.destroy(); });

test('40 people reserve at the same moment: units are never oversold', async () => {
  const p = (await sup.post('/api/admin/packages').send({ name: 'FOODCORE Alpha', area: 'Alpha market', city: 'Ibadan', unitsTotal: 10 })).body.package;
  const people = []; for (let i = 0; i < 40; i++) people.push(await mkInvestor(i));
  const res = await Promise.all(people.map((x, i) => x.a.post('/api/holdings').send({ packageId: p.id, units: 1, signedName: 'Inv Number' + i, agree: true })));
  const ok = res.filter((r) => r.status === 201).length; const errs = res.filter((r) => r.status >= 500).length;
  assert.equal(errs, 0, 'no server errors'); assert.equal(ok, 10, `exactly 10 reserved (got ${ok})`);
  assert.equal((await agent(app).get('/api/packages/' + p.id)).body.package.unitsOpen, 0);
  global.__pkg = p; global.__people = people; global.__winners = res.map((r, i) => (r.status === 201 ? { ...people[i], h: r.body.holding, i } : null)).filter(Boolean);
});

test('the same Paystack payment reported 10 times at once is applied once', async () => {
  const w = global.__winners[0];
  const pay = await w.a.post('/api/holdings/' + w.h.id + '/pay').send({ method: 'card' }); paid[pay.body.reference] = 200000000;
  const body = JSON.stringify({ event: 'charge.success', data: { reference: pay.body.reference } }); const sig = crypto.createHmac('sha512', 'sk_test_x').update(body).digest('hex');
  await Promise.all([...Array(6)].map(() => agent(app).raw.post('/webhooks/paystack').set('Content-Type', 'application/json').set('x-paystack-signature', sig).send(body)).concat([...Array(4)].map(() => w.a.get('/api/holdings/payments/' + pay.body.reference + '/verify'))));
  await new Promise((r) => setTimeout(r, 800));
  const h = await db('holdings').where({ id: w.h.id }).first(); assert.equal(h.status, 'reserved'); assert.match(h.cert_no, /^FC-C-/);
  const certs = await db('holdings').whereNotNull('cert_no'); assert.equal(certs.length, 1, 'one certificate');
  const mails = await db('emails').where({ ref: h.ref }).where('subject', 'like', 'Payment received%'); assert.equal(mails.length, 1, 'one payment email');
});

test('a payment that lands after the reservation expired is not lost', async () => {
  const w = global.__winners[1];
  const pay = await w.a.post('/api/holdings/' + w.h.id + '/pay').send({ method: 'card' });
  await db('holdings').where({ id: w.h.id }).update({ reserved_until: new Date(Date.now() - 1000) });
  await units.expireReservations(); // a checkout was just started, so the reservation must be kept
  assert.equal((await db('holdings').where({ id: w.h.id }).first()).status, 'unpaid');
  paid[pay.body.reference] = 200000000;
  await w.a.get('/api/holdings/payments/' + pay.body.reference + '/verify');
  assert.equal((await db('holdings').where({ id: w.h.id }).first()).status, 'reserved');
});

test('confirming the same bank transfer twice at once applies it once', async () => {
  const w = global.__winners[2];
  await w.a.post('/api/holdings/' + w.h.id + '/pay').send({ method: 'transfer' }); await w.a.post('/api/holdings/' + w.h.id + '/transfer-sent');
  const pay = await db('payments').where({ holding_id: w.h.id }).first();
  const rs = await Promise.all([...Array(5)].map(() => fin.post('/api/admin/payments/' + pay.id + '/confirm')));
  assert.equal(rs.filter((r) => r.status >= 500).length, 0);
  assert.equal((await db('emails').where({ ref: w.h.ref }).where('subject', 'like', 'Payment received%')).length, 1);
});

test('fill the package; opening it twice at once creates one set of deliveries', async () => {
  for (const w of global.__winners.slice(3)) { await w.a.post('/api/holdings/' + w.h.id + '/pay').send({ method: 'transfer' }); await w.a.post('/api/holdings/' + w.h.id + '/transfer-sent'); const pay = await db('payments').where({ holding_id: w.h.id }).first(); await fin.post('/api/admin/payments/' + pay.id + '/confirm'); }
  assert.equal((await db('packages').where({ id: global.__pkg.id }).first()).stage, 'full');
  const rs = await Promise.all([...Array(4)].map(() => sup.post('/api/admin/packages/' + global.__pkg.id + '/open').send({})));
  assert.equal(rs.filter((r) => r.status === 200).length, 1); assert.equal(rs.filter((r) => r.status >= 500).length, 0);
  assert.equal((await db('deliveries').where({ package_id: global.__pkg.id, kind: 'stake' })).length, 10);
});

test('a delivery code entered 5 times at once completes the delivery once', async () => {
  const d = await db('deliveries').where({ package_id: global.__pkg.id }).first();
  await logi.post('/api/admin/deliveries/' + d.id + '/advance'); await logi.post('/api/admin/deliveries/' + d.id + '/advance');
  const code = (await storeA.get('/api/store/deliveries/' + d.id)).body.delivery.deliveryCode; const token = d.driver_token;
  const rs = await Promise.all([...Array(5)].map(() => agent(app).post('/api/driver/' + token + '/complete').send({ code })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1); assert.equal(rs.filter((r) => r.status >= 500).length, 0);
  assert.equal((await db('delivery_log').where({ delivery_id: d.id, stage: 3 })).length, 1);
  assert.equal((await db('store_cycles').where({ store_user_id: storeIdA })).length, 1);
});

test('wallet: 10 withdrawals at once can never take more than the balance', async () => {
  const w = global.__winners[0];
  await db('wallet_tx').insert({ id: crypto.randomUUID(), user_id: w.id, type: 'adjustment', amount: 50000, status: 'completed', memo: 'test credit', created_at: new Date() });
  const rs = await Promise.all([...Array(10)].map(() => w.a.post('/api/me/wallet/withdrawals').send({ amount: 20000 })));
  assert.equal(rs.filter((r) => r.status >= 500).length, 0); assert.equal(rs.filter((r) => r.status === 201).length, 2, 'only 2 × ₦20,000 fit in ₦50,000');
  assert.equal((await w.a.get('/api/me/wallet')).body.balance, 10000);
  const wd = (await db('withdrawals').where({ user_id: w.id }))[0];
  const ds = await Promise.all([fin.post('/api/admin/withdrawals/' + wd.id + '/pay').send({ transferReference: 'A' }), fin.post('/api/admin/withdrawals/' + wd.id + '/reject').send({ reason: 'x' }), fin.post('/api/admin/withdrawals/' + wd.id + '/pay').send({ transferReference: 'B' })]);
  assert.equal(ds.filter((r) => r.status === 200).length, 1);
  const rejected = ds[1].status === 200; // if the rejection won, the ₦20,000 goes back to the wallet
  assert.equal((await w.a.get('/api/me/wallet')).body.balance, rejected ? 30000 : 10000);
});

test('payout run clicked 3 times at once pays once', async () => {
  await db('packages').where({ id: global.__pkg.id }).update({ opened_at: new Date(Date.now() - 91 * 864e5) });
  const before = Number((await db('wallet_tx').where({ type: 'payout' }).sum({ s: 'amount' }).first()).s) || 0;
  const rs = await Promise.all([...Array(3)].map(() => fin.post('/api/admin/payouts/' + global.__pkg.id).send({ profit: 12000000 })));
  assert.equal(rs.filter((r) => r.status === 201).length, 1); assert.equal(rs.filter((r) => r.status >= 500).length, 0);
  const after = Number((await db('wallet_tx').where({ type: 'payout' }).sum({ s: 'amount' }).first()).s); assert.equal(after - before, 10 * 166667);
});

test('remittance confirmed twice at once and reconcile twice at once', async () => {
  await db('store_cycles').where({ store_user_id: storeIdA }).update({ audit_at: new Date(Date.now() - 1000), restock_at: new Date(Date.now() + 864e5) });
  await aud.post('/api/admin/stores/' + storeIdA + '/audit').send({ auditedValue: 100000 });
  const rm = (await storeA.post('/api/store/remittances').send({ amount: 100000 })).body.remittance;
  const rs = await Promise.all([...Array(4)].map(() => aud.post('/api/admin/remittances/' + rm.id + '/confirm')));
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
  const rc = await Promise.all([...Array(4)].map(() => aud.post('/api/admin/stores/' + storeIdA + '/reconcile')));
  assert.equal(rc.filter((r) => r.status === 200).length, 1); assert.equal(rc.filter((r) => r.status >= 500).length, 0);
});

test('redemption requested 5 times at once creates one request', async () => {
  const w = global.__winners[3];
  await db('holdings').where({ id: w.h.id }).update({ active_since: new Date(Date.now() - 400 * 864e5) });
  const rs = await Promise.all([...Array(5)].map(() => w.a.post('/api/me/holdings/' + w.h.id + '/redeem')));
  assert.equal(rs.filter((r) => r.status === 201).length, 1); assert.equal((await db('redemptions').where({ holding_id: w.h.id })).length, 1);
});

test('nobody can see or change someone else’s data', async () => {
  const a = global.__winners[4], b = global.__winners[5];
  assert.equal((await b.a.get('/api/holdings/' + a.h.id)).status, 404);
  assert.equal((await b.a.post('/api/holdings/' + a.h.id + '/pay').send({ method: 'card' })).status, 404);
  assert.equal((await b.a.delete('/api/holdings/' + a.h.id)).status, 404);
  assert.equal((await b.a.post('/api/me/holdings/' + a.h.id + '/redeem')).status, 404);
  const d = await db('deliveries').where({ store_user_id: storeIdA }).first();
  assert.equal((await storeB.get('/api/store/deliveries/' + d.id)).status, 404);
  assert.equal((await a.a.get('/api/store/account')).status, 403);
  assert.equal((await storeA.post('/api/holdings').send({ packageId: global.__pkg.id, units: 1, signedName: 'Store Alpha', agree: true })).status, 403);
  for (const path of ['/api/admin/users', '/api/admin/deliveries', '/api/admin/payouts', '/api/admin/analytics', '/api/admin/kyc']) assert.equal((await a.a.get(path)).status, 401, path);
  assert.equal((await logi.post('/api/admin/payouts/' + global.__pkg.id).send({ profit: 1 })).status, 403);
  assert.equal((await logi.post('/api/admin/admins').send({ name: 'Bad Actor', email: 'x@x.com', role: 'Super Admin' })).status, 403);
  assert.equal((await fin.put('/api/admin/settings/terms').send({ terms: { unitPrice: 1 } })).status, 403);
});

test('hostile and broken input is rejected cleanly', async () => {
  const w = global.__people[30];
  const cases = [
    w.a.post('/api/holdings').send({ packageId: global.__pkg.id, units: -5, signedName: 'Inv Number30', agree: true }),
    w.a.post('/api/holdings').send({ packageId: "' OR 1=1 --", units: 1, signedName: 'Inv Number30', agree: true }),
    w.a.post('/api/me/wallet/withdrawals').send({ amount: 'lots' }),
    w.a.post('/api/me/wallet/withdrawals').send({ amount: -100 }),
    agent(app).post('/api/auth/login').send({ email: { $gt: '' }, password: { $gt: '' } }),
    agent(app).post('/api/auth/register').send({ role: 'admin', firstName: 'X', lastName: 'Y', email: 'z@z.com', phone: '0803', password: 'Secret123', agreeTerms: true }),
    agent(app).post('/api/auth/register').send({ role: 'investor', firstName: '<script>alert(1)</script>', lastName: 'Y', email: 'xss@z.com', phone: '08030000000', password: 'Secret123', agreeTerms: true }),
    agent(app).raw.post('/api/auth/login').set('X-Tafiki-Client', '1').set('Content-Type', 'application/json').send('{bad json'),
    sup.get("/api/admin/users?q=%27%3B%20DROP%20TABLE%20users%3B--"),
    agent(app).get('/api/driver/not-a-real-token'),
    agent(app).get('/api/certificates/FC-C-0000/verify?code=x'),
  ];
  const rs = await Promise.all(cases);
  rs.forEach((r, i) => assert.ok(r.status < 500, `case ${i} gave ${r.status}`));
  assert.equal(rs[5].status, 400);
  assert.ok((await db('users').count({ n: '*' }).first()).n > 0, 'users table still there');
  const x = await db('emails').where({ to_email: 'xss@z.com' }).first(); assert.ok(!x.body_html.includes('<script>'), 'names are escaped in emails');
});

test('load: 300 mixed requests at once with no errors', async () => {
  const w = global.__winners[6]; const t0 = Date.now();
  const reqs = []; for (let i = 0; i < 100; i++) reqs.push(agent(app).get('/api/packages'), w.a.get('/api/holdings'), sup.get('/api/admin/deliveries'));
  const rs = await Promise.all(reqs); const ms = Date.now() - t0;
  assert.equal(rs.filter((r) => r.status !== 200).length, 0, 'all 200'); console.log(`# 300 requests in ${ms} ms`);
});

test('a late payment for units that were taken by someone else is flagged for refund', async () => {
  const p = (await sup.post('/api/admin/packages').send({ name: 'FOODCORE Late', area: 'Late', city: 'Ibadan', unitsTotal: 1 })).body.package;
  const x = global.__people[35], y = global.__people[36];
  const hx = (await x.a.post('/api/holdings').send({ packageId: p.id, units: 1, signedName: 'Inv Number35', agree: true })).body.holding;
  const pay = await x.a.post('/api/holdings/' + hx.id + '/pay').send({ method: 'card' });
  await db('payments').where({ reference: pay.body.reference }).update({ created_at: new Date(Date.now() - 2 * 3600e3) });
  await db('holdings').where({ id: hx.id }).update({ reserved_until: new Date(Date.now() - 1000) });
  await units.expireReservations();
  assert.equal((await y.a.post('/api/holdings').send({ packageId: p.id, units: 1, signedName: 'Inv Number36', agree: true })).status, 201);
  paid[pay.body.reference] = 200000000;
  await x.a.get('/api/holdings/payments/' + pay.body.reference + '/verify');
  assert.equal((await db('payments').where({ reference: pay.body.reference }).first()).status, 'refund_due');
  assert.match((await db('emails').where({ to_email: 'fin@tafiki.com' }).orderBy('created_at', 'desc').first()).subject, /Refund needed/);
});
