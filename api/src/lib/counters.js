const { getDb } = require('../db');
// Atomic counters for references (FC-1040) and certificate numbers.
async function next(name, start) {
  const db = getDb();
  return db.transaction(async (trx) => {
    const row = await trx('counters').where({ name }).forUpdate().first();
    const v = row ? Number(row.value) + 1 : start;
    if (row) await trx('counters').where({ name }).update({ value: v }); else await trx('counters').insert({ name, value: v });
    return v;
  });
}
module.exports = { next };
