// Stage 2: investment packages, unit holdings, payments and certificates.
exports.up = async (knex) => {
  const now3 = String(knex.client.config.client).startsWith('mysql') ? knex.fn.now(3) : knex.fn.now();
  await knex.schema.createTable('packages', (t) => {
    t.string('id', 36).primary();
    t.string('name', 120).notNullable(); // FOODCORE Iwo Road
    t.string('area', 160).notNullable();
    t.string('city', 80).notNullable();
    t.string('state', 40).notNullable().defaultTo('Oyo');
    t.string('route', 80);
    t.string('target_open', 40); // e.g. Feb 2027
    t.integer('units_total').notNullable().defaultTo(40);
    t.string('stage', 16).notNullable().defaultTo('funding'); // funding | full | trading | closed
    t.string('store_user_id', 36); // linked FOODCORE store account
    t.datetime('opened_at');
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.createTable('holdings', (t) => {
    t.string('id', 36).primary();
    t.string('ref', 20).notNullable().unique(); // FC-1040
    t.string('user_id', 36).notNullable();
    t.string('package_id', 36).notNullable();
    t.integer('units').notNullable();
    t.bigInteger('amount').notNullable(); // naira
    t.string('status', 16).notNullable(); // unpaid | confirming | reserved | active | redeem | closed | cancelled
    t.string('method', 12); // card | debit | transfer
    t.datetime('reserved_until');
    t.string('signed_name', 120).notNullable();
    t.datetime('signed_at').notNullable();
    t.string('agreement_version', 40).notNullable();
    t.datetime('paid_at');
    t.boolean('payment_verified').notNullable().defaultTo(false);
    t.string('cert_no', 24).unique();
    t.datetime('issued_at');
    t.datetime('active_since');
    t.string('cancel_reason', 120);
    t.datetime('created_at', { precision: 3 }).notNullable().defaultTo(now3);
    t.index(['user_id']); t.index(['package_id', 'status']);
  });
  await knex.schema.createTable('payments', (t) => {
    t.string('id', 36).primary();
    t.string('holding_id', 36).notNullable();
    t.string('user_id', 36).notNullable();
    t.string('provider', 12).notNullable(); // paystack | transfer
    t.string('reference', 60).notNullable().unique();
    t.bigInteger('amount').notNullable(); // naira
    t.string('status', 16).notNullable(); // initialized | success | failed | pending_review | rejected
    t.string('channel', 30);
    t.text('raw');
    t.string('confirmed_by', 36);
    t.datetime('verified_at');
    t.datetime('created_at', { precision: 3 }).notNullable().defaultTo(now3);
    t.index(['holding_id']);
  });
  await knex.schema.createTable('counters', (t) => { t.string('name', 30).primary(); t.bigInteger('value').notNullable(); });
};
exports.down = async (knex) => { for (const t of ['counters', 'payments', 'holdings', 'packages']) await knex.schema.dropTableIfExists(t); };
