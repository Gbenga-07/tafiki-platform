// Marts created automatically for a package were set up by Tafiki itself, so they count as approved.
exports.up = async (knex) => {
  await knex('users').where({ role: 'retailer', kyc_status: 'pending' }).where('email', 'like', '%@marts.tafiki.invalid').update({ kyc_status: 'verified' });
};
exports.down = async () => {};
