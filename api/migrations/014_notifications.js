// In-app notifications: every important email to a member or mart also appears in their Notifications screen.
exports.up = async (knex) => {
  await knex.schema.alterTable('emails', (t) => { t.boolean('notify').notNullable().defaultTo(false); t.string('lead', 500).nullable(); t.index(['to_email', 'notify']); });
  await knex.schema.alterTable('users', (t) => { t.datetime('notes_seen_at', { precision: 3 }).nullable(); });
  // earlier account emails count too, except one-time codes and password-reset links
  await knex('emails').whereNot({ category: 'security' }).update({ notify: true });
  await knex('emails').where({ category: 'security' }).where('subject', 'like', '%password was reset%').update({ notify: true });
};
exports.down = async (knex) => {
  await knex.schema.alterTable('emails', (t) => { t.dropIndex(['to_email', 'notify']); t.dropColumn('notify'); t.dropColumn('lead'); });
  await knex.schema.alterTable('users', (t) => { t.dropColumn('notes_seen_at'); });
};
