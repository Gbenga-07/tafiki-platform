// PDF attachments: what each email attaches (receipt or certificate) is kept so it can be rebuilt for a resend or a download.
exports.up = async (knex) => { await knex.schema.alterTable('emails', (t) => { t.text('attach').nullable(); }); };
exports.down = async (knex) => { await knex.schema.alterTable('emails', (t) => { t.dropColumn('attach'); }); };
