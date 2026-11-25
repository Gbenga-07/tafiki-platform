// Payout calculation (same formula as the website and console), wallets, withdrawals and redemptions.
// Order: tax on profit; unit holders paid first up to the target per unit; a shortfall is topped up from the
// package's payout reserve; per-unit payouts are kept under the annual cap; then the reserve top-up,
// FOODCORE's share, and the remainder to operations.
const { getDb } = require('../db');
const { uuid, bad, HttpError, now, addMinutes } = require('./util');
const { getTerms } = require('./terms');
const counters = require('./counters');
const { sendEmail } = require('./mailer');
const activity = require('./activity');
const N = (n) => '₦' + Number(n).toLocaleString('en-NG');
const DAY = 24 * 60;

async function reserveBalance(packageId) {
  const r = await getDb()('payout_runs').where({ package_id: packageId }).select(getDb().raw('COALESCE(SUM(reserve_added),0) as a'), getDb().raw('COALESCE(SUM(reserve_used),0) as u')).first();
  return Number(r.a) - Number(r.u);
}
async function eligibleHoldings(packageId) { return getDb()('holdings').where({ package_id: packageId }).whereIn('status', ['active', 'redeem']); }
async function paidPerUnitLastYear(packageId) {
  const since = addMinutes(now(), -365 * DAY);
  const r = await getDb()('payout_runs').where({ package_id: packageId }).where('created_at', '>=', since).sum({ s: 'per_unit' }).first();
  return Number(r.s) || 0;
}
async function calculate(packageId, profitIn) {
  const t = await getTerms(); const db = getDb();
  const p = await db('packages').where({ id: packageId }).first(); if (!p) throw new HttpError(404, 'Package not found.');
  if (p.stage !== 'trading') throw bad('Payouts are made only for packages that are trading.');
  const hs = await eligibleHoldings(packageId); const units = hs.reduce((a, h) => a + h.units, 0);
  if (!units) throw bad('No units are earning in this package.');
  const profit = Math.max(0, Math.round(Number(profitIn) || 0));
  const tax = Math.round(profit * (t.citRate + t.devLevy));
  const targetPerUnit = Math.round(t.unitPrice * t.targetPerCycle);
  const capLeft = Math.max(0, Math.round(t.unitPrice * t.capPct) - (await paidPerUnitLastYear(packageId)));
  const perUnitLimit = Math.min(targetPerUnit, capLeft);
  const capped = perUnitLimit < targetPerUnit;
  const target = perUnitLimit * units;
  const available = profit - tax; const reserve = await reserveBalance(packageId);
  let pool, reserveUsed = 0, left;
  if (available >= target) { pool = target; left = available - target; } else { reserveUsed = Math.min(target - available, reserve); pool = Math.max(0, available) + reserveUsed; left = 0; }
  const perUnit = Math.floor(pool / units); const investorsTotal = perUnit * units; left += pool - investorsTotal; // rounding stays in the business
  const reserveAdded = Math.min(left, Math.round(profit * t.reservePct)); left -= reserveAdded;
  const company = Math.min(left, Math.round(profit * t.companyPct)); left -= company;
  return { packageId, packageName: p.name, units, profit, tax, taxRate: t.citRate + t.devLevy, targetPerUnit, perUnit, investorsTotal, reserveBefore: reserve, reserveUsed, reserveAdded, reserveAfter: reserve - reserveUsed + reserveAdded, company, operations: left, capped, holdings: hs.map((h) => ({ id: h.id, ref: h.ref, userId: h.user_id, units: h.units, amount: h.units * perUnit })) };
}
async function run(packageId, profit, actor, note) {
  const db = getDb(); const t = await getTerms(); const c = await calculate(packageId, profit);
  const last = await db('payout_runs').where({ package_id: packageId }).orderBy('cycle_no', 'desc').first();
  const p = await db('packages').where({ id: packageId }).first();
  const start = last ? new Date(last.period_end) : new Date(p.opened_at);
  if (Date.now() - start.getTime() < (t.cycleDays - 3) * DAY * 60000) throw bad(`The next payout for ${p.name} is due after ${new Date(start.getTime() + t.cycleDays * DAY * 60000).toDateString()}.`);
  const id = uuid(); const cycleNo = last ? last.cycle_no + 1 : 1;
  await db.transaction(async (trx) => {
    await trx('payout_runs').insert({ id, package_id: packageId, cycle_no: cycleNo, period_start: start, period_end: now(), profit: c.profit, tax: c.tax, units: c.units, per_unit: c.perUnit, investors_total: c.investorsTotal, reserve_used: c.reserveUsed, reserve_added: c.reserveAdded, company: c.company, operations: c.operations, capped: c.capped, note: note || null, created_by: actor.id });
    for (const h of c.holdings) if (h.amount > 0) await trx('wallet_tx').insert({ id: uuid(), user_id: h.userId, type: 'payout', amount: h.amount, status: 'completed', memo: `${p.name} · payout ${cycleNo}`, ref: h.ref, payout_run_id: id, holding_id: h.id, created_at: new Date() });
  });
  for (const h of c.holdings) { const u = await db('users').where({ id: h.userId }).first(); if (h.amount > 0) await sendEmail({ to: u.email, name: u.name.split(' ')[0], category: 'payouts', ref: h.ref, subject: `Payout ${cycleNo} from ${p.name}: ${N(h.amount)}`, paragraphs: [`Your payout for cycle ${cycleNo} of ${p.name} has been paid into your Tafiki wallet.`, 'You can withdraw it to your bank account from your dashboard at any time.'], receipt: { title: 'Payout advice', amount: h.amount, direction: 'out', rows: [['Paid to', `${u.name}${u.coop_no ? ' · ' + u.coop_no : ''}`], ['FOODCORE Mart', p.name], ['Cycle', `${cycleNo} · ${new Date(start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} to ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`], ['Stake reference', h.ref], ['Units', `${h.units} × ${N(c.perUnit)} per unit`], ['Paid into', 'Tafiki wallet'], ['Wallet balance now', N(await walletBalance(u.id))]], total: ['Payout', N(h.amount)], note: 'Payouts come from the mart’s realised profit. Targets are not guaranteed.' } }); }
  await activity.log(actor, 'payout.run', { type: 'package', id: packageId }, { cycleNo, profit: c.profit, perUnit: c.perUnit, investors: c.investorsTotal });
  return { id, cycleNo, ...c };
}

async function walletBalance(userId) {
  const r = await getDb()('wallet_tx').where({ user_id: userId }).whereIn('status', ['completed', 'processing']).sum({ s: 'amount' }).first();
  return Number(r.s) || 0;
}
async function requestWithdrawal(user, amount) {
  const db = getDb(); amount = Math.round(Number(amount));
  if (!(amount >= 1000)) throw bad('The minimum withdrawal is ₦1,000.');
  if (user.kyc_status !== 'verified') throw bad('Your identity must be verified before you can withdraw.');
  if (!user.bank_account) throw bad('Add your bank account first.');
  const id = uuid(); let ref;
  // The member's row is locked while the balance is checked and the withdrawal written, so parallel requests queue.
  await counters.retry(() => db.transaction(async (trx) => {
    await trx('users').where({ id: user.id }).forUpdate().first();
    const r = await trx('wallet_tx').where({ user_id: user.id }).whereIn('status', ['completed', 'processing']).sum({ s: 'amount' }).first();
    const bal = Number(r.s) || 0; if (amount > bal) throw bad(`You can withdraw up to ${N(bal)}.`);
    ref = 'WD-' + String(await counters.next('withdrawal', 1, trx)).padStart(5, '0');
    await trx('withdrawals').insert({ id, ref, user_id: user.id, amount, bank_name: user.bank_name, bank_account: user.bank_account, bank_account_name: user.bank_account_name, status: 'processing' });
    await trx('wallet_tx').insert({ id: uuid(), user_id: user.id, type: 'withdrawal', amount: -amount, status: 'processing', memo: `To ${user.bank_name} ••${String(user.bank_account).slice(-4)}`, ref, withdrawal_id: id, created_at: new Date() });
  }));
  await activity.log({ type: 'user', id: user.id }, 'wallet.withdrawal_requested', { type: 'withdrawal', id }, { ref, amount });
  await sendEmail({ to: user.email, name: user.name.split(' ')[0], category: 'wallet', ref, subject: `Withdrawal ${ref} received`, paragraphs: [`We have received your request to withdraw ${N(amount)} to ${user.bank_name} ••${String(user.bank_account).slice(-4)}. It is usually paid within two working days, and you will get a payment advice when it is sent.`, 'If you did not ask for this withdrawal, reply to this email or call us straight away.'] });
  return db('withdrawals').where({ id }).first();
}
async function decideWithdrawal(id, ok, actor, { transferReference, reason } = {}) {
  const db = getDb(); const w = await db('withdrawals').where({ id }).first(); if (!w) throw new HttpError(404, 'Withdrawal not found.');
  if (w.status !== 'processing') throw bad('This withdrawal has already been decided.');
  if (ok && !transferReference) throw bad('Enter the bank transfer reference.');
  const won = await db.transaction(async (trx) => {
    const n = await trx('withdrawals').where({ id, status: 'processing' }).update({ status: ok ? 'paid' : 'rejected', transfer_reference: transferReference || null, reason: reason || null, decided_by: actor.id, decided_at: now() });
    if (n) await trx('wallet_tx').where({ withdrawal_id: id }).update({ status: ok ? 'completed' : 'rejected' });
    return n;
  });
  if (!won) throw bad('This withdrawal has already been decided.');
  const u = await db('users').where({ id: w.user_id }).first();
  if (ok) await sendEmail({ to: u.email, name: u.name.split(' ')[0], category: 'payouts', ref: w.ref, subject: `Withdrawal ${w.ref} paid: ${N(w.amount)}`, paragraphs: [`${N(w.amount)} has been sent to your bank account. Depending on your bank it can take a few hours to show.`], receipt: { title: 'Payment advice', amount: Number(w.amount), direction: 'out', rows: [['Paid to', `${w.bank_account_name || u.name}`], ['Bank', `${w.bank_name} ••${String(w.bank_account).slice(-4)}`], ['Withdrawal reference', w.ref], ['Bank transfer reference', transferReference], ['Requested', new Date(w.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })], ['Wallet balance now', N(await walletBalance(u.id))]], total: ['Amount paid', N(w.amount)] } });
  else await sendEmail({ to: u.email, name: u.name.split(' ')[0], category: 'wallet', ref: w.ref, subject: `Withdrawal ${w.ref} was not paid`, paragraphs: [`We could not pay your withdrawal of ${N(w.amount)}${reason ? ': ' + reason : ''}. The full amount is back in your wallet (balance ${N(await walletBalance(u.id))}).`] });
  await activity.log(actor, ok ? 'wallet.withdrawal_paid' : 'wallet.withdrawal_rejected', { type: 'withdrawal', id }, { ref: w.ref });
  return db('withdrawals').where({ id }).first();
}

async function requestRedemption(user, holdingId) {
  const db = getDb(); const t = await getTerms(); const h = await db('holdings').where({ id: holdingId, user_id: user.id }).first();
  if (!h) throw new HttpError(404, 'Not found.');
  if (h.status !== 'active') throw bad('Only units that are earning can be redeemed.');
  const since = new Date(h.active_since || h.created_at); const opens = new Date(since); opens.setMonth(opens.getMonth() + t.minHoldMonths);
  if (opens > now()) throw bad(`Redemption opens on ${opens.toDateString()}, after the ${t.minHoldMonths}-month minimum hold.`);
  const id = uuid(); const settleAfter = addMinutes(now(), 90 * DAY);
  if (!(await db('holdings').where({ id: h.id, status: 'active' }).update({ status: 'redeem' }))) throw bad('A redemption has already been requested for these units.');
  await db('redemptions').insert({ id, holding_id: h.id, user_id: user.id, amount: Number(h.amount), settle_after: settleAfter, status: 'requested' });
  await activity.log({ type: 'user', id: user.id }, 'units.redemption_requested', { type: 'holding', id: h.id }, { ref: h.ref });
  await sendEmail({ to: user.email, name: user.name.split(' ')[0], category: 'units', ref: h.ref, subject: `Redemption requested for ${h.ref}`, paragraphs: [`Your request to redeem ${h.units} unit${h.units > 1 ? 's' : ''} (${h.ref}) is recorded. After 90 days' notice it settles at the close of the next cycle, on or after ${settleAfter.toDateString()}.`, 'Your units keep earning payouts until then.'] });
  return db('redemptions').where({ id }).first();
}
async function cancelRedemption(user, holdingId) {
  const db = getDb(); const r = await db('redemptions').where({ holding_id: holdingId, user_id: user.id, status: 'requested' }).first(); if (!r) throw bad('There is no redemption request to cancel.');
  if (!(await db('redemptions').where({ id: r.id, status: 'requested' }).update({ status: 'cancelled' }))) throw bad('This redemption is no longer pending.');
  await db('holdings').where({ id: holdingId, status: 'redeem' }).update({ status: 'active' });
  await activity.log({ type: 'user', id: user.id }, 'units.redemption_cancelled', { type: 'holding', id: holdingId });
  return true;
}
async function settleRedemption(id, actor) {
  const db = getDb(); const r = await db('redemptions').where({ id }).first(); if (!r) throw new HttpError(404, 'Redemption not found.');
  if (r.status !== 'requested') throw bad('This redemption is not waiting to be settled.');
  if (new Date(r.settle_after) > now()) throw bad(`The notice period ends on ${new Date(r.settle_after).toDateString()}.`);
  const h = await db('holdings').where({ id: r.holding_id }).first();
  await db.transaction(async (trx) => {
    if (!(await trx('redemptions').where({ id, status: 'requested' }).update({ status: 'settled', settled_at: now(), decided_by: actor.id }))) throw bad('This redemption is not waiting to be settled.');
    await trx('holdings').where({ id: h.id }).update({ status: 'closed' });
    await trx('wallet_tx').insert({ id: uuid(), user_id: r.user_id, type: 'redemption', amount: Number(r.amount), status: 'completed', memo: `Redemption of ${h.ref}`, ref: h.ref, holding_id: h.id, created_at: new Date() });
  });
  const u = await db('users').where({ id: r.user_id }).first();
  const rp = await db('packages').where({ id: h.package_id }).first();
  await sendEmail({ to: u.email, name: u.name.split(' ')[0], category: 'payouts', ref: h.ref, subject: `Redemption of ${h.ref} settled: ${N(r.amount)}`, paragraphs: [`Your redemption is settled and your unit capital has been paid into your Tafiki wallet. You can withdraw it to your bank.`], receipt: { title: 'Redemption settlement', amount: Number(r.amount), direction: 'out', rows: [['Paid to', `${u.name}${u.coop_no ? ' · ' + u.coop_no : ''}`], ['FOODCORE Mart', rp ? rp.name : ''], ['Stake reference', h.ref], ['Units redeemed', String(h.units)], ['Requested', new Date(r.created_at || Date.now()).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })], ['Paid into', 'Tafiki wallet'], ['Wallet balance now', N(await walletBalance(u.id))]], total: ['Capital returned', N(r.amount)] } });
  await activity.log(actor, 'units.redemption_settled', { type: 'holding', id: h.id }, { amount: r.amount });
  return db('redemptions').where({ id }).first();
}
module.exports = { calculate, run, reserveBalance, walletBalance, requestWithdrawal, decideWithdrawal, requestRedemption, cancelRedemption, settleRedemption };
