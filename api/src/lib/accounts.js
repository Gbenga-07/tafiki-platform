// Account lifecycle: welcome on sign-up, active once the email is confirmed, suspended / reactivated, and closure.
const { getDb } = require('../db');
const { sendEmail } = require('./mailer');
const K = require('./emailkit');
const { bad } = require('./util');
const { revokeAll } = require('./auth');
const activity = require('./activity');
const config = require('../config');
const first = (u) => (u.role === 'retailer' && /^mart manager$/i.test(String(u.name || '').trim()) ? 'Mart Manager' : String(u.name || '').split(' ')[0]);
const day = (d) => new Date(d || Date.now()).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const N = (n) => '₦' + Number(n || 0).toLocaleString('en-NG');

async function welcome(u) {
  const mart = u.role === 'retailer';
  await sendEmail({ to: u.email, name: first(u), category: 'account', ref: u.id, subject: mart ? `Welcome to Tafiki: ${u.shop} is registered` : 'Welcome to Tafiki: your account is created',
    title: mart ? `Welcome to Tafiki, ${u.shop}` : 'Welcome to Tafiki', preheader: mart ? 'Your FOODCORE Mart account is created' : 'You are now a member of FOODCORE Cooperative Limited',
    lead: mart ? `Your FOODCORE Mart account for **${u.shop}** has been created. We are glad to have you on board.` : 'Your Tafiki account has been created and you are now a member of **FOODCORE Cooperative Limited**, bound by its bye-laws. We are glad to have you.',
    blocks: [{ type: 'kv', title: 'Account details', rows: [['Name', u.name], ['Email', u.email], ['Phone', u.phone || ''], ['Account type', mart ? 'FOODCORE Mart' : 'Cooperative member'], ['Membership number', mart ? '' : u.coop_no || ''], ['Terms accepted', u.terms_version ? 'Version ' + u.terms_version : 'Yes'], ['Joined', day(u.created_at)]] },
      mart ? { type: 'steps', title: 'Getting started', steps: [{ label: 'Account created', state: 'done', sub: K.short(u.created_at) }, { label: 'Email', state: 'now', sub: 'Confirm with the code' }, { label: 'Mart approved', state: 'todo', sub: 'By Tafiki' }, { label: 'Stock arrives', state: 'todo', sub: 'When a package opens' }] }
        : { type: 'steps', title: 'Getting started', steps: [{ label: 'Account created', state: 'done', sub: K.short(u.created_at) }, { label: 'Email', state: 'now', sub: 'Confirm with the code' }, { label: 'Identity check', state: 'todo', sub: 'Smile ID, 2 minutes' }, { label: 'Buy units', state: 'todo', sub: 'Any open mart' }] },
      mart ? null : { type: 'note', tone: 'info', text: `Your first stake each membership year includes the yearly membership fee${(await require('./terms').getTerms()).membershipFee ? ' of **' + K.N((await require('./terms').getTerms()).membershipFee) + '**' : ''}. It is not unit capital: it is non-refundable and earns no returns.` }],
    next: mart ? ['Confirm your email with the code we sent.', 'Tafiki reviews and approves your mart, then assigns a package to it.', 'When the package is fully funded, stock is delivered to you on consignment.'] : ['Confirm your email with the code we sent.', 'Complete your identity check from your dashboard. It takes about two minutes.', 'Then buy units in any open FOODCORE Mart and track them from your dashboard.'],
    cta: { label: 'Sign in to Tafiki', url: K.link('login') }, help: 'If you did not create this account, reply to this email straight away.' });
}
async function activated(u) {
  await sendEmail({ to: u.email, name: first(u), category: 'account', ref: u.id, subject: 'Your Tafiki account is active', title: 'Your account is active',
    lead: 'Thank you for confirming your email. Your Tafiki account is now **active**.',
    blocks: [{ type: 'kv', title: 'Your account', rows: [['Name', u.name], ['Email', u.email + ' · confirmed'], ['Membership number', u.coop_no || ''], ['Identity check', u.kyc_status === 'verified' ? 'Verified' : u.kyc_status === 'pending' ? 'Not done yet' : 'Needs attention']] }],
    next: u.role === 'retailer' ? ['Tafiki reviews and approves your mart.', 'You will be emailed when a package is assigned to it.'] : u.kyc_status === 'verified' ? ['Your identity is already verified, so you can buy units straight away.'] : ['Complete your **identity check** from your dashboard.', 'Then buy units in any open FOODCORE Mart.'],
    cta: { label: 'Go to my dashboard', url: K.link('login') } });
}
async function statusChanged(u, status, reason) {
  if (status === 'suspended') await sendEmail({ to: u.email, name: first(u), category: 'account', ref: u.id, subject: 'Your Tafiki account has been suspended', title: 'Your account has been suspended',
    lead: `Your Tafiki account was suspended on **${day()}**.`,
    blocks: [{ type: 'kv', title: 'Account', rows: [['Name', u.name], ['Membership number', u.coop_no || ''], ['Suspended', K.when()], ['Reason', reason || 'Not given']] },
      { type: 'note', tone: 'warn', text: 'You cannot sign in while your account is suspended. **Your units and wallet are not affected** and keep their value.' }],
    next: ['Reply to this email or write to support@tafiki.com to resolve this.', 'We will reactivate your account as soon as the issue is cleared.'] });
  if (status === 'active') await sendEmail({ to: u.email, name: first(u), category: 'account', ref: u.id, subject: 'Your Tafiki account is active again', title: 'Your account is active again',
    lead: 'Good news. Your Tafiki account has been **reactivated** and you can sign in again.',
    blocks: [{ type: 'kv', title: 'Account', rows: [['Name', u.name], ['Membership number', u.coop_no || ''], ['Reactivated', K.when()]] }],
    cta: { label: 'Sign in to Tafiki', url: K.link('login') } });
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
  await sendEmail({ to: u.email, name: first(u), category: 'account', ref: u.id, subject: 'Your Tafiki account is closed', title: 'Your account is closed',
    lead: `Your Tafiki account was closed on **${day()}**${actor.type === 'admin' ? ' by Tafiki' : ' at your request'}. Thank you for being part of FOODCORE.`,
    receipt: { title: 'Closure statement', rows: [['Name', u.name], ['Membership number', u.coop_no || ''], ['Closed', K.when()], ['Units held', 'None'], ['Wallet balance', K.N(0)], ['Reason', reason || '']] },
    paragraphs: ['Your cooperative membership ends with your account. We keep your transaction records for as long as the law requires, then delete them.'],
    blocks: [{ type: 'note', tone: 'warn', title: 'Not you?', text: 'If you did not ask for this, contact **support@tafiki.com** straight away.' }] });
}
module.exports = { welcome, activated, statusChanged, blockers, close };
