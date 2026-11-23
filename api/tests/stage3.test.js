const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, addAdmin, agent, lastEmail } = require('./helpers');
const ops = require('../src/lib/ops');
const sms = require('../src/lib/sms');
let app, db, sup, logi, aud, inv, store, storeId, delivery;
const sent = [];
before(async () => {
  ({ app, db } = await setup());
  process.env.TERMII_API_KEY = 'tk_test'; process.env.TERMII_SENDER_ID = 'Tafiki';
  sms.setFetch(async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ message_id: 'm' + sent.length, message: 'Successfully Sent' }) }; });
  await addAdmin('Super Admin', 'ops@tafiki.com'); await addAdmin('Logistics Officer', 'logi@tafiki.com'); await addAdmin('Auditor', 'aud@tafiki.com');
  sup = agent(app); await sup.post('/api/admin/auth/login').send({ email: 'ops@tafiki.com', password: 'Passw0rd!' });
  logi = agent(app); await logi.post('/api/admin/auth/login').send({ email: 'logi@tafiki.com', password: 'Passw0rd!' });
  aud = agent(app); await aud.post('/api/admin/auth/login').send({ email: 'aud@tafiki.com', password: 'Passw0rd!' });
  inv = agent(app); await inv.post('/api/auth/register').send({ role: 'investor', firstName: 'Ada', lastName: 'Okafor', email: 'ada@example.com', phone: '08030001100', password: 'Secret123', agreeTerms: true });
  store = agent(app); const s = await store.post('/api/auth/register').send({ role: 'retailer', firstName: 'Kemi', lastName: 'Alade', email: 'kemi@example.com', phone: '08030001101', password: 'Secret123', shop: 'FOODCORE Bodija', area: 'Bodija, Ibadan', agreeTerms: true });
  storeId = s.body.user.id;
  const ada = (await sup.get('/api/admin/users?role=investor')).body.users[0]; await sup.patch('/api/admin/users/' + ada.id).send({ kycStatus: 'verified' });
  const p = await sup.post('/api/admin/packages').send({ name: 'FOODCORE Bodija', area: 'Bodija Market', city: 'Ibadan', unitsTotal: 2 });
  const h = await inv.post('/api/holdings').send({ packageId: p.body.package.id, units: 2, signedName: 'Ada Okafor', agree: true });
  await inv.post('/api/holdings/' + h.body.holding.id + '/pay').send({ method: 'transfer' }); await inv.post('/api/holdings/' + h.body.holding.id + '/transfer-sent');
  const pay = (await sup.get('/api/admin/payments?status=pending_review')).body.payments[0]; await sup.post('/api/admin/payments/' + pay.id + '/confirm');
  const o = await sup.post('/api/admin/packages/' + p.body.package.id + '/open').send({}); assert.equal(o.status, 200, JSON.stringify(o.body)); assert.deepEqual(o.body.deliveries.length, 1);
});
after(async () => { await db.destroy(); });

test('opening a package creates the stake delivery with stock for each unit', async () => {
  const list = (await logi.get('/api/admin/deliveries')).body.deliveries; assert.equal(list.length, 1); delivery = list[0];
  assert.match(delivery.code, /^SO-\d+$/); assert.equal(delivery.value, 4000000); assert.equal(delivery.stageName, 'Order Received');
  const full = (await logi.get('/api/admin/deliveries/' + delivery.id)).body.delivery; assert.equal(full.lines.find((l) => l.sku === 'garri-5').qty, 1000);
});

test('stages move automatically; In Transit texts the delivery code by Termii (masked in our log)', async () => {
  await db('delivery_log').where({ delivery_id: delivery.id }).update({ at: new Date(Date.now() - 7 * 3600e3) });
  assert.equal(await ops.autoAdvance(), 1);
  await db('delivery_log').where({ delivery_id: delivery.id }).update({ at: new Date(Date.now() - 7 * 3600e3) });
  assert.equal(await ops.autoAdvance(), 1);
  assert.equal(await ops.autoAdvance(), 0); // last step needs the code
  const s = sent.find((x) => x.body.sms.includes('delivery code')); assert.ok(s); assert.equal(s.body.to, '2348030001101'); assert.equal(s.body.channel, 'dnd'); assert.match(s.body.sms, /\d{6}/);
  const logged = await db('sms').where({ category: 'delivery_code' }).first(); assert.ok(logged.body.includes('••••••')); assert.ok(!/\d{6}/.test(logged.body)); assert.equal(logged.status, 'sent');
});

test('store sees its code; driver link completes only with the right code', async () => {
  const sd = (await store.get('/api/store/deliveries/' + delivery.id)).body.delivery; assert.match(sd.deliveryCode, /^\d{6}$/);
  const full = (await logi.get('/api/admin/deliveries/' + delivery.id)).body.delivery; const token = full.driverLink.split('t=')[1];
  const info = await agent(app).get('/api/driver/' + token); assert.equal(info.body.delivery.store, 'FOODCORE Bodija'); assert.equal(info.body.delivery.code, delivery.code);
  global.__token = token;
  assert.equal((await agent(app).post('/api/driver/' + token + '/complete').send({ code: '000000' === sd.deliveryCode ? '111111' : '000000' })).status, 400);
  const ok = await agent(app).post('/api/driver/' + token + '/complete').send({ code: sd.deliveryCode }); assert.equal(ok.status, 200);
  assert.equal((await store.get('/api/store/deliveries/' + delivery.id)).body.delivery.deliveryCode, undefined);
  assert.equal((await agent(app).get('/api/driver/' + token)).body.delivery.store, undefined);
  const acc = (await store.get('/api/store/account')).body.account; assert.equal(acc.stockReceived, 4000000); assert.equal(acc.onShelf, 4000000); assert.equal(acc.cycle.k, 1);
  assert.match((await lastEmail('ada@example.com')).subject, /Delivered/);
});

test('day-28 audit, remittance, reconciliation, then restock', async () => {
  await store.post('/api/store/sales').send({ amount: 1500000, note: 'Week sales' });
  assert.equal((await logi.post('/api/admin/stores/' + storeId + '/audit').send({ auditedValue: 1500000 })).status, 403);
  assert.equal((await aud.post('/api/admin/stores/' + storeId + '/audit').send({ auditedValue: 1600000 })).status, 400); // before day 28
  await db('store_cycles').where({ store_user_id: storeId, k: 1 }).update({ audit_at: new Date(Date.now() - 1000) });
  assert.equal((await aud.post('/api/admin/stores/' + storeId + '/audit').send({ auditedValue: 9000000 })).status, 400);
  assert.equal((await aud.post('/api/admin/stores/' + storeId + '/audit').send({ auditedValue: 1600000 })).status, 200);
  let acc = (await store.get('/api/store/account')).body.account; assert.equal(acc.remittanceDue, 1600000); assert.equal(acc.onShelf, 2400000);
  assert.equal((await aud.post('/api/admin/stores/' + storeId + '/reconcile')).status, 400);
  assert.equal((await store.post('/api/store/remittances').send({ amount: 1700000 })).status, 400);
  const rm = await store.post('/api/store/remittances').send({ amount: 1600000, bankReference: 'GTB-123' });
  assert.equal((await store.post('/api/store/remittances').send({ amount: 100 })).status, 400); assert.match(rm.body.remittance.ref, /^RM-0001$/);
  assert.equal((await aud.post('/api/admin/remittances/' + rm.body.remittance.id + '/confirm')).status, 200);
  acc = (await store.get('/api/store/account')).body.account; assert.equal(acc.remittanceDue, 0);
  await db('store_cycles').where({ store_user_id: storeId, k: 1 }).update({ restock_at: new Date(Date.now() - 1000) });
  assert.equal((await aud.post('/api/admin/stores/' + storeId + '/reconcile')).status, 200);
  const ds = (await logi.get('/api/admin/deliveries?kind=restock')).body.deliveries; assert.equal(ds.length, 1); assert.match(ds[0].code, /-R1$/);
  assert.equal(ds[0].value, 1600000); // replaces exactly what was sold
  // restock delivered with an override starts cycle 2
  assert.equal((await logi.post('/api/admin/deliveries/' + ds[0].id + '/override').send({ reason: 'short' })).status, 400);
  assert.equal((await logi.post('/api/admin/deliveries/' + ds[0].id + '/override').send({ reason: 'Driver phone lost; store manager confirmed by call' })).status, 200);
  const cycles = (await store.get('/api/store/cycles')).body.cycles; assert.equal(cycles[0].k, 2);
  acc = (await store.get('/api/store/account')).body.account; assert.equal(acc.stockReceived, 5600000); assert.equal(acc.onShelf, 4000000); // back to the original level
});

test('manual store order and wrong-code lock', async () => {
  const o = await logi.post('/api/admin/deliveries').send({ storeUserId: storeId, items: [{ sku: 'garri-5', qty: 50 }] }); assert.equal(o.status, 201); assert.match(o.body.delivery.code, /^TR-\d+$/);
  await logi.post('/api/admin/deliveries/' + o.body.delivery.id + '/advance'); await logi.post('/api/admin/deliveries/' + o.body.delivery.id + '/advance');
  for (let i = 0; i < 5; i++) await logi.post('/api/admin/deliveries/' + o.body.delivery.id + '/complete').send({ code: 'xx' });
  assert.equal((await logi.post('/api/admin/deliveries/' + o.body.delivery.id + '/complete').send({ code: 'xx' })).status, 423);
  assert.match((await lastEmail('logi@tafiki.com')).subject, /locked/);
  assert.equal((await logi.post('/api/admin/deliveries/' + o.body.delivery.id + '/reissue-code')).status, 200);
  const code = (await store.get('/api/store/deliveries/' + o.body.delivery.id)).body.delivery.deliveryCode;
  assert.equal((await logi.post('/api/admin/deliveries/' + o.body.delivery.id + '/complete').send({ code })).status, 200);
});

test('nothing sold means no restock, and the next cycle starts', async () => {
  const c2 = await db('store_cycles').where({ store_user_id: storeId, k: 2 }).first();
  await db('store_cycles').where({ id: c2.id }).update({ audit_at: new Date(Date.now() - 1000) });
  assert.equal((await aud.post('/api/admin/stores/' + storeId + '/audit').send({ auditedValue: 0 })).status, 200);
  await db('store_cycles').where({ id: c2.id }).update({ restock_at: new Date(Date.now() - 1000) });
  assert.equal((await aud.post('/api/admin/stores/' + storeId + '/reconcile')).status, 200);
  assert.equal((await logi.get('/api/admin/deliveries?kind=restock')).body.deliveries.length, 1);
  assert.equal((await store.get('/api/store/cycles')).body.cycles[0].k, 3);
});

test('audit reminder emails at day 28', async () => {
  await db('store_cycles').where({ store_user_id: storeId, k: 3 }).update({ audit_at: new Date(Date.now() - 1000) });
  assert.equal(await ops.auditReminders(), 1); assert.match((await lastEmail('aud@tafiki.com')).subject, /audit due/i);
  assert.equal(await ops.auditReminders(), 0);
});
