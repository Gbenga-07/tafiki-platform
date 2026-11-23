// Stage 1: members, admins, sessions, security, activity log and email outbox.
exports.up = async (knex) => {
  const now3 = String(knex.client.config.client).startsWith('mysql') ? knex.fn.now(3) : knex.fn.now();
  await knex.schema.createTable('users', (t) => {
    t.string('id', 36).primary();
    t.string('role', 16).notNullable(); // investor | retailer
    t.string('name', 120).notNullable();
    t.string('email', 190).notNullable().unique();
    t.string('phone', 40);
    t.string('city', 80);
    t.string('shop', 120); // FOODCORE store name (retailer)
    t.string('area', 160); // store address (retailer)
    t.date('dob');
    t.string('password_hash', 100).notNullable();
    t.boolean('must_change').notNullable().defaultTo(false);
    t.boolean('email_verified').notNullable().defaultTo(false);
    t.string('kyc_status', 16).notNullable().defaultTo('pending'); // pending | verified | rejected
    t.string('bank_name', 80);
    t.string('bank_account', 10);
    t.string('bank_account_name', 120);
    t.string('coop_no', 20).unique();
    t.datetime('coop_agreed_at');
    t.string('terms_version', 40);
    t.string('status', 16).notNullable().defaultTo('active'); // active | suspended
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('updated_at').notNullable().defaultTo(knex.fn.now());
    t.index(['role', 'kyc_status']);
  });
  await knex.schema.createTable('admins', (t) => {
    t.string('id', 36).primary();
    t.string('name', 120).notNullable();
    t.string('email', 190).notNullable().unique();
    t.string('role', 40).notNullable();
    t.string('password_hash', 100).notNullable();
    t.boolean('must_change').notNullable().defaultTo(false);
    t.string('status', 16).notNullable().defaultTo('active');
    t.datetime('last_login_at');
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.createTable('settings', (t) => {
    t.string('key', 60).primary();
    t.text('value').notNullable(); // JSON
    t.datetime('updated_at').notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.createTable('sessions', (t) => {
    t.string('id', 36).primary();
    t.string('actor_type', 8).notNullable(); // user | admin
    t.string('actor_id', 36).notNullable();
    t.datetime('expires_at').notNullable();
    t.datetime('revoked_at');
    t.string('ip', 64);
    t.string('user_agent', 255);
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['actor_type', 'actor_id']);
  });
  await knex.schema.createTable('codes', (t) => {
    t.string('id', 36).primary();
    t.string('purpose', 24).notNullable(); // email_verify | admin_2fa | password_reset
    t.string('subject_type', 8).notNullable();
    t.string('subject_id', 36).notNullable();
    t.string('code_hash', 128).notNullable();
    t.integer('attempts').notNullable().defaultTo(0);
    t.datetime('expires_at').notNullable();
    t.datetime('used_at');
    t.datetime('created_at', { precision: 3 }).notNullable().defaultTo(now3);
    t.index(['purpose', 'subject_type', 'subject_id']);
  });
  await knex.schema.createTable('login_failures', (t) => {
    t.string('key', 220).primary();
    t.integer('count').notNullable().defaultTo(0);
    t.datetime('locked_until');
  });
  await knex.schema.createTable('login_events', (t) => {
    t.increments('id');
    t.string('actor_type', 8).notNullable();
    t.string('email', 190).notNullable();
    t.boolean('ok').notNullable();
    t.string('note', 120);
    t.string('ip', 64);
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.createTable('activity_log', (t) => {
    t.increments('id');
    t.string('actor_type', 8).notNullable(); // user | admin | system
    t.string('actor_id', 36);
    t.string('action', 60).notNullable();
    t.string('target_type', 24);
    t.string('target_id', 36);
    t.text('detail');
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['target_type', 'target_id']);
  });
  await knex.schema.createTable('emails', (t) => {
    t.string('id', 36).primary();
    t.string('to_email', 190).notNullable();
    t.string('to_name', 120);
    t.string('category', 32).notNullable();
    t.string('subject', 200).notNullable();
    t.text('body_text').notNullable();
    t.text('body_html');
    t.string('ref', 60); // order code, user id, etc.
    t.string('status', 16).notNullable().defaultTo('queued'); // queued | sent | failed | logged
    t.string('provider_id', 120);
    t.string('error', 255);
    t.datetime('created_at', { precision: 3 }).notNullable().defaultTo(now3);
    t.datetime('sent_at');
    t.index(['status']);
  });
};
exports.down = async (knex) => {
  for (const t of ['emails', 'activity_log', 'login_events', 'login_failures', 'codes', 'sessions', 'settings', 'admins', 'users']) await knex.schema.dropTableIfExists(t);
};
