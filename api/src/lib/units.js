// Core rules for units: availability, reservations, payment confirmation, certificates and opening packages.
const crypto = require('crypto');
const config = require('../config');
const { getDb } = require('../db');
const membership = require('./membership');
const { HttpError, bad, now, addMinutes } = require('./util');
const counters = require('./counters');
const { getTerms } = require('./terms');
const { sendEmail } = require('./mailer');
const activity = require('./activity');

const HELD = ['unpaid', 'confirming', 'reserved', 'active', 'redeem'];
const CONFIRMED = ['reserved', 'active', 'redeem'];

async function unitsTaken(packageId, trx) {
  const db = trx || getDb();
  const rows = await db('holdings').where({ package_id: packageId }).whereIn('status', HELD).where((b) => b.whereNot({ status: 'unpaid' }).orWhere('reserved_until', '>', now()));
  return rows.reduce((a, h) => a + h.units, 0);
}
async function unitsConfirmed(packageId, trx) {
  const r = await (trx || getDb())('holdings').where({ package_id: packageId }).whereIn('status', CONFIRMED).sum({ s: 'units' }).first();
  return Number(r && r.s) || 0;
}
const fmtN = (n) => '₦' + Number(n).toLocaleString('en-NG');
const verifyCode = (ref, certNo, name) => { const h = crypto.createHmac('sha256', config.jwtSecret).update(`${ref}|${certNo}|${name}`).digest('hex').toUpperCase().slice(0, 8); return h.slice(0, 4) + '-' + h.slice(4); };

async function issueCertificate(h, user, trx) {
  const cur = await (trx || getDb())('holdings').where({ id: h.id }).first();
  if (cur.cert_no) return cur.cert_no;
  const n = await counters.next('cert:' + new Date().getFullYear(), 1);
  const certNo = `FC-C-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;
  const won = await (trx || getDb())('holdings').where({ id: h.id }).whereNull('cert_no').update({ cert_no: certNo, issued_at: now() });
  if (!won) return (await getDb()('holdings').where({ id: h.id }).first()).cert_no; // another request issued it
  await sendEmail({ to: user.email, name: user.name.split(' ')[0], category: 'units', ref: h.ref, subject: `Your Certificate of Stake ${certNo}`, paragraphs: [`Your ${h.units} unit${h.units > 1 ? 's' : ''} (${h.ref}) are confirmed and your Certificate of Stake ${certNo} has been issued.`, `Verification code: ${verifyCode(h.ref, certNo, user.name)}. You can download the certificate from your dashboard.`] });
  return certNo;
}

// Moves a paid holding forward. Payment must be verified; the member's identity must be verified to issue units.
async function settle(holdingId, actor) {
  const db = getDb();
  const h = await db('holdings').where({ id: holdingId }).first();
  if (!h || !['unpaid', 'confirming'].includes(h.status)) return h;
  const u = await db('users').where({ id: h.user_id }).first();
  const p = await db('packages').where({ id: h.package_id }).first();
  if (!h.payment_verified) return h;
  if (u.kyc_status !== 'verified') {
    if (h.status !== 'confirming') await db('holdings').where({ id: h.id }).update({ status: 'confirming' });
    return db('holdings').where({ id: h.id }).first();
  }
  const status = p.stage === 'trading' ? 'active' : 'reserved';
  const won = await db('holdings').where({ id: h.id }).whereIn('status', ['unpaid', 'confirming']).update({ status, reserved_until: null, active_since: status === 'active' ? now() : null });
  if (!won) return db('holdings').where({ id: h.id }).first(); // already settled by a parallel request
  await issueCertificate({ ...h, status }, u);
  await activity.log(actor, 'units.confirmed', { type: 'holding', id: h.id }, { ref: h.ref, units: h.units, status });
  const terms = await getTerms();
  const confirmed = await unitsConfirmed(p.id);
  if (p.stage === 'funding' && confirmed >= p.units_total) {
    if (!(await db('packages').where({ id: p.id, stage: 'funding' }).update({ stage: 'full' }))) return db('holdings').where({ id: h.id }).first();
    await activity.log({ type: 'system' }, 'package.full', { type: 'package', id: p.id }, { units: confirmed });
    const admins = await db('admins').where({ status: 'active' }).whereIn('role', ['Super Admin', 'Operations Manager']);
    for (const a of admins) await sendEmail({ to: a.email, name: a.name.split(' ')[0], category: 'operations', ref: p.id, subject: `${p.name} is fully subscribed`, paragraphs: [`All ${p.units_total} units in ${p.name} are confirmed (${fmtN(p.units_total * terms.unitPrice)}).`, 'Open the package in the Tafiki Console to assign the mart and start trading.'] });
  }
  return db('holdings').where({ id: h.id }).first();
}

async function markPaymentSuccess(payment, { channel, raw, by, mustWin } = {}) {
  const db = getDb(); const actor = by ? { type: 'admin', id: by } : { type: 'system' };
  // Only the first request to mark this payment successful continues; parallel reports stop here.
  const won = await db('payments').where({ id: payment.id }).whereNotIn('status', ['success', 'refund_due']).update({ status: 'success', channel: channel || payment.channel, raw: raw ? JSON.stringify(raw).slice(0, 60000) : payment.raw, verified_at: now(), confirmed_by: by || null });
  if (!won) { if (mustWin) throw new HttpError(409, 'This payment has already been confirmed.'); return settle(payment.holding_id, actor); }
  // The membership fee part is settled first: it is non-refundable, so it stands even if the stake has to be refunded.
  await membership.recordFeePaid(payment, actor);
  const stakePart = Number(payment.amount) - (Number(payment.fee_amount) || 0);
  let h = await db('holdings').where({ id: payment.holding_id }).first();
  if (h.status === 'cancelled') { // paid after the reservation lapsed: reinstate if the units are still free, otherwise flag a refund
    const reinstated = await db.transaction(async (trx) => {
      const p = await trx('packages').where({ id: h.package_id }).forUpdate().first();
      const open = p.units_total - (await unitsTaken(p.id, trx));
      if (p.stage === 'closed' || open < h.units) return false;
      await trx('holdings').where({ id: h.id }).update({ status: 'unpaid', cancel_reason: null });
      return true;
    });
    if (!reinstated) {
      await db('payments').where({ id: payment.id }).update({ status: 'refund_due' });
      await activity.log(actor, 'payment.refund_due', { type: 'payment', id: payment.id }, { ref: h.ref, amount: stakePart, membershipFeeKept: Number(payment.fee_amount) || 0 });
      const admins = await db('admins').where({ status: 'active' }).whereIn('role', ['Super Admin', 'Finance Officer']);
      for (const a of admins) await sendEmail({ to: a.email, name: a.name.split(' ')[0], category: 'operations', ref: h.ref, subject: `Refund needed: payment for ${h.ref} arrived after its units were released`, paragraphs: [`${fmtN(payment.amount)} (reference ${payment.reference}) was paid after the reservation lapsed and the units are no longer available.`, Number(payment.fee_amount) ? `Refund the stake part, ${fmtN(stakePart)}, or offer units in another package. The ${fmtN(payment.fee_amount)} yearly membership fee in this payment is non-refundable and the membership is now active.` : 'Refund the member or offer units in another package.'] });
      return h;
    }
  }
  await db('holdings').where({ id: payment.holding_id }).update({ payment_verified: true, paid_at: now(), reserved_until: null });
  h = await db('holdings').where({ id: payment.holding_id }).first();
  const u = await db('users').where({ id: h.user_id }).first();
  await sendEmail({ to: u.email, name: u.name.split(' ')[0], category: 'units', ref: h.ref, subject: `Payment received for ${h.ref}`, paragraphs: [Number(payment.fee_amount) ? `We have received ${fmtN(payment.amount)}: ${fmtN(stakePart)} for ${h.units} unit${h.units > 1 ? 's' : ''} (${h.ref}) and ${fmtN(payment.fee_amount)} for your yearly cooperative membership. The unit money is held in the escrow account until the mart opens. The membership fee is non-refundable and earns no returns; returns are paid on your units only.` : `We have received ${fmtN(payment.amount)} for ${h.units} unit${h.units > 1 ? 's' : ''} (${h.ref}). The money is held in the escrow account until the mart opens.`, u.kyc_status === 'verified' ? 'Your units are now confirmed.' : 'Your units will be confirmed as soon as your identity check is complete.'] });
  return settle(h.id, by ? { type: 'admin', id: by } : { type: 'system' });
}

async function onKycVerified(userId, actor) {
  const hs = await getDb()('holdings').where({ user_id: userId, status: 'confirming', payment_verified: true });
  for (const h of hs) await settle(h.id, actor);
}

async function expireReservations() {
  const db = getDb();
  const old = await db('holdings').where({ status: 'unpaid', payment_verified: false }).where('reserved_until', '<', now());
  const recent = addMinutes(now(), -60); let n = 0;
  for (const h of old) {
    // keep the reservation while a checkout started in the last hour may still complete
    if (await db('payments').where({ holding_id: h.id }).whereIn('status', ['initialized', 'pending_review']).where('created_at', '>', recent).first()) continue;
    const won = await db('holdings').where({ id: h.id, status: 'unpaid', payment_verified: false }).update({ status: 'cancelled', cancel_reason: 'Reservation expired' });
    if (!won) continue; n++;
    await db('payments').where({ holding_id: h.id, status: 'initialized' }).update({ status: 'failed' });
    const u = await db('users').where({ id: h.user_id }).first();
    if (u) await sendEmail({ to: u.email, name: u.name.split(' ')[0], category: 'units', ref: h.ref, subject: `Your reservation ${h.ref} has expired`, paragraphs: ['We did not receive payment within the reservation period, so the units have been released.', 'You can reserve again from your dashboard if units are still open.'] });
  }
  return n;
}

async function openPackage(packageId, storeUserId, actor) {
  const db = getDb();
  const p = await db('packages').where({ id: packageId }).first();
  if (!p) throw new HttpError(404, 'Package not found.');
  if (p.stage === 'trading') throw bad('This package is already trading.');
  const confirmed = await unitsConfirmed(p.id);
  if (confirmed < p.units_total) throw bad(`Only ${confirmed} of ${p.units_total} units are confirmed. A package opens when every unit is confirmed.`);
  let store;
  if (storeUserId) { store = await db('users').where({ id: storeUserId, role: 'retailer' }).first(); if (!store) throw bad('That FOODCORE Mart account was not found.'); }
  else { const made = await require('./marts').ensureMart(db, p); store = made.store; if (made.created) await activity.log(actor, 'mart.auto_created', { type: 'user', id: store.id }, { package: p.id, shop: store.shop }); }
  const storeId = store.id;
  const won = await db('packages').where({ id: p.id }).whereIn('stage', ['funding', 'full']).update({ stage: 'trading', store_user_id: storeId, opened_at: now() });
  if (!won) throw new HttpError(409, 'This package has just been opened.');
  const hs = await db('holdings').where({ package_id: p.id, status: 'reserved' });
  for (const h of hs) {
    await db('holdings').where({ id: h.id }).update({ status: 'active', active_since: now() });
    const u = await db('users').where({ id: h.user_id }).first();
    await sendEmail({ to: u.email, name: u.name.split(' ')[0], category: 'units', ref: h.ref, subject: `${p.name} is open and trading`, paragraphs: [`${p.name} is now open. Your ${h.units} unit${h.units > 1 ? 's' : ''} (${h.ref}) are earning from today.`, 'Stock is on its way to the mart. You will see each delivery on your dashboard.'] });
  }
  await activity.log(actor, 'package.opened', { type: 'package', id: p.id }, { store: store.shop, holdings: hs.length });
  return db('packages').where({ id: p.id }).first();
}
module.exports = { HELD, CONFIRMED, unitsTaken, unitsConfirmed, settle, markPaymentSuccess, onKycVerified, expireReservations, openPackage, verifyCode, issueCertificate };
