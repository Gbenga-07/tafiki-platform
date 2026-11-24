// Every funding package belongs to a FOODCORE Mart. When a package is created or opened without a mart account,
// the matching mart is found by name, or created as a placeholder account the admin later hands to the mart manager.
const pw = require('./passwords');
const { uuid } = require('./util');
const crypto = require('crypto');

const PLACEHOLDER_DOMAIN = 'marts.tafiki.invalid'; // .invalid never receives mail
const isPlaceholderEmail = (e) => String(e || '').toLowerCase().endsWith('@' + PLACEHOLDER_DOMAIN);
// "FOODCORE Mart Bodija", "Foodcore Bodija" and "FOODCORE Bodija Mart" are the same mart
const martKey = (s) => String(s || '').toLowerCase().replace(/\b(foodcore|mart|marts|store|stores)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const martName = (s) => { const n = String(s || '').trim().replace(/\s+/g, ' '); return /^FOODCORE\s+\S/i.test(n) ? n : 'FOODCORE ' + n; };
const slug = (s) => martKey(s).replace(/\s+/g, '-').slice(0, 40) || 'mart';

async function findMart(db, name) {
  const k = martKey(name); if (!k) return null;
  const rs = await db('users').where({ role: 'retailer' }).select('id', 'shop', 'status');
  return rs.find((r) => martKey(r.shop) === k) || null;
}

// Returns { store, created }. db may be a transaction.
async function ensureMart(db, pkg) {
  if (pkg.store_user_id) { const s = await db('users').where({ id: pkg.store_user_id, role: 'retailer' }).first(); if (s) return { store: s, created: false }; }
  if (!db.isTransaction) { // one mart per name, even when two packages for it are created at the same moment
    await db('settings').insert({ key: 'lock:marts', value: '1' }).onConflict('key').ignore();
    return db.transaction(async (trx) => { await trx('settings').where({ key: 'lock:marts' }).forUpdate().first(); return ensureMart(trx, await trx('packages').where({ id: pkg.id }).first()); });
  }
  let store = await findMart(db, pkg.name); let created = false;
  if (!store) {
    const id = uuid(); const shop = martName(pkg.name);
    await db('users').insert({ id, role: 'retailer', name: shop + ' manager', email: `${slug(pkg.name)}-${id.slice(0, 8)}@${PLACEHOLDER_DOMAIN}`, phone: null, city: pkg.city || null, shop, area: [pkg.area, pkg.city].filter(Boolean).join(', ') || null,
      password_hash: await pw.hash(crypto.randomBytes(24).toString('hex')), kyc_status: 'pending', status: 'active', created_at: new Date(), updated_at: new Date() });
    created = true; store = { id };
  }
  await db('packages').where({ id: pkg.id }).whereNull('store_user_id').update({ store_user_id: store.id });
  const linked = await db('packages').where({ id: pkg.id }).first();
  return { store: await db('users').where({ id: linked.store_user_id || store.id }).first(), created };
}
module.exports = { ensureMart, findMart, martKey, martName, isPlaceholderEmail, PLACEHOLDER_DOMAIN };
