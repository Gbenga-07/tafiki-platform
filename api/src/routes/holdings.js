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
const paystack = require('../lib/paystack');
const activity = require('../lib/activity');
const { sendEmail } = require('../lib/mailer');
const r = express.Router();
r.use(requireUser);
const shapeH = (h, p) => ({ id: h.id, ref: h.ref, package: p ? { id: p.id, name: p.name, stage: p.stage } : h.package_id, units: h.units, amount: Number(h.amount), status: h.status, method: h.method, reservedUntil: h.reserved_until, signedName: h.signed_name, signedAt: h.signed_at, paidAt: h.paid_at, certificate: h.cert_no ? { number: h.cert_no, issuedAt: h.issued_at, verificationCode: null } : null, activeSince: h.active_since, createdAt: h.created_at });

r.get('/', async (req, res) => {
  const db = getDb(); const hs = await db('holdings').where({ user_id: req.user.id }).orderBy('created_at', 'desc');
  const ps = await db('packages').whereIn('id', [...new Set(hs.map((h) => h.package_id))]);
  res.json({ holdings: hs.map((h) => shapeH(h, ps.find((p) => p.id === h.package_id))) });
});
r.get('/:id', async (req, res) => {
  const db = getDb(); const h = await db('holdings').where({ id: req.params.id, user_id: req.user.id }).first(); if (!h) throw new HttpError(404, 'Not found.');
  const p = await db('packages').where({ id: h.package_id }).first(); const out = shapeH(h, p);
  if (h.cert_no) out.certificate.verificationCode = units.verifyCode(h.ref, h.cert_no, req.user.name);
  res.json({ holding: out, payments: await db('payments').where({ holding_id: h.id }).select('reference', 'provider', 'amount', 'status', 'channel', 'created_at', 'verified_at') });
});

const Reserve = z.object({ packageId: z.string().min(1), units: z.number().int().min(1).max(40), signedName: z.string().trim().min(3).max(120), agree: z.literal(true, { errorMap: () => ({ message: 'Read and accept the key terms and the Unit Subscription and Security Agreement.' }) }) });
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
    await trx('holdings').insert({ id, ref, user_id: u.id, package_id: p.id, units: d.units, amount: d.units * terms.unitPrice, status: 'unpaid', reserved_until: addMinutes(now(), terms.reservationHours * 60), signed_name: d.signedName, signed_at: now(), agreement_version: config.termsVersion });
  }));
  await activity.log({ type: 'user', id: u.id }, 'units.reserved', { type: 'holding', id }, { ref, units: d.units });
  const h = await db('holdings').where({ id }).first();
  res.status(201).json({ holding: shapeH(h, await db('packages').where({ id: h.package_id }).first()) });
});

r.get('/:id/deliveries', async (req, res) => {
  const db = getDb(); const h = await db('holdings').where({ id: req.params.id, user_id: req.user.id }).first(); if (!h) throw new HttpError(404, 'Not found.');
  const ds = await db('deliveries').where({ holding_id: h.id }).orderBy('created_at');
  const out = []; for (const d of ds) out.push({ id: d.id, code: d.code, kind: d.kind, cycle: d.cycle, stage: d.status, value: Number(d.value), driver: d.driver, deliveredAt: d.delivered_at, createdAt: d.created_at, lines: await db('delivery_lines').where({ delivery_id: d.id }).select('sku', 'name', 'size', 'qty'), log: await db('delivery_log').where({ delivery_id: d.id }).orderBy('id').select('stage', 'at') });
  res.json({ deliveries: out });
});

r.post('/:id/pay', async (req, res) => {
  const method = req.body && req.body.method; if (!['card', 'debit', 'transfer'].includes(method)) throw bad('Choose card, bank debit or bank transfer.');
  const db = getDb(); const h = await db('holdings').where({ id: req.params.id, user_id: req.user.id }).first();
  if (!h) throw new HttpError(404, 'Not found.');
  if (h.status !== 'unpaid' || h.payment_verified) throw bad('This reservation is not waiting for payment.');
  if (h.reserved_until && new Date(h.reserved_until) < now()) throw bad('This reservation has expired. Reserve again.');
  const reference = `${h.ref}-${Date.now().toString(36).toUpperCase()}`;
  await db('holdings').where({ id: h.id }).update({ method });
  if (method === 'transfer') {
    await db('payments').insert({ id: uuid(), holding_id: h.id, user_id: h.user_id, provider: 'transfer', reference, amount: h.amount, status: 'initialized' });
    return res.json({ method, reference, amount: Number(h.amount), escrow: await getSetting('escrow'), note: 'Use the reference as the transfer narration, then tap "I have sent the transfer".' });
  }
  const init = await paystack.initialize({ email: req.user.email, amountNaira: Number(h.amount), reference, callbackUrl: `${config.appUrl}/#pay-result?ref=${encodeURIComponent(reference)}`, channels: method === 'card' ? ['card'] : ['bank', 'bank_transfer'], metadata: { holding: h.ref, units: h.units, user: req.user.id } });
  await db('payments').insert({ id: uuid(), holding_id: h.id, user_id: h.user_id, provider: 'paystack', reference, amount: h.amount, status: 'initialized' });
  res.json({ method, reference, authorizationUrl: init.authorization_url, accessCode: init.access_code });
});

r.post('/:id/transfer-sent', async (req, res) => {
  const db = getDb(); const h = await db('holdings').where({ id: req.params.id, user_id: req.user.id }).first(); if (!h) throw new HttpError(404, 'Not found.');
  const p = await db('payments').where({ holding_id: h.id, provider: 'transfer', status: 'initialized' }).orderBy('created_at', 'desc').first();
  if (!p) throw bad('Start a bank transfer first.');
  await db('payments').where({ id: p.id }).update({ status: 'pending_review' });
  await db('holdings').where({ id: h.id }).update({ status: 'confirming', reserved_until: null });
  await activity.log({ type: 'user', id: req.user.id }, 'units.transfer_reported', { type: 'holding', id: h.id }, { reference: p.reference });
  await sendEmail({ to: req.user.email, name: req.user.name.split(' ')[0], category: 'units', ref: h.ref, subject: `We are confirming your transfer for ${h.ref}`, paragraphs: [`Thank you. We will match your transfer of ₦${Number(h.amount).toLocaleString('en-NG')} (reference ${p.reference}) in the escrow account, usually within one working day.`] });
  res.json({ ok: true });
});

r.get('/payments/:reference/verify', async (req, res) => {
  const db = getDb(); const pay = await db('payments').where({ reference: req.params.reference, user_id: req.user.id }).first();
  if (!pay) throw new HttpError(404, 'Payment not found.');
  if (pay.provider === 'paystack' && pay.status !== 'success') {
    const v = await paystack.verify(pay.reference);
    if (v.status === 'success' && Math.round(v.amount) === Math.round(Number(pay.amount) * 100) && v.currency === 'NGN') await units.markPaymentSuccess(pay, { channel: v.channel, raw: v });
    else if (['failed', 'abandoned'].includes(v.status)) await db('payments').where({ id: pay.id }).update({ status: 'failed' });
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
