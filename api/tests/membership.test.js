// Yearly cooperative membership fee (₦50,000): added only to the first stake payment of each membership year,
// non-refundable, never unit capital, never earns returns.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
process.env.PAYSTACK_SECRET_KEY = 'sk_test_membership';
const { setup, addAdmin, agent, lastEmail } = require('./helpers');
const paystack = require('../src/lib/paystack');

const charges = {};
paystack.setFetch(async (url, opts) => {
  if (url.includes('/transaction/initialize')) { const b = JSON.parse(opts.body); charges[b.reference] = { amount: b.amount, paid: false, fail: false }; return { ok: true, json: async () => ({ status: true, data: { authorization_url: 'https://checkout.paystack.com/x', access_code: 'x', reference: b.reference } }) }; }
  const ref = decodeURIComponent(url.split('/').pop()); const c = charges[ref] || {};
  return { ok: true, json: async () => ({ status: true, data: { status: c.paid ? 'success' : c.fail ? 'failed' : 'abandoned', amount: c.paid ? c.amount : 0, currency: 'NGN', channel: 'card', reference: ref } }) };
});

let app, db, sup, fin, view, pkgId, pkg2, pkg3;
const FEE = 50000, UNIT = 2000000;
async function member(email, name = 'Test Member') {
  const a = agent(app); const [f, l] = name.split(' ');
  const r = await a.post('/api/auth/register').send({ role: 'investor', firstName: f, lastName: l, email, phone: '0803' + String(Math.floor(1e6 + Math.random() * 8e6)), password: 'Secret123', agreeTerms: true, bank: { name: 'GTBank', account: '0123456789', accountName: name } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await db('users').where({ id: r.body.user.id }).update({ kyc_status: 'verified' });
  return { a, id: r.body.user.id, name };
}
const reserve = async (m, units = 1, pkg = pkgId) => { const r = await m.a.post('/api/holdings').send({ packageId: pkg, units, signedName: m.name, agree: true }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.holding; };
const payCard = async (m, h) => { const r = await m.a.post('/api/holdings/' + h.id + '/pay').send({ method: 'card' }); return r; };
const succeed = async (m, ref) => { charges[ref].paid = true; return m.a.get('/api/holdings/payments/' + ref + '/verify'); };

before(async () => {
  ({ app, db } = await setup({ membershipFee: true }));
  await addAdmin('Super Admin', 'ops@tafiki.com'); await addAdmin('Finance Officer', 'fin@tafiki.com'); await addAdmin('Admin', 'view@tafiki.com');
  const login = async (e) => { const a = agent(app); await a.post('/api/admin/auth/login').send({ email: e, password: 'Passw0rd!' }); return a; };
  [sup, fin, view] = await Promise.all(['ops@tafiki.com', 'fin@tafiki.com', 'view@tafiki.com'].map(login));
  pkgId = (await sup.post('/api/admin/packages').send({ name: 'FOODCORE Bodija', area: 'Bodija market', city: 'Ibadan', unitsTotal: 40 })).body.package.id;
  pkg3 = (await sup.post('/api/admin/packages').send({ name: 'FOODCORE Akobo', area: 'Akobo junction', city: 'Ibadan', unitsTotal: 40 })).body.package.id;
  const st = agent(app); await st.post('/api/auth/register').send({ role: 'retailer', firstName: 'Kemi', lastName: 'Alade', email: 'kemi@example.com', phone: '08031110000', password: 'Secret123', shop: 'FOODCORE Bodija', area: 'Bodija, Ibadan', agreeTerms: true });
  pkg2 = (await sup.post('/api/admin/packages').send({ name: 'FOODCORE Ojoo', area: 'Ojoo terminal', city: 'Ibadan', unitsTotal: 3 })).body.package.id;
});
after(async () => { await db.destroy(); });

test('default fee is ₦50,000 a year and is public', async () => {
  const t = (await agent(app).get('/api/terms')).body; const terms = t.terms || t;
  assert.equal(terms.membershipFee, 50000); assert.equal(terms.membershipMonths, 12);
});

test('first stake: Paystack is charged units + ₦50,000; capital stays units only; membership runs 12 months', async () => {
  const m = await member('first@example.com', 'Ada Okafor');
  assert.equal((await m.a.get('/api/me')).body.user.membershipUntil, null);
  const h = await reserve(m, 2);
  assert.equal(h.amount, 2 * UNIT); // the stake itself never includes the fee
  const p = await payCard(m, h);
  assert.equal(p.status, 200); assert.deepEqual(p.body.breakdown, { units: 2 * UNIT, membershipFee: FEE, total: 2 * UNIT + FEE });
  assert.equal(charges[p.body.reference].amount, (2 * UNIT + FEE) * 100);
  const v = await succeed(m, p.body.reference); assert.equal(v.body.payment.status, 'success');
  const u = (await m.a.get('/api/me')).body.user; assert.ok(u.membershipUntil);
  const months = (new Date(u.membershipUntil) - Date.now()) / (30.44 * 864e5); assert.ok(months > 11.8 && months < 12.2, String(months));
  const rows = await db('memberships').where({ user_id: m.id }); assert.equal(rows.length, 1); assert.equal(Number(rows[0].amount), FEE);
  const hold = await db('holdings').where({ id: h.id }).first(); assert.equal(Number(hold.amount), 2 * UNIT); assert.equal(hold.status, 'reserved');
  const mails = await db('emails').where({ to_email: 'first@example.com' }).where('subject', 'like', '%ayment received%'); assert.equal(mails.length, 1); assert.match(mails[0].body_text, /₦4,050,000: ₦4,000,000 for 2 units/); assert.match(mails[0].body_text, /Units: 2 × ₦2,000,000/); assert.match(mails[0].body_text, /Total paid: ₦4,050,000/); assert.match(mails[0].body_text, /₦50,000 for your yearly cooperative membership/); assert.match(mails[0].body_text, /non-refundable and earns no returns/);
});

test('second stake in the same year: no fee', async () => {
  const m = await member('second@example.com', 'Bayo Ade');
  const h1 = await reserve(m); const p1 = await payCard(m, h1); assert.equal(p1.body.breakdown.membershipFee, FEE); await succeed(m, p1.body.reference);
  const h2 = await reserve(m, 3); const p2 = await payCard(m, h2);
  assert.deepEqual(p2.body.breakdown, { units: 3 * UNIT, membershipFee: 0, total: 3 * UNIT });
  assert.equal(charges[p2.body.reference].amount, 3 * UNIT * 100);
  await succeed(m, p2.body.reference);
  assert.equal((await db('memberships').where({ user_id: m.id })).length, 1);
});

test('a failed or abandoned first payment does not count; the retry carries the fee again', async () => {
  const m = await member('retry@example.com', 'Chi Obi');
  const h = await reserve(m); const p1 = await payCard(m, h); charges[p1.body.reference].fail = true;
  await m.a.get('/api/holdings/payments/' + p1.body.reference + '/verify');
  assert.equal((await db('payments').where({ reference: p1.body.reference }).first()).status, 'failed');
  assert.equal((await m.a.get('/api/me')).body.user.membershipUntil, null);
  const p2 = await payCard(m, h); assert.equal(p2.body.breakdown.membershipFee, FEE);
  await succeed(m, p2.body.reference);
  assert.equal((await db('memberships').where({ user_id: m.id })).length, 1);
});

test('only one stake at a time can carry the fee; once the first is rejected, the next one carries it', async () => {
  const m = await member('two@example.com', 'Dayo Bello');
  const a = await reserve(m), b = await reserve(m);
  const pa = await m.a.post('/api/holdings/' + a.id + '/pay').send({ method: 'transfer' });
  assert.equal(pa.body.amount, UNIT + FEE); assert.equal(pa.body.breakdown.membershipFee, FEE);
  await m.a.post('/api/holdings/' + a.id + '/transfer-sent');
  const pb = await payCard(m, b); assert.equal(pb.status, 409); assert.match(pb.body.error, /membership fee/);
  const pay = (await fin.get('/api/admin/payments?status=pending_review')).body.payments.find((x) => x.ref === a.ref);
  assert.equal(Number(pay.fee_amount), FEE); assert.equal(Number(pay.amount), UNIT + FEE);
  assert.equal((await fin.post('/api/admin/payments/' + pay.id + '/reject').send({ reason: 'Not received' })).status, 200);
  const pb2 = await payCard(m, b); assert.equal(pb2.status, 200); assert.equal(pb2.body.breakdown.membershipFee, FEE);
});

test('two checkouts at the same moment: exactly one carries the fee', async () => {
  const m = await member('race@example.com', 'Efe Udo');
  const a = await reserve(m), b = await reserve(m);
  const rs = await Promise.all([payCard(m, a), payCard(m, b)]);
  const ok = rs.filter((r) => r.status === 200); const withFee = ok.filter((r) => r.body.breakdown.membershipFee === FEE);
  assert.equal(withFee.length, 1, rs.map((r) => r.status + ':' + JSON.stringify(r.body.breakdown || r.body.error)).join(' | '));
  assert.ok(rs.every((r) => r.status === 200 || r.status === 409));
});

test('transfer confirmed by Finance records the fee; the fee is shown apart from capital', async () => {
  const m = await member('transfer@example.com', 'Funke Ojo');
  const h = await reserve(m, 4);
  const p = await m.a.post('/api/holdings/' + h.id + '/pay').send({ method: 'transfer' }); assert.equal(p.body.amount, 4 * UNIT + FEE);
  await m.a.post('/api/holdings/' + h.id + '/transfer-sent');
  const pay = (await fin.get('/api/admin/payments?status=pending_review')).body.payments.find((x) => x.ref === h.ref);
  assert.equal((await fin.post('/api/admin/payments/' + pay.id + '/confirm')).status, 200);
  assert.equal((await db('payments').where({ id: pay.id }).first()).fee_status, 'paid');
  assert.equal(Number((await db('holdings').where({ id: h.id }).first()).amount), 4 * UNIT);
  const list = (await view.get('/api/admin/memberships')).body.memberships; assert.ok(list.find((x) => x.member === 'Funke Ojo' && Number(x.amount) === FEE));
});

test('returns are on units only: the payout pays per unit, the fee earns nothing', async () => {
  // fill the package and open it, then pay a cycle
  const filler = await member('filler@example.com', 'Gbola Tade');
  const taken = Number((await db('holdings').where({ package_id: pkgId }).whereNot({ status: 'cancelled' }).sum({ s: 'units' }).first()).s);
  const fh = await reserve(filler, 40 - taken); const fp = await payCard(filler, fh); await succeed(filler, fp.body.reference);
  await db('holdings').where({ package_id: pkgId, status: 'unpaid' }).update({ status: 'cancelled' });
  const unitsHeld = Number((await db('holdings').where({ package_id: pkgId }).whereIn('status', ['reserved']).sum({ s: 'units' }).first()).s);
  if (unitsHeld < 40) { const g = await reserve(filler, 40 - unitsHeld); const gp = await payCard(filler, g); await succeed(filler, gp.body.reference); }
  const op = await sup.post('/api/admin/packages/' + pkgId + '/open').send({}); assert.equal(op.status, 200, JSON.stringify(op.body));
  await db('packages').where({ id: pkgId }).update({ opened_at: new Date(Date.now() - 91 * 864e5) });
  const run = await fin.post('/api/admin/payouts/' + pkgId).send({ profit: 48000000 }); assert.equal(run.status, 201, JSON.stringify(run.body));
  const ada = await db('users').where({ email: 'first@example.com' }).first();
  const w = await db('wallet_tx').where({ user_id: ada.id, type: 'payout' }).sum({ s: 'amount' }).first();
  assert.equal(Number(w.s), 2 * 166667); // Ada holds 2 units: 2 × ₦166,667, nothing on her ₦50,000 fee
});

test('redemption returns unit capital only; the fee is non-refundable', async () => {
  const ada = await db('users').where({ email: 'first@example.com' }).first();
  const h = await db('holdings').where({ user_id: ada.id, package_id: pkgId }).first();
  await db('holdings').where({ id: h.id }).update({ active_since: new Date(Date.now() - 370 * 864e5) });
  const m = agent(app); await m.post('/api/auth/login').send({ email: 'first@example.com', password: 'Secret123' });
  const r = await m.post('/api/me/holdings/' + h.id + '/redeem'); assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(Number(r.body.redemption.amount), 2 * UNIT);
});

test('paid after the reservation lapsed and the units are gone: refund the stake part only, membership stays', async () => {
  const late = await member('late@example.com', 'Hassan Bala'); const other = await member('other@example.com', 'Ife Ayo');
  const h = await reserve(late, 3, pkg2); const p = await payCard(late, h); assert.equal(p.body.breakdown.membershipFee, FEE);
  await db('holdings').where({ id: h.id }).update({ status: 'cancelled' }); // lapsed
  const o = await reserve(other, 3, pkg2); const op = await payCard(other, o); await succeed(other, op.body.reference); // units taken by someone else
  await succeed(late, p.body.reference);
  const pay = await db('payments').where({ reference: p.body.reference }).first();
  assert.equal(pay.status, 'refund_due'); assert.equal(pay.fee_status, 'paid');
  assert.ok((await db('users').where({ id: late.id }).first()).membership_until);
  const act = await db('activity_log').where({ action: 'payment.refund_due' }).orderBy('created_at', 'desc').first();
  const det = JSON.parse(act.detail); assert.equal(det.amount, 3 * UNIT); assert.equal(det.membershipFeeKept, FEE);
});

test('after the year runs out, the next stake carries the fee again', async () => {
  const m = await member('renew@example.com', 'Jide Ola');
  const h1 = await reserve(m, 1, pkg3); const p1 = await payCard(m, h1); await succeed(m, p1.body.reference);
  await db('users').where({ id: m.id }).update({ membership_until: new Date(Date.now() - 1000) });
  const h2 = await reserve(m, 1, pkg3); const p2 = await payCard(m, h2); assert.equal(p2.body.breakdown.membershipFee, FEE);
  await succeed(m, p2.body.reference);
  assert.equal((await db('memberships').where({ user_id: m.id })).length, 2);
});

test('fee is set in Terms & Settings by a Super Admin; ₦0 switches it off', async () => {
  assert.equal((await view.put('/api/admin/settings/terms').send({ terms: { membershipFee: 30000 } })).status, 403);
  assert.equal((await sup.put('/api/admin/settings/terms').send({ terms: { membershipFee: -1 } })).status, 400);
  assert.equal((await sup.put('/api/admin/settings/terms').send({ terms: { membershipFee: 0 } })).status, 200);
  const m = await member('nofee@example.com', 'Kunle Ade'); const h = await reserve(m, 1, pkg3); const p = await payCard(m, h);
  assert.deepEqual(p.body.breakdown, { units: UNIT, membershipFee: 0, total: UNIT });
  assert.equal((await sup.put('/api/admin/settings/terms').send({ terms: { membershipFee: 50000 } })).status, 200);
});
