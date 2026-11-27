// Inactive accounts: closed or deleted accounts keep all their data; these columns record when, why and by whom.
exports.up = async (knex) => {
  await knex.schema.alterTable('users', (t) => { t.datetime('closed_at').nullable(); t.string('closed_reason', 200).nullable(); t.string('closed_by', 120).nullable(); t.boolean('deleted').notNullable().defaultTo(false); });
};
exports.down = async (knex) => { await knex.schema.alterTable('users', (t) => { t.dropColumn('closed_at'); t.dropColumn('closed_reason'); t.dropColumn('closed_by'); t.dropColumn('deleted'); }); };
