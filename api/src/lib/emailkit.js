// Small helpers shared by every email, so the wording, dates, links and progress trackers match everywhere.
const config = require('../config');
const TZ = 'Africa/Lagos';
const base = () => String(config.appUrl || 'https://tafiki.com').replace(/\/+$/, '');
const link = (hash) => base() + (hash ? '/#' + hash : '/');
const consoleLink = () => base() + (config.consolePath || '/console');
const N = (n) => '₦' + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (d) => new Date(d || Date.now()).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ });
const short = (d) => new Date(d || Date.now()).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: TZ });
const when = (d) => new Date(d || Date.now()).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: TZ }) + ' WAT';
const units = (n) => `${n} unit${Number(n) === 1 ? '' : 's'}`;
const first = (u) => (u && u.role === 'retailer' && /^mart manager$/i.test(String(u.name || '').trim()) ? 'Mart Manager' : String((u && u.name) || '').split(' ')[0] || 'there');
const mask = (acct) => (acct ? '•••• ' + String(acct).slice(-4) : '');
const bank = (u) => (u && u.bank_name ? `${u.bank_name} ${mask(u.bank_account)}` : 'your bank account');
const addDays = (d, n) => new Date(new Date(d || Date.now()).getTime() + n * 86400000);

// The journey of a stake, shown as a four-step tracker. at: 0 bought, 1 paid, 2 units confirmed, 3 trading.
function stakeSteps(at, t = {}) {
  const L = [['Bought', t.bought], ['Paid', t.paid], ['Units confirmed', t.confirmed], ['Trading', t.trading]];
  return { type: 'steps', title: 'Your stake', steps: L.map(([label, sub], i) => ({ label, sub: sub || undefined, state: i < at ? 'done' : i === at ? 'now' : 'todo' })) };
}
// A mart's 90-day cycle: stock delivered, trading, day-28 audit, remittance, reconciled and restocked.
function cycleSteps(at, t = {}) {
  const L = [['Stock in', t.stock], ['Day-28 audit', t.audit], ['Remittance', t.remit], ['Reconciled', t.done]];
  return { type: 'steps', title: 'Cycle progress', steps: L.map(([label, sub], i) => ({ label, sub: sub || undefined, state: i < at ? 'done' : i === at ? 'now' : 'todo' })) };
}
// A withdrawal or redemption: requested, being paid, paid.
function payoutSteps(at, t = {}) {
  const L = [['Requested', t.requested], ['Processing', t.processing], ['Paid', t.paid]];
  return { type: 'steps', title: 'Payment progress', steps: L.map(([label, sub], i) => ({ label, sub: sub || undefined, state: i < at ? 'done' : i === at ? 'now' : 'todo' })) };
}
module.exports = { link, consoleLink, N, day, short, when, units, first, mask, bank, addDays, stakeSteps, cycleSteps, payoutSteps };
