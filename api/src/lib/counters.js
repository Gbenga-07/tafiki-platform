const { getDb } = require('../db');
// Atomic counters for references (FC-1040, RM-0001, WD-00001) and certificate numbers.
// The row is created once without locking; each number is then taken by an atomic UPDATE on that single row,
// so many simultaneous requests queue on one row instead of deadlocking.
const isDeadlock = (e) => e && (e.code === 'ER_LOCK_DEADLOCK' || e.code === 'ER_LOCK_WAIT_TIMEOUT' || e.code === 'SQLITE_BUSY');
async function retry(fn, tries = 5) { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (!isDeadlock(e) || i >= tries - 1) throw e; await new Promise((r) => setTimeout(r, 20 + Math.random() * 80 * (i + 1))); } } }
// Pass the caller's transaction (trx) when inside one, so no second database connection is needed.
async function next(name, start, trx) {
  const db = getDb();
  if (!(await (trx || db)('counters').where({ name }).first())) await (trx || db)('counters').insert({ name, value: start - 1 }).onConflict('name').ignore();
  const take = async (t) => { await t('counters').where({ name }).increment('value', 1); return Number((await t('counters').where({ name }).first()).value); };
  return trx ? take(trx) : retry(() => db.transaction(take));
}
module.exports = { next, retry, isDeadlock };
