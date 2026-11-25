// Account lifecycle: welcome on sign-up, active once the email is confirmed, suspended / reactivated, and closure.
const { getDb } = require('../db');
const { sendEmail } = require('./mailer');
const { bad } = require('./util');
const { revokeAll } = require('./auth');
const activity = require('./activity');
const config = require('../config');
const first = (u) => String(u.name || '').split(' ')[0];
const day = (d) => new Date(d || Date.now()).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const N = (n) => '₦' + Number(n || 0).toLocaleString('en-NG');

async function welcome(u) {
  const mart = u.role === 'retailer';
  await sendEmail({ to: u.email, name: first(u), category: 'account', ref: u.id, subject: mart ? `Welcome to Tafiki: ${u.shop} is registered` : 'Welcome to Tafiki: your account is created',
    paragraphs: mart ? [`Your FOODCORE Mart account for ${u.shop} has been created.`, 'Next: confirm your email with the code we sent, and confirm your phone number with the SMS code. Tafiki will review and approve your mart, then assign a package to it.']
      : ['Your Tafiki account has been created and you are now a member of FOODCORE Multipurpose Cooperative, bound by its bye-laws.', 'Next steps: 1) confirm your email with the code we sent; 2) confirm your phone number with the SMS code; 3) complete your identity check from your dashboard. You can then reserve units in any open FOODCORE Mart.', 'Your first stake each membership year includes the yearly membership fee. It is non-refundable and earns no returns.'],
    receipt: { title: 'Account details', rows: [['Name', u.name], ['Email', u.email], ['Phone', u.phone || ''], ['Account type', mart ? 'FOODCORE Mart' : 'Cooperative member'], ['Membership number', u.coop_no || ''], ['Terms accepted', u.terms_version ? 'Version ' + u.terms_version : 'Yes'], ['Joined', day(u.created_at)]], note: `Sign in at ${config.appUrl}/#login. If you did not create this account, reply to this email.` } });
}
async function activated(u) {
  await sendEmail({ to: u.email, name: first(u), category: 'account', ref: u.id, subject: 'Your Tafiki account is active', paragraphs: ['Thank you for confirming your email. Your Tafiki account is now active.', u.kyc_status === 'verified' ? 'Your identity is already verified, so you can reserve units straight away.' : 'Complete your identity check from your dashboard to start reserving units.'] });
}
async function statusChanged(u, status, reason) {
  if (status === 'suspended') await sendEmail({ to: u.email, name: first(u), category: 'account', ref: u.id, subject: 'Your Tafiki account has been suspended', paragraphs: [`Your Tafiki account was suspended on ${day()}${reason ? ': ' + reason : '.'}`, 'You cannot sign in while it is suspended. Your units and wallet are unaffected. Contact support@tafiki.com to resolve this.'] });
  if (status === 'active') await sendEmail({ to: u.email, name: first(u), category: 'account', ref: u.id, subject: 'Your Tafiki account is active again', paragraphs: ['Your Tafiki account has been reactivated. You can sign in again.'] });
}
// Closing is allowed only when nothing is still owed either way.
async function blockers(u) {
  const db = getDb(); const out = [];
  const held = await db('holdings').where({ user_id: u.id }).whereIn('status', ['reserved', 'active', 'redeem']).count({ n: '*' }).first();
  if (Number(held.n)) out.push('You still hold units. Redeem them first; your account can close once they settle.');
  const bal = Number((await db('wallet_tx').where({ user_id: u.id }).whereNot({ status: 'rejected' }).sum({ s: 'amount' }).first()).s) || 0;
  if (bal > 0) out.push(`Your wallet still holds ${N(bal)}. Withdraw it to your bank first.`);
  const wd = await db('withdrawals').where({ user_id: u.id, status: 'processing' }).first(); if (wd) out.push('A withdrawal is still being paid.');
  const pay = await db('payments').where({ user_id: u.id, status: 'pending_review' }).first(); if (pay) out.push('A bank transfer is still being confirmed.');
  if (u.role === 'retailer') {
    const pk = await db('packages').where({ store_user_id: u.id }).whereNot({ stage: 'closed' }).first(); if (pk) out.push('This mart is assigned to a package. Tafiki must reassign it first.');
  }
  return out;
}
async function close(u, actor, reason) {
  const db = getDb(); const why = await blockers(u);
  if (why.length) throw bad(why.join(' '));
  await db('holdings').where({ user_id: u.id, status: 'unpaid' }).update({ status: 'cancelled', cancel_reason: 'Account closed' });
  if (!(await db('users').where({ id: u.id }).whereNot({ status: 'closed' }).update({ status: 'closed', updated_at: new Date() }))) throw bad('This account is already closed.');
  await revokeAll('user', u.id);
  await activity.log(actor, 'member.closed', { type: 'user', id: u.id }, { reason: reason || null });
  await sendEmail({ to: u.email, name: first(u), category: 'account', ref: u.id, subject: 'Your Tafiki account is closed', paragraphs: [`Your Tafiki account was closed on ${day()}${actor.type === 'admin' ? ' by Tafiki' : ' at your request'}.`, 'Your cooperative membership ends with it. We keep your transaction records for as long as the law requires, then delete them.', 'If you did not ask for this, contact support@tafiki.com straight away.'],
    receipt: { title: 'Closure statement', rows: [['Name', u.name], ['Membership number', u.coop_no || ''], ['Closed', day()], ['Units held', 'None'], ['Wallet balance', N(0)], ['Reason', reason || '']] } });
}
module.exports = { welcome, activated, statusChanged, blockers, close };
