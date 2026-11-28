// Mart confirms receipt in its portal ("All received"), or reports a problem (bags short or damaged) for Tafiki to resolve.
exports.up = async (knex) => {
  await knex.schema.alterTable('deliveries', (t) => {
    t.string('confirmed_by', 120).nullable(); // who completed it: "FOODCORE Bodija (mart)", "Driver code", "Admin: name"
    t.datetime('issue_at').nullable(); t.string('issue_by', 120).nullable(); t.string('issue_note', 500).nullable(); t.text('issue_lines').nullable(); // [{sku,name,sent,received}]
  });
};
exports.down = async (knex) => { await knex.schema.alterTable('deliveries', (t) => { for (const c of ['confirmed_by', 'issue_at', 'issue_by', 'issue_note', 'issue_lines']) t.dropColumn(c); }); };
