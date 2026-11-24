// Every package now has a FOODCORE Mart: link existing packages to a mart with the same name, or create one.
exports.up = async (knex) => {
  const { ensureMart } = require('../src/lib/marts');
  const ps = await knex('packages').whereNull('store_user_id');
  for (const p of ps) await ensureMart(knex, p);
};
exports.down = async () => {};
