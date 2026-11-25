// Receipts: every money movement between Tafiki and a member or mart sends an email with a receipt number and amount.
exports.up = async (knex) => {
  await knex.schema.alterTable('emails', (t) => { t.string('receipt_no', 32).nullable(); t.decimal('amount', 16, 2).nullable(); t.string('direction', 8).nullable(); t.string('audience', 8).nullable(); });
  await knex.schema.alterTable('emails', (t) => { t.index(['category', 'created_at']); t.index(['receipt_no']); t.index(['audience', 'created_at']); });
  // sort earlier emails: member, mart or team
  await knex.raw("UPDATE emails SET audience = 'member' WHERE to_email IN (SELECT email FROM users WHERE role = 'investor')");
  await knex.raw("UPDATE emails SET audience = 'mart' WHERE to_email IN (SELECT email FROM users WHERE role = 'retailer')");
  await knex.raw("UPDATE emails SET audience = 'team' WHERE audience IS NULL AND to_email IN (SELECT email FROM admins)");
};
exports.down = async (knex) => { await knex.schema.alterTable('emails', (t) => { t.dropIndex(['category', 'created_at']); t.dropIndex(['receipt_no']); t.dropIndex(['audience', 'created_at']); t.dropColumn('audience'); t.dropColumn('receipt_no'); t.dropColumn('amount'); t.dropColumn('direction'); }); };
