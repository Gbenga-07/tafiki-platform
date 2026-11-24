// Deliveries, delivery codes, store cycles, audits, remittances and restocks.
const config = require('../config');
const { getDb } = require('../db');
const { uuid, randomCode, randomToken, sha256, HttpError, bad, now, addMinutes } = require('./util');
const { getUnitPackage, getSetting } = require('./terms');
const { DEFAULTS } = require('./settings');
const box = require('./secretbox');
const counters = require('./counters');
const { sendEmail } = require('./mailer');
const { sendSms } = require('./sms');
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
async function notifyStage(d) {
  const db = getDb(); const store = await db('users').where({ id: d.store_user_id }).first();
  const st = STAGES[d.status]; const drv = d.driver ? ` Driver: ${d.driver}${d.vehicle ? ' (' + d.vehicle + ')' : ''}.` : '';
  const storeLines = { 0: [`A stock order (#${d.code}, ${N(d.value)}) has been raised for ${store.shop}.`], 1: [`Order #${d.code} has been collected from the Tafiki Distribution Centre.${drv}`], 2: [`Order #${d.code} is on its way to ${store.shop}.${drv}`, 'Count the bags before you give the driver your delivery code. Your code is in your mart portal and by SMS.'], 3: [`Order #${d.code} was delivered and confirmed with your delivery code. The stock has been added to your consignment account.`] }[d.status];
  await sendEmail({ to: store.email, name: 'Mart Manager', category: 'delivery', ref: d.code, subject: `Order #${d.code}: ${st}`, paragraphs: storeLines });
  if (d.status === 2) { const code = box.open(d.code_enc); await sendSms({ to: store.phone, category: 'delivery_code', ref: d.code, mask: code, text: `Tafiki: Order ${d.code} is on its way to ${store.shop}. Count the bags, then give the driver this delivery code: ${code}. Never share it before delivery.` }); }
  for (const u of await holdersOf(d)) await sendEmail({ to: u.email, name: u.name.split(' ')[0], category: 'delivery', ref: d.code, subject: `Order #${d.code}: ${st}`, paragraphs: [d.status === 3 ? `Your stock (${N(d.value)}) was delivered to ${store.shop} and confirmed by the mart. It is now on the shelf and trading.` : `Your stock order for ${store.shop} is now at the "${st}" stage.`] });
}
async function logStage(d, stage, note, actor) { await getDb()('delivery_log').insert({ delivery_id: d.id, stage, note: note || null, actor: actor || 'system', at: new Date() }); }

async function createDelivery({ kind, storeUserId, holdingId, packageId, cycle, lines, code }, actor) {
  const db = getDb(); const id = uuid(); const secret = randomCode(6);
  const value = lines.reduce((a, l) => a + l.qty * l.unit_cost, 0);
  const dcode = code || 'TR-' + (await counters.next('store_order', 2001));
  await db('deliveries').insert({ id, code: dcode, kind, cycle: cycle || null, holding_id: holdingId || null, package_id: packageId || null, store_user_id: storeUserId, status: 0, code_hash: sha256(id + '|' + secret), code_enc: box.seal(secret), driver_token: randomToken(24), value });
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
  const out = [];
  for (const h of hs) { if (await db('deliveries').where({ holding_id: h.id, kind: 'stake' }).first()) continue; out.push(await createDelivery({ kind: 'stake', storeUserId: p.store_user_id, holdingId: h.id, packageId, lines: await linesForUnits(h.units), code: 'SO-' + h.ref.replace('FC-', '') }, actor)); }
  return out;
}

// expectStatus: the job runner passes the stage it saw, so a delivery that another runner (or an admin) has just
// moved is skipped instead of being moved a second time.
async function advance(id, actor, note, expectStatus) {
  const db = getDb(); const d = await db('deliveries').where({ id }).first();
  if (!d) throw new HttpError(404, 'Delivery not found.');
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
async function markDelivered(d, how, actor) {
  const db = getDb(); const at = now();
  const won = await db('deliveries').where({ id: d.id }).where('status', '<', 3).update({ status: 3, delivered_at: at, override_reason: how.override || null });
  if (!won) throw bad('This delivery is already complete.');
  const nd = await db('deliveries').where({ id: d.id }).first();
  await logStage(nd, 3, how.override ? 'Override: ' + how.override : 'Confirmed with delivery code', how.by || 'driver');
  // first stock of a cycle (stake delivery, or restock after reconciliation) starts the store's cycle
  const cur = await db('store_cycles').where({ store_user_id: d.store_user_id }).orderBy('k', 'desc').first();
  if (!cur || (cur.restock_released_at && d.kind === 'restock')) await ensureCycle(d.store_user_id, at);
  await activity.log(actor || null, 'delivery.delivered', { type: 'delivery', id: d.id }, { code: d.code, override: how.override || null });
  await notifyStage(nd);
  return nd;
}
async function completeWithCode(d, code, by) {
  const db = getDb(); const L = await getSetting('logistics');
  if (d.status === 3) throw bad('This delivery is already complete.');
  if (d.status < 2) throw bad('The delivery must be in transit before it can be completed.');
  if (d.code_attempts >= L.maxCodeAttempts) throw new HttpError(423, 'Too many wrong codes. Tafiki operations has been alerted.');
  if (sha256(d.id + '|' + String(code || '').trim()) !== d.code_hash) {
    await db('deliveries').where({ id: d.id }).increment('code_attempts', 1);
    const fresh = await db('deliveries').where({ id: d.id }).first();
    if (fresh.code_attempts === L.maxCodeAttempts) { await activity.log(null, 'delivery.code_locked', { type: 'delivery', id: d.id }, { code: d.code }); const admins = await db('admins').where({ status: 'active' }).whereIn('role', ['Super Admin', 'Operations Manager', 'Logistics Officer']); for (const a of admins) await sendEmail({ to: a.email, name: a.name.split(' ')[0], category: 'operations', ref: d.code, subject: `Delivery #${d.code} locked after wrong codes`, paragraphs: ['Too many wrong delivery codes were entered. Contact the mart and driver, then reissue the code or complete the delivery with a reason.'] }); }
    throw bad('That delivery code is not correct.');
  }
  return markDelivered(d, { by }, null);
}
async function reissueCode(id, actor) {
  const db = getDb(); const d = await db('deliveries').where({ id }).first(); if (!d) throw new HttpError(404, 'Delivery not found.');
  if (d.status === 3) throw bad('This delivery is complete.');
  const secret = randomCode(6);
  await db('deliveries').where({ id }).update({ code_hash: sha256(id + '|' + secret), code_enc: box.seal(secret), code_attempts: 0 });
  const store = await db('users').where({ id: d.store_user_id }).first();
  await sendSms({ to: store.phone, category: 'delivery_code', ref: d.code, mask: secret, text: `Tafiki: New delivery code for order ${d.code}: ${secret}. Give it to the driver only after counting the bags.` });
  await activity.log(actor, 'delivery.code_reissued', { type: 'delivery', id });
  return true;
}

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
  await sendEmail({ to: store.email, name: 'Mart Manager', category: 'audit', ref: 'cycle-' + c.k, subject: `Day-28 audit recorded for cycle ${c.k}`, paragraphs: [`Audited sales for cycle ${c.k}: ${N(value)}.`, `Remittance due: ${N(acc.remittanceDue + Math.round(value))}. Pay into the Tafiki Collections Account and report it in your mart portal.`] });
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
  return db('remittances').where({ id }).first();
}
async function decideRemittance(id, ok, actor, note) {
  const db = getDb(); const r = await db('remittances').where({ id }).first(); if (!r) throw new HttpError(404, 'Remittance not found.');
  if (r.status !== 'pending') throw bad('This remittance has already been decided.');
  if (!(await db('remittances').where({ id, status: 'pending' }).update({ status: ok ? 'confirmed' : 'rejected', confirmed_by: actor.id, confirmed_at: now(), note: note || null }))) throw bad('This remittance has already been decided.');
  const store = await db('users').where({ id: r.store_user_id }).first();
  await sendEmail({ to: store.email, name: 'Mart Manager', category: 'remittance', ref: r.ref, subject: ok ? `Remittance ${r.ref} confirmed` : `Remittance ${r.ref} could not be confirmed`, paragraphs: [ok ? `We have confirmed your remittance of ${N(r.amount)} (${r.ref}).` : `We could not find your remittance of ${N(r.amount)} (${r.ref}) in the collections account${note ? ': ' + note : ''}. Reply with your proof of payment.`] });
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
    for (const [k, h] of hs.entries()) {
      const lines = pack.items.map((i) => ({ sku: i.sku, name: i.name, size: i.size, brand: i.brand, qty: share[i.sku][k], unit_cost: i.cost })).filter((l) => l.qty > 0);
      if (!lines.length) continue;
      await createDelivery({ kind: 'restock', cycle: c.k, storeUserId: c.store_user_id, holdingId: h.id, packageId: h.package_id, lines, code: `SO-${h.ref.replace('FC-', '')}-R${c.k}` }, null); made++; n++;
    }
    if (!made) await ensureCycle(c.store_user_id, now()); // nothing sold: the next cycle starts straight away
    await activity.log(null, 'store.restock_released', { type: 'user', id: c.store_user_id }, { cycle: c.k, deliveries: made, share: Math.round(f * 1000) / 10 + '%' });
  }
  return n;
}
async function autoAdvance() {
  const db = getDb(); const L = await getSetting('logistics'); let n = 0;
  const open = await db('deliveries').where({ auto: true }).whereIn('status', [0, 1]);
  for (const d of open) {
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
    for (const a of admins) await sendEmail({ to: a.email, name: a.name.split(' ')[0], category: 'audit', ref: 'cycle-' + c.k, subject: `Day-28 audit due: ${store.shop}`, paragraphs: [`Cycle ${c.k} at ${store.shop} has reached day 28. Record the audit in the Tafiki Console.`] });
    await sendEmail({ to: store.email, name: 'Mart Manager', category: 'audit', ref: 'cycle-' + c.k, subject: `Your day-28 audit is due (cycle ${c.k})`, paragraphs: ['Please submit your sales for this cycle and make the shop available for the stock count.'] });
    await db('store_cycles').where({ id: c.id }).update({ reminder_sent: true });
  }
  return due.length;
}
module.exports = { STAGES, createDelivery, deliveriesForPackage, linesForUnits, advance, markDelivered, completeWithCode, reissueCode, storeAccount, recordAudit, reportRemittance, decideRemittance, reconcile, releaseRestocks, autoAdvance, auditReminders, ensureCycle };
