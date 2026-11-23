// Stage 4: identity checks (Smile ID), payout runs, wallets, withdrawals, redemptions.
exports.up = async (knex) => {
  const now3 = String(knex.client.config.client).startsWith('mysql') ? knex.fn.now(3) : knex.fn.now();
  await knex.schema.createTable('kyc_checks', (t) => {
    t.string('id', 36).primary(); t.string('user_id', 36).notNullable().index(); t.string('job_id', 60).notNullable().unique();
    t.string('smile_job_id', 60); t.string('product', 30).notNullable(); t.string('id_type', 30);
    t.string('status', 12).notNullable(); // pending | verified | review | failed
    t.string('result_code', 10); t.string('result_text', 160); t.integer('confidence'); t.text('actions'); t.text('raw');
    t.datetime('completed_at'); t.datetime('created_at', { precision: 3 }).notNullable().defaultTo(now3);
  });
  await knex.schema.createTable('payout_runs', (t) => {
    t.string('id', 36).primary(); t.string('package_id', 36).notNullable().index(); t.integer('cycle_no').notNullable();
    t.datetime('period_start').notNullable(); t.datetime('period_end').notNullable();
    t.bigInteger('profit').notNullable(); t.bigInteger('tax').notNullable(); t.integer('units').notNullable();
    t.bigInteger('per_unit').notNullable(); t.bigInteger('investors_total').notNullable(); t.bigInteger('reserve_used').notNullable(); t.bigInteger('reserve_added').notNullable();
    t.bigInteger('company').notNullable(); t.bigInteger('operations').notNullable(); t.boolean('capped').notNullable().defaultTo(false);
    t.string('note', 200); t.string('created_by', 36).notNullable();
    t.datetime('created_at', { precision: 3 }).notNullable().defaultTo(now3);
    t.unique(['package_id', 'cycle_no']);
  });
  await knex.schema.createTable('wallet_tx', (t) => {
    t.string('id', 36).primary(); t.string('user_id', 36).notNullable().index();
    t.string('type', 16).notNullable(); // payout | withdrawal | redemption | adjustment
    t.bigInteger('amount').notNullable(); // + credit, - debit
    t.string('status', 12).notNullable(); // completed | processing | rejected
    t.string('memo', 200); t.string('ref', 40); t.string('payout_run_id', 36); t.string('withdrawal_id', 36); t.string('holding_id', 36);
    t.datetime('created_at', { precision: 3 }).notNullable().defaultTo(now3);
  });
  await knex.schema.createTable('withdrawals', (t) => {
    t.string('id', 36).primary(); t.string('ref', 20).notNullable().unique(); t.string('user_id', 36).notNullable().index();
    t.bigInteger('amount').notNullable(); t.string('bank_name', 80).notNullable(); t.string('bank_account', 10).notNullable(); t.string('bank_account_name', 120).notNullable();
    t.string('status', 12).notNullable(); // processing | paid | rejected
    t.string('transfer_reference', 80); t.string('reason', 160); t.string('decided_by', 36); t.datetime('decided_at');
    t.datetime('created_at', { precision: 3 }).notNullable().defaultTo(now3);
  });
  await knex.schema.createTable('redemptions', (t) => {
    t.string('id', 36).primary(); t.string('holding_id', 36).notNullable().index(); t.string('user_id', 36).notNullable();
    t.bigInteger('amount').notNullable(); t.datetime('settle_after').notNullable();
    t.string('status', 12).notNullable(); // requested | settled | cancelled
    t.string('decided_by', 36); t.datetime('settled_at');
    t.datetime('created_at', { precision: 3 }).notNullable().defaultTo(now3);
  });
};
exports.down = async (knex) => { for (const t of ['redemptions', 'withdrawals', 'wallet_tx', 'payout_runs', 'kyc_checks']) await knex.schema.dropTableIfExists(t); };
