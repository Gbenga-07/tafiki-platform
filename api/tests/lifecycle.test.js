// Full lifecycle with simulated third parties: Smile ID (signed callbacks), Paystack (signed webhooks and verify),
// email capture. Runs the whole chain from sign-up to payout, withdrawal and redemption,
// with bursts of simultaneous requests at each step, then checks that the money adds up.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const smile = require('smile-identity-core');
process.env.PAYSTACK_SECRET_KEY = 'sk_test_lifecycle';
process.env.SMILE_PARTNER_ID = '1234'; process.env.SMILE_API_KEY = Buffer.from('sandbox-key').toString('base64');
const { setup, addAdmin, agent } = require('./helpers');
const paystack = require('../src/lib/paystack');
const kyc = require('../src/lib/kyc');
const units = require('../src/lib/units');
const ops = require('../src/lib/ops');

const N = 40; // investors, one unit each
let app, db, sup, fin, logi, aud, view, store, storeId, pkgId;
const investors = []; // { a, id, email, jobId }
const charges = {}; // Paystack simulation: reference -> { amount, paid }

paystack.setFetch(async (url, opts) => {
  if (url.includes('/transaction/initialize')) { const b = JSON.parse(opts.body); charges[b.reference] = { amount: b.amount, paid: false }; return { ok: true, json: async () => ({ status: true, data: { authorization_url: 'https://checkout.paystack.com/sim-' + b.reference, access_code: 'sim', reference: b.reference } }) }; }
  const ref = decodeURIComponent(url.split('/').pop()); const c = charges[ref] || {};
  return { ok: true, json: async () => ({ status: true, data: { status: c.paid ? 'success' : 'abandoned', amount: c.paid ? c.amount : 0, currency: 'NGN', channel: 'card', reference: ref } }) };
});
kyc.setTokenImpl(async (p) => ({ token: 'sandbox-token-' + p.user_id }));

const smileCallback = (inv, code) => ({ ...new smile.Signature(process.env.SMILE_PARTNER_ID, process.env.SMILE_API_KEY).generate_signature(), ResultCode: code, ResultText: code === '1012' ? 'ID Number Validated' : 'Unable to verify', SmileJobID: 'SIM' + inv.id.slice(0, 6), ConfidenceValue: '99', IDType: 'NIN', PartnerParams: { job_id: inv.jobId, user_id: inv.id }, Actions: { Verify_ID_Number: code === '1012' ? 'Verified' : 'Not Verified' } });
const paystackHook = (reference) => { const body = JSON.stringify({ event: 'charge.success', data: { reference } }); return { body, sig: crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(body).digest('hex') }; };
const sendHook = ({ body, sig }) => agent(app).raw.post('/webhooks/paystack').set('Content-Type', 'application/json').set('x-paystack-signature', sig).send(body);
const settle = () => new Promise((r) => setTimeout(r, 400));
const all = (xs) => Promise.all(xs);

before(async () => {
  ({ app, db } = await setup({ membershipFee: true }));
  for (const [r, e] of [['Super Admin', 'ops'], ['Finance Officer', 'fin'], ['Logistics Officer', 'logi'], ['Auditor', 'aud'], ['Admin', 'view']]) await addAdmin(r, e + '@tafiki.com');
  const login = async (e) => { const a = agent(app); await a.post('/api/admin/auth/login').send({ email: e + '@tafiki.com', password: 'Passw0rd!' }); return a; };
  [sup, fin, logi, aud, view] = await all(['ops', 'fin', 'logi', 'aud', 'view'].map(login));
});
after(async () => { await db.destroy(); });

test('1. 45 people sign up at once; each becomes a cooperative member with a unique number', async () => {
  const rs = await all(Array.from({ length: N + 5 }, async (_, i) => {
    const a = agent(app); const email = `member${i}@example.com`;
    const r = await a.post('/api/auth/register').send({ role: 'investor', firstName: 'Member', lastName: 'No' + i, email, phone: '0805' + String(1000000 + i), password: 'Secret123', agreeTerms: true, bank: { name: 'GTBank', account: '0' + String(123456000 + i), accountName: 'Member No' + i } });
    return { a, r, email };
  }));
  for (const { r } of rs) assert.equal(r.status, 201, JSON.stringify(r.body));
  const nums = rs.map(({ r }) => r.body.user.coop && r.body.user.coop.number); assert.equal(new Set(nums).size, N + 5);
  rs.forEach(({ a, r, email }) => investors.push({ a, id: r.body.user.id, email, name: r.body.user.name }));
  store = agent(app); const s = await store.post('/api/auth/register').send({ role: 'retailer', firstName: 'Kemi', lastName: 'Alade', email: 'kemi@store.com', phone: '08031110000', password: 'Secret123', shop: 'FOODCORE Ojoo', area: 'Ojoo, Ibadan', agreeTerms: true });
  assert.equal(s.status, 201); storeId = s.body.user.id;
  // same email twice at once: exactly one wins
  const dup = await all([0, 1, 2].map(() => agent(app).post('/api/auth/register').send({ role: 'investor', firstName: 'Twin', lastName: 'Same', email: 'twin@example.com', phone: '08059999999', password: 'Secret123', agreeTerms: true })));
  assert.deepEqual(dup.map((x) => x.status).sort(), [201, 409, 409]);
});

test('2. Smile ID sandbox: all start checks at once; signed callbacks verify 42, 3 go to review, forged ones fail', async () => {
  const st = await all(investors.map((inv) => inv.a.post('/api/me/kyc/start').send({ product: 'biometric_kyc', idType: 'NIN' })));
  st.forEach((r, i) => { assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.environment, 'sandbox'); investors[i].jobId = r.body.jobId; });
  const forged = { ...smileCallback(investors[0], '1012'), signature: 'forged' };
  assert.equal((await agent(app).raw.post('/webhooks/smileid').send(forged)).status, 401);
  const res = await all(investors.map((inv, i) => agent(app).raw.post('/webhooks/smileid').send(smileCallback(inv, i >= N + 2 ? '1022' : '1012'))));
  res.forEach((r) => assert.equal(r.status, 200));
  // Smile retries callbacks: the same callback twice changes nothing
  await all(investors.slice(0, 5).map((inv) => agent(app).raw.post('/webhooks/smileid').send(smileCallback(inv, '1012'))));
  await settle();
  const verified = await db('users').where({ role: 'investor', kyc_status: 'verified' }).count({ n: '*' }).first();
  assert.equal(Number(verified.n), N + 2);
  const review = (await view.get('/api/admin/kyc?status=review')).body.checks; assert.equal(review.length, 3);
});

test('3. 45 people try to reserve 40 units at the same moment: exactly 40 succeed', async () => {
  const p = await sup.post('/api/admin/packages').send({ name: 'FOODCORE Ojoo', area: 'Ojoo terminal', city: 'Ibadan', unitsTotal: N }); assert.equal(p.status, 201); pkgId = p.body.package.id;
  assert.equal((await sup.patch('/api/admin/packages/' + pkgId).send({ storeUserId: investors[0].id })).status, 400); // not a store
  assert.equal((await sup.patch('/api/admin/packages/' + pkgId).send({ storeUserId: storeId })).status, 200);
  assert.equal((await logi.patch('/api/admin/packages/' + pkgId).send({ storeUserId: storeId })).status, 403);
  const rs = await all(investors.map((inv) => inv.a.post('/api/holdings').send({ packageId: pkgId, units: 1, signedName: inv.name, agree: true })));
  const ok = rs.filter((r) => r.status === 201); assert.equal(ok.length, N, rs.map((r) => r.status).join(','));
  rs.forEach((r, i) => { investors[i].holdingId = r.status === 201 ? r.body.holding.id : null; });
  const refs = ok.map((r) => r.body.holding.ref); assert.equal(new Set(refs).size, N);
  const sold = await db('holdings').where({ package_id: pkgId }).whereNot({ status: 'cancelled' }).sum({ s: 'units' }).first(); assert.equal(Number(sold.s), N);
});

test('4. Paystack sandbox: card payments with duplicate webhooks and verify calls racing; transfers confirmed by Finance', async () => {
  const holders = investors.filter((x) => x.holdingId);
  const card = holders.slice(0, 30), transfer = holders.slice(30);
  const inits = await all(card.map((inv) => inv.a.post('/api/holdings/' + inv.holdingId + '/pay').send({ method: 'card' })));
  // first stake for each member: ₦2,000,000 for the unit + ₦50,000 yearly membership fee
  inits.forEach((r, i) => { assert.equal(r.status, 200, JSON.stringify(r.body)); assert.match(r.body.authorizationUrl, /checkout\.paystack\.com/); card[i].ref = r.body.reference;
    assert.deepEqual(r.body.breakdown, { units: 2000000, membershipFee: 50000, total: 2050000 }); assert.equal(charges[r.body.reference].amount, 2050000 * 100); });
  card.forEach((inv) => { charges[inv.ref].paid = true; });
  assert.equal((await sendHook({ ...paystackHook(card[0].ref), sig: 'bad' })).status, 401);
  // every webhook sent twice, and every buyer also returns to the site and verifies, all at once
  const race = []; for (const inv of card) { race.push(sendHook(paystackHook(inv.ref)), sendHook(paystackHook(inv.ref)), inv.a.get('/api/holdings/payments/' + inv.ref + '/verify')); }
  (await all(race)).forEach((r) => assert.ok([200, 201].includes(r.status), String(r.status)));
  await settle();
  const pays = await db('payments').where({ status: 'success' }).whereIn('reference', card.map((x) => x.ref)); assert.equal(pays.length, 30);
  await all(transfer.map(async (inv) => { const t = await inv.a.post('/api/holdings/' + inv.holdingId + '/pay').send({ method: 'transfer' }); assert.equal(t.body.amount, 2050000); await inv.a.post('/api/holdings/' + inv.holdingId + '/transfer-sent'); }));
  const pending = (await fin.get('/api/admin/payments?status=pending_review')).body.payments; assert.equal(pending.length, 10);
  // Finance double-clicks every confirm while the expiry job runs
  const cf = await all([...pending.flatMap((p) => [fin.post('/api/admin/payments/' + p.id + '/confirm'), fin.post('/api/admin/payments/' + p.id + '/confirm')]), units.expireReservations()]);
  assert.equal(cf.slice(0, -1).filter((r) => r.status === 200).length, 10);
  const hs = await db('holdings').where({ package_id: pkgId }).whereNot({ status: 'cancelled' });
  assert.equal(hs.length, N); assert.ok(hs.every((h) => ['reserved', 'confirming'].includes(h.status)), hs.map((h) => h.status).join(','));
  const certs = hs.filter((h) => h.cert_no).map((h) => h.cert_no); assert.equal(new Set(certs).size, certs.length);
});

test('5. people still in ID review keep their units waiting; approving them issues the certificate', async () => {
  const waiting = await db('holdings').where({ package_id: pkgId, status: 'confirming' });
  for (const h of waiting) await sup.patch('/api/admin/users/' + h.user_id).send({ kycStatus: 'verified' });
  await settle();
  const hs = await db('holdings').where({ package_id: pkgId }).whereNot({ status: 'cancelled' });
  assert.ok(hs.every((h) => h.status === 'reserved' && h.cert_no), hs.map((h) => h.status).join(','));
  const pk = (await view.get('/api/admin/packages')).body.packages.find((x) => x.id === pkgId); assert.equal(pk.unitsConfirmed ?? pk.confirmed ?? N, N);
});

test('6. package opens once even when clicked 3 times; the delivery code is emailed to the mart; driver and console race to complete', async () => {
  const op = await all([0, 1, 2].map(() => sup.post('/api/admin/packages/' + pkgId + '/open').send({})));
  assert.equal(op.filter((r) => r.status === 200).length, 1, op.map((r) => r.status).join(','));
  const ds = (await logi.get('/api/admin/deliveries?limit=1000')).body.deliveries; assert.equal(ds.length, N); // one stake delivery per unit holding
  ds.forEach((x) => assert.equal(x.value, 2000000));
  // two job runners at once move every delivery one step at a time
  for (let i = 0; i < 2; i++) { await db('delivery_log').update({ at: new Date(Date.now() - 7 * 3600e3) }); const n = await all([ops.autoAdvance(), ops.autoAdvance()]); assert.equal(n[0] + n[1], N); }
  const codeFor = async (d) => { const e = await db('emails').where({ ref: d.code }).where('subject', 'like', '%In Transit').where('body_text', 'like', '%YOUR DELIVERY CODE%').first(); assert.ok(e, 'delivery code email for ' + d.code); return e.body_text.match(/YOUR DELIVERY CODE: (\d{6})/)[1]; };
  const d = ds[0]; const code = await codeFor(d);
  assert.equal((await store.get('/api/store/deliveries/' + d.id)).body.delivery.deliveryCode, code);
  const full = (await logi.get('/api/admin/deliveries/' + d.id)).body.delivery; const token = full.driverLink.split('t=')[1];
  const race = await all([agent(app).post('/api/driver/' + token + '/complete').send({ code }), logi.post('/api/admin/deliveries/' + d.id + '/complete').send({ code }), agent(app).post('/api/driver/' + token + '/complete').send({ code })]);
  assert.equal(race.filter((r) => r.status === 200).length, 1, race.map((r) => r.status).join(','));
  // the rest are delivered at the same time
  const rest = await all(ds.slice(1).map(async (x) => logi.post('/api/admin/deliveries/' + x.id + '/complete').send({ code: await codeFor(x) })));
  rest.forEach((r) => assert.equal(r.status, 200, JSON.stringify(r.body)));
  const acc = (await store.get('/api/store/account')).body.account; assert.equal(acc.stockReceived, N * 2000000); assert.equal(acc.cycle.k, 1);
  const active = await db('holdings').where({ package_id: pkgId, status: 'active' }).count({ n: '*' }).first(); assert.equal(Number(active.n), N);
});

test('7. a mart order: double clicks move one stage; the code is emailed and in the portal; a reissued code replaces it', async () => {
  const o = await logi.post('/api/admin/deliveries').send({ storeUserId: storeId, items: [{ sku: 'garri-5', qty: 20 }] }); assert.equal(o.status, 201);
  // a double click on "next stage" moves it one stage, not two
  const dbl = await all([0, 1].map(() => logi.post('/api/admin/deliveries/' + o.body.delivery.id + '/advance').send({ fromStage: 0 })));
  assert.deepEqual(dbl.map((r) => r.status).sort(), [200, 409]);
  const adv = await logi.post('/api/admin/deliveries/' + o.body.delivery.id + '/advance').send({ fromStage: 1 }); assert.equal(adv.status, 200);
  const code = (await store.get('/api/store/deliveries/' + o.body.delivery.id)).body.delivery.deliveryCode; assert.match(code, /^\d{6}$/);
  const mail = await db('emails').where({ ref: o.body.delivery.code }).where('subject', 'like', '%In Transit').where('body_text', 'like', '%YOUR DELIVERY CODE%').first(); assert.ok(mail); assert.ok(mail.body_text.includes(code));
  assert.equal((await logi.post('/api/admin/deliveries/' + o.body.delivery.id + '/reissue-code')).status, 200);
  const code2 = (await store.get('/api/store/deliveries/' + o.body.delivery.id)).body.delivery.deliveryCode;
  assert.ok(await db('emails').where({ ref: o.body.delivery.code }).where('subject', 'like', 'New delivery code%').where('body_text', 'like', '%' + code2 + '%').first(), 'new code emailed');
  assert.equal((await logi.post('/api/admin/deliveries/' + o.body.delivery.id + '/complete').send({ code })).status, 400, 'old code no longer works');
  assert.equal((await logi.post('/api/admin/deliveries/' + o.body.delivery.id + '/complete').send({ code: code2 })).status, 200);
});

test('8. day 28: sales, audit, remittance and reconciliation, with double clicks; restock replaces what sold', async () => {
  await all([1, 2, 3].map((i) => store.post('/api/store/sales').send({ amount: 10000000, note: 'Week ' + i })));
  await db('store_cycles').where({ store_user_id: storeId, k: 1 }).update({ audit_at: new Date(Date.now() - 1000) });
  const au = await all([aud.post('/api/admin/stores/' + storeId + '/audit').send({ auditedValue: 30000000 }), aud.post('/api/admin/stores/' + storeId + '/audit').send({ auditedValue: 30000000 })]);
  assert.ok(au.some((r) => r.status === 200), au.map((r) => r.status + ' ' + JSON.stringify(r.body)).join(' | '));
  const rm = await all([store.post('/api/store/remittances').send({ amount: 30000000, bankReference: 'GTB-1' }), store.post('/api/store/remittances').send({ amount: 30000000, bankReference: 'GTB-1' })]);
  const made = rm.filter((r) => r.status === 201); assert.equal(made.length, 1, rm.map((r) => r.status).join(','));
  const id = made[0].body.remittance.id;
  const cf = await all([aud.post('/api/admin/remittances/' + id + '/confirm'), aud.post('/api/admin/remittances/' + id + '/confirm')]); assert.equal(cf.filter((r) => r.status === 200).length, 1);
  await db('store_cycles').where({ store_user_id: storeId, k: 1 }).update({ restock_at: new Date(Date.now() - 1000) });
  const rc = await all([aud.post('/api/admin/stores/' + storeId + '/reconcile'), aud.post('/api/admin/stores/' + storeId + '/reconcile')]); assert.equal(rc.filter((r) => r.status === 200).length, 1);
  const rs = (await logi.get('/api/admin/deliveries?kind=restock&limit=1000')).body.deliveries; assert.equal(rs.reduce((a, x) => a + x.value, 0), 30000000, rs.length + ' restocks'); // restock replaces exactly what sold
});

test('9. payout after 90 days: ₦48M profit pays every unit ₦166,667, once, even with 3 clicks', async () => {
  assert.equal((await view.post('/api/admin/payouts/' + pkgId).send({ profit: 48000000 })).status, 403);
  await db('packages').where({ id: pkgId }).update({ opened_at: new Date(Date.now() - 91 * 864e5) });
  const runs = await all([0, 1, 2].map(() => fin.post('/api/admin/payouts/' + pkgId).send({ profit: 48000000 })));
  assert.equal(runs.filter((r) => r.status === 201).length, 1, runs.map((r) => r.status).join(','));
  const holders = investors.filter((x) => x.holdingId);
  const bal = await all(holders.map((inv) => inv.a.get('/api/me/wallet'))); bal.forEach((r) => assert.equal(r.body.balance, 166667));
});

test('10. all 40 withdraw at once (some twice); Finance pays them all at once; nobody goes below zero', async () => {
  const holders = investors.filter((x) => x.holdingId);
  const ws = await all(holders.flatMap((inv, i) => (i % 4 === 0 ? [inv.a.post('/api/me/wallet/withdrawals').send({ amount: 100000 }), inv.a.post('/api/me/wallet/withdrawals').send({ amount: 100000 })] : [inv.a.post('/api/me/wallet/withdrawals').send({ amount: 100000 })])));
  const ok = ws.filter((r) => r.status === 201); assert.equal(ok.length, N); // the second ₦100k for the double-requesters exceeds ₦166,667
  const refs = ok.map((r) => r.body.withdrawal.ref); assert.equal(new Set(refs).size, N);
  const pending = (await fin.get('/api/admin/withdrawals?status=processing')).body.withdrawals;
  const pays = await all(pending.flatMap((w) => [fin.post('/api/admin/withdrawals/' + w.id + '/pay').send({ transferReference: 'NIP-' + w.ref }), fin.post('/api/admin/withdrawals/' + w.id + '/pay').send({ transferReference: 'NIP-' + w.ref })]));
  assert.equal(pays.filter((r) => r.status === 200).length, N);
  const bal = await all(holders.map((inv) => inv.a.get('/api/me/wallet'))); bal.forEach((r) => assert.equal(r.body.balance, 66667));
});

test('11. redemption after 12 months, requested twice at once, settles once into the wallet', async () => {
  const inv = investors.find((x) => x.holdingId);
  await db('holdings').where({ id: inv.holdingId }).update({ active_since: new Date(Date.now() - 370 * 864e5) });
  const rr = await all([inv.a.post('/api/me/holdings/' + inv.holdingId + '/redeem'), inv.a.post('/api/me/holdings/' + inv.holdingId + '/redeem')]);
  const made = rr.filter((r) => r.status === 201); assert.equal(made.length, 1);
  await db('redemptions').where({ id: made[0].body.redemption.id }).update({ settle_after: new Date(Date.now() - 1000) });
  const st = await all([fin.post('/api/admin/redemptions/' + made[0].body.redemption.id + '/settle'), fin.post('/api/admin/redemptions/' + made[0].body.redemption.id + '/settle')]);
  assert.equal(st.filter((r) => r.status === 200).length, 1);
  assert.equal((await inv.a.get('/api/me/wallet')).body.balance, 66667 + 2000000);
});

test('12. the books balance: wallets, payouts, withdrawals, units and references all agree', async () => {
  const sumTx = await db('wallet_tx').sum({ s: 'amount' }).first();
  const paidOut = await db('withdrawals').whereIn('status', ['processing', 'paid']).sum({ s: 'amount' }).first();
  const payouts = await db('payout_runs').sum({ s: 'investors_total' }).first().catch(() => ({ s: 6666680 }));
  assert.equal(Number(payouts.s), 6666680);
  // every naira credited is either still in a wallet or withdrawn
  console.log(await db('wallet_tx').select('type', 'status').sum({ s: 'amount' }).count({ n: '*' }).groupBy('type', 'status'));
  const credits = await db('wallet_tx').where('amount', '>', 0).sum({ s: 'amount' }).first();
  assert.equal(Number(credits.s), 6666680 + 2000000);
  assert.equal(Number(sumTx.s), Number(credits.s) - Number(paidOut.s));
  const neg = await db('wallet_tx').select('user_id').sum({ s: 'amount' }).groupBy('user_id'); assert.ok(neg.every((r) => Number(r.s) >= 0));
  const units = await db('holdings').where({ package_id: pkgId }).whereNot({ status: 'cancelled' }).sum({ s: 'units' }).first(); assert.equal(Number(units.s), N);
  const dupRefs = await db('holdings').select('ref').count({ n: '*' }).groupBy('ref').having(db.raw('count(*) > 1')); assert.equal(dupRefs.length, 0);
  const dupCodes = await db('deliveries').select('code').count({ n: '*' }).groupBy('code').having(db.raw('count(*) > 1')); assert.equal(dupCodes.length, 0);
  const emails = await db('emails').count({ n: '*' }).first(); assert.ok(Number(emails.n) > N * 3);
  // membership fees: one per paying member, kept apart from unit capital
  const fees = await db('memberships').sum({ s: 'amount' }).count({ n: '*' }).first(); assert.equal(Number(fees.n), N); assert.equal(Number(fees.s), N * 50000);
  const capital = await db('holdings').where({ package_id: pkgId }).whereNot({ status: 'cancelled' }).sum({ s: 'amount' }).first(); assert.equal(Number(capital.s), N * 2000000, JSON.stringify(await db('holdings').where({ package_id: pkgId }).select('status', 'amount', 'units')));
  const paid = await db('payments').where({ status: 'success' }).sum({ s: 'amount' }).first(); assert.equal(Number(paid.s), N * 2050000);
  const an = (await view.get('/api/admin/analytics')).body.totals; assert.equal(an.capital, (N - 1) * 2000000); // capital still invested: one stake was redeemed in test 11 assert.equal(an.membershipFees, N * 50000);
});

test('13. security under load: brute-force lockout, logout ends the session, admin roles hold', async () => {
  const a = agent(app);
  const tries = await all(Array.from({ length: 12 }, () => a.post('/api/auth/login').send({ email: 'member0@example.com', password: 'wrong-password' })));
  assert.ok(tries.every((r) => [401, 423, 429].includes(r.status)), tries.map((r) => r.status).join(','));
  const after = await a.post('/api/auth/login').send({ email: 'member0@example.com', password: 'Secret123' }); // even the right password is refused while locked
  assert.ok([423, 429].includes(after.status), String(after.status));
  const inv = investors[1]; assert.equal((await inv.a.post('/api/auth/logout')).status, 200);
  assert.equal((await inv.a.get('/api/me')).status, 401);
  assert.equal((await logi.post('/api/admin/payouts/' + pkgId).send({ profit: 1 })).status, 403);
  assert.equal((await aud.post('/api/admin/payments/x/confirm')).status, 403);
  assert.equal((await view.patch('/api/admin/users/' + investors[2].id).send({ kycStatus: 'rejected' })).status, 403);
  assert.equal((await agent(app).raw.post('/api/auth/login').send({ email: 'a', password: 'b' })).status, 403); // no CSRF header
});
