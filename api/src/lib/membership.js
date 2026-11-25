// Yearly cooperative membership fee (default ₦50,000, set in Terms & Settings).
// Rules:
//  - It is added to the member's first stake payment, and again to the first stake payment after the year runs out.
//  - It is not unit capital: holdings.amount (capital) never includes it, so returns, payouts, redemptions and
//    capital figures are unaffected. It is non-refundable.
//  - Only one payment at a time may carry it. While one is in progress, another stake cannot start paying.
const { getDb } = require('../db');
const { uuid, now, HttpError } = require('./util');
const { getTerms } = require('./terms');
const activity = require('./activity');
const { sendEmail } = require('./mailer');
const K = require('./emailkit');
const fmtN = (n) => '₦' + Math.round(Number(n)).toLocaleString('en-NG');
const IN_PROGRESS_MIN = 60; // an unfinished Paystack checkout older than this counts as abandoned (same rule as reservation expiry)

const isActive = (u, at = now()) => !!(u && u.membership_until && new Date(u.membership_until) > at);

async function status(u) {
  const t = await getTerms(); const fee = Math.max(0, Math.round(Number(t.membershipFee) || 0));
  const active = isActive(u);
  return { fee, months: t.membershipMonths || 12, active, paidUntil: u.membership_until || null, dueOnNextStake: u.role === 'investor' && fee > 0 && !active };
}

// Decide the fee for a new payment on this holding. Throws if another stake's payment already carries this year's fee.
// terms must be read before the caller's transaction (reading settings inside it would need a second connection).
async function feeForPayment(u, holdingId, trx, terms) {
  const fee = Math.max(0, Math.round(Number(terms.membershipFee) || 0));
  if (u.role !== 'investor' || !fee || isActive(u)) return 0;
  const recent = new Date(Date.now() - IN_PROGRESS_MIN * 60000);
  const other = await trx('payments as y').join('holdings as h', 'h.id', 'y.holding_id')
    .where('y.user_id', u.id).where('y.fee_amount', '>', 0).whereNot('y.holding_id', holdingId)
    .where((q) => q.where('y.status', 'pending_review').orWhere((q2) => q2.where('y.status', 'initialized').where('y.created_at', '>', recent)))
    .whereIn('h.status', ['unpaid', 'confirming']).select('h.ref').first();
  if (other) throw new HttpError(409, `Your payment for ${other.ref} includes the yearly membership fee. Finish or cancel it before paying for another stake.`);
  return fee;
}

// Called once, when a payment that carries the fee succeeds (inside the "won" path, so never twice for one payment).
async function recordFeePaid(payment, actor) {
  const fee = Number(payment.fee_amount) || 0; if (!fee) return;
  const db = getDb(); const t = await getTerms(); const months = t.membershipMonths || 12;
  const res = await db.transaction(async (trx) => {
    const u = await trx('users').where({ id: payment.user_id }).forUpdate().first();
    if (isActive(u)) { await trx('payments').where({ id: payment.id }).update({ fee_status: 'refund_due' }); return { dup: true, u }; }
    const start = now(); const end = new Date(start); end.setMonth(end.getMonth() + months);
    await trx('users').where({ id: u.id }).update({ membership_until: end });
    await trx('memberships').insert({ id: uuid(), user_id: u.id, payment_id: payment.id, amount: fee, period_start: start, period_end: end });
    await trx('payments').where({ id: payment.id }).update({ fee_status: 'paid' });
    return { dup: false, u, end };
  });
  if (res.dup) {
    await activity.log(actor, 'membership.fee_refund_due', { type: 'payment', id: payment.id }, { fee });
    const admins = await db('admins').where({ status: 'active' }).whereIn('role', ['Super Admin', 'Finance Officer']);
    for (const a of admins) await sendEmail({ to: a.email, name: a.name.split(' ')[0], category: 'operations', ref: payment.reference, subject: `Refund ${fmtN(fee)} membership fee paid twice by ${res.u.name}`,
      title: 'A membership fee was paid twice', lead: `Payment **${payment.reference}** included the yearly membership fee, but **${res.u.name}**'s membership was already paid for this year.`,
      hero: { label: 'Refund due to the member', value: K.N(fee), sub: 'The stake itself is unaffected', tone: 'warn' },
      blocks: [{ type: 'kv', title: 'Payment', rows: [['Member', res.u.name + (res.u.coop_no ? ' · ' + res.u.coop_no : '')], ['Email', res.u.email], ['Payment reference', payment.reference], ['Amount paid', K.N(payment.amount)], ['Membership paid until', res.u.membership_until ? K.day(res.u.membership_until) : '']] }],
      next: [`Refund ${K.N(fee)} to the member.`, 'Record the refund in the console so the payment shows as settled.'],
      cta: { label: 'Open the Tafiki Console', url: K.consoleLink() }, help: 'This is an automatic alert for Super Admins and Finance Officers.' });
  } else await activity.log(actor, 'membership.fee_paid', { type: 'user', id: res.u.id }, { fee, until: res.end, payment: payment.reference });
}

module.exports = { status, feeForPayment, recordFeePaid, isActive };
