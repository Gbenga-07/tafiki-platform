// Phone numbers are confirmed by SMS code (Termii); the code is also asked for before money leaves a wallet.
exports.up = async (knex) => { await knex.schema.alterTable('users', (t) => { t.datetime('phone_verified_at').nullable(); t.string('pending_phone', 40).nullable(); }); };
exports.down = async (knex) => { await knex.schema.alterTable('users', (t) => { t.dropColumn('phone_verified_at'); t.dropColumn('pending_phone'); }); };
