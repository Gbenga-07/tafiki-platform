// Admin roles and the areas each can change. Every role can view everything.
const GROUPS = {
  members: 'Member Services', payments: 'Payments', packages: 'Packages', logistics: 'Logistics',
  audit: 'Audit', payouts: 'Payouts', settings: 'Settings',
};
const ROLES = {
  'Super Admin': Object.keys(GROUPS),
  'Operations Manager': ['members', 'packages', 'logistics', 'audit'],
  'Finance Officer': ['payments', 'audit', 'payouts'],
  'Logistics Officer': ['logistics'],
  'Member Services': ['members'],
  Auditor: ['audit'],
  Admin: [], // view only
};
const can = (role, group) => (ROLES[role] || []).includes(group);
module.exports = { GROUPS, ROLES, can };
