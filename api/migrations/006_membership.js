// Yearly cooperative membership fee: charged once, on the member's first stake payment of each membership year.
// It is not unit capital: it earns no returns and is never refunded.
exports.up = async (knex) => {
  const now3 = String(knex.client.config.client).startsWith('mysql') ? knex.fn.now(3) : knex.fn.now();
  await knex.schema.alterTable('users', (t) => { t.datetime('membership_until'); });
  await knex.schema.alterTable('payments', (t) => {
    t.bigInteger('fee_amount').notNullable().defaultTo(0); // naira; part of amount, not unit capital
    t.string('fee_status', 16); // paid | refund_due (only if the same year's fee was already paid by another payment)
  });
  await knex.schema.createTable('memberships', (t) => {
    t.string('id', 36).primary(); t.string('user_id', 36).notNullable().index(); t.string('payment_id', 36).notNullable().unique();
    t.bigInteger('amount').notNullable(); t.datetime('period_start').notNullable(); t.datetime('period_end').notNullable();
    t.datetime('created_at', { precision: 3 }).notNullable().defaultTo(now3);
  });
};
exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('memberships');
  await knex.schema.alterTable('payments', (t) => { t.dropColumn('fee_amount'); t.dropColumn('fee_status'); });
  await knex.schema.alterTable('users', (t) => { t.dropColumn('membership_until'); });
};
