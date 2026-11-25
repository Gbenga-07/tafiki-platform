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

test('an unconfirmed payment can be released by the team only after 24 hours; a payment Paystack shows as paid is confirmed instead', async () => {
  const r = await a.post('/api/holdings').send({ packageId: pkg, units: 2, signedName: 'Ada Obi', agree: true });
  const id = r.body.holding.id; const ref = r.body.checkout.reference;
  await db('holdings').where({ id }).update({ reserved_until: new Date(Date.now() + 48 * 3600e3) }); // keep it from expiring on its own
  let x = await sup.post('/api/admin/holdings/' + id + '/release');
  assert.equal(x.status, 400); assert.match(x.body.error || x.body.message || JSON.stringify(x.body), /24 hours/);
  const list = await sup.get('/api/admin/holdings'); assert.equal(list.body.releaseAfterHours, 24); assert.ok(list.body.holdings.find((h) => h.id === id).last_payment_at);
  await db('payments').where({ holding_id: id }).update({ created_at: new Date(Date.now() - 25 * 3600e3) });
  charges[ref].paid = true; // the money did arrive: release must refuse and confirm it
  x = await sup.post('/api/admin/holdings/' + id + '/release'); assert.equal(x.status, 400);
  assert.ok((await db('holdings').where({ id }).first()).payment_verified, 'confirmed instead of released');
  // a second stake that never paid is released, its payment marked failed and the member emailed
  const r2 = await a.post('/api/holdings').send({ packageId: pkg, units: 3, signedName: 'Ada Obi', agree: true }); const id2 = r2.body.holding.id;
  await db('holdings').where({ id: id2 }).update({ reserved_until: new Date(Date.now() + 48 * 3600e3) });
  await db('payments').where({ holding_id: id2 }).update({ created_at: new Date(Date.now() - 25 * 3600e3) });
  x = await sup.post('/api/admin/holdings/' + id2 + '/release'); assert.equal(x.status, 200, JSON.stringify(x.body));
  assert.equal((await db('holdings').where({ id: id2 }).first()).status, 'cancelled');
  assert.equal((await db('payments').where({ holding_id: id2 }).first()).status, 'failed');
  assert.ok(await db('emails').where('subject', 'like', '%units for%have been released%').first());
  assert.equal((await sup.post('/api/admin/holdings/' + id + '/release')).status, 400, 'a paid stake cannot be released');
});

test('every receipt and the Certificate of Stake go out with a PDF attached, downloadable from the console', async () => {
  const rc = await db('emails').where({ to_email: 'ada@example.com', category: 'receipts' }).first();
  const ct = await db('emails').where({ to_email: 'ada@example.com' }).where('subject', 'like', 'Your Certificate of Stake%').first();
  assert.ok(rc && rc.attach && ct && ct.attach, 'attachments recorded');
  assert.equal(JSON.parse(rc.attach)[0].kind, 'receipt'); assert.equal(JSON.parse(ct.attach)[0].kind, 'certificate');
  assert.match(rc.body_text, /Attached: Tafiki-Payment-Receipt-TFK-\d{4}-\d{6}\.pdf/);
  const list = await sup.get('/api/admin/emails?limit=50'); const row = list.body.emails.find((e) => e.id === ct.id);
  assert.match(row.attachments[0], /^Certificate-of-Stake-FC-C-\d{4}-\d{4}\.pdf$/); assert.ok(!('attach' in row));
  for (const id of [rc.id, ct.id]) {
    const f = await sup.get('/api/admin/emails/' + id + '/attachments/0').buffer(true).parse((res, cb) => { const b = []; res.on('data', (c) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
    assert.equal(f.status, 200); assert.equal(f.headers['content-type'], 'application/pdf'); assert.equal(f.body.slice(0, 4).toString(), '%PDF'); assert.ok(f.body.length > 5000);
  }
});
