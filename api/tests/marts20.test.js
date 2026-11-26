// 20 FOODCORE Marts at every stage of launch and funding, run together, with the real ₦50,000 yearly membership fee.
// Every package gets a mart automatically (or is linked to the one that already exists), members buy across many marts
// at once, and the money must add up at the end: capital, fees, wallets, payouts and redemptions.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, addAdmin, agent } = require('./helpers');
const ops = require('../src/lib/ops');
const units = require('../src/lib/units');
const { martKey } = require('../src/lib/marts');

const all = (xs) => Promise.all(xs);
const settle = () => new Promise((r) => setTimeout(r, 300));
const PRICE = 2000000, FEE = 50000;

// stage plan for the 20 marts
const AREAS = ['Bodija', 'Ojoo', 'Dugbe', 'Mokola', 'Sango', 'Eleyele', 'Challenge', 'Ring Road', 'Apata', 'Oja-Oba', 'Ketu', 'Bariga', 'Surulere', 'Mushin', 'Agege', 'Egbeda', 'Ikotun', 'Oshodi', 'Ojota', 'Ajah'];
const PLAN = ['empty', 'empty', 'reserved', 'reserved', 'part-paid', 'part-paid', 'full-mixed', 'full-mixed', 'full-review', 'full-review', 'full-confirmed', 'full-confirmed', 'opened', 'opened', 'delivered', 'delivered', 'paid-out', 'paid-out', 'redeemed', 'redeemed'];
const TAKE = { empty: 0, reserved: 12, 'part-paid': 25, 'full-mixed': 40, 'full-review': 40, 'full-confirmed': 40, opened: 40, delivered: 40, 'paid-out': 40, redeemed: 40 };

let app, db, sup, fin, logi, aud; const members = []; const marts = []; // { id, area, plan, storeId }
const login = async (e) => { const a = agent(app); await a.post('/api/admin/auth/login').send({ email: e, password: 'Passw0rd!' }); return a; };

before(async () => {
  ({ app, db } = await setup({ membershipFee: true }));
  for (const [r, e] of [['Super Admin', 'ops'], ['Finance Officer', 'fin'], ['Logistics Officer', 'logi'], ['Auditor', 'aud']]) await addAdmin(r, e + '@tafiki.com');
  [sup, fin, logi, aud] = await all(['ops', 'fin', 'logi', 'aud'].map((e) => login(e + '@tafiki.com')));
});
after(async () => { await db.destroy(); });

test('1. marts that already have accounts are linked, not duplicated', async () => {
  // two marts registered themselves earlier, with slightly different names
  for (const [shop, email, phone] of [['FOODCORE Bodija', 'bodija@mart.com', '08030000001'], ['Foodcore Ketu Mart', 'ketu@mart.com', '08030000002']]) {
    const r = await agent(app).post('/api/auth/register').send({ role: 'retailer', firstName: 'Mart', lastName: 'Manager', email, phone, password: 'Secret123', shop: shop.startsWith('FOODCORE') ? shop : 'FOODCORE Ketu Mart', area: 'Main road', agreeTerms: true });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
});

test('2. 20 packages created at once: each gets exactly one mart, created automatically unless it already exists', async () => {
  const rs = await all(AREAS.map((a, i) => sup.post('/api/admin/packages').send({ name: 'FOODCORE Mart ' + a, area: a + ' junction', city: i < 10 ? 'Ibadan' : 'Lagos', state: i < 10 ? 'Oyo' : 'Lagos', route: i < 10 ? 'Ibadan North' : 'Lagos Mainland', unitsTotal: 40 })));
  rs.forEach((r, i) => { assert.equal(r.status, 201, JSON.stringify(r.body)); assert.ok(r.body.package.storeUserId, 'mart linked'); marts.push({ id: r.body.package.id, area: AREAS[i], plan: PLAN[i], storeId: r.body.package.storeUserId, created: r.body.mart.created }); });
  assert.equal(marts.find((m) => m.area === 'Bodija').created, false);
  assert.equal(marts.find((m) => m.area === 'Ketu').created, false);
  const stores = await db('users').where({ role: 'retailer' });
  assert.equal(stores.length, 20, stores.map((s) => s.shop).join(' | '));
  assert.equal(new Set(stores.map((s) => martKey(s.shop))).size, 20);
  // a second package for an existing mart, and two for a brand-new mart at the same moment, never duplicate it
  const again = await sup.post('/api/admin/packages').send({ name: 'FOODCORE Bodija', area: 'Bodija', city: 'Ibadan', unitsTotal: 40 });
  assert.equal(again.body.package.storeUserId, marts[0].storeId);
  const twins = await all(['FOODCORE Mart Akobo', 'Foodcore Akobo', 'FOODCORE AKOBO MART'].map((n) => sup.post('/api/admin/packages').send({ name: n, area: 'Akobo', city: 'Ibadan', unitsTotal: 40 })));
  twins.forEach((r) => assert.equal(r.status, 201));
  assert.equal(new Set(twins.map((r) => r.body.package.storeUserId)).size, 1);
  assert.equal(Number((await db('users').where({ role: 'retailer' }).count({ n: '*' }).first()).n), 21);
  // placeholder marts get no email until a manager is set
  const auto = await db('users').where({ id: marts[1].storeId }).first(); assert.match(auto.email, /@marts\.tafiki\.invalid$/);
  // the extra test packages are removed again so the 20 below are the only ones in play
  for (const r of [again, ...twins]) await db('packages').where({ id: r.body.package.id }).del();
  // the console lists all 20 marts
  assert.ok((await sup.get('/api/admin/stores')).body.stores.length >= 20);
});

test('3. 30 members sign up and are verified', async () => {
  const rs = await all(Array.from({ length: 30 }, async (_, i) => {
    const a = agent(app); const email = `m${i}@example.com`;
    const r = await a.post('/api/auth/register').send({ role: 'investor', firstName: 'Member', lastName: 'No' + i, email, phone: '0806' + String(1000000 + i), password: 'Secret123', agreeTerms: true, bank: { name: 'GTBank', account: String(2000000000 + i), accountName: 'Member No' + i } });
    assert.equal(r.status, 201, JSON.stringify(r.body)); return { a, id: r.body.user.id, name: r.body.user.name, holdings: [] };
  }));
  members.push(...rs);
  await all(members.map((m) => sup.patch('/api/admin/users/' + m.id).send({ kycStatus: 'verified' })));
});

// spread each mart's units over members in chunks of 1 to 8; every member buys in several marts
function chunks(total, seed) { const out = []; let left = total, k = seed; while (left > 0) { const n = Math.min(left, 1 + (k * 7) % 8); out.push(n); left -= n; k++; } return out; }

test('4. everyone reserves across all 20 marts at the same moment; no mart is oversold', async () => {
  const jobs = [];
  marts.forEach((m, mi) => { let who = mi; chunks(TAKE[m.plan], mi).forEach((n) => { const mem = members[who++ % members.length]; jobs.push({ m, mem, n }); }); });
  // extra buyers pile on to the full marts to prove they cannot go past 40
  marts.filter((m) => TAKE[m.plan] === 40).forEach((m, i) => jobs.push({ m, mem: members[(i * 5) % members.length], n: 3, extra: true }));
  const rs = await all(jobs.map((j) => j.mem.a.post('/api/holdings').send({ packageId: j.m.id, units: j.n, signedName: j.mem.name, agree: true })));
  rs.forEach((r, i) => { const j = jobs[i]; if (r.status === 201) j.mem.holdings.push({ id: r.body.holding.id, ref: r.body.holding.ref, mart: j.m, units: j.n }); else assert.ok([400, 409].includes(r.status), r.status + JSON.stringify(r.body)); });
  for (const m of marts) {
    const t = Number((await db('holdings').where({ package_id: m.id }).whereNot({ status: 'cancelled' }).sum({ s: 'units' }).first()).s) || 0;
    assert.ok(t <= 40, m.area + ' oversold: ' + t);
    m.taken = t;
  }
  // full-plan marts that lost a chunk to an extra buyer are topped up so the plan holds
  for (const m of marts.filter((x) => TAKE[x.plan] === 40 && x.taken < 40)) {
    const mem = members.find((x) => !x.holdings.some((h) => h.mart === m)) || members[0];
    const r = await mem.a.post('/api/holdings').send({ packageId: m.id, units: 40 - m.taken, signedName: mem.name, agree: true }); assert.equal(r.status, 201, JSON.stringify(r.body));
    mem.holdings.push({ id: r.body.holding.id, ref: r.body.holding.ref, mart: m, units: 40 - m.taken }); m.taken = 40;
  }
  marts.forEach((m) => assert.equal(m.taken, TAKE[m.plan], m.area));
});

const holdingsOf = (m) => members.flatMap((mem) => mem.holdings.filter((h) => h.mart === m).map((h) => ({ ...h, mem })));
const pay = async (h) => { const t = await h.mem.a.post('/api/holdings/' + h.id + '/pay').send({ method: 'transfer' }); assert.equal(t.status, 200, JSON.stringify(t.body)); await h.mem.a.post('/api/holdings/' + h.id + '/transfer-sent'); return t.body; };

test('5. payments by stage: each member pays the ₦50,000 fee once, on their first stake only', async () => {
  const toPay = [];
  for (const m of marts) {
    const hs = holdingsOf(m);
    if (['part-paid'].includes(m.plan)) toPay.push(...hs.slice(0, Math.ceil(hs.length / 2)));
    if (m.plan === 'full-mixed') toPay.push(...hs.slice(0, Math.floor(hs.length / 2)));
    if (['full-review', 'full-confirmed', 'opened', 'delivered', 'paid-out', 'redeemed'].includes(m.plan)) toPay.push(...hs);
  }
  const isReview = (h) => h.mart.plan === 'full-review';
  // A review payment stays unconfirmed, and while a member's first (fee-carrying) payment is unconfirmed the platform
  // refuses their next one. So a member whose only payments would be review stakes first pays one ordinary stake
  // (from a part-paid or mixed mart that stays short of full), or keeps just one review stake.
  for (const mem of members) {
    const mine = toPay.filter((h) => h.mem === mem);
    if (mine.length < 2 || !mine.every(isReview)) continue;
    const ids = new Set(toPay.map((h) => h.id));
    const extra = mem.holdings.map((h) => ({ ...h, mem })).find((h) => ['part-paid', 'full-mixed'].includes(h.mart.plan) && !ids.has(h.id) && toPay.filter((x) => x.mart === h.mart).length + 1 < holdingsOf(h.mart).length);
    if (extra) toPay.push(extra); else mine.slice(1).forEach((h) => toPay.splice(toPay.indexOf(h), 1));
  }
  // a member pays stake by stake: the first carries the fee and must clear before the next (a second fee-carrying payment is refused)
  const queue = {}; toPay.forEach((h) => (queue[h.mem.id] = queue[h.mem.id] || []).push(h));
  Object.values(queue).forEach((q) => q.sort((x, y) => isReview(x) - isReview(y)));
  let first = true;
  while (Object.values(queue).some((q) => q.length)) {
    const round = Object.values(queue).map((q) => q.shift()).filter(Boolean);
    if (first) { // both at once from the same member: one wins, the other is told to finish the first
      const m = round[0].mem, other = Object.values(queue).find((q) => q.length && q[0].mem === m);
      if (other) { const two = await all([m.a.post('/api/holdings/' + round[0].id + '/pay').send({ method: 'transfer' }), m.a.post('/api/holdings/' + other[0].id + '/pay').send({ method: 'transfer' })]); assert.ok(two.some((r) => r.status === 409) || two.every((r) => r.status === 200), two.map((r) => r.status).join()); const pair = [round[0], other[0]]; for (const [i, r] of two.entries()) if (r.status === 200) await m.a.post('/api/holdings/' + pair[i].id + '/transfer-sent'); round.shift(); other.shift(); for (const [i, r] of two.entries()) if (r.status !== 200) other.push(pair[i]); }
      first = false;
    }
    await all(round.map(pay));
    const pending = (await fin.get('/api/admin/payments?status=pending_review&limit=1000')).body.payments;
    const reviewRefs = new Set(marts.filter((m) => m.plan === 'full-review').flatMap((m) => holdingsOf(m).map((h) => h.ref)));
    const confirmNow = pending.filter((p) => !reviewRefs.has(p.ref));
    const cf = await all(confirmNow.flatMap((p) => [fin.post('/api/admin/payments/' + p.id + '/confirm'), fin.post('/api/admin/payments/' + p.id + '/confirm')]));
    assert.equal(cf.filter((r) => r.status === 200).length, confirmNow.length, cf.map((r) => r.status).join(','));
  }
  await settle();
  const fees = await db('payments').where({ status: 'success' }).select('user_id').sum({ f: 'fee_amount' }).groupBy('user_id');
  fees.forEach((r) => assert.ok(Number(r.f) === 0 || Number(r.f) === FEE, 'fee per member ' + r.f));
  const paidUsers = new Set((await db('payments').where({ status: 'success' }).select('user_id')).map((x) => x.user_id));
  assert.equal(fees.filter((r) => Number(r.f) === FEE).length, paidUsers.size, 'every paying member paid the fee exactly once');
});

test('6. full and confirmed marts open (double-clicked); marts without a manager phone get one, then codes are reissued', async () => {
  const toOpen = marts.filter((m) => ['full-confirmed', 'opened', 'delivered', 'paid-out', 'redeemed'].includes(m.plan));
  const notReady = marts.filter((m) => ['full-review', 'full-mixed', 'part-paid'].includes(m.plan));
  for (const m of notReady) assert.equal((await sup.post('/api/admin/packages/' + m.id + '/open').send({})).status, 400, m.area);
  const keep = toOpen.filter((m) => m.plan !== 'full-confirmed');
  const op = await all(keep.flatMap((m) => [sup.post('/api/admin/packages/' + m.id + '/open').send({}), sup.post('/api/admin/packages/' + m.id + '/open').send({})]));
  assert.equal(op.filter((r) => r.status === 200).length, keep.length, op.map((r) => r.status + (r.status !== 200 ? JSON.stringify(r.body) : '')).join(','));
  // hand each auto-created mart to a manager: real email and phone
  for (const [i, m] of keep.entries()) {
    const u = await db('users').where({ id: m.storeId }).first();
    if (u.email.endsWith('.invalid')) { const r = await sup.patch('/api/admin/users/' + m.storeId).send({ email: `manager${i}@mart.com`, phone: '0809' + String(5000000 + i), name: 'Manager ' + m.area }); assert.equal(r.status, 200, JSON.stringify(r.body)); }
    m.mgr = (await db('users').where({ id: m.storeId }).first());
  }
  const welcome = await db('emails').where({ to_email: 'manager0@mart.com' }).first(); assert.ok(welcome && /You now manage/.test(welcome.subject));
  assert.equal(Number((await db('emails').where('to_email', 'like', '%.invalid').whereNot({ status: 'skipped' }).count({ n: '*' }).first()).n), 0, 'nothing is ever sent to a placeholder address');
});

async function deliverAll(m) {
  const ds = (await logi.get('/api/admin/deliveries?limit=1000')).body.deliveries.filter((d) => (d.store && d.store.id) === m.storeId || d.storeUserId === m.storeId || d.toId === m.storeId);
  assert.ok(ds.length > 0, 'deliveries for ' + m.area);
  for (let i = 0; i < 3; i++) { await db('delivery_log').update({ at: new Date(Date.now() - 7 * 3600e3) }); await ops.autoAdvance(); }
  for (const d of ds) {
    await logi.post('/api/admin/deliveries/' + d.id + '/reissue-code');
    const t = await db('emails').where({ ref: d.code }).where('subject', 'like', 'New delivery code%').orderBy('created_at', 'desc').first(); assert.ok(t, 'code email ' + d.code);
    const code = t.body_text.match(/DELIVERY CODE: (\d{6})/)[1];
    const r = await logi.post('/api/admin/deliveries/' + d.id + '/complete').send({ code }); assert.equal(r.status, 200, m.area + ' ' + JSON.stringify(r.body));
  }
}

test('7. delivered, paid-out and redeemed marts receive their stock; stock value equals capital', async () => {
  for (const m of marts.filter((x) => ['delivered', 'paid-out', 'redeemed'].includes(x.plan))) {
    await deliverAll(m);
    const s = agent(app); await s.post('/api/auth/password/forgot').send({ email: m.mgr.email });
    const acc = (await sup.get('/api/admin/stores/' + m.storeId)).body; assert.ok(acc, m.area);
    const recv = acc.account ? acc.account.stockReceived : (acc.store && acc.store.account && acc.store.account.stockReceived);
    assert.equal(recv, 40 * PRICE, m.area + ' stock received');
  }
});

test('8. payouts after 90 days for paid-out and redeemed marts, run three times at once, pay once', async () => {
  const ms = marts.filter((x) => ['paid-out', 'redeemed'].includes(x.plan));
  await db('packages').whereIn('id', ms.map((m) => m.id)).update({ opened_at: new Date(Date.now() - 91 * 864e5) });
  const runs = await all(ms.flatMap((m) => [0, 1, 2].map(() => fin.post('/api/admin/payouts/' + m.id).send({ profit: 48000000 }))));
  assert.equal(runs.filter((r) => r.status === 201).length, ms.length, runs.map((r) => r.status).join(','));
  for (const m of ms) { const paid = await db('wallet_tx').where({ type: 'payout' }).whereIn('user_id', holdingsOf(m).map((h) => h.mem.id)).sum({ s: 'amount' }).first(); assert.ok(Number(paid.s) > 0, m.area); }
});

test('9. redemptions after 12 months settle once each', async () => {
  const ms = marts.filter((x) => x.plan === 'redeemed');
  for (const m of ms) {
    const h = holdingsOf(m)[0];
    await db('holdings').where({ id: h.id }).update({ active_since: new Date(Date.now() - 370 * 864e5) });
    const rr = await all([h.mem.a.post('/api/me/holdings/' + h.id + '/redeem'), h.mem.a.post('/api/me/holdings/' + h.id + '/redeem')]);
    const made = rr.filter((r) => r.status === 201); assert.equal(made.length, 1, rr.map((r) => r.status + JSON.stringify(r.body)).join(' '));
    await db('redemptions').where({ id: made[0].body.redemption.id }).update({ settle_after: new Date(Date.now() - 1000) });
    const st = await all([fin.post('/api/admin/redemptions/' + made[0].body.redemption.id + '/settle'), fin.post('/api/admin/redemptions/' + made[0].body.redemption.id + '/settle')]);
    assert.equal(st.filter((r) => r.status === 200).length, 1, st.map((r) => r.status + JSON.stringify(r.body)).join(' '));
  }
});

test('10. every page the console and members use answers for all 20 marts, and the money adds up', async () => {
  const pub = (await agent(app).get('/api/packages')).body.packages; assert.equal(pub.length, 20);
  pub.forEach((p) => { const m = marts.find((x) => x.id === p.id); assert.equal(p.unitsTaken, m.taken - (m.plan === 'redeemed' ? holdingsOf(m)[0].units : 0), m.area); assert.ok(p.unitsConfirmed <= p.unitsTaken); });
  for (const u of ['/api/admin/packages', '/api/admin/stores', '/api/admin/payments?limit=1000', '/api/admin/deliveries?limit=1000', '/api/admin/analytics', '/api/admin/memberships', '/api/admin/payouts', '/api/admin/redemptions', '/api/admin/withdrawals', '/api/admin/remittances'])
    assert.equal((await sup.get(u)).status, 200, u);
  for (const m of members.slice(0, 10)) for (const u of ['/api/me', '/api/holdings', '/api/me/wallet']) assert.equal((await m.a.get(u)).status, 200, u);
  // capital counts units only; fees are separate and never part of capital
  const cap = Number((await db('payments').where({ status: 'success' }).sum({ s: 'amount' }).first()).s);
  const fees = Number((await db('payments').where({ status: 'success' }).sum({ s: 'fee_amount' }).first()).s);
  const unitsPaid = Number((await db('holdings').whereNotNull('paid_at').sum({ s: 'amount' }).first()).s);
  assert.equal(cap - fees, unitsPaid, 'payments = units + fees');
  const an = (await sup.get('/api/admin/analytics')).body;
  assert.equal(an.totals.membershipFees, fees); assert.equal(an.totals.capital, Number((await db('holdings').whereIn('status', units.CONFIRMED).sum({ s: 'amount' }).first()).s), 'capital = confirmed units still held');
  // no wallet below zero
  const neg = await db('wallet_tx').select('user_id').sum({ s: 'amount' }).groupBy('user_id'); neg.forEach((r) => assert.ok(Number(r.s) >= 0));
  // expiring unpaid reservations releases them and the stage plan still holds for paid ones
  await db('holdings').where({ status: 'unpaid' }).update({ reserved_until: new Date(Date.now() - 1000) });
  await all([units.expireReservations(), units.expireReservations()]);
  const left = Number((await db('holdings').where({ status: 'unpaid' }).count({ n: '*' }).first()).n); assert.equal(left, 0);
});

test('11. every money movement sent an email receipt with a unique number and the right amount', async () => {
  const pays = await db('payments').where({ status: 'success' });
  const rc = await db('emails').where({ category: 'receipts', direction: 'in' }).whereNotNull('receipt_no');
  const payRc = rc.filter((e) => /payment received/i.test(e.subject));
  assert.equal(payRc.length, pays.length, 'one payment receipt per successful payment');
  assert.equal(payRc.reduce((a, e) => a + Number(e.amount), 0), pays.reduce((a, p) => a + Number(p.amount), 0), 'receipt amounts add up');
  const payoutTx = await db('wallet_tx').where({ type: 'payout' });
  const payoutRc = await db('emails').where({ category: 'payouts', direction: 'out' }).where('subject', 'like', 'Payout %');
  assert.equal(payoutRc.length, payoutTx.length, 'one payout advice per payout');
  const red = await db('redemptions').where({ status: 'settled' });
  assert.equal((await db('emails').where({ category: 'payouts' }).where('subject', 'like', 'Redemption%').count({ n: '*' }).first()).n, red.length);
  const delivered = await db('deliveries').where({ status: 3 });
  assert.equal(Number((await db('emails').where({ category: 'delivery', direction: 'goods' }).count({ n: '*' }).first()).n), delivered.length, 'goods-received note per delivery');
  const nos = (await db('emails').whereNotNull('receipt_no').select('receipt_no')).map((x) => x.receipt_no);
  assert.equal(new Set(nos).size, nos.length, 'receipt numbers are unique'); nos.forEach((n) => assert.match(n, /^TFK-\d{4}-\d{6}$/));
  const one = payRc[0]; assert.match(one.body_html, /Payment receipt/); assert.match(one.body_text, /Total paid: ₦/); assert.match(one.subject, / · TFK-/);
  const list = (await sup.get('/api/admin/emails?receipts=1&limit=1000')).body;
  assert.ok(list.emails.length >= payRc.length && list.summary.find((x) => x.category === 'receipts').count >= payRc.length);
  assert.ok((await sup.get('/api/admin/emails?q=' + encodeURIComponent(one.receipt_no))).body.emails.some((e) => e.id === one.id), 'search by receipt number');
});
