// Console AI assistant (live site). Runs on the server with ANTHROPIC_API_KEY, reads the real database through
// read-only tools, and never changes data. Answers name the exact console page for any action.
const { getDb } = require('../db');
const { getTerms } = require('./terms');
const ops = require('./ops');
const units = require('./units');

const N = (n) => '₦' + Math.round(Number(n || 0)).toLocaleString('en-NG');
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const like = (s) => '%' + String(s || '').trim().replace(/^foodcore\s+(mart\s+)?/i, '').slice(0, 60) + '%';
let fetchImpl = (...a) => fetch(...a);
const setFetch = (f) => { fetchImpl = f; };

async function pkgRow(db, p) {
  const taken = await units.unitsTaken(p.id);
  const conf = await units.unitsConfirmed(p.id);
  const mart = p.store_user_id ? await db('users').where({ id: p.store_user_id }).first('shop', 'email') : null;
  const holders = await db('holdings').where({ package_id: p.id }).whereIn('status', units.CONFIRMED).countDistinct({ n: 'user_id' }).first();
  return { id: p.id, name: p.name, area: `${p.area}, ${p.city}`, route: p.route || null, stage: p.stage, unitsTotal: p.units_total, unitsTaken: taken, unitsConfirmed: conf, capitalConfirmed: N(conf * (await getTerms()).unitPrice), unitHolders: Number(holders.n), mart: mart ? mart.shop : null, martHasManager: mart ? !/\.invalid$/.test(mart.email) : null, openedAt: day(p.opened_at), page: 'admin-pkg-' + p.id };
}

const TOOLS = [
  { name: 'get_overview', description: 'Totals for the whole platform and every task waiting for an admin (payments to confirm, IDs to review, withdrawals, remittances, deliveries, audits, packages ready to open). Call this first for "what needs attention" questions.', input_schema: { type: 'object', properties: {} },
    run: async (db) => {
      const n = async (q) => Number((await q.count({ n: '*' }).first()).n);
      const t = await getTerms();
      const cap = Number((await db('holdings').whereIn('status', units.CONFIRMED).sum({ s: 'amount' }).first()).s) || 0;
      const fees = Number((await db('payments').where({ status: 'success' }).sum({ s: 'fee_amount' }).first()).s) || 0;
      const pays = Number((await db('wallet_tx').where({ type: 'payout' }).sum({ s: 'amount' }).first()).s) || 0;
      return { today: day(new Date()), capitalInvested: N(cap), membershipFeesCollected: N(fees), payoutsToMembers: N(pays), unitPrice: N(t.unitPrice),
        packages: { funding: await n(db('packages').where({ stage: 'funding' })), readyToOpen: await n(db('packages').where({ stage: 'full' })), trading: await n(db('packages').where({ stage: 'trading' })) },
        members: await n(db('users').where({ role: 'investor' })), marts: await n(db('users').where({ role: 'retailer' })),
        tasks: { transfersToConfirm: await n(db('payments').where({ status: 'pending_review' })), idsToReview: await n(db('users').where({ role: 'investor', kyc_status: 'pending' })), withdrawalsToPay: await n(db('withdrawals').where({ status: 'processing' })), remittancesToConfirm: await n(db('remittances').where({ status: 'pending' })), deliveriesOnTheWay: await n(db('deliveries').where('status', '<', 3)), auditsDue: await n(db('store_cycles').whereNull('audited_at').where('audit_at', '<=', new Date())), redemptionsToSettle: await n(db('redemptions').where({ status: 'requested' }).where('settle_after', '<=', new Date())), refundsDue: await n(db('payments').where({ status: 'refund_due' })), failedEmails: await n(db('emails').where({ status: 'failed' })) } };
    } },
  { name: 'list_packages', description: 'Every investment package (one per FOODCORE Mart) with stage, units taken/confirmed, capital, unit holders and its mart. Optional stage filter: funding, full, trading.', input_schema: { type: 'object', properties: { stage: { type: 'string' } } },
    run: async (db, { stage }) => { let q = db('packages').orderBy('name'); if (stage) q = q.where({ stage }); const out = []; for (const p of await q) out.push(await pkgRow(db, p)); return out; } },
  { name: 'get_package', description: 'One package by name (e.g. "Ikotun"), with every stake, payout runs and deliveries.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    run: async (db, { name }) => {
      const p = await db('packages').where('name', 'like', like(name)).first(); if (!p) return { error: 'No package matches ' + name };
      const o = await pkgRow(db, p);
      o.stakes = (await db('holdings as h').join('users as u', 'u.id', 'h.user_id').where('h.package_id', p.id).whereNot('h.status', 'cancelled').select('h.ref', 'u.name', 'h.units', 'h.amount', 'h.status', 'h.paid_at')).map((h) => ({ ref: h.ref, member: h.name, units: h.units, amount: N(h.amount), status: h.status, paid: day(h.paid_at) }));
      o.payoutRuns = (await db('payout_runs').where({ package_id: p.id }).orderBy('cycle_no')).map((r) => ({ cycle: r.cycle_no, perUnit: N(r.per_unit), paidToMembers: N(r.investors_total), date: day(r.created_at) }));
      o.deliveries = (await db('deliveries').where({ package_id: p.id })).map((d) => ({ code: d.code, kind: d.kind, stage: ops.STAGES[d.status], value: N(d.value) }));
      return o;
    } },
  { name: 'list_marts', description: 'Every FOODCORE Mart with manager, stock received, audited sales, stock on shelf, remittance due and current cycle.', input_schema: { type: 'object', properties: {} },
    run: async (db) => { const out = []; for (const u of await db('users').where({ role: 'retailer' }).orderBy('shop')) { const a = await ops.storeAccount(u.id); out.push({ name: u.shop, manager: /\.invalid$/.test(u.email) ? 'Not assigned yet' : u.name, phone: u.phone || null, approved: u.kyc_status === 'verified', stockReceived: N(a.stockReceived), auditedSales: N(a.auditedSales), onShelf: N(a.onShelf), remittanceDue: N(a.remittanceDue), remittancePending: N(a.remittancePending), cycle: a.cycle ? { number: a.cycle.k, auditDate: day(a.cycle.audit_at), audited: !!a.cycle.audited_at, reconciled: !!a.cycle.reconciled_at } : null, page: 'admin-store-' + u.id }); } return out; } },
  { name: 'find_member', description: 'Look up a member by name, email, phone or cooperative number: stakes, wallet balance, payments, withdrawals, ID and membership status.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: async (db, { query }) => {
      const w = '%' + String(query).trim() + '%';
      const us = await db('users').where({ role: 'investor' }).where((b) => b.where('name', 'like', w).orWhere('email', 'like', w).orWhere('phone', 'like', w).orWhere('coop_no', 'like', w)).limit(5);
      if (!us.length) return { error: 'No member matches ' + query };
      const out = [];
      for (const u of us) {
        const bal = Number((await db('wallet_tx').where({ user_id: u.id }).whereNot({ status: 'rejected' }).sum({ s: 'amount' }).first()).s) || 0;
        out.push({ name: u.name, email: u.email, phone: u.phone, coopNo: u.coop_no, idStatus: u.kyc_status, accountStatus: u.status, phoneConfirmed: !!u.phone_verified_at, membershipValidUntil: day(u.membership_until), walletBalance: N(bal),
          stakes: (await db('holdings as h').join('packages as p', 'p.id', 'h.package_id').where('h.user_id', u.id).whereNot('h.status', 'cancelled').select('h.ref', 'p.name', 'h.units', 'h.amount', 'h.status')).map((h) => ({ ref: h.ref, mart: h.name, units: h.units, amount: N(h.amount), status: h.status })),
          payments: (await db('payments').where({ user_id: u.id }).orderBy('created_at', 'desc').limit(8)).map((p) => ({ reference: p.reference, amount: N(p.amount), fee: N(p.fee_amount), method: p.method, status: p.status, date: day(p.created_at) })),
          withdrawals: (await db('withdrawals').where({ user_id: u.id }).orderBy('created_at', 'desc').limit(5)).map((x) => ({ ref: x.ref, amount: N(x.amount), status: x.status, date: day(x.created_at) })), page: 'admin-inv-' + u.id });
      }
      return out;
    } },
  { name: 'list_pending', description: 'Items waiting for an admin of one type: payments (bank transfers to confirm), withdrawals, remittances, ids, redemptions, deliveries, refunds.', input_schema: { type: 'object', properties: { type: { type: 'string', enum: ['payments', 'withdrawals', 'remittances', 'ids', 'redemptions', 'deliveries', 'refunds'] } }, required: ['type'] },
    run: async (db, { type }) => {
      if (type === 'payments' || type === 'refunds') return (await db('payments as p').join('users as u', 'u.id', 'p.user_id').leftJoin('holdings as h', 'h.id', 'p.holding_id').where('p.status', type === 'payments' ? 'pending_review' : 'refund_due').select('p.reference', 'u.name', 'p.amount', 'p.fee_amount', 'h.ref', 'p.created_at')).map((x) => ({ reference: x.reference, member: x.name, amount: N(x.amount), fee: N(x.fee_amount), stake: x.ref, since: day(x.created_at) }));
      if (type === 'withdrawals') return (await db('withdrawals as w').join('users as u', 'u.id', 'w.user_id').where('w.status', 'processing').select('w.ref', 'u.name', 'w.amount', 'w.bank_name', 'w.created_at')).map((x) => ({ ref: x.ref, member: x.name, amount: N(x.amount), bank: x.bank_name, since: day(x.created_at) }));
      if (type === 'remittances') return (await db('remittances as m').join('users as u', 'u.id', 'm.store_user_id').where('m.status', 'pending').select('m.ref', 'u.shop', 'm.amount', 'm.bank_reference', 'm.created_at')).map((x) => ({ ref: x.ref, mart: x.shop, amount: N(x.amount), bankReference: x.bank_reference, since: day(x.created_at) }));
      if (type === 'ids') return (await db('users').where({ role: 'investor', kyc_status: 'pending' }).select('name', 'email', 'created_at')).map((x) => ({ member: x.name, email: x.email, joined: day(x.created_at) }));
      if (type === 'redemptions') return (await db('redemptions as r').join('users as u', 'u.id', 'r.user_id').where('r.status', 'requested').select('u.name', 'r.amount', 'r.settle_after')).map((x) => ({ member: x.name, amount: N(x.amount), settlesFrom: day(x.settle_after) }));
      return (await db('deliveries as d').join('users as u', 'u.id', 'd.store_user_id').where('d.status', '<', 3).select('d.code', 'u.shop', 'd.status', 'd.value')).map((x) => ({ code: x.code, mart: x.shop, stage: ops.STAGES[x.status], value: N(x.value) }));
    } },
  { name: 'money_summary', description: 'Money in and out over the last N days (default 30): unit payments, membership fees, remittances from marts, payouts, withdrawals paid, redemptions.', input_schema: { type: 'object', properties: { days: { type: 'number' } } },
    run: async (db, { days }) => {
      const since = new Date(Date.now() - (Number(days) || 30) * 864e5); const sum = async (q, c = 'amount') => Number((await q.sum({ s: c }).first()).s) || 0;
      const paid = await sum(db('payments').where({ status: 'success' }).where('created_at', '>=', since)); const fees = await sum(db('payments').where({ status: 'success' }).where('created_at', '>=', since), 'fee_amount');
      return { period: `last ${Number(days) || 30} days`, unitPayments: N(paid - fees), membershipFees: N(fees), remittancesConfirmed: N(await sum(db('remittances').where({ status: 'confirmed' }).where('confirmed_at', '>=', since))), payoutsToWallets: N(await sum(db('wallet_tx').where({ type: 'payout' }).where('created_at', '>=', since))), withdrawalsPaid: N(await sum(db('withdrawals').where({ status: 'paid' }).where('decided_at', '>=', since))), redemptionsSettled: N(await sum(db('redemptions').where({ status: 'settled' }).where('settled_at', '>=', since))) };
    } },
  { name: 'search_emails', description: 'Find emails sent by the platform by words, person, receipt number or category (receipts, payouts, wallet, units, account, security, delivery, remittance, audit, operations). Shows status (sent, held, failed).', input_schema: { type: 'object', properties: { query: { type: 'string' }, category: { type: 'string' } } },
    run: async (db, { query, category }) => { let q = db('emails').orderBy('created_at', 'desc').limit(15).select('to_email', 'to_name', 'category', 'subject', 'status', 'receipt_no', 'amount', 'created_at'); if (category) q = q.where({ category }); if (query) { const w = '%' + query + '%'; q = q.where((b) => b.where('subject', 'like', w).orWhere('to_email', 'like', w).orWhere('to_name', 'like', w).orWhere('receipt_no', 'like', w)); } return (await q).map((e) => ({ to: `${e.to_name || ''} <${e.to_email}>`, category: e.category, subject: e.subject, status: e.status, receipt: e.receipt_no, amount: e.amount != null ? N(e.amount) : null, date: day(e.created_at) })); } },
  { name: 'get_terms', description: 'Investment terms set in the console: unit price, units per package, target return, payout cycle, minimum hold, membership fee.', input_schema: { type: 'object', properties: {} },
    run: async () => { const t = await getTerms(); return { ...t, unitPrice: N(t.unitPrice), membershipFee: N(t.membershipFee) }; } },
];

const SYSTEM = (admin, today) => `You are the Tafiki Console Assistant for ${admin.name} (${admin.role}). Today is ${today}.
Rules:
- Always call tools to read live data before giving any figure, name, count or status. Never estimate or invent numbers. If a tool returns nothing, say so plainly.
- You cannot change anything. For any action (confirm, approve, open, pay, audit, edit) say exactly where to do it in the console and give a link.
- Be precise: quote naira amounts exactly as the tools give them, give dates as e.g. 3 Dec 2026, and name the mart or member.
- Keep answers short: a one-line answer first, then up to 6 bullets. No tables, no headings.
- Link to console pages as [[page-id|Label]]; page ids come from the tools (admin-pkg-…, admin-store-…, admin-inv-…) or: admin (dashboard), admin-slots (units and payments), admin-stores (investment packages), admin-shops (marts), admin-dispatch (deliveries), admin-audit (audit and reconciliation), admin-payouts, admin-transactions (withdrawals), admin-investors, admin-emails, admin-config (settings).
How Tafiki works: members of FOODCORE Multipurpose Cooperative buy units in a FOODCORE Mart's package (40 units). Each member's first stake each membership year also pays the yearly membership fee, which is non-refundable, earns no returns and is never capital. When all 40 units are confirmed the package is opened; the unit money buys stock that is delivered to the mart on consignment, confirmed with a one-time delivery code. On day 28 of each cycle the mart is audited, the mart remits audited sales, the cycle is reconciled and the sold stock is restocked. Payouts are paid to member wallets from realised profit each cycle; members withdraw to their bank with an SMS code. Units can be redeemed after the minimum hold with 90 days' notice.`;

async function ask(admin, messages) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { text: 'The assistant is not switched on for this server yet. Add ANTHROPIC_API_KEY to the API settings to enable it.' };
  const db = getDb(); const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Lagos' });
  const msgs = messages.filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content.trim()).slice(-12).map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length) return { text: 'Ask me anything about the platform.' };
  const tools = TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  for (let round = 0; round < 8; round++) {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: 1500, system: SYSTEM(admin, today), tools, messages: msgs }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { console.error('AI error', res.status, body && body.error); return { text: res.status === 429 ? 'The assistant is busy. Try again in a moment.' : 'The assistant could not answer just now. Please try again.' }; }
    const uses = (body.content || []).filter((c) => c.type === 'tool_use');
    if (body.stop_reason !== 'tool_use' || !uses.length) return { text: (body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim() || 'I could not find an answer.' };
    msgs.push({ role: 'assistant', content: body.content });
    const results = [];
    for (const u of uses) {
      const t = TOOLS.find((x) => x.name === u.name);
      let out; try { out = t ? await t.run(db, u.input || {}) : { error: 'Unknown tool' }; } catch (e) { out = { error: String(e.message).slice(0, 200) }; }
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 60000) });
    }
    msgs.push({ role: 'user', content: results });
  }
  return { text: 'That needed too many lookups. Try a narrower question.' };
}
module.exports = { ask, TOOLS, setFetch };
