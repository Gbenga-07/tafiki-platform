const { getDb } = require('../db');
const { getSetting } = require('./settings');
const { addMinutes, now } = require('./util');
async function isLocked(key) { const r = await getDb()('login_failures').where({ key }).first(); return r && r.locked_until && new Date(r.locked_until) > now() ? new Date(r.locked_until) : null; }
// Failed sign-ins are counted with an atomic increment, so a burst of simultaneous wrong passwords still locks the account.
async function fail(key) {
  const db = getDb(); const sec = await getSetting('security');
  await db('login_failures').insert({ key, count: 0, locked_until: null }).onConflict('key').ignore();
  await db('login_failures').where({ key }).increment('count', 1);
  const lock = addMinutes(now(), sec.lockMinutes);
  const n = await db('login_failures').where({ key }).where('count', '>=', sec.maxFailures).update({ count: 0, locked_until: lock });
  return n ? lock : null;
}
async function clear(key) { await getDb()('login_failures').where({ key }).del(); }
async function event(type, email, ok, note, ip) { await getDb()('login_events').insert({ actor_type: type, email, ok, note: note || null, ip: ip || null }); }
module.exports = { isLocked, fail, clear, event };
