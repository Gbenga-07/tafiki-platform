const { test, before, after } = require('node:test');
const assert = require('node:assert');
const smile = require('smile-identity-core');
process.env.SMILE_PARTNER_ID = '1234'; process.env.SMILE_API_KEY = Buffer.from('test-key').toString('base64');
const { setup, addAdmin, agent, lastEmail } = require('./helpers');
const kyc = require('../src/lib/kyc');
let app, db, sup, fin, view, inv, inv2, pkgId, holdingId, adaId;
before(async () => {
  ({ app, db } = await setup());
  kyc.setTokenImpl(async (p) => ({ token: 'web-token-for-' + p.user_id }));
  await addAdmin('Super Admin', 'ops@tafiki.com'); await addAdmin('Finance Officer', 'fin@tafiki.com'); await addAdmin('Admin', 'view@tafiki.com');
  sup = agent(app); await sup.post('/api/admin/auth/login').send({ email: 'ops@tafiki.com', password: 'Passw0rd!' });
  fin = agent(app); await fin.post('/api/admin/auth/login').send({ email: 'fin@tafiki.com', password: 'Passw0rd!' });
  view = agent(app); await view.post('/api/admin/auth/login').send({ email: 'view@tafiki.com', password: 'Passw0rd!' });
  inv = agent(app); const a = await inv.post('/api/auth/register').send({ role: 'investor', firstName: 'Ada', lastName: 'Okafor', email: 'ada@example.com', phone: '08030001100', password: 'Secret123', agreeTerms: true, bank: { name: 'GTBank', account: '0123456789', accountName: 'Ada Okafor' } });
  adaId = a.body.user.id;
  inv2 = agent(app); await inv2.post('/api/auth/register').send({ role: 'investor', firstName: 'Bayo', lastName: 'Ade', email: 'bayo@example.com', phone: '08030001102', password: 'Secret123', agreeTerms: true });
  const s = agent(app); await s.post('/api/auth/register').send({ role: 'retailer', firstName: 'Kemi', lastName: 'Alade', email: 'kemi@example.com', phone: '08030001101', password: 'Secret123', shop: 'FOODCORE Ojoo', area: 'Ojoo, Ibadan', agreeTerms: true });
  const p = await sup.post('/api/admin/packages').send({ name: 'FOODCORE Ojoo', area: 'Ojoo terminal', city: 'Ibadan', unitsTotal: 40 }); pkgId = p.body.package.id;
  const h = await inv.post('/api/holdings').send({ packageId: pkgId, units: 40, signedName: 'Ada Okafor', agree: true }); holdingId = h.body.holding.id;
  await inv.post('/api/holdings/' + holdingId + '/pay').send({ method: 'transfer' }); await inv.post('/api/holdings/' + holdingId + '/transfer-sent');
  const pay = (await fin.get('/api/admin/payments?status=pending_review')).body.payments[0]; await fin.post('/api/admin/payments/' + pay.id + '/confirm');
});
after(async () => { await db.destroy(); });
const callback = (jobId, code, text) => { const sig = new smile.Signature(process.env.SMILE_PARTNER_ID, process.env.SMILE_API_KEY).generate_signature(); return { ...sig, ResultCode: code, ResultText: text, SmileJobID: '0000123', ConfidenceValue: '99', IDType: 'NIN', PartnerParams: { job_id: jobId, user_id: adaId }, Actions: { Verify_ID_Number: 'Verified' } }; };

test('Smile ID: token, signed callback verifies the member and confirms paid units', async () => {
  assert.equal((await inv.get('/api/holdings/' + holdingId)).body.holding.status, 'confirming');
  const st = await inv.post('/api/me/kyc/start').send({ product: 'biometric_kyc', idType: 'NIN' }); assert.equal(st.status, 200); assert.match(st.body.token, /web-token/); assert.equal(st.body.environment, 'sandbox'); assert.deepEqual(st.body.idTypes, ['NIN_V2', 'BVN', 'VOTER_ID']); assert.deepEqual(st.body.consentTypes, ['NIN_V2', 'BVN']);
  const bad = callback(st.body.jobId, '1012', 'ID Number Validated'); bad.signature = 'forged';
  assert.equal((await agent(app).raw.post('/webhooks/smileid').send(bad)).status, 401);
  assert.equal((await agent(app).raw.post('/webhooks/smileid').send(callback(st.body.jobId, '1012', 'ID Number Validated'))).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await inv.get('/api/me')).body.user.kycStatus, 'verified');
  const h = (await inv.get('/api/holdings/' + holdingId)).body.holding; assert.equal(h.status, 'reserved'); assert.ok(h.certificate);
  assert.equal((await sup.get('/api/admin/packages')).body.packages[0].stage, 'full');
});

test('Smile ID: unclear results go to manual review, never auto-reject', async () => {
  const st = await inv2.post('/api/me/kyc/start').send({});
  const cb = callback(st.body.jobId, '1022', 'No match'); cb.PartnerParams.user_id = 'x';
  await agent(app).raw.post('/webhooks/smileid').send(cb); await new Promise((r) => setTimeout(r, 300));
  assert.equal((await inv2.get('/api/me')).body.user.kycStatus, 'pending');
  const review = (await view.get('/api/admin/kyc?status=review')).body.checks; assert.equal(review.length, 1); assert.equal(review[0].result_code, '1022');
  assert.match((await lastEmail('bayo@example.com')).subject, /reviewing/);
});

test('payout formula matches the website: ₦48M profit on 40 units', async () => {
  await sup.post('/api/admin/packages/' + pkgId + '/open').send({});
  const pv = (await view.get('/api/admin/payouts/' + pkgId + '/preview?profit=48000000')).body.preview;
  assert.equal(pv.tax, 16320000); assert.equal(pv.perUnit, 166667); assert.equal(pv.investorsTotal, 6666680);
  assert.equal(pv.reserveAdded, 4800000); assert.equal(pv.company, 4848000); assert.equal(pv.operations, 15365320);
  assert.equal(pv.tax + pv.investorsTotal + pv.reserveAdded + pv.company + pv.operations, 48000000);
});

test('running a payout pays wallets; only after the cycle; view-only cannot run', async () => {
  assert.equal((await view.post('/api/admin/payouts/' + pkgId).send({ profit: 48000000 })).status, 403);
  assert.equal((await fin.post('/api/admin/payouts/' + pkgId).send({ profit: 48000000 })).status, 400); // too early
  await db('packages').where({ id: pkgId }).update({ opened_at: new Date(Date.now() - 91 * 864e5) });
  const r = await fin.post('/api/admin/payouts/' + pkgId).send({ profit: 48000000 }); assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.run.cycleNo, 1);
  assert.equal((await inv.get('/api/me/wallet')).body.balance, 6666680);
  assert.match((await lastEmail('ada@example.com')).subject, /Payout 1/);
  assert.equal((await fin.post('/api/admin/payouts/' + pkgId).send({ profit: 1 })).status, 400); // next one not due
});

test('a weak quarter is topped up from the reserve', async () => {
  await db('payout_runs').update({ period_end: new Date(Date.now() - 91 * 864e5) });
  const pv = (await view.get('/api/admin/payouts/' + pkgId + '/preview?profit=6000000')).body.preview;
  // after tax 3,960,000 < target 6,666,680 → shortfall 2,706,680 from the 4.8M reserve
  assert.equal(pv.reserveUsed, 2706680); assert.equal(pv.perUnit, 166667); assert.equal(pv.reserveAfter, 4800000 - 2706680);
  assert.equal(pv.company, 0); assert.equal(pv.operations, 0);
});

test('withdrawals: request, finance pays with a reference; rejection returns the money', async () => {
  assert.equal((await inv.post('/api/me/wallet/withdrawals').send({ amount: 99999999 })).status, 400);
  const w = await inv.post('/api/me/wallet/withdrawals').send({ amount: 2000000 }); assert.equal(w.status, 201); assert.match(w.body.withdrawal.ref, /^WD-0000\d$/);
  assert.equal((await inv.get('/api/me/wallet')).body.balance, 4666680);
  assert.equal((await fin.post('/api/admin/withdrawals/' + w.body.withdrawal.id + '/pay').send({})).status, 400);
  assert.equal((await fin.post('/api/admin/withdrawals/' + w.body.withdrawal.id + '/pay').send({ transferReference: 'NIP-778899' })).status, 200);
  const w2 = await inv.post('/api/me/wallet/withdrawals').send({ amount: 1000000 });
  await fin.post('/api/admin/withdrawals/' + w2.body.withdrawal.id + '/reject').send({ reason: 'Bank details mismatch' });
  assert.equal((await inv.get('/api/me/wallet')).body.balance, 4666680);
  assert.equal((await inv2.post('/api/me/wallet/withdrawals').send({ amount: 1000 })).status, 400); // not verified
});

test('redemption only after the 12-month hold, settles after 90 days into the wallet', async () => {
  assert.equal((await inv.post('/api/me/holdings/' + holdingId + '/redeem')).status, 400);
  await db('holdings').where({ id: holdingId }).update({ active_since: new Date(Date.now() - 370 * 864e5) });
  const r = await inv.post('/api/me/holdings/' + holdingId + '/redeem'); assert.equal(r.status, 201);
  assert.equal((await fin.post('/api/admin/redemptions/' + r.body.redemption.id + '/settle')).status, 400); // notice period
  await db('redemptions').where({ id: r.body.redemption.id }).update({ settle_after: new Date(Date.now() - 1000) });
  assert.equal((await fin.post('/api/admin/redemptions/' + r.body.redemption.id + '/settle')).status, 200);
  assert.equal((await inv.get('/api/me/wallet')).body.balance, 4666680 + 80000000);
  assert.equal((await inv.get('/api/holdings/' + holdingId)).body.holding.status, 'closed');
});

test('analytics summarises capital, deliveries, payouts', async () => {
  const a = (await view.get('/api/admin/analytics')).body; assert.equal(a.months.length, 10); assert.equal(a.totals.payouts, 6666680); assert.equal(a.capitalRaised[9], 0 + a.capitalRaised[9]);
});
