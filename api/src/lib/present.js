// Shapes returned to the browser. Never include password hashes.
const user = (u) => u && ({ id: u.id, role: u.role, name: u.name, email: u.email, phone: u.phone, city: u.city, shop: u.shop, area: u.area, dob: u.dob, kycStatus: u.kyc_status, emailVerified: !!u.email_verified, phoneVerified: !!u.phone_verified_at, mustChangePassword: !!u.must_change,
  bank: u.bank_name ? { name: u.bank_name, accountLast4: String(u.bank_account || '').slice(-4), accountName: u.bank_account_name } : null,
  coop: u.coop_no ? { number: u.coop_no, agreedAt: u.coop_agreed_at, termsVersion: u.terms_version } : null, status: u.status, membershipUntil: u.membership_until || null, createdAt: u.created_at });
const userFull = (u) => u && ({ ...user(u), bank: u.bank_name ? { name: u.bank_name, account: u.bank_account, accountName: u.bank_account_name } : null });
const admin = (a) => a && ({ id: a.id, name: a.name, email: a.email, role: a.role, status: a.status, mustChangePassword: !!a.must_change, lastLoginAt: a.last_login_at, createdAt: a.created_at });
module.exports = { user, userFull, admin };
