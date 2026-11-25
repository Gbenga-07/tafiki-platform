// Members buying units: reserve, sign, pay (card/bank debit via Paystack, or bank transfer), view, cancel.
const express = require('express');
const { z } = require('zod');
const config = require('../config');
const { getDb } = require('../db');
const { uuid, bad, HttpError, addMinutes, now } = require('../lib/util');
const { requireUser } = require('../lib/auth');
const { getTerms, getSetting } = require('../lib/terms');
const counters = require('../lib/counters');
const units = require('../lib/units');
const membership = require('../lib/membership');
const paystack = require('../lib/paystack');
const flutterwave = require('../lib/flutterwave');
const gateway = require('../lib/gateway');
const activity = require('../lib/activity');
const { sendEmail } = require('../lib/mailer');
const K = require('../lib/emailkit');
const r = express.Router();
r.use(requireUser);
const shapeH = (h, p) => ({ id: h.id, ref: h.ref, package: p ? { id: p.id, name: p.name, stage: p.stage } : h.package_id, units: h.units, amount: Number(h.amount), status: h.status, method: h.method, reservedUntil: h.reserved_until, signedName: h.signed_name, signedAt: h.signed_at, paidAt: h.paid_at, certificate: h.cert_no ? { number: h.cert_no, issuedAt: h.issued_at, verificationCode: null } : null, activeSince: h.active_since, createdAt: h.created_at });

r.get('/', async (req, res) => {
  const db = getDb(); const hs = await db('holdings').where({ user_id: req.user.id }).orderBy('created_at', 'desc');
  const ps = await db('packages').whereIn('id', [...new Set(hs.map((h) => h.package_id))]);
  // membershipFee: the yearly fee carried by this stake's live or settled payment (0 for most stakes)
  const pays = hs.length ? await db('payments').whereIn('holding_id', hs.map((h) => h.id)).whereIn('status', ['initialized', 'pending_review', 'success', 'refund_due']).orderBy('created_at', 'asc').select('holding_id', 'fee_amount', 'status') : [];
  const feeOf = (id) => { const ps2 = pays.filter((y) => y.holding_id === id); const ok = ps2.filter((y) => ['success', 'refund_due', 'pending_review'].includes(y.status)); const y = (ok.length ? ok : ps2).pop(); return y ? Number(y.fee_amount) || 0 : 0; };
  res.json({ holdings: hs.map((h) => ({ ...shapeH(h, ps.find((p) => p.id === h.package_id)), membershipFee: feeOf(h.id) })) });
});
r.get('/:id', async (req, res) => {
  const db = getDb(); const h = await db('holdings').where({ id: req.params.id, user_id: req.user.id }).first(); if (!h) throw new HttpError(404, 'Not found.');
  const p = await db('packages').where({ id: h.package_id }).first(); const out = shapeH(h, p);
  if (h.cert_no) out.certificate.verificationCode = units.verifyCode(h.ref, h.cert_no, req.user.name);
  res.json({ holding: out, payments: await db('payments').where({ holding_id: h.id }).select('reference', 'provider', 'amount', 'fee_amount', 'status', 'channel', 'created_at', 'verified_at') });
});

// Buying: the member signs, then chooses how to pay.
//  - Flutterwave (card, bank transfer, USSD, bank account): units are held for the checkout (terms.checkoutMinutes)
//    and released automatically if it is not completed.
//  - Bank transfer to the escrow account: units are held for RELEASE_AFTER_HOURS (24). The member reports the transfer,
//    Finance confirms it. Not reported in time: released automatically. Reported but unconfirmed after 24 hours: the
//    console can release it. Set MANUAL_TRANSFERS=off to hide the bank transfer option.
const manualTransfers = () => !['0', 'false', 'off'].includes(String(process.env.MANUAL_TRANSFERS || 'on').toLowerCase());
const Reserve = z.object({ packageId: z.string().min(1), units: z.number().int().min(1).max(40), signedName: z.string().trim().min(3).max(120), method: z.enum(['card', 'debit', 'any', 'flutterwave', 'transfer']).optional(), agree: z.literal(true, { errorMap: () => ({ message: 'Read and accept the key terms and the Unit Subscription and Security Agreement.' }) }) });
r.post('/', async (req, res) => {
  const d = Reserve.parse(req.body); const u = req.user;
  if (u.role !== 'investor') throw new HttpError(403, 'Only unit holder accounts can buy units.');
  if (!u.coop_no) throw new HttpError(403, 'Cooperative membership is required to buy units.');
  if (d.signedName.toLowerCase() !== u.name.toLowerCase()) throw bad('Type your full name exactly as it appears on your account to sign.');
  const terms = await getTerms(); const db = getDb();
  const id = uuid(); let ref;
  await counters.retry(() => db.transaction(async (trx) => {
    const p = await trx('packages').where({ id: d.packageId }).forUpdate().first();
    if (!p || p.stage !== 'funding') throw bad('This package is not open for new units.');
    const open = p.units_total - (await units.unitsTaken(p.id, trx));
    if (d.units > open) throw bad(open ? `Only ${open} unit${open > 1 ? 's are' : ' is'} still open in ${p.name}.` : `${p.name} has no units left.`);
    ref = 'FC-' + (await counters.next('holding', 1001, trx));
    await trx('holdings').insert({ id, ref, user_id: u.id, package_id: p.id, units: d.units, amount: d.units * terms.unitPrice, status: 'unpaid', reserved_until: addMinutes(now(), terms.checkoutMinutes || 30), signed_name: d.signedName, signed_at: now(), agreement_version: config.termsVersion });
  }));
  await activity.log({ type: 'user', id: u.id }, 'units.checkout_started', { type: 'holding', id }, { ref, units: d.units, method: d.method || 'not chosen yet' });
  let h = await db('holdings').where({ id }).first();
  let checkout = null;
  const method = d.method || (manualTransfers() ? null : flutterwave.configured() ? 'flutterwave' : 'any'); // no bank transfer option: go straight to the online checkout
  if (method) { // pay straight away; if the gateway is unreachable the units are released
    try { checkout = await startCheckout(req.user, h, method); }
    catch (e) { await db('holdings').where({ id, status: 'unpaid' }).update({ status: 'cancelled', cancel_reason: 'Checkout could not start' }); throw e; }
    h = await db('holdings').where({ id }).first();
  }
  res.status(201).json({ holding: shapeH(h, await db('packages').where({ id: h.package_id }).first()), checkout });
});

r.get('/:id/deliveries', async (req, res) => {
  const db = getDb(); const h = await db('holdings').where({ id: req.params.id, user_id: req.user.id }).first(); if (!h) throw new HttpError(404, 'Not found.');
  const ds = await db('deliveries').where({ holding_id: h.id }).orderBy('created_at');
  const out = []; for (const d of ds) out.push({ id: d.id, code: d.code, kind: d.kind, cycle: d.cycle, stage: d.status, value: Number(d.value), driver: d.driver, deliveredAt: d.delivered_at, createdAt: d.created_at, lines: await db('delivery_lines').where({ delivery_id: d.id }).select('sku', 'name', 'size', 'qty'), log: await db('delivery_log').where({ delivery_id: d.id }).orderBy('id').select('stage', 'at') });
  res.json({ deliveries: out });
});

async function startCheckout(user, h, method) {
  const db = getDb();
  if (method === 'transfer' && !manualTransfers()) throw bad('Bank transfer is not available. Please pay online with Flutterwave.');
  if (h.status !== 'unpaid' || h.payment_verified) throw bad('This purchase is not waiting for payment.');
  if (h.reserved_until && new Date(h.reserved_until) < now()) throw bad('This checkout has timed out. Buy again.');
  const provider = method === 'transfer' ? 'transfer' : method === 'flutterwave' ? 'flutterwave' : 'paystack';
  const reference = `${h.ref}-${Date.now().toString(36).toUpperCase()}`;
  // The yearly membership fee rides on the member's first stake payment. Locking the member's row makes two
  // simultaneous checkouts decide one at a time, so only one of them can carry the fee.
  const payId = uuid(); let fee = 0; const terms = await getTerms();
  await db.transaction(async (trx) => {
    const u = await trx('users').where({ id: user.id }).forUpdate().first();
    fee = await membership.feeForPayment(u, h.id, trx, terms);
    await trx('payments').insert({ id: payId, holding_id: h.id, user_id: h.user_id, provider, reference, amount: Number(h.amount) + fee, fee_amount: fee, status: 'initialized' });
  });
  const total = Number(h.amount) + fee;
  const breakdown = { units: Number(h.amount), membershipFee: fee, total };
  if (provider === 'transfer') {
    const hours = units.releaseAfterHours(); const until = new Date(new Date(h.created_at).getTime() + hours * 3600000);
    await db('holdings').where({ id: h.id }).update({ method: 'transfer', reserved_until: until });
    const escrow = await getSetting('escrow'); const pkg = await db('packages').where({ id: h.package_id }).first();
    await sendEmail({ to: user.email, name: K.first(user), category: 'units', ref: h.ref, subject: `How to pay for ${h.ref} by bank transfer`, title: 'Pay by bank transfer',
      lead: `Your **${K.units(h.units)}** in **${pkg ? pkg.name : 'FOODCORE'}** are held for you until **${K.when(until)}**. Transfer **${K.N(total)}** to the escrow account below, then tap **I've sent the transfer** on your dashboard.`,
      hero: { label: 'Amount to transfer', value: K.N(total), sub: fee ? `${K.N(h.amount)} for units + ${K.N(fee)} yearly membership fee` : `${K.units(h.units)} × ${K.N(h.amount / h.units)}` },
      blocks: [{ type: 'kv', title: 'Escrow account', rows: [['Bank', escrow.bank], ['Account name', escrow.accountName], ['Account number', escrow.accountNumber], ['Amount', K.N(total)], ['Narration / reference', reference]] },
        { type: 'kv', title: 'Your purchase', rows: [['Stake reference', h.ref], ['FOODCORE Mart', pkg ? pkg.name : ''], ['Units', K.units(h.units)], ['Held until', K.when(until)]] },
        { type: 'note', tone: 'warn', title: 'Pay only into this escrow account', text: 'Tafiki never asks you to pay into a personal account. Use the reference exactly so we can match your transfer.' }],
      next: ['Transfer the exact amount and use the reference as the narration.', `Tap **I've sent the transfer** on your dashboard within ${hours} hours, or the units are released.`, 'Finance matches it in the escrow account, usually within one working day, and you get a numbered receipt with a PDF copy.'],
      cta: { label: 'Open my dashboard', url: K.link('me-invest') } });
    return { method: 'transfer', reference, amount: total, breakdown, escrow, holdUntil: until, holdHours: hours, note: 'Use the reference as the transfer narration, then tap "I have sent the transfer".' };
  }
  await db('holdings').where({ id: h.id }).update({ method: provider === 'flutterwave' ? 'flutterwave' : method === 'any' ? 'card' : method });
  const callbackUrl = `${config.appUrl}/#pay-result?ref=${encodeURIComponent(reference)}`;
  let link;
  try {
    if (provider === 'flutterwave') link = (await flutterwave.initialize({ reference, amountNaira: total, redirectUrl: callbackUrl, customer: { email: user.email, name: user.name, phonenumber: user.phone || undefined }, meta: { holding: h.ref, units: h.units, user: user.id, membership_fee: fee }, logo: `${config.appUrl}/img/email-logo.png` })).link;
    else { const channels = method === 'card' ? ['card'] : method === 'debit' ? ['bank', 'bank_transfer'] : ['card', 'bank', 'bank_transfer', 'ussd']; link = (await paystack.initialize({ email: user.email, amountNaira: total, reference, callbackUrl, channels, metadata: { holding: h.ref, units: h.units, user: user.id, membership_fee: fee } })).authorization_url; }
  } catch (e) { await db('payments').where({ id: payId }).update({ status: 'failed' }); throw e; }
  return { method: provider, reference, amount: total, breakdown, authorizationUrl: link };
}
r.post('/:id/pay', async (req, res) => {
  const method = req.body && req.body.method; if (!['card', 'debit', 'transfer', 'any', 'flutterwave'].includes(method)) throw bad('Choose how to pay.');
  const db = getDb(); const h = await db('holdings').where({ id: req.params.id, user_id: req.user.id }).first();
  if (!h) throw new HttpError(404, 'Not found.');
  res.json(await startCheckout(req.user, h, method));
});

r.post('/:id/transfer-sent', async (req, res) => {
  const db = getDb(); const h = await db('holdings').where({ id: req.params.id, user_id: req.user.id }).first(); if (!h) throw new HttpError(404, 'Not found.');
  if (!manualTransfers()) throw bad('Bank transfer is not available. Please pay online with Flutterwave.');
  const p = await db('payments').where({ holding_id: h.id, provider: 'transfer', status: 'initialized' }).orderBy('created_at', 'desc').first();
  if (!p) throw bad('Start a bank transfer first.');
  await db('payments').where({ id: p.id }).update({ status: 'pending_review' });
  await db('holdings').where({ id: h.id }).update({ status: 'confirming', reserved_until: null });
  await activity.log({ type: 'user', id: req.user.id }, 'units.transfer_reported', { type: 'holding', id: h.id }, { reference: p.reference });
  await sendEmail({ to: req.user.email, name: req.user.name.split(' ')[0], category: 'units', ref: h.ref, subject: `We are confirming your transfer for ${h.ref}`, title: 'We are confirming your transfer',
    lead: `Thank you. We will match your transfer of **${K.N(p.amount)}** in the escrow account, usually within one working day.`,
    blocks: [{ type: 'kv', title: 'Transfer details', rows: [['Stake reference', h.ref], ['Units', K.units(h.units)], ['Amount', K.N(p.amount)], ['Includes membership fee', Number(p.fee_amount) ? K.N(p.fee_amount) + ' · non-refundable, earns no returns' : ''], ['Payment reference', p.reference], ['Reported', K.when()]] },
      K.stakeSteps(1, { bought: K.short(h.created_at), paid: 'Being matched' })],
    next: ['Finance matches the transfer in the escrow account.', 'You get a numbered **payment receipt** as soon as it is confirmed.'] });
  res.json({ ok: true });
});

r.get('/payments/:reference/verify', async (req, res) => {
  const db = getDb(); const pay = await db('payments').where({ reference: req.params.reference, user_id: req.user.id }).first();
  if (!pay) throw new HttpError(404, 'Payment not found.');
  if (gateway.online.includes(pay.provider) && pay.status !== 'success') {
    const v = await gateway.check(pay);
    if (v.ok) await units.markPaymentSuccess(pay, { channel: v.channel, raw: v.raw });
    else if (v.failed) await db('payments').where({ id: pay.id, status: 'initialized' }).update({ status: 'failed' });
  }
  const h = await db('holdings').where({ id: pay.holding_id }).first(); const p2 = await db('payments').where({ id: pay.id }).first();
  res.json({ payment: { reference: p2.reference, status: p2.status }, holding: shapeH(h) });
});

r.delete('/:id', async (req, res) => {
  const db = getDb(); const h = await db('holdings').where({ id: req.params.id, user_id: req.user.id }).first(); if (!h) throw new HttpError(404, 'Not found.');
  if (h.status !== 'unpaid' || h.payment_verified) throw bad('Only unpaid reservations can be cancelled. Contact support for anything else.');
  await db('holdings').where({ id: h.id }).update({ status: 'cancelled', cancel_reason: 'Cancelled by member' });
  await activity.log({ type: 'user', id: req.user.id }, 'units.cancelled', { type: 'holding', id: h.id });
  res.json({ ok: true });
});
module.exports = r;
