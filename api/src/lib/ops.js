// Deliveries, delivery codes, store cycles, audits, remittances and restocks.
const config = require('../config');
const { getDb } = require('../db');
const { uuid, randomCode, randomToken, sha256, HttpError, bad, now, addMinutes } = require('./util');
const { getUnitPackage, getSetting } = require('./terms');
const { DEFAULTS } = require('./settings');
const box = require('./secretbox');
const counters = require('./counters');
const { sendEmail } = require('./mailer');
const K = require('./emailkit');
const activity = require('./activity');
DEFAULTS.logistics = { stageHours: 6, auditDay: 28, cycleDays: 30, maxCodeAttempts: 5 };
const STAGES = ['Order Received', 'Picked Up', 'In Transit', 'Delivered'];
const N = (n) => '₦' + Number(n).toLocaleString('en-NG');
const DAY = 24 * 60;

async function holdersOf(d) {
  const db = getDb();
  if (!d.holding_id) return [];
  const h = await db('holdings').where({ id: d.holding_id }).first();
  return h ? [await db('users').where({ id: h.user_id }).first()] : [];
}
async function notifyStage(d) { if (!d.bundle_code) await notifyMart(d, null); await notifyHolders(d); }
// the mart: one email per stage; for a bundle, one email for the whole bundle (lines added up, one delivery code)
async function notifyMart(d, linesOverride, count) {
  const db = getDb(); const store = await db('users').where({ id: d.store_user_id }).first();
  const st = STAGES[d.status], si = d.status, L = DEFAULTS.logistics;
  const log = await db('delivery_log').where({ delivery_id: d.id }).orderBy('at');
  const at = (i) => { const e = log.filter((x) => x.stage === i).pop(); return e ? e.at : i === si ? new Date() : null; };
  const ls = linesOverride || await db('delivery_lines').where({ delivery_id: d.id });
  const bags = ls.reduce((a, l) => a + Number(l.qty), 0);
  const type = d.kind === 'restock' ? `Restock · after cycle ${d.cycle}` : d.kind === 'stake' ? 'Opening stock' : 'Mart order';
  const driver = d.driver ? `${d.driver}${d.vehicle ? ' · ' + d.vehicle : ''}` : '';
  const nextBy = si < 2 && at(si) ? K.when(new Date(new Date(at(si)).getTime() + (L.stageHours || 6) * 3600000)) : '';
  const steps = { type: 'steps', title: 'Delivery progress', steps: STAGES.map((label, i) => ({ label, state: i < si ? 'done' : i === si ? 'now' : 'todo', sub: i <= si && at(i) ? K.when(at(i)).replace(/ \d{4},/, ',').replace(' WAT', '') : 'Pending' })) };
  const items = (withValue) => ({ type: 'items', title: 'Items', head: withValue ? ['Product', 'Bags', 'Value'] : ['Product', 'Bags'], right: [1, 2],
    rows: ls.map((l) => [[`${l.name}`, [l.size, l.brand].filter(Boolean).join(' · ')], Number(l.qty).toLocaleString(), ...(withValue ? [K.N(l.qty * l.unit_cost)] : [])]),
    total: ['Total', bags.toLocaleString(), ...(withValue ? [K.N(d.value)] : [])] });
  // the mart
  const lead = {
    0: `A stock order for **${store.shop}** has been raised and is being prepared at the Tafiki Distribution Centre. We will let you know as soon as it is collected for delivery.`,
    1: `Your order has been collected from the Tafiki Distribution Centre${driver ? ` by **${driver}**` : ''}. ${nextBy ? `The next update is expected by **${nextBy}**.` : 'We will update you at the next stage.'}`,
    2: `Your order is now **in transit** to **${store.shop}**. When it arrives, count the bags, then tap **All received** in your mart portal. If anything is short or damaged, tap **Report a problem** instead.`,
    3: `Your order has been delivered to **${store.shop}** and confirmed with your delivery code on **${K.when(at(3))}**. The stock has been added to your consignment account.` }[si];
  const next = {
    0: ['The order is packed and checked against the order list.', `A driver collects it, usually within ${L.stageHours || 6} hours.`, 'You receive an email at every stage until delivery.'],
    1: [`The driver heads to ${store.shop}.`, 'You will receive an email with your **delivery code** when the order is in transit. It is also in your mart portal.', 'Make sure someone authorised is at the mart to receive it.'],
    2: ['**Count the bags** against the list above.', 'All correct? Tap **All received** in your mart portal. The driver can leave once you have confirmed.', 'Short or damaged? Tap **Report a problem** instead of confirming. Tafiki sorts it out with you.'],
    3: ['Record your sales as usual through your Tafiki mart portal.', `Your stock is audited on day ${L.auditDay || 28} of the cycle and the remittance is settled.`, 'The next restock is released after reconciliation.'] }[si];
  let receipt;
  if (si === 3) { const acc = await storeAccount(store.id);
    receipt = { title: 'Goods received note', amount: Number(d.value), direction: 'goods', rows: [['Received by', store.shop], ['Order', `#${d.code} · ${type}`], ['Bags received', bags.toLocaleString()], ['Delivered', K.when(at(3))], ['Driver', driver], ['Stock on consignment now', K.N(acc.onShelf)]], total: ['Value received', K.N(d.value)], note: 'The stock stays Tafiki property until sold. Sales are recorded at the day-28 audit and become remittance due.' }; }
  await sendEmail({ to: store.email, name: 'Mart Manager', category: 'delivery', ref: d.code, subject: `Order #${d.code}: ${st}`, title: `Order #${d.code}: ${st}`, tag: st, preheader: `${bags.toLocaleString()} bags for ${store.shop} · ${st}`,
    lead, blocks: [{ type: 'kv', title: 'Order details', rows: [['Order number', '#' + d.code], ['Order type', type], ['Delivering to', store.shop], ['Supplied by', 'FOODCORE Cooperative Limited · Tafiki Distribution Centre'], ['Driver', si >= 1 ? driver : ''], ['Status', st]] }, items(true), steps,
      null,
      si === 2 ? { type: 'note', tone: 'warn', title: 'Keep your delivery code private', text: 'The same code is in your mart portal. Never share it before the bags are counted. Tafiki staff will never ask for it.' } : null],
    receipt, next, cta: si === 2 ? { label: 'Confirm receipt in my portal', url: K.link('shop-orders') } : undefined, help: `Questions about this order? Reply to this email quoting **#${d.code}**, or contact Tafiki Operations at **support@tafiki.com**.`, team: 'Tafiki Operations' });
}
// the unit holder whose stake this stock comes from: always their own order number and steps
async function notifyHolders(d) {
  const db = getDb(); const store = await db('users').where({ id: d.store_user_id }).first();
  const st = STAGES[d.status], si = d.status, L = DEFAULTS.logistics;
  const log = await db('delivery_log').where({ delivery_id: d.id }).orderBy('at');
  const at = (i) => { const e = log.filter((x) => x.stage === i).pop(); return e ? e.at : i === si ? new Date() : null; };
  const ls = await db('delivery_lines').where({ delivery_id: d.id });
  const bags = ls.reduce((a, l) => a + Number(l.qty), 0);
  const type = d.kind === 'restock' ? `Restock · after cycle ${d.cycle}` : d.kind === 'stake' ? 'Opening stock' : 'Mart order';
  const driver = d.driver ? `${d.driver}${d.vehicle ? ' · ' + d.vehicle : ''}` : '';
  const steps = { type: 'steps', title: 'Delivery progress', steps: STAGES.map((label, i) => ({ label, state: i < si ? 'done' : i === si ? 'now' : 'todo', sub: i <= si && at(i) ? K.when(at(i)).replace(/ \d{4},/, ',').replace(' WAT', '') : 'Pending' })) };
  const items = (withValue) => ({ type: 'items', title: 'Items', head: withValue ? ['Product', 'Bags', 'Value'] : ['Product', 'Bags'], right: [1, 2],
    rows: ls.map((l) => [[`${l.name}`, [l.size, l.brand].filter(Boolean).join(' · ')], Number(l.qty).toLocaleString(), ...(withValue ? [K.N(l.qty * l.unit_cost)] : [])]),
    total: ['Total', bags.toLocaleString(), ...(withValue ? [K.N(d.value)] : [])] });
  for (const u of await holdersOf(d)) {
    const h = await db('holdings').where({ id: d.holding_id }).first();
    const hl = { 0: `We have received the stock order linked to your stake and it is being prepared at the Tafiki Distribution Centre for delivery to **${store.shop}**.`, 1: `The stock for your stake has been collected from the Tafiki Distribution Centre and is heading to **${store.shop}**.`, 2: `Your stock is now **in transit** to **${store.shop}**. The mart will confirm receipt with its delivery code when it arrives.`, 3: `Your stock has been delivered to **${store.shop}** and confirmed by the mart with its delivery code on **${K.when(at(3))}**. It is now on the shelf and trading.` }[si];
    await sendEmail({ to: u.email, name: K.first(u), category: 'delivery', ref: d.code, subject: `Order #${d.code}: ${st}`, tag: st, title: si === 3 ? 'Your stock is on the shelf' : `Your stock: ${st}`, lead: hl,
      blocks: [{ type: 'kv', title: 'Order details', rows: [['Order number', '#' + d.code], ['Order type', type], ['Your stake', h ? `${h.ref} · ${K.units(h.units)}` : ''], ['Delivering to', store.shop], ['Stock value', K.N(d.value)], ['Status', st]] }, items(true), steps],
      next: si === 3 ? [d.kind === 'restock' ? 'This restock was bought from the last cycle’s sales, so there is nothing to pay.' : 'Your stake is now active in the current trading cycle.', 'Sales are recorded after the day-28 audit and the remittance is confirmed.', 'Your returns are paid to your Tafiki wallet at the end of each 90-day cycle.'] : ['You will get an email at each stage until the stock is delivered.', 'The mart confirms receipt with its own delivery code, so every delivery is accounted for.'],
      cta: { label: 'Track on my dashboard', url: K.link('me-invest') }, team: 'Tafiki Operations' });
  }
}
async function logStage(d, stage, note, actor) { await getDb()('delivery_log').insert({ delivery_id: d.id, stage, note: note || null, actor: actor || 'system', at: new Date() }); }

async function createDelivery({ kind, storeUserId, holdingId, packageId, cycle, lines, code, bundleCode, secret: shared }, actor) {
  const db = getDb(); const id = uuid(); const secret = shared || randomCode(6);
  const value = lines.reduce((a, l) => a + l.qty * l.unit_cost, 0);
  const dcode = code || 'TR-' + (await counters.next('store_order', 2001));
  await db('deliveries').insert({ id, code: dcode, kind, cycle: cycle || null, holding_id: holdingId || null, package_id: packageId || null, store_user_id: storeUserId, bundle_code: bundleCode || null, status: 0, code_hash: sha256(id + '|' + secret), code_enc: box.seal(secret), driver_token: randomToken(24), value });
  for (const l of lines) await db('delivery_lines').insert({ delivery_id: id, ...l });
  const d = await db('deliveries').where({ id }).first();
  await logStage(d, 0, null, actor ? actor.type + ':' + actor.id : 'system');
  await activity.log(actor || null, 'delivery.created', { type: 'delivery', id }, { code: dcode, kind, value });
  await notifyStage(d);
  return d;
}
async function linesForUnits(units) { const p = await getUnitPackage(); return p.items.map((i) => ({ sku: i.sku, name: i.name, size: i.size, brand: i.brand, qty: i.bags * units, unit_cost: i.cost })); }

// When a package opens, each holding's stock is sent to the store.
async function deliveriesForPackage(packageId, actor) {
  const db = getDb(); const p = await db('packages').where({ id: packageId }).first();
  const hs = await db('holdings').where({ package_id: packageId }).whereIn('status', ['active', 'redeem']);
  const out = []; const todo = [];
  for (const h of hs) if (!(await db('deliveries').where({ holding_id: h.id, kind: 'stake' }).first())) todo.push(h);
  if (!todo.length) return out;
  // one bundle for the whole mart: one order number, one delivery code, one truck; each stake keeps its own order
  const bundleCode = await newBundleCode(); const secret = randomCode(6);
  for (const h of todo) out.push(await createDelivery({ kind: 'stake', storeUserId: p.store_user_id, holdingId: h.id, packageId, lines: await linesForUnits(h.units), code: 'SO-' + h.ref.replace('FC-', ''), bundleCode, secret }, actor));
  await notifyBundle(bundleCode);
  return out;
}

// expectStatus: the job runner passes the stage it saw, so a delivery that another runner (or an admin) has just
// moved is skipped instead of being moved a second time.
async function advance(id, actor, note, expectStatus, inner) {
  const db = getDb(); const d = await db('deliveries').where({ id }).first();
  if (!d) throw new HttpError(404, 'Delivery not found.');
  if (d.bundle_code && !inner) return advanceBundle(d.bundle_code, actor, note, expectStatus);
  if (expectStatus !== undefined && d.status !== expectStatus) return null;
  if (d.status >= 2) throw bad(d.status === 3 ? 'This delivery is complete.' : 'The last step needs the mart’s delivery code.');
  if (!(await db('deliveries').where({ id, status: d.status }).update({ status: d.status + 1, delay_minutes: 0 }))) { if (expectStatus !== undefined) return null; throw bad('This delivery has just moved on.'); }
  const nd = await db('deliveries').where({ id }).first();
  await logStage(nd, nd.status, note, actor ? actor.type + ':' + actor.id : 'auto');
  await notifyStage(nd);
  return nd;
}
async function ensureCycle(storeUserId, startAt) {
  const db = getDb(); const L = await getSetting('logistics');
  const open = await db('store_cycles').where({ store_user_id: storeUserId }).orderBy('k', 'desc').first();
  if (open && !open.restock_released_at) return open; // current cycle still running
  const k = open ? open.k + 1 : 1; const s = new Date(startAt);
  await db('store_cycles').insert({ store_user_id: storeUserId, k, start_at: s, audit_at: addMinutes(s, L.auditDay * DAY), restock_at: addMinutes(s, L.cycleDays * DAY) });
  return db('store_cycles').where({ store_user_id: storeUserId, k }).first();
}
async function markDelivered(d, how, actor, inner) {
  if (d.bundle_code && !inner) return deliverBundle(d.bundle_code, how, actor);
  const db = getDb(); const at = now();
  const won = await db('deliveries').where({ id: d.id }).where('status', '<', 3).update({ status: 3, delivered_at: at, override_reason: how.override || null, confirmed_by: how.who || null });
  if (!won) throw bad('This delivery is already complete.');
  const nd = await db('deliveries').where({ id: d.id }).first();
  await logStage(nd, 3, how.note || (how.override ? 'Override: ' + how.override : 'Confirmed with delivery code'), how.by || 'driver');
  // first stock of a cycle (stake delivery, or restock after reconciliation) starts the store's cycle
  const cur = await db('store_cycles').where({ store_user_id: d.store_user_id }).orderBy('k', 'desc').first();
  if (!cur || (cur.restock_released_at && d.kind === 'restock')) await ensureCycle(d.store_user_id, at);
  await activity.log(actor || null, 'delivery.delivered', { type: 'delivery', id: d.id }, { code: d.code, override: how.override || null });
  await notifyStage(nd);
  return nd;
}
const NO_CODES = () => new HttpError(410, 'Delivery codes are no longer used. The mart confirms receipt in its Tafiki portal.');
async function completeWithCode() { throw NO_CODES(); }
async function reissueCode() { throw NO_CODES(); }

async function storeAccount(storeUserId) {
  const db = getDb();
  const consigned = Number((await db('deliveries').where({ store_user_id: storeUserId, status: 3 }).sum({ s: 'value' }).first()).s) || 0;
  const sold = Number((await db('store_cycles').where({ store_user_id: storeUserId }).sum({ s: 'audited_value' }).first()).s) || 0;
  const remitted = Number((await db('remittances').where({ store_user_id: storeUserId, status: 'confirmed' }).sum({ s: 'amount' }).first()).s) || 0;
  const pending = Number((await db('remittances').where({ store_user_id: storeUserId, status: 'pending' }).sum({ s: 'amount' }).first()).s) || 0;
  const cycle = await db('store_cycles').where({ store_user_id: storeUserId }).orderBy('k', 'desc').first();
  return { stockReceived: consigned, auditedSales: sold, remittanceConfirmed: remitted, remittancePending: pending, remittanceDue: Math.max(0, sold - remitted), onShelf: consigned - sold, cycle: cycle || null };
}

async function recordAudit(storeUserId, value, actor) {
  const db = getDb(); const c = await db('store_cycles').where({ store_user_id: storeUserId }).orderBy('k', 'desc').first();
  if (!c || c.restock_released_at) throw bad('This mart has no cycle waiting for an audit.');
  if (c.audited_at) throw bad(`Cycle ${c.k} has already been audited.`);
  if (new Date(c.audit_at) > now()) throw bad(`The day-28 audit for cycle ${c.k} opens on ${new Date(c.audit_at).toDateString()}.`);
  const acc = await storeAccount(storeUserId);
  if (!(value >= 0) || value > acc.onShelf) throw bad(`The audited sales value must be between ₦0 and the ${N(acc.onShelf)} on the shelf.`);
  if (!(await db('store_cycles').where({ id: c.id }).whereNull('audited_at').update({ audited_value: Math.round(value), audited_at: now(), audited_by: actor.id }))) throw bad(`Cycle ${c.k} has already been audited.`);
  const store = await db('users').where({ id: storeUserId }).first();
  await sendEmail({ to: store.email, name: 'Mart Manager', category: 'audit', ref: 'cycle-' + c.k, subject: `Day-28 audit recorded for cycle ${c.k}`,
    title: `Your day-28 audit for cycle ${c.k}`, lead: `The day-28 audit at **${store.shop}** has been recorded. Here is what it found and what is now due.`,
    hero: { label: 'Remittance due', value: K.N(acc.remittanceDue + Math.round(value)), sub: 'Pay into the Tafiki Collections Account, then report it in your mart portal', tone: 'warn' },
    blocks: [{ type: 'kv', title: 'Audit result', rows: [['Mart', store.shop], ['Cycle', `${c.k} · started ${K.day(c.start_at)}`], ['Stock received to date', K.N(acc.stockReceived)], ['Audited sales this cycle', K.N(value)], ['Stock still on shelf', K.N(acc.onShelf - Math.round(value))], ['Earlier remittance still due', acc.remittanceDue ? K.N(acc.remittanceDue) : 'None'], ['Audited', K.when()]] },
      K.cycleSteps(2, { stock: 'Done', audit: K.short(), remit: 'Due now', done: 'After remittance' })],
    next: ['Pay the remittance into the **Tafiki Collections Account** shown in your mart portal.', 'Report the payment in your portal with the bank reference, so finance can match it.', `Once it is confirmed, the cycle is reconciled and your restock is released.`],
    cta: { label: 'Report my remittance', url: K.link('shop') } });
  await activity.log(actor, 'store.audited', { type: 'user', id: storeUserId }, { cycle: c.k, value });
  return db('store_cycles').where({ id: c.id }).first();
}
async function reportRemittance(store, amount, bankReference) {
  const db = getDb(); if (!(amount > 0)) throw bad('Enter the amount you paid.');
  const c = await db('store_cycles').where({ store_user_id: store.id }).orderBy('k', 'desc').first();
  const id = uuid(); let ref;
  await counters.retry(() => db.transaction(async (trx) => {
    await trx('users').where({ id: store.id }).forUpdate().first();
    const sold = Number((await trx('store_cycles').where({ store_user_id: store.id }).sum({ s: 'audited_value' }).first()).s) || 0;
    const done = Number((await trx('remittances').where({ store_user_id: store.id }).whereIn('status', ['confirmed', 'pending']).sum({ s: 'amount' }).first()).s) || 0;
    const pending = Number((await trx('remittances').where({ store_user_id: store.id, status: 'pending' }).sum({ s: 'amount' }).first()).s) || 0;
    const open = sold - done;
    if (open <= 0) throw bad(pending ? 'Your earlier remittance is still being confirmed.' : 'There is no remittance due right now.');
    if (amount > open) throw bad(`The amount due is ${N(open)}. Report the exact amount you paid, up to that figure.`);
    ref = 'RM-' + String(await counters.next('remittance', 1, trx)).padStart(4, '0');
    await trx('remittances').insert({ id, ref, store_user_id: store.id, cycle_k: c ? c.k : null, amount: Math.round(amount), bank_reference: bankReference || null, status: 'pending' });
  }));
  await activity.log({ type: 'user', id: store.id }, 'store.remittance_reported', { type: 'remittance', id }, { ref, amount });
  await sendEmail({ to: store.email, name: 'Mart Manager', category: 'remittance', ref, subject: `Remittance ${ref} received: ${N(amount)}`,
    title: 'We have recorded your remittance', lead: `Thank you. Your remittance of **${K.N(Math.round(amount))}** is recorded and with our finance team to match in the collections account.`,
    hero: { label: 'Remittance reported', value: K.N(Math.round(amount)), sub: `Reference ${ref}${bankReference ? ' · bank reference ' + bankReference : ''}`, tone: 'info' },
    blocks: [{ type: 'kv', title: 'Remittance details', rows: [['Mart', store.shop], ['Remittance reference', ref], ['Bank reference', bankReference || ''], ['Amount', K.N(Math.round(amount))], ['Reported', K.when()]] }],
    next: ['Finance matches the payment in the Tafiki Collections Account, usually within one working day.', 'You get a numbered **receipt** as soon as it is confirmed.'] });
  return db('remittances').where({ id }).first();
}
async function decideRemittance(id, ok, actor, note) {
  const db = getDb(); const r = await db('remittances').where({ id }).first(); if (!r) throw new HttpError(404, 'Remittance not found.');
  if (r.status !== 'pending') throw bad('This remittance has already been decided.');
  if (!(await db('remittances').where({ id, status: 'pending' }).update({ status: ok ? 'confirmed' : 'rejected', confirmed_by: actor.id, confirmed_at: now(), note: note || null }))) throw bad('This remittance has already been decided.');
  const store = await db('users').where({ id: r.store_user_id }).first();
  if (ok) { const acc = await storeAccount(store.id); await sendEmail({ to: store.email, name: 'Mart Manager', category: 'receipts', ref: r.ref, subject: `Receipt: remittance ${r.ref} confirmed`,
    title: 'Remittance confirmed', lead: `Thank you. We have confirmed your remittance of **${K.N(r.amount)}** into the Tafiki Collections Account.`,
    hero: { label: 'Amount confirmed', value: K.N(r.amount), sub: `${store.shop} · ${r.ref}`, tone: 'in' },
    receipt: { title: 'Remittance receipt', amount: Number(r.amount), direction: 'in', rows: [['Paid by', store.shop], ['Remittance reference', r.ref], ['Bank reference', r.bank_reference || ''], ['Cycle', r.cycle_k ? String(r.cycle_k) : ''], ['Reported', K.day(r.created_at)], ['Confirmed', K.when()], ['Remittance still due', acc.remittanceDue ? K.N(acc.remittanceDue) : 'Nothing · fully settled']], total: ['Amount confirmed', K.N(r.amount)] },
    next: acc.remittanceDue ? [`${K.N(acc.remittanceDue)} is still due for this cycle. Pay it and report it in your portal.`] : ['Your remittance is settled. The cycle is reconciled next and your restock released.'] }); }
  else await sendEmail({ to: store.email, name: 'Mart Manager', category: 'remittance', ref: r.ref, subject: `Remittance ${r.ref} could not be confirmed`,
    title: 'We could not confirm your remittance', lead: `We could not find your remittance of **${K.N(r.amount)}** in the Tafiki Collections Account.`,
    blocks: [{ type: 'kv', title: 'Remittance', rows: [['Mart', store.shop], ['Remittance reference', r.ref], ['Bank reference', r.bank_reference || 'Not given'], ['Amount', K.N(r.amount)], ['Reported', K.when(r.created_at)], ['Finance note', note || '']] },
      { type: 'note', tone: 'warn', title: 'Please send your proof of payment', text: 'Reply to this email with the bank receipt or transfer slip. Until it is confirmed, the amount still counts as remittance due.' }] });
  await activity.log(actor, ok ? 'remittance.confirmed' : 'remittance.rejected', { type: 'remittance', id }, { ref: r.ref, amount: r.amount });
  return db('remittances').where({ id }).first();
}
async function reconcile(storeUserId, actor) {
  const db = getDb(); const c = await db('store_cycles').where({ store_user_id: storeUserId }).orderBy('k', 'desc').first();
  if (!c || !c.audited_at) throw bad('Record the day-28 audit first.');
  if (c.reconciled_at) throw bad(`Cycle ${c.k} is already reconciled.`);
  const acc = await storeAccount(storeUserId);
  if (acc.remittanceDue > 0) throw bad(`${N(acc.remittanceDue)} is still due. Confirm the mart’s remittance before reconciling.`);
  if (!(await db('store_cycles').where({ id: c.id }).whereNull('reconciled_at').update({ reconciled_at: now(), reconciled_by: actor.id }))) throw bad(`Cycle ${c.k} is already reconciled.`);
  await activity.log(actor, 'store.reconciled', { type: 'user', id: storeUserId }, { cycle: c.k });
  { const store = await db('users').where({ id: storeUserId }).first(); await sendEmail({ to: store.email, name: 'Mart Manager', category: 'audit', ref: 'cycle-' + c.k, subject: `Cycle ${c.k} reconciled for ${store.shop}`,
    title: `Cycle ${c.k} is closed and reconciled`, lead: `Well done. Cycle **${c.k}** at **${store.shop}** is closed: the audit and your remittances match. Your restock is being released.`,
    blocks: [K.cycleSteps(4, { stock: 'Done', audit: 'Done', remit: 'Settled', done: K.short() })],
    receipt: { title: 'Cycle statement', rows: [['Mart', store.shop], ['Cycle', `${c.k} · ${K.short(c.start_at)} to ${K.day()}`], ['Audited sales', K.N(c.audited_value)], ['Remittance confirmed to date', K.N(acc.remittanceConfirmed)], ['Stock still on shelf', K.N(acc.onShelf)], ['Restock from', K.day(c.restock_at)]] },
    next: [`The restock replaces what sold and follows on or after **${K.day(c.restock_at)}**.`, 'You will get an email at every delivery stage, with your delivery code when it is in transit.', 'A new cycle starts when the restock arrives.'] }); }
  await releaseRestocks(); // releases straight away if the restock date has passed
  return db('store_cycles').where({ id: c.id }).first();
}
// Restock: after reconciliation and on/after the restock date, each active holding's stock is sent again.
// Restock: after reconciliation and on/after the restock date, the stock that was sold (audited sales) is replaced,
// shared across the store's active holdings in proportion to their units. The shelf returns to its original level.
async function releaseRestocks() {
  const db = getDb(); let n = 0; const pack = await getUnitPackage();
  const due = await db('store_cycles').whereNotNull('reconciled_at').whereNull('restock_released_at').where('restock_at', '<=', now());
  for (const c of due) {
    if (!(await db('store_cycles').where({ id: c.id }).whereNull('restock_released_at').update({ restock_released_at: now() }))) continue; // claimed by another run
    const pkgs = await db('packages').where({ store_user_id: c.store_user_id, stage: 'trading' });
    const hs = pkgs.length ? await db('holdings').whereIn('package_id', pkgs.map((p) => p.id)).whereIn('status', ['active', 'redeem']) : [];
    const unitValue = pack.items.reduce((a, i) => a + i.bags * i.cost, 0);
    const total = hs.reduce((a, h) => a + h.units * unitValue, 0);
    const f = total ? Math.min(1, Number(c.audited_value || 0) / total) : 0;
    let made = 0;
    // Share each product's bags across holdings by units, largest remainder first, so the bags sent add up
    // exactly to what was sold (rounding per holding would over- or under-send).
    const share = {};
    for (const i of pack.items) {
      const want = hs.map((h) => i.bags * h.units * f); const target = Math.round(want.reduce((a, x) => a + x, 0));
      const q = want.map(Math.floor); let left = target - q.reduce((a, x) => a + x, 0);
      want.map((x, k) => [x - Math.floor(x), k]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).forEach(([, k]) => { if (left > 0) { q[k]++; left--; } });
      share[i.sku] = q;
    }
    const bundleCode = await newBundleCode(); const secret = randomCode(6);
    for (const [k, h] of hs.entries()) {
      const lines = pack.items.map((i) => ({ sku: i.sku, name: i.name, size: i.size, brand: i.brand, qty: share[i.sku][k], unit_cost: i.cost })).filter((l) => l.qty > 0);
      if (!lines.length) continue;
      await createDelivery({ kind: 'restock', cycle: c.k, storeUserId: c.store_user_id, holdingId: h.id, packageId: h.package_id, lines, code: `SO-${h.ref.replace('FC-', '')}-R${c.k}`, bundleCode, secret }, null); made++; n++;
    }
    if (made) await notifyBundle(bundleCode);
    if (!made) await ensureCycle(c.store_user_id, now()); // nothing sold: the next cycle starts straight away
    await activity.log(null, 'store.restock_released', { type: 'user', id: c.store_user_id }, { cycle: c.k, deliveries: made, share: Math.round(f * 1000) / 10 + '%' });
  }
  return n;
}
async function autoAdvance() {
  const db = getDb(); const L = await getSetting('logistics'); let n = 0;
  const open = await db('deliveries').where({ auto: true }).whereIn('status', [0, 1]).orderBy('created_at');
  const seen = new Set();
  for (const d of open) {
    if (d.bundle_code) { if (seen.has(d.bundle_code)) continue; seen.add(d.bundle_code); }
    const last = await db('delivery_log').where({ delivery_id: d.id, stage: d.status }).orderBy('id', 'desc').first();
    const at = new Date(last ? last.at : d.created_at).getTime() + (L.stageHours * 60 + d.delay_minutes) * 60000;
    if (at > Date.now()) continue;
    try { if (await advance(d.id, null, 'Automatic update', d.status)) n++; }
    catch (e) { if (!(e instanceof HttpError)) throw e; } // moved on by someone else at the same moment
  }
  return n;
}
async function auditReminders() {
  const db = getDb(); const due = await db('store_cycles').whereNull('audited_at').where('audit_at', '<=', now()).where({ reminder_sent: false });
  for (const c of due) {
    const store = await db('users').where({ id: c.store_user_id }).first();
    const admins = await db('admins').where({ status: 'active' }).whereIn('role', ['Super Admin', 'Operations Manager', 'Auditor']);
    for (const a of admins) await sendEmail({ to: a.email, name: a.name.split(' ')[0], category: 'audit', ref: 'cycle-' + c.k, subject: `Day-28 audit due: ${store.shop}`,
      title: 'A day-28 audit is due', lead: `Cycle **${c.k}** at **${store.shop}** has reached day 28. Its stock count and sales audit are due.`,
      blocks: [{ type: 'kv', title: 'Mart', rows: [['Mart', store.shop], ['Cycle', String(c.k)], ['Cycle started', K.day(c.start_at)], ['Audit due', K.day(c.audit_at)], ['Mart phone', store.phone || '']] }],
      next: ['Arrange the stock count with the mart manager.', 'Record the audited sales in the Tafiki Console. The mart is emailed the remittance due straight away.'],
      cta: { label: 'Record the audit', url: K.consoleLink() }, help: 'This is an automatic reminder for the audit team.' });
    await sendEmail({ to: store.email, name: 'Mart Manager', category: 'audit', ref: 'cycle-' + c.k, subject: `Your day-28 audit is due (cycle ${c.k})`,
      title: 'Your day-28 audit is due', lead: `Cycle **${c.k}** at **${store.shop}** has reached day 28. Please get ready for the stock count and sales audit.`,
      blocks: [K.cycleSteps(1, { stock: 'Done', audit: 'Due now' }), { type: 'kv', title: 'Your cycle', rows: [['Mart', store.shop], ['Cycle', String(c.k)], ['Started', K.day(c.start_at)], ['Audit due', K.day(c.audit_at)]] }],
      next: ['Submit your sales for this cycle in your mart portal.', 'Make the shop and stock room available for the stock count.', 'After the audit you will receive an email with the remittance due.'],
      cta: { label: 'Submit my sales', url: K.link('shop') } });
    await db('store_cycles').where({ id: c.id }).update({ reminder_sent: true });
  }
  return due.length;
}

// ---------- delivery bundles ----------
async function newBundleCode() { return 'BD-' + (await counters.next('bundle', 3001)); }
async function bundleMembers(code) { const ms = await getDb()('deliveries').where({ bundle_code: code }).orderBy('code'); if (!ms.length) throw new HttpError(404, 'Delivery not found.'); return ms; }
async function bundleLines(ms) {
  const all = await getDb()('delivery_lines').whereIn('delivery_id', ms.map((m) => m.id)); const by = new Map();
  for (const l of all) { const k = l.sku; const x = by.get(k) || { sku: l.sku, name: l.name, size: l.size, brand: l.brand, qty: 0, unit_cost: l.unit_cost }; x.qty += Number(l.qty); by.set(k, x); }
  return [...by.values()];
}
// the bundle as one delivery (for the mart, the console and the driver): lowest stage of its orders, added-up lines and value
async function bundleView(code) {
  const ms = await bundleMembers(code); const first = ms.reduce((a, m) => (m.status < a.status ? m : a), ms[0]);
  return { ...first, code, value: ms.reduce((a, m) => a + Number(m.value), 0), code_attempts: Math.max(...ms.map((m) => m.code_attempts || 0)), members: ms };
}
async function notifyBundle(code) { const v = await bundleView(code); await notifyMart(v, await bundleLines(v.members), v.members.length); }
async function advanceBundle(code, actor, note, expectStatus) {
  const ms = await bundleMembers(code); const st = Math.min(...ms.map((m) => m.status));
  if (expectStatus !== undefined && st !== expectStatus) return null;
  if (st >= 2) throw bad(st === 3 ? 'This delivery is complete.' : 'The last step needs the mart’s delivery code.');
  const db = getDb(); const mine = ms.filter((x) => x.status === st).map((x) => x.id);
  // one atomic step for the whole bundle, so two clicks (or two job runners) cannot move it twice
  if (!(await db('deliveries').whereIn('id', mine).where({ status: st }).update({ status: st + 1, delay_minutes: 0 }))) { if (expectStatus !== undefined) return null; throw bad('This delivery has just moved on.'); }
  const moved = await db('deliveries').whereIn('id', mine).where({ status: st + 1 });
  for (const nd of moved) { await logStage(nd, nd.status, note, actor ? actor.type + ':' + actor.id : 'auto'); await notifyHolders(nd); }
  await notifyBundle(code);
  return moved[0];
}
async function deliverBundle(code, how, actor) {
  const db = getDb(); const at = now();
  const open = (await bundleMembers(code)).filter((m) => m.status < 3); if (!open.length) throw bad('This delivery is already complete.');
  // the whole bundle is claimed in one step, so the driver and the console cannot both complete it
  if (!(await db('deliveries').whereIn('id', open.map((m) => m.id)).where('status', '<', 3).update({ status: 3, delivered_at: at, override_reason: how.override || null, confirmed_by: how.who || null }))) throw bad('This delivery is already complete.');
  const done = await db('deliveries').whereIn('id', open.map((m) => m.id)).where({ status: 3 });
  const cur = await db('store_cycles').where({ store_user_id: open[0].store_user_id }).orderBy('k', 'desc').first();
  if (!cur || (cur.restock_released_at && open[0].kind === 'restock')) await ensureCycle(open[0].store_user_id, at);
  for (const nd of done) {
    await logStage(nd, 3, how.note || (how.override ? 'Override: ' + how.override : 'Confirmed with delivery code'), how.by || 'driver');
    await activity.log(actor || null, 'delivery.delivered', { type: 'delivery', id: nd.id }, { code: nd.code, bundle: code, override: how.override || null, by: how.who || null });
    await notifyHolders(nd);
  }
  await notifyBundle(code);
  return done[0];
}

// ---------- the mart confirms receipt, or reports a problem ----------
async function martReceive(d, store) {
  if (d.status === 3) throw bad('This delivery is already complete.');
  if (d.status < 1) throw bad('This order has not left the Tafiki Distribution Centre yet.');
  const who = `${store.shop} (mart${store.name ? ': ' + store.name : ''})`;
  return markDelivered(d, { by: 'mart:' + store.id, who, note: 'Confirmed by the mart: all bags received' }, { type: 'user', id: store.id });
}
async function martReportIssue(d, store, { lines, note }) {
  const db = getDb();
  if (d.status === 3) throw bad('This delivery is already complete.');
  if (d.status < 1) throw bad('This order has not left the Tafiki Distribution Centre yet.');
  const ids = d.members ? d.members.map((m) => m.id) : [d.id];
  const sent = d.members ? await bundleLines(d.members) : await db('delivery_lines').where({ delivery_id: d.id });
  const got = new Map((lines || []).map((l) => [String(l.sku), Math.max(0, Math.floor(Number(l.received) || 0))]));
  const rows = sent.map((l) => ({ sku: l.sku, name: l.name, size: l.size, sent: Number(l.qty), received: got.has(l.sku) ? Math.min(got.get(l.sku), Number(l.qty) * 2) : Number(l.qty) }));
  const text = String(note || '').trim().slice(0, 480);
  if (!text && rows.every((r) => r.received === r.sent)) throw bad('Tell us what is wrong: change the bags received, or add a short note.');
  await db('deliveries').whereIn('id', ids).update({ issue_at: now(), issue_by: `${store.shop}${store.name ? ' (' + store.name + ')' : ''}`, issue_note: text || null, issue_lines: JSON.stringify(rows) });
  for (const id of ids) await logStage({ id }, d.status, 'Problem reported by the mart' + (text ? ': ' + text : ''), 'mart:' + store.id);
  await activity.log({ type: 'user', id: store.id }, 'delivery.issue_reported', { type: 'delivery', id: ids[0] }, { code: d.code, note: text, short: rows.filter((r) => r.received < r.sent).map((r) => `${r.name}: ${r.sent - r.received} short`) });
  const admins = await db('admins').where({ status: 'active' }).whereIn('role', ['Super Admin', 'Operations Manager', 'Logistics Officer']);
  for (const a of admins) await sendEmail({ to: a.email, name: a.name.split(' ')[0], category: 'operations', ref: d.code, subject: `Problem reported on order #${d.code}`, title: 'A mart reported a delivery problem',
    lead: `**${store.shop}** reported a problem with order **#${d.code}** before confirming receipt. The order stays open until it is resolved.`,
    blocks: [{ type: 'items', title: 'Bags sent and received', head: ['Product', 'Sent', 'Received'], right: [1, 2], rows: rows.map((r) => [[r.name, r.size || ''], r.sent.toLocaleString(), r.received.toLocaleString()]) },
      { type: 'kv', title: 'Report', rows: [['Order', '#' + d.code], ['Mart', store.shop], ['Reported by', store.name || 'Mart manager'], ['Driver', d.driver ? `${d.driver}${d.vehicle ? ' · ' + d.vehicle : ''}` : ''], ['Note', text], ['Reported', K.when()]].filter((r) => r[1]) }],
    next: ['Call the mart manager and the driver to agree what happened.', 'If the bags are found or brought back, the mart can still tap **All received**.', 'Otherwise complete the order in the console with **Resolve and complete**, giving a clear reason.'],
    cta: { label: 'Open the Tafiki Console', url: K.consoleLink() }, help: 'This is an automatic alert for Super Admins, Operations Managers and Logistics Officers.' });
  return db('deliveries').where({ id: ids[0] }).first();
}
module.exports = { martReceive, martReportIssue, newBundleCode, bundleMembers, bundleLines, bundleView, advanceBundle, deliverBundle, notifyBundle, STAGES, createDelivery, deliveriesForPackage, linesForUnits, advance, markDelivered, completeWithCode, reissueCode, storeAccount, recordAudit, reportRemittance, decideRemittance, reconcile, releaseRestocks, autoAdvance, auditReminders, ensureCycle };
