// Direct purchase: buying opens Paystack checkout at once, units are held only for the checkout, no manual transfers.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
process.env.MANUAL_TRANSFERS = 'off';
process.env.PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || 'sk_test_direct';
const { setup, addAdmin, agent } = require('./helpers');
const paystack = require('../src/lib/paystack');
const units = require('../src/lib/units');
const charges = {}; let down = false;
paystack.setFetch(async (url, opts) => {
  if (url.includes('/transaction/initialize')) { if (down) return { ok: false, json: async () => ({ status: false, message: 'Paystack unavailable' }) }; const b = JSON.parse(opts.body); charges[b.reference] = { amount: b.amount, channels: b.channels, paid: false }; return { ok: true, json: async () => ({ status: true, data: { authorization_url: 'https://checkout.paystack.com/sim-' + b.reference, access_code: 'sim', reference: b.reference } }) }; }
  const ref = decodeURIComponent(url.split('/').pop()); const c = charges[ref] || {};
  return { ok: true, json: async () => ({ status: true, data: { status: c.paid ? 'success' : 'abandoned', amount: c.paid ? c.amount : 0, currency: 'NGN', channel: 'card', reference: ref } }) };
});
const hook = (reference) => { const body = JSON.stringify({ event: 'charge.success', data: { reference } }); return { body, sig: crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(body).digest('hex') }; };
let app, db, sup, a, uid, pkg;
before(async () => {
  ({ app, db } = await setup({ membershipFee: true }));
  await addAdmin('Super Admin', 'ops@tafiki.com'); sup = agent(app); await sup.post('/api/admin/auth/login').send({ email: 'ops@tafiki.com', password: 'Passw0rd!' });
  pkg = (await sup.post('/api/admin/packages').send({ name: 'FOODCORE Mart Ikotun', area: 'Ikotun', city: 'Lagos', unitsTotal: 40 })).body.package.id;
  a = agent(app); const r = await a.post('/api/auth/register').send({ role: 'investor', firstName: 'Ada', lastName: 'Obi', email: 'ada@example.com', phone: '08031234567', password: 'Secret123', agreeTerms: true }); uid = r.body.user.id;
  await sup.patch('/api/admin/users/' + uid).send({ kycStatus: 'verified' });
});
after(async () => { await db.destroy(); });

test('buying returns a Paystack checkout straight away with every channel; the hold lasts 30 minutes', async () => {
  const r = await a.post('/api/holdings').send({ packageId: pkg, units: 2, signedName: 'Ada Obi', agree: true });
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.match(r.body.checkout.authorizationUrl, /checkout\.paystack\.com/);
  assert.equal(r.body.checkout.breakdown.membershipFee, 50000); assert.deepEqual(charges[r.body.checkout.reference].channels, ['card', 'bank', 'bank_transfer', 'ussd']);
  const h = await db('holdings').where({ id: r.body.holding.id }).first(); const mins = (new Date(h.reserved_until) - Date.now()) / 60000; assert.ok(mins > 25 && mins <= 31, 'hold ' + mins);
  charges[r.body.checkout.reference].paid = true; const k = hook(r.body.checkout.reference);
  await agent(app).raw.post('/webhooks/paystack').set('Content-Type', 'application/json').set('x-paystack-signature', k.sig).send(k.body);
  await new Promise((x) => setTimeout(x, 300));
  assert.ok((await db('holdings').where({ id: h.id }).first()).payment_verified, 'paid');
  assert.ok(await db('emails').where({ to_email: 'ada@example.com' }).where('subject', 'like', '%ayment received%').first(), 'receipt sent');
});

test('manual transfers are refused; an abandoned checkout releases the units with a "not completed" email', async () => {
  const r = await a.post('/api/holdings').send({ packageId: pkg, units: 3, signedName: 'Ada Obi', agree: true });
  assert.equal((await a.post('/api/holdings/' + r.body.holding.id + '/pay').send({ method: 'transfer' })).status, 400);
  assert.equal((await a.post('/api/holdings/' + r.body.holding.id + '/transfer-sent')).status, 400);
  await db('holdings').where({ id: r.body.holding.id }).update({ reserved_until: new Date(Date.now() - 1000) }); await db('payments').where({ holding_id: r.body.holding.id }).update({ created_at: new Date(Date.now() - 2 * 3600e3) });
  await units.expireReservations();
  assert.equal((await db('holdings').where({ id: r.body.holding.id }).first()).status, 'cancelled');
  assert.ok(await db('emails').where('subject', 'like', 'Your checkout for%not completed%').first());
});

test('if Paystack cannot start the checkout, the units are released at once', async () => {
  down = true; const r = await a.post('/api/holdings').send({ packageId: pkg, units: 1, signedName: 'Ada Obi', agree: true }); down = false;
  assert.ok(r.status >= 400); assert.equal(Number((await db('holdings').where({ user_id: uid, status: 'unpaid' }).count({ n: '*' }).first()).n), 0);
});
