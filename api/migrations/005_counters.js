// Create the reference counters up front so no request ever has to create one under load.
exports.up = async (knex) => {
  for (const [name, value] of [['holding', 1000], ['remittance', 0], ['withdrawal', 0], ['store_order', 2000]]) {
    if (!(await knex('counters').where({ name }).first())) await knex('counters').insert({ name, value });
  }
};
exports.down = async () => {};
