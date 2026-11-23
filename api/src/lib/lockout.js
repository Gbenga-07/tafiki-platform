const { getDb } = require('../db');
const { getSetting } = require('./settings');
const { addMinutes, now } = require('./util');
async function isLocked(key) { const r = await getDb()('login_failures').where({ key }).first(); return r && r.locked_until && new Date(r.locked_until) > now() ? new Date(r.locked_until) : null; }
async function fail(key) {
  const db = getDb(); const sec = await getSetting('security');
  const r = await db('login_failures').where({ key }).first();
  const count = (r ? r.count : 0) + 1;
  const lock = count >= sec.maxFailures ? addMinutes(now(), sec.lockMinutes) : null;
  const row = { count: lock ? 0 : count, locked_until: lock };
  if (r) await db('login_failures').where({ key }).update(row); else await db('login_failures').insert({ key, ...row });
  return lock;
}
async function clear(key) { await getDb()('login_failures').where({ key }).del(); }
async function event(type, email, ok, note, ip) { await getDb()('login_events').insert({ actor_type: type, email, ok, note: note || null, ip: ip || null }); }
module.exports = { isLocked, fail, clear, event };
