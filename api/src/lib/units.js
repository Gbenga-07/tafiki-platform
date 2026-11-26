// Core rules for units: availability, reservations, payment confirmation, certificates and opening packages.
const crypto = require('crypto');
const config = require('../config');
const { getDb } = require('../db');
const membership = require('./membership');
const { HttpError, bad, now, addMinutes } = require('./util');
const counters = require('./counters');
const { getTerms } = require('./terms');
const { sendEmail } = require('./mailer');
const K = require('./emailkit');
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
  await sendEmail({ to: user.email, name: user.name.split(' ')[0], category: 'units', ref: h.ref, subject: `Your Certificate of Stake ${certNo}`,
    title: 'Your Certificate of Stake is issued', preheader: `${K.units(h.units)} confirmed in ${(await getDb()('packages').where({ id: h.package_id }).first() || {}).name || 'FOODCORE'}`,
    lead: `Congratulations. Your **${K.units(h.units)}** are confirmed and your Certificate of Stake **${certNo}** has been issued in your name.`,
    blocks: [{ type: 'kv', title: 'Certificate details', rows: [['Certificate number', certNo], ['Issued to', user.name + (user.coop_no ? ' · ' + user.coop_no : '')], ['Stake reference', h.ref], ['FOODCORE Mart', (await getDb()('packages').where({ id: h.package_id }).first() || {}).name || ''], ['Units', `${K.units(h.units)} · ${K.N(h.units * (await getTerms()).unitPrice)} unit capital`], ['Issued on', K.day()], ['Verification code', verifyCode(h.ref, certNo, user.name)]] },
      K.stakeSteps(h.status === 'active' ? 3 : 2, { paid: h.paid_at ? K.short(h.paid_at) : undefined, confirmed: K.short(), trading: h.status === 'active' ? 'Earning now' : 'When the package is full' }),
      { type: 'note', tone: 'ok', text: 'Anyone can check this certificate is genuine with the verification code above. Keep it safe; it is your proof of ownership of these units.' }],
    next: h.status === 'active' ? ['Your units are already trading and earning.', 'Returns are paid into your Tafiki wallet at the end of each 90-day cycle.', 'Download the certificate any time from **My Investments** on your dashboard.'] : ['The package opens once every unit in it is paid and confirmed.', 'Stock then goes to the mart and your units start earning.', 'Download the certificate any time from **My Investments** on your dashboard.'],
    cta: { label: 'Download my certificate', url: K.link('me-invest') }, fullName: user.name,
    certificate: await (async () => { const db = getDb(); const t = await getTerms(); const p = await db('packages').where({ id: h.package_id }).first() || {}; const pay = await db('payments').where({ holding_id: h.id, status: 'success' }).orderBy('created_at', 'desc').first(); const up = await require('./terms').getUnitPackage();
      return { certNo, holder: user.name, ref: h.ref, units: h.units, unitPrice: t.unitPrice, packageName: p.name || 'FOODCORE', area: p.area, city: p.city, state: p.state, targetPct: t.targetPerCycle, cycleDays: t.cycleDays, minHoldMonths: t.minHoldMonths, paidBy: pay ? (pay.provider === 'transfer' ? 'Bank transfer' : pay.provider === 'flutterwave' ? 'Flutterwave' : 'Card via Paystack') : '', payRef: pay ? pay.reference : '', issuedAt: new Date(), signedName: h.signed_name, signedAt: h.signed_at, verifyCode: verifyCode(h.ref, certNo, user.name), confirmedInMart: await unitsConfirmed(h.package_id), totalUnits: p.units_total || 40, pack: (up && up.items) || [] }; })() });
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
    for (const a of admins) await sendEmail({ to: a.email, name: a.name.split(' ')[0], category: 'operations', ref: p.name, subject: `${p.name} is fully subscribed`,
      title: 'A package is fully subscribed', lead: `Every unit in **${p.name}** is now paid and confirmed. It is ready to open.`,
      hero: { label: 'Capital confirmed', value: K.N(p.units_total * terms.unitPrice), sub: `${K.units(p.units_total)} · held in escrow`, tone: 'in' },
      blocks: [{ type: 'kv', title: 'Package', rows: [['Package', p.name], ['Location', [p.area, p.city].filter(Boolean).join(', ')], ['Units', `${p.units_total} of ${p.units_total} confirmed`], ['Unit price', K.N(terms.unitPrice)], ['Full since', K.when()]] }],
      next: ['Open the package in the Tafiki Console and confirm its FOODCORE Mart.', 'Opening raises the first stock orders and starts the first 90-day cycle.', 'Unit holders are emailed automatically when it opens.'],
      cta: { label: 'Open the Tafiki Console', url: K.consoleLink() }, help: 'This is an automatic alert for Super Admins and Operations Managers.' });
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
      for (const a of admins) await sendEmail({ to: a.email, name: a.name.split(' ')[0], category: 'operations', ref: h.ref, subject: `Refund needed: payment for ${h.ref} arrived after its units were released`,
        title: 'A late payment needs a refund', lead: `A payment for **${h.ref}** arrived after its checkout lapsed, and the units are no longer available.`,
        hero: { label: 'Refund due', value: K.N(stakePart), sub: Number(payment.fee_amount) ? `The ${K.N(payment.fee_amount)} membership fee is kept: it is non-refundable and the membership is now active.` : 'The whole payment is refundable.', tone: 'warn' },
        blocks: [{ type: 'kv', title: 'Payment', rows: [['Member', (await db('users').where({ id: h.user_id }).first() || {}).name || ''], ['Stake reference', h.ref], ['Units', K.units(h.units)], ['Amount paid', K.N(payment.amount)], ['Payment reference', payment.reference], ['Method', payment.provider === 'transfer' ? 'Bank transfer' : 'Paystack'], ['Received', K.when()]] }],
        next: ['Contact the member and offer units in another open package, or', `refund ${K.N(stakePart)} to them and record the refund in the console.`],
        cta: { label: 'Open the Tafiki Console', url: K.consoleLink() }, help: 'This is an automatic alert for Super Admins and Finance Officers.' });
      return h;
    }
  }
  await db('holdings').where({ id: payment.holding_id }).update({ payment_verified: true, paid_at: now(), reserved_until: null });
  h = await db('holdings').where({ id: payment.holding_id }).first();
  const u = await db('users').where({ id: h.user_id }).first();
  const pkg = await db('packages').where({ id: h.package_id }).first(); const fee = Number(payment.fee_amount) || 0;
  await sendEmail({ to: u.email, name: u.name.split(' ')[0], category: 'receipts', ref: h.ref, subject: `Receipt: payment received for ${h.ref}`,
    title: `Payment received for ${h.ref}`, preheader: `${fmtN(payment.amount)} received for ${K.units(h.units)} in ${pkg ? pkg.name : 'FOODCORE'}`,
    lead: fee ? `Thank you. We have received your payment of **${fmtN(payment.amount)}**: ${fmtN(stakePart)} for **${K.units(h.units)}** in **${pkg ? pkg.name : 'FOODCORE'}** and ${fmtN(fee)} for your yearly cooperative membership.` : `Thank you. We have received your payment of **${fmtN(payment.amount)}** for **${K.units(h.units)}** in **${pkg ? pkg.name : 'FOODCORE'}**.`,
    hero: { label: 'Amount received', value: fmtN(payment.amount), sub: `${payment.provider === 'transfer' ? 'Bank transfer to escrow' : payment.provider === 'flutterwave' ? 'Paid through Flutterwave' : 'Paid through Paystack'}${payment.channel ? ' · ' + String(payment.channel).replace(/_/g, ' ') : ''} · ${payment.reference}`, tone: 'in' },
    blocks: [K.stakeSteps(u.kyc_status === 'verified' ? 2 : 1, { bought: K.short(h.created_at), paid: K.short(), confirmed: u.kyc_status === 'verified' ? 'Certificate next' : 'After ID check', trading: pkg ? `${await unitsConfirmed(pkg.id)} of ${pkg.units_total} units paid` : undefined })],
    receipt: { title: 'Payment receipt', amount: Number(payment.amount), direction: 'in', rows: [['Paid by', `${u.name}${u.coop_no ? ' · ' + u.coop_no : ''}`], ['FOODCORE Mart', pkg ? pkg.name : ''], ['Stake reference', h.ref], ['Units', `${h.units} × ${fmtN(stakePart / h.units)}`], ['Units subtotal', fmtN(stakePart)], fee ? ['Yearly membership fee', fmtN(fee) + (u.membership_until ? ' · valid until ' + K.day(u.membership_until) : '')] : null, ['Method', payment.provider === 'transfer' ? 'Bank transfer to escrow' : payment.provider === 'flutterwave' ? 'Online via Flutterwave' : 'Card / bank via Paystack'], ['Payment reference', payment.reference]].filter(Boolean), total: ['Total paid', fmtN(payment.amount)], note: fee ? 'Unit capital is held in escrow until the mart opens. The membership fee is not unit capital: it is non-refundable and earns no returns.' : 'Unit capital is held in escrow until the mart opens.' },
    next: [u.kyc_status === 'verified' ? 'Your units are confirmed now. Your **Certificate of Stake** follows in a separate email.' : 'Complete your **identity check** from your dashboard. Your units are confirmed as soon as it passes.', 'When every unit in the package is paid, it opens and stock goes to the mart.', 'From then on, returns are paid into your Tafiki wallet at the end of each 90-day cycle.'],
    cta: { label: 'View my stake', url: K.link('me-invest') } });
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
    const lastPay = await db('payments').where({ holding_id: h.id }).orderBy('created_at', 'desc').first();
    await db('payments').where({ holding_id: h.id, status: 'initialized' }).update({ status: 'failed' });
    const u = await db('users').where({ id: h.user_id }).first();
    if (u && lastPay && lastPay.provider === 'transfer') { await sendEmail({ to: u.email, name: u.name.split(' ')[0], category: 'units', ref: h.ref, subject: `Your units for ${h.ref} have been released`, title: 'Your units have been released',
      lead: `We did not receive word of your bank transfer for **${h.ref}** within ${releaseAfterHours()} hours, so its **${K.units(h.units)}** have been released for other members.`,
      blocks: [{ type: 'kv', title: 'Purchase', rows: [['Stake reference', h.ref], ['FOODCORE Mart', (await db('packages').where({ id: h.package_id }).first() || {}).name || ''], ['Units', K.units(h.units)], ['Amount due', K.N(lastPay.amount)], ['Bought', K.when(h.created_at)], ['Released', K.when()]] },
        { type: 'note', tone: 'warn', title: 'Did you pay?', text: 'Reply to this email with your **proof of transfer**. We will check the escrow account and either confirm your units or refund you in full.' }],
      next: ['You can buy again from your dashboard while units are still open.'], cta: { label: 'Go to my dashboard', url: K.link('me') } }); continue; }
    if (u) await sendEmail({ to: u.email, name: u.name.split(' ')[0], category: 'units', ref: h.ref, subject: `Your checkout for ${h.ref} was not completed`,
      title: 'Your checkout was not completed', lead: `The payment for **${K.units(h.units)}** (${h.ref}) was not completed in time, so the units have been released. **No money was taken.**`,
      blocks: [{ type: 'kv', title: 'Purchase', rows: [['Stake reference', h.ref], ['FOODCORE Mart', (await db('packages').where({ id: h.package_id }).first() || {}).name || ''], ['Units', K.units(h.units)], ['Started', K.when(h.created_at)], ['Released', K.when()]] },
        { type: 'note', tone: 'info', text: 'If money did leave your account, it is usually reversed by your bank within 24 hours. If not, reply with the Paystack reference and we will sort it out.' }],
      next: ['You can buy again from your dashboard while units are still open.', 'Checkout holds your units for 30 minutes, so keep the payment page open until it says **successful**.'],
      cta: { label: 'Buy units', url: K.link('invest') } });
  }
  return n;
}

// A stake whose payment has not been confirmed can be released by the team once it has waited RELEASE_AFTER_HOURS (default 24).
const releaseAfterHours = () => Math.max(1, Number(process.env.RELEASE_AFTER_HOURS) || 24);
async function waitingSince(h, db) {
  const y = await db('payments').where({ holding_id: h.id }).orderBy('created_at', 'desc').first();
  return new Date((y && y.created_at) || h.created_at);
}
async function releaseUnconfirmed(holdingId, actor) {
  const db = getDb();
  const h = await db('holdings').where({ id: holdingId }).first();
  if (!h) throw new HttpError(404, 'Stake not found.');
  if (!['unpaid', 'confirming'].includes(h.status) || h.payment_verified) throw bad('Only stakes whose payment has not been confirmed can be released.');
  const hrs = releaseAfterHours(); const since = await waitingSince(h, db);
  const left = since.getTime() + hrs * 3600000 - now().getTime();
  if (left > 0) throw bad(`This payment can be released ${hrs} hours after it started. Try again in about ${Math.ceil(left / 3600000)} hour${Math.ceil(left / 3600000) > 1 ? 's' : ''}.`);
  // last check with Paystack, so a payment that did go through is never released
  const ps = await db('payments').where({ holding_id: h.id }).whereIn('provider', ['paystack', 'flutterwave']).whereIn('status', ['initialized', 'pending_review']);
  for (const y of ps) {
    try {
      const v = await require('./gateway').check(y);
      if (v.ok) { await markPaymentSuccess(y, { channel: v.channel, raw: v.raw }); throw bad(`${y.provider === 'flutterwave' ? 'Flutterwave' : 'Paystack'} shows this payment went through, so the stake has been confirmed instead of released.`); }
    } catch (e) { if (e.status === 400) throw e; }
  }
  const won = await db('holdings').where({ id: h.id, payment_verified: false }).whereIn('status', ['unpaid', 'confirming']).update({ status: 'cancelled', cancel_reason: `Payment not confirmed within ${hrs} hours`, reserved_until: null });
  if (!won) throw bad('This stake changed while you were looking at it. Refresh and try again.');
  await db('payments').where({ holding_id: h.id }).whereIn('status', ['initialized', 'pending_review']).update({ status: 'failed' });
  await activity.log(actor, 'units.released', { type: 'holding', id: h.id }, { ref: h.ref, units: h.units, waitingHours: Math.floor((now() - since) / 3600000) });
  const u = await db('users').where({ id: h.user_id }).first();
  if (u) await sendEmail({ to: u.email, name: u.name.split(' ')[0], category: 'units', ref: h.ref, subject: `Your units for ${h.ref} have been released`,
    title: 'Your units have been released', lead: `We could not confirm a payment for **${h.ref}** within ${hrs} hours, so its **${K.units(h.units)}** have been released for other members.`,
    blocks: [{ type: 'kv', title: 'Purchase', rows: [['Stake reference', h.ref], ['FOODCORE Mart', (await db('packages').where({ id: h.package_id }).first() || {}).name || ''], ['Units', K.units(h.units)], ['Waiting since', K.when(since)], ['Released', K.when()]] },
      { type: 'note', tone: 'warn', title: 'Did you pay?', text: 'Reply to this email with your **proof of payment** (bank receipt or Paystack reference). We will check it and either refund you in full or offer you units in another open package.' }],
    next: ['You can buy again from your dashboard while units are still open.'],
    cta: { label: 'Go to my dashboard', url: K.link('me') } });
  return db('holdings').where({ id: h.id }).first();
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
    await sendEmail({ to: u.email, name: u.name.split(' ')[0], category: 'units', ref: h.ref, subject: `${p.name} is open and trading`,
      title: 'Your units are now earning', preheader: `${p.name} is open and trading at ${store.shop}`,
      lead: `Good news. **${p.name}** is fully funded and now trading at **${store.shop}**. Your **${K.units(h.units)}** (${h.ref}) are earning from today.`,
      blocks: [K.stakeSteps(3, { bought: K.short(h.created_at), paid: h.paid_at ? K.short(h.paid_at) : undefined, confirmed: h.issued_at ? K.short(h.issued_at) : undefined, trading: 'From ' + K.short() }),
        { type: 'kv', title: 'Your stake', rows: [['Stake reference', h.ref], ['Certificate', h.cert_no || ''], ['FOODCORE Mart', store.shop], ['Units', `${K.units(h.units)} · ${K.N(h.units * (await getTerms()).unitPrice)}`], ['Trading from', K.day()], ['First cycle ends', K.day(K.addDays(Date.now(), (await getTerms()).cycleDays || 90))]] }],
      next: ['Stock is on its way to the mart. You will get an email when it is delivered.', `The mart's sales are audited on day 28 of each cycle and its remittance is checked.`, 'Your returns are paid into your Tafiki wallet at the end of each 90-day cycle, with an email advice.'],
      cta: { label: 'Track my stake', url: K.link('me-invest') } });
  }
  await activity.log(actor, 'package.opened', { type: 'package', id: p.id }, { store: store.shop, holdings: hs.length });
  await sendEmail({ to: store.email, name: 'Mart Manager', category: 'operations', ref: p.name, subject: `${p.name} is open: stock is on its way to ${store.shop}`,
    title: `${store.shop} is open for trading`, lead: `**${p.name}** is fully funded and now trading at **${store.shop}**. Your first stock orders have been raised at the Tafiki Distribution Centre.`,
    hero: { label: 'Stock value to receive', value: K.N(p.units_total * (await getTerms()).unitPrice), sub: `${p.units_total} stock packs · on consignment`, tone: 'info' },
    blocks: [{ type: 'kv', title: 'Your mart', rows: [['Mart', store.shop], ['Package', p.name], ['Stock packs', String(p.units_total)], ['Opened', K.when()], ['First audit', 'Day 28 · ' + K.day(K.addDays(Date.now(), 28))], ['Cycle ends', K.day(K.addDays(Date.now(), (await getTerms()).cycleDays || 90))]] }, K.cycleSteps(0, { stock: 'On the way' })],
    next: ['You will get an email at every delivery stage, with your **delivery code** when a load is in transit. It is also in your mart portal.', 'Count the bags before you give the driver the code. A goods-received note follows each delivery.', 'Record your sales in the mart portal. Your stock is audited on day 28 and the remittance is settled after it.'],
    cta: { label: 'Open my mart portal', url: K.link('login') } });
  return db('packages').where({ id: p.id }).first();
}
module.exports = { HELD, CONFIRMED, unitsTaken, unitsConfirmed, settle, markPaymentSuccess, onKycVerified, expireReservations, releaseUnconfirmed, waitingSince, releaseAfterHours, openPackage, verifyCode, issueCertificate };
