// Delivery bundles: the stock for every stake in one FOODCORE Mart goes out as one bundle (one order number, one delivery
// code, one truck). Each member still tracks their own order. Existing stake and restock deliveries are grouped too.
exports.up = async (knex) => {
  await knex.schema.alterTable('deliveries', (t) => { t.string('bundle_code', 30).nullable(); t.index(['bundle_code']); });
  const ds = await knex('deliveries').whereIn('kind', ['stake', 'restock']).orderBy('created_at');
  const groups = new Map();
  for (const d of ds) { const k = d.kind === 'stake' ? `s|${d.package_id}` : `r|${d.store_user_id}|${d.cycle}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(d); }
  if (!groups.size) return;
  if (!(await knex('counters').where({ name: 'bundle' }).first())) await knex('counters').insert({ name: 'bundle', value: 3000 });
  for (const list of groups.values()) {
    await knex('counters').where({ name: 'bundle' }).increment('value', 1);
    const n = Number((await knex('counters').where({ name: 'bundle' }).first()).value);
    await knex('deliveries').whereIn('id', list.map((d) => d.id)).update({ bundle_code: 'BD-' + n });
  }
};
exports.down = async (knex) => { await knex.schema.alterTable('deliveries', (t) => { t.dropIndex(['bundle_code']); t.dropColumn('bundle_code'); }); };
