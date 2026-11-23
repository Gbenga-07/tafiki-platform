# Tafiki API

The server for the Tafiki platform (tafiki.com) and the Tafiki Console. It stores the real data, runs logins and roles, sends emails and will handle payments, identity checks, deliveries, audits and payouts.

Built with Node.js 20+, Express and a MySQL / MariaDB database (works on InterServer VPS and InterServer cPanel hosting).

## Build stages

| Stage | What it covers | Status |
|---|---|---|
| 1 | Member accounts and cooperative membership, console sign-in, two-step verification, 7 admin roles, admin management, editing members, password resets, email outbox, activity log | **Done** |
| 2 | Investment packages, units, Paystack checkout and webhooks, bank-transfer confirmation, certificates, investment terms, unit package | **Done** |
| 3 | Deliveries with automatic stages and delivery codes (SMS + email), stock on shelves, day-28 audits, remittances, reconciliation, restock | Next |
| 4 | Payout calculations, wallets and withdrawals, Smile ID verification, SMS provider, email templates, analytics | Planned |
| 5 | Connect the website and console to this API, remove prototype data, go live | Planned |

## Quick start (local)

```bash
npm install
cp .env.example .env           # then edit .env
npm run migrate                # creates the tables
npm run create-admin           # creates the first Super Admin from SUPERADMIN_* in .env
npm start                      # http://localhost:4000/api/health
npm test                       # runs the automated tests (uses an in-memory database)
```

For local testing without MySQL set `DB_CLIENT=better-sqlite3` and `DB_FILE=./data/tafiki.sqlite`.

## Security built in

- Passwords hashed with bcrypt (cost 12). One-time codes and reset tokens stored only as hashes.
- Sessions in secure, http-only cookies, revocable from the database. Separate cookies for members and the console.
- Console sessions end after the inactivity timeout set in Settings (default 60 minutes).
- Lockout after repeated failed sign-ins (default 5 attempts, 15 minutes). Every console sign-in is recorded.
- Every write request must carry the `X-Tafiki-Client: 1` header (blocks cross-site form attacks). CORS limited to your domains.
- Role permissions enforced on the server, not just hidden in the page.
- Helmet security headers, rate limits on sign-in routes, input validation on every request.

## Admin roles

Every role can view everything. The table shows where each role can make changes.

| Role | Member Services | Payments | Packages | Logistics | Audit | Payouts | Settings |
|---|---|---|---|---|---|---|---|
| Super Admin | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Operations Manager | ✓ | | ✓ | ✓ | ✓ | | |
| Finance Officer | | ✓ | | | ✓ | ✓ | |
| Logistics Officer | | | | ✓ | | | |
| Member Services | ✓ | | | | | | |
| Auditor | | | | | ✓ | | |
| Admin (view only) | | | | | | | |

## API (Stage 1)

All write requests: JSON body, header `X-Tafiki-Client: 1`, cookies included (`credentials: 'include'`).

**Members**

| Method | Path | Purpose |
|---|---|---|
| POST | /api/auth/register | Create account. Requires `agreeTerms: true` (cooperative membership). Returns member with cooperative number. |
| POST | /api/auth/verify-email | Confirm email with the 6-digit code |
| POST | /api/auth/verify-email/resend | Send a new code |
| POST | /api/auth/login | Email and password |
| POST | /api/auth/logout | Sign out |
| POST | /api/auth/password/forgot | Email a reset link (same reply whether or not the email exists) |
| POST | /api/auth/password/reset | Set a new password with the token |
| GET / PATCH | /api/me | Own profile; update phone, city, bank |
| POST | /api/me/password | Change own password |

**Console**

| Method | Path | Permission | Purpose |
|---|---|---|---|
| POST | /api/admin/auth/login | — | Email and password. Returns `{step:'code', ticket}` when two-step verification is on |
| POST | /api/admin/auth/verify | — | Ticket and emailed code |
| POST | /api/admin/auth/logout | — | Sign out |
| GET | /api/admin/auth/me | any admin | Current admin and permissions |
| POST | /api/admin/auth/me/password | any admin | Change own password |
| GET | /api/admin/admins | any admin | List administrators |
| GET | /api/admin/admins/roles | any admin | Roles and permission groups |
| POST | /api/admin/admins | settings | Add administrator (returns a one-time temporary password) |
| PATCH | /api/admin/admins/:id | settings | Edit name, email, role |
| POST | /api/admin/admins/:id/reset-password | settings | New temporary password, signs them out |
| POST | /api/admin/admins/:id/status | settings | `active` or `disabled` |
| GET / PUT | /api/admin/admins/security | settings to change | Two-step verification, timeout, lockout |
| GET | /api/admin/admins/login-events | any admin | Console sign-in history |
| GET | /api/admin/users?role=&kyc=&q= | any admin | Members and stores |
| GET | /api/admin/users/:id | any admin | Member with activity |
| PATCH | /api/admin/users/:id | members | Edit details; member is emailed what changed |
| POST | /api/admin/users/:id/reset-link | members | Email a reset link |
| POST | /api/admin/users/:id/temporary-password | members | One-time password, signs them out |
| POST | /api/admin/users/:id/status | members | `active` or `suspended` |
| GET | /api/admin/activity | any admin | Activity log |
| GET | /api/admin/emails, /api/admin/emails/:id | any admin | Email correspondence |

## API (Stage 2)

**Public**

| Method | Path | Purpose |
|---|---|---|
| GET | /api/packages, /api/packages/:id | Packages with units taken, confirmed and open |
| GET | /api/terms | Unit price, target return, hold period, unit package (stock per unit), escrow account |
| GET | /api/certificates/:certNo/verify?code= | Check a Certificate of Stake |

**Members (unit holders)**

| Method | Path | Purpose |
|---|---|---|
| GET | /api/holdings, /api/holdings/:id | My units, payments and certificate (with verification code) |
| POST | /api/holdings | Reserve units: `{packageId, units, signedName, agree:true}`. Held for 48 hours |
| POST | /api/holdings/:id/pay | `{method:'card'|'debit'}` returns the Paystack checkout link; `{method:'transfer'}` returns escrow details and a reference |
| POST | /api/holdings/:id/transfer-sent | Member reports the bank transfer; finance confirms it |
| GET | /api/holdings/payments/:reference/verify | Check a Paystack payment after checkout |
| DELETE | /api/holdings/:id | Cancel an unpaid reservation |
| POST | /webhooks/paystack | Paystack calls this (signature checked, then verified with Paystack) |

Rules: units are confirmed only when the payment is verified **and** the member's identity is verified. Certificates are issued at that moment. When every unit in a package is confirmed, it becomes **full** and Super Admins and Operations Managers are emailed. Unpaid reservations are released automatically when they expire.

**Console**

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | /api/admin/packages | any admin | Packages with funding status |
| POST / PATCH | /api/admin/packages(/:id) | packages | Create or edit a package |
| POST | /api/admin/packages/:id/open | packages | Open a full package: links the FOODCORE store, units start earning, holders emailed |
| GET | /api/admin/holdings?status=&packageId= | any admin | All unit holdings |
| GET | /api/admin/payments?status= | any admin | All payments |
| POST | /api/admin/payments/:id/confirm | payments | Confirm a bank transfer found in escrow |
| POST | /api/admin/payments/:id/reject | payments | Reject a transfer with a reason (member emailed) |
| GET / PUT | /api/admin/settings/terms | settings to change | Investment terms and escrow account |
| GET / PUT | /api/admin/settings/unit-package | packages to change | Stock each unit buys (must add up to the unit price) |

## Deploying on InterServer

See [docs/deploy-interserver.md](docs/deploy-interserver.md).
