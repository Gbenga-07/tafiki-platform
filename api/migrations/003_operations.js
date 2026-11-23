// Stage 3: deliveries and delivery codes, SMS, store cycles, sales reports, audits, remittances.
exports.up = async (knex) => {
  const now3 = String(knex.client.config.client).startsWith('mysql') ? knex.fn.now(3) : knex.fn.now();
  await knex.schema.createTable('deliveries', (t) => {
    t.string('id', 36).primary();
    t.string('code', 30).notNullable().unique(); // SO-1040, SO-1040-R1, TR-2041
    t.string('kind', 12).notNullable(); // stake | restock | store_order
    t.integer('cycle'); // restock: the cycle it follows
    t.string('holding_id', 36);
    t.string('package_id', 36);
    t.string('store_user_id', 36).notNullable();
    t.integer('status').notNullable().defaultTo(0); // 0 received, 1 picked up, 2 in transit, 3 delivered
    t.string('driver', 80);
    t.string('vehicle', 40);
    t.boolean('auto').notNullable().defaultTo(true);
    t.integer('delay_minutes').notNullable().defaultTo(0);
    t.string('code_hash', 64).notNullable();
    t.string('code_enc', 120).notNullable();
    t.integer('code_attempts').notNullable().defaultTo(0);
    t.string('driver_token', 60).notNullable().unique();
    t.bigInteger('value').notNullable(); // naira at cost
    t.string('override_reason', 160);
    t.datetime('delivered_at');
    t.datetime('created_at', { precision: 3 }).notNullable().defaultTo(now3);
    t.index(['store_user_id', 'status']);
  });
  await knex.schema.createTable('delivery_lines', (t) => {
    t.increments('id'); t.string('delivery_id', 36).notNullable().index();
    t.string('sku', 40).notNullable(); t.string('name', 80).notNullable(); t.string('size', 20); t.string('brand', 40);
    t.integer('qty').notNullable(); t.integer('unit_cost').notNullable();
  });
  await knex.schema.createTable('delivery_log', (t) => {
    t.increments('id'); t.string('delivery_id', 36).notNullable().index();
    t.integer('stage').notNullable(); t.string('note', 160); t.string('actor', 60);
    t.datetime('at', { precision: 3 }).notNullable().defaultTo(now3);
  });
  await knex.schema.createTable('sms', (t) => {
    t.string('id', 36).primary(); t.string('to_phone', 20).notNullable(); t.string('body', 320).notNullable(); // codes are masked
    t.string('category', 32).notNullable(); t.string('ref', 60);
    t.string('status', 16).notNullable(); t.string('provider_id', 80); t.string('error', 255);
    t.datetime('created_at', { precision: 3 }).notNullable().defaultTo(now3);
  });
  await knex.schema.createTable('store_cycles', (t) => {
    t.increments('id'); t.string('store_user_id', 36).notNullable(); t.integer('k').notNullable();
    t.datetime('start_at').notNullable(); t.datetime('audit_at').notNullable(); t.datetime('restock_at').notNullable();
    t.bigInteger('audited_value'); t.datetime('audited_at'); t.string('audited_by', 36);
    t.datetime('reconciled_at'); t.string('reconciled_by', 36); t.datetime('restock_released_at');
    t.boolean('reminder_sent').notNullable().defaultTo(false);
    t.unique(['store_user_id', 'k']);
  });
  await knex.schema.createTable('sales_reports', (t) => {
    t.increments('id'); t.string('store_user_id', 36).notNullable().index(); t.integer('cycle_k').notNullable();
    t.bigInteger('amount').notNullable(); t.string('note', 200);
    t.datetime('created_at', { precision: 3 }).notNullable().defaultTo(now3);
  });
  await knex.schema.createTable('remittances', (t) => {
    t.string('id', 36).primary(); t.string('ref', 20).notNullable().unique(); // RM-0001
    t.string('store_user_id', 36).notNullable().index(); t.integer('cycle_k');
    t.bigInteger('amount').notNullable(); t.string('bank_reference', 80);
    t.string('status', 12).notNullable(); // pending | confirmed | rejected
    t.string('note', 200); t.string('confirmed_by', 36); t.datetime('confirmed_at');
    t.datetime('created_at', { precision: 3 }).notNullable().defaultTo(now3);
  });
};
exports.down = async (knex) => { for (const t of ['remittances', 'sales_reports', 'store_cycles', 'sms', 'delivery_log', 'delivery_lines', 'deliveries']) await knex.schema.dropTableIfExists(t); };
