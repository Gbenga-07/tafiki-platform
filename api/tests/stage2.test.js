const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
process.env.PAYSTACK_SECRET_KEY = 'sk_test_x';
const { setup, addAdmin, agent, lastEmail } = require('./helpers');
const paystack = require('../src/lib/paystack');
const units = require('../src/lib/units');
let app, db, sup, inv, packageId;
const store = {}; // fake Paystack
paystack.setFetch(async (url, opts) => {
  if (url.includes('/transaction/initialize')) { const b = JSON.parse(opts.body); store[b.reference] = b; return { ok: true, json: async () => ({ status: true, data: { authorization_url: 'https://checkout.paystack.com/x', access_code: 'ac', reference: b.reference } }) }; }
  const ref = decodeURIComponent(url.split('/').pop()); const b = store[ref];
  return { ok: true, json: async () => ({ status: true, data: { status: b && b.paid ? 'success' : 'abandoned', amount: b ? b.amount : 0, currency: 'NGN', channel: 'card', reference: ref } }) };
});
before(async () => {
  ({ app, db } = await setup());
  await addAdmin('Super Admin', 'ops@tafiki.com'); await addAdmin('Finance Officer', 'fin@tafiki.com'); await addAdmin('Logistics Officer', 'logi@tafiki.com');
  sup = agent(app); await sup.post('/api/admin/auth/login').send({ email: 'ops@tafiki.com', password: 'Passw0rd!' });
  inv = agent(app);
  await inv.post('/api/auth/register').send({ role: 'investor', firstName: 'Ada', lastName: 'Okafor', email: 'ada@example.com', phone: '+2348030001100', password: 'Secret123', agreeTerms: true });
  const s = agent(app); await s.post('/api/auth/register').send({ role: 'retailer', firstName: 'Kemi', lastName: 'Alade', email: 'kemi@example.com', phone: '+2348030001101', password: 'Secret123', shop: 'FOODCORE Test', area: 'Bodija, Ibadan', agreeTerms: true });
});
after(async () => { await db.destroy(); });

test('admin creates a package; terms and unit package are public', async () => {
  const p = await sup.post('/api/admin/packages').send({ name: 'FOODCORE Test', area: 'Bodija Market', city: 'Ibadan', unitsTotal: 3 });
  assert.equal(p.status, 201, JSON.stringify(p.body)); packageId = p.body.package.id;
  const logi = agent(app); await logi.post('/api/admin/auth/login').send({ email: 'logi@tafiki.com', password: 'Passw0rd!' });
  assert.equal((await logi.post('/api/admin/packages').send({ name: 'FOODCORE X', area: 'Area', city: 'Lagos' })).status, 403);
  const t = await agent(app).get('/api/terms'); assert.equal(t.body.terms.unitPrice, 2000000); assert.equal(t.body.unitPackage.value, 2000000);
  const bad = await sup.put('/api/admin/settings/unit-package').send({ items: [{ sku: 'a', name: 'Garri', brand: 'FOODCORE', size: '5 kg', bags: 10, cost: 100 }] }); assert.equal(bad.status, 400);
  const list = await agent(app).get('/api/packages'); assert.equal(list.body.packages[0].unitsOpen, 3);
});

test('reserve requires signature and limits to open units', async () => {
  assert.equal((await inv.post('/api/holdings').send({ packageId, units: 1, signedName: 'Someone Else', agree: true })).status, 400);
  assert.equal((await inv.post('/api/holdings').send({ packageId, units: 4, signedName: 'Ada Okafor', agree: true })).status, 400);
  const r = await inv.post('/api/holdings').send({ packageId, units: 2, signedName: 'ada okafor', agree: true }); assert.equal(r.status, 201); assert.match(r.body.holding.ref, /^FC-\d+$/);
  assert.equal((await agent(app).get('/api/packages')).body.packages[0].unitsOpen, 1);
});

test('card payment through Paystack; units wait for identity check, then certificate', async () => {
  const h = (await inv.get('/api/holdings')).body.holdings[0];
  const pay = await inv.post('/api/holdings/' + h.id + '/pay').send({ method: 'card' }); assert.equal(pay.status, 200); assert.match(pay.body.authorizationUrl, /paystack/);
  assert.equal(store[pay.body.reference].amount, 400000000); // kobo
  let v = await inv.get('/api/holdings/payments/' + pay.body.reference + '/verify'); assert.equal(v.body.payment.status, 'failed');
  // new attempt that succeeds, via webhook
  const pay2 = await inv.post('/api/holdings/' + h.id + '/pay').send({ method: 'card' }); store[pay2.body.reference].paid = true;
  const body = JSON.stringify({ event: 'charge.success', data: { reference: pay2.body.reference } });
  assert.equal((await agent(app).raw.post('/webhooks/paystack').set('Content-Type', 'application/json').set('x-paystack-signature', 'bad').send(body)).status, 401);
  const sig = crypto.createHmac('sha512', 'sk_test_x').update(body).digest('hex');
  assert.equal((await agent(app).raw.post('/webhooks/paystack').set('Content-Type', 'application/json').set('x-paystack-signature', sig).send(body)).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  let hh = (await inv.get('/api/holdings/' + h.id)).body.holding; assert.equal(hh.status, 'confirming'); assert.equal(hh.certificate, null);
  const users = await sup.get('/api/admin/users?role=investor'); const ada = users.body.users.find((u) => u.email === 'ada@example.com');
  await sup.patch('/api/admin/users/' + ada.id).send({ kycStatus: 'verified' });
  hh = (await inv.get('/api/holdings/' + h.id)).body.holding; assert.equal(hh.status, 'reserved'); assert.match(hh.certificate.number, /^FC-C-\d{4}-0001$/);
  const ver = await agent(app).get(`/api/certificates/${hh.certificate.number}/verify?code=${hh.certificate.verificationCode}`); assert.equal(ver.body.valid, true);
  assert.equal((await agent(app).get(`/api/certificates/${hh.certificate.number}/verify?code=WRONG`)).body.valid, false);
});

test('bank transfer confirmed by finance fills the package; package opens to trading', async () => {
  const r = await inv.post('/api/holdings').send({ packageId, units: 1, signedName: 'Ada Okafor', agree: true });
  const pay = await inv.post('/api/holdings/' + r.body.holding.id + '/pay').send({ method: 'transfer' }); assert.ok(pay.body.escrow);
  assert.equal((await inv.post('/api/holdings/' + r.body.holding.id + '/transfer-sent')).status, 200);
  const fin = agent(app); await fin.post('/api/admin/auth/login').send({ email: 'fin@tafiki.com', password: 'Passw0rd!' });
  const pend = (await fin.get('/api/admin/payments?status=pending_review')).body.payments; assert.equal(pend.length, 1);
  assert.equal((await fin.post('/api/admin/payments/' + pend[0].id + '/confirm')).status, 200);
  const pk = (await sup.get('/api/admin/packages')).body.packages[0]; assert.equal(pk.stage, 'full'); assert.equal(pk.unitsConfirmed, 3);
  assert.match((await lastEmail('ops@tafiki.com')).subject, /fully subscribed/);
  assert.equal((await fin.post('/api/admin/packages/' + packageId + '/open').send({})).status, 403);
  const o = await sup.post('/api/admin/packages/' + packageId + '/open').send({}); assert.equal(o.status, 200, JSON.stringify(o.body)); assert.equal(o.body.package.stage, 'trading');
  const hs = (await inv.get('/api/holdings')).body.holdings; assert.ok(hs.every((h) => h.status === 'active'));
});

test('unpaid reservations expire', async () => {
  const p = await sup.post('/api/admin/packages').send({ name: 'FOODCORE Two', area: 'Ojoo', city: 'Ibadan', unitsTotal: 5 });
  const r = await inv.post('/api/holdings').send({ packageId: p.body.package.id, units: 2, signedName: 'Ada Okafor', agree: true });
  await db('holdings').where({ id: r.body.holding.id }).update({ reserved_until: new Date(Date.now() - 1000) });
  assert.equal(await units.expireReservations(), 1);
  assert.equal((await inv.get('/api/holdings/' + r.body.holding.id)).body.holding.status, 'cancelled');
  assert.equal((await agent(app).get('/api/packages/' + p.body.package.id)).body.package.unitsOpen, 5);
});
