// Checkout choices: Flutterwave online, or bank transfer to escrow with units held for 24 hours.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
process.env.MANUAL_TRANSFERS = 'on';
process.env.FLW_SECRET_KEY = 'FLWSECK_TEST-abc123';
process.env.FLW_SECRET_HASH = 'tafiki-hash-123';
const { setup, addAdmin, agent } = require('./helpers');
const flutterwave = require('../src/lib/flutterwave');
const units = require('../src/lib/units');
const txs = {};
flutterwave.setFetch(async (url, opts) => {
  if (url.endsWith('/payments')) { const b = JSON.parse(opts.body); txs[b.tx_ref] = { amount: b.amount, paid: false, options: b.payment_options, redirect: b.redirect_url }; return { ok: true, json: async () => ({ status: 'success', data: { link: 'https://checkout.flutterwave.com/v3/hosted/pay/' + b.tx_ref } }) }; }
  const ref = decodeURIComponent(url.split('tx_ref=')[1]); const t = txs[ref];
  if (!t) return { ok: false, json: async () => ({ status: 'error', message: 'No transaction was found for this id' }) };
  return { ok: true, json: async () => ({ status: 'success', data: { status: t.paid ? 'successful' : 'pending', amount: t.amount, currency: 'NGN', payment_type: 'card', tx_ref: ref } }) };
});
let app, db, fin, a, uid, pkg;
const buy = (n, method) => a.post('/api/holdings').send({ packageId: pkg, units: n, signedName: 'Ada Obi', agree: true, ...(method ? { method } : {}) });
const hook = (body, hash) => agent(app).post('/webhooks/flutterwave').set('verif-hash', hash).send(body);
before(async () => {
  ({ app, db } = await setup({ membershipFee: true }));
  await addAdmin('Super Admin', 'ops@tafiki.com'); fin = agent(app); await fin.post('/api/admin/auth/login').send({ email: 'ops@tafiki.com', password: 'Passw0rd!' });
  pkg = (await fin.post('/api/admin/packages').send({ name: 'FOODCORE Mart Agege', area: 'Agege', city: 'Lagos', unitsTotal: 40 })).body.package.id;
  await fin.put('/api/admin/settings/terms').send({ terms: {}, escrow: { bank: 'Zenith Bank', accountNumber: '1234567890', accountName: 'Tafiki Escrow · FOODCORE Units' } });
  a = agent(app); uid = (await a.post('/api/auth/register').send({ role: 'investor', firstName: 'Ada', lastName: 'Obi', email: 'ada@example.com', phone: '08031234567', password: 'Secret123', agree: true, agreeTerms: true })).body.user.id;
  await fin.patch('/api/admin/users/' + uid).send({ kycStatus: 'verified' });
});
after(async () => { await db.destroy(); });

test('Flutterwave: checkout link for the full amount; a forged webhook is refused; a real one confirms with a receipt PDF', async () => {
  const r = await buy(2, 'flutterwave'); assert.equal(r.status, 201, JSON.stringify(r.body));
  const c = r.body.checkout; assert.equal(c.method, 'flutterwave'); assert.match(c.authorizationUrl, /checkout\.flutterwave\.com/);
  assert.equal(txs[c.reference].amount, 4050000); assert.equal(txs[c.reference].options, 'card,banktransfer,ussd,account'); assert.match(txs[c.reference].redirect, /#pay-result\?ref=/);
  const h = await db('holdings').where({ id: r.body.holding.id }).first(); const mins = (new Date(h.reserved_until) - Date.now()) / 60000; assert.ok(mins > 25 && mins <= 31);
  assert.equal((await hook({ event: 'charge.completed', data: { tx_ref: c.reference } }, 'wrong')).status, 401);
  txs[c.reference].paid = true;
  assert.equal((await hook({ event: 'charge.completed', data: { tx_ref: c.reference, status: 'successful' } }, 'tafiki-hash-123')).status, 200);
  await new Promise((x) => setTimeout(x, 300));
  assert.ok((await db('holdings').where({ id: h.id }).first()).payment_verified);
  const rc = await db('emails').where({ to_email: 'ada@example.com', category: 'receipts' }).first(); assert.ok(rc && rc.attach); assert.match(rc.body_text, /Card \/ bank via Paystack|Flutterwave|card/i);
  const v = await a.get('/api/holdings/payments/' + c.reference + '/verify'); assert.equal(v.body.payment.status, 'success');
});

test('bank transfer: units held 24 hours with escrow details emailed; reported transfer is confirmed by Finance with receipt and certificate', async () => {
  const r = await buy(3, 'transfer'); assert.equal(r.status, 201, JSON.stringify(r.body));
  const c = r.body.checkout; assert.equal(c.method, 'transfer'); assert.equal(c.escrow.accountNumber, '1234567890'); assert.equal(c.holdHours, 24); assert.equal(c.amount, 6000000);
  const h = await db('holdings').where({ id: r.body.holding.id }).first(); const hrs = (new Date(h.reserved_until) - new Date(h.created_at)) / 3600000; assert.ok(hrs > 23.9 && hrs <= 24.01, 'hold ' + hrs);
  const ins = await db('emails').where({ to_email: 'ada@example.com' }).where('subject', 'like', 'How to pay for%by bank transfer').first(); assert.ok(ins); assert.match(ins.body_text, /1234567890/); assert.match(ins.body_text, new RegExp(c.reference));
  assert.equal((await a.post('/api/holdings/' + h.id + '/transfer-sent')).status, 200);
  const pay = (await fin.get('/api/admin/payments?status=pending_review')).body.payments.find((p) => p.ref === h.ref);
  assert.equal((await fin.post('/api/admin/payments/' + pay.id + '/confirm')).status, 200);
  assert.ok(['reserved', 'active'].includes((await db('holdings').where({ id: h.id }).first()).status));
  const cert = await db('emails').where({ to_email: 'ada@example.com' }).where('subject', 'like', `Your Certificate of Stake%`).orderBy('created_at', 'desc').first(); assert.ok(cert && cert.attach);
});

test('bank transfer never reported: released automatically after 24 hours with an email', async () => {
  const r = await buy(1, 'transfer'); const id = r.body.holding.id;
  await db('holdings').where({ id }).update({ reserved_until: new Date(Date.now() - 1000) }); await db('payments').where({ holding_id: id }).update({ created_at: new Date(Date.now() - 25 * 3600e3) });
  await units.expireReservations();
  assert.equal((await db('holdings').where({ id }).first()).status, 'cancelled');
  assert.ok(await db('emails').where({ to_email: 'ada@example.com' }).where('subject', 'like', '%have been released').where('body_text', 'like', '%bank transfer%').first());
});

test('bank transfer reported but not confirmed: kept past 24 hours, and only then can the team release it', async () => {
  const r = await buy(1, 'transfer'); const id = r.body.holding.id;
  await a.post('/api/holdings/' + id + '/transfer-sent');
  assert.equal((await fin.post('/api/admin/holdings/' + id + '/release')).status, 400, 'too early');
  await db('payments').where({ holding_id: id }).update({ created_at: new Date(Date.now() - 25 * 3600e3) });
  await units.expireReservations(); assert.equal((await db('holdings').where({ id }).first()).status, 'confirming', 'not auto-released once reported');
  assert.equal((await fin.post('/api/admin/holdings/' + id + '/release')).status, 200);
  assert.equal((await db('holdings').where({ id }).first()).status, 'cancelled');
});

test('choosing later: a stake bought without a method can then pay by either option', async () => {
  const r = await buy(1); assert.equal(r.status, 201); assert.equal(r.body.checkout, null);
  const p = await a.post('/api/holdings/' + r.body.holding.id + '/pay').send({ method: 'flutterwave' }); assert.equal(p.status, 200, JSON.stringify(p.body)); assert.match(p.body.authorizationUrl, /flutterwave/);
});
