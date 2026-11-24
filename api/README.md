# Tafiki API

The server for the Tafiki platform (tafiki.com) and the Tafiki Console. It stores the real data, runs logins and roles, sends emails and will handle payments, identity checks, deliveries, audits and payouts.

Built with Node.js 20+, Express and a MySQL / MariaDB database (works on InterServer VPS and InterServer cPanel hosting).

## Build stages

| Stage | What it covers | Status |
|---|---|---|
| 1 | Member accounts and cooperative membership, console sign-in, two-step verification, 7 admin roles, admin management, editing members, password resets, email outbox, activity log | **Done** |
| 2 | Investment packages, units, Paystack checkout and webhooks, bank-transfer confirmation, certificates, investment terms, unit package | **Done** |
| 3 | Deliveries with automatic stages, delivery codes by Termii SMS and email, driver delivery links, stock on shelves, day-28 audits and reminders, remittances, reconciliation, automatic restocks | **Done** |
| 4 | Payout runs (website formula), reserve top-ups and annual cap, wallets, withdrawals, redemptions, Smile ID identity checks, analytics | **Done** |
| 5 | Connect the website and console to this API, remove prototype data, go live | Next |

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
| GET | /api/admin/users?role=&kyc=&q= | any admin | Members and marts |
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
| POST | /api/admin/packages/:id/open | packages | Open a full package: links the FOODCORE Mart, units start earning, holders emailed |
| GET | /api/admin/holdings?status=&packageId= | any admin | All unit holdings |
| GET | /api/admin/payments?status= | any admin | All payments |
| POST | /api/admin/payments/:id/confirm | payments | Confirm a bank transfer found in escrow |
| POST | /api/admin/payments/:id/reject | payments | Reject a transfer with a reason (member emailed) |
| GET / PUT | /api/admin/settings/terms | settings to change | Investment terms and escrow account |
| GET / PUT | /api/admin/settings/unit-package | packages to change | Stock each unit buys (must add up to the unit price) |

## API (Stage 3)

**How a delivery works**
1. A package opens, so each holding's stock (the unit package × units) becomes a delivery to its FOODCORE Mart, coded `SO-1040`. Admins can also raise mart orders (`TR-2001`).
2. Every delivery gets a random 6-digit **delivery code**. It is stored encrypted and its hash is checked; the SMS log shows it masked.
3. Stages move **automatically** every 6 hours: Order Received, Picked Up, In Transit. Logistics can move, delay, pause or set the driver.
4. At **In Transit** the mart manager gets the code by **Termii SMS** (DND route) and email, and can see it in the mart portal.
5. On arrival the driver opens their **delivery link** (no account needed) and enters the code the mart gives them. Five wrong codes lock the delivery and alert operations, who can reissue the code. Logistics can complete with an **override** and a written reason (recorded).
6. Delivered stock is added to the mart's consignment account. The first delivery starts **cycle 1**.

**Each cycle (30 days):** the mart reports sales; on **day 28** the audit is due (mart and auditors are emailed); an Auditor records audited sales; the mart pays and reports the **remittance**; it is confirmed; the account is **reconciled**; on day 30, after reconciliation, the **restock** deliveries (`SO-1040-R1`) are created automatically, and their delivery starts the next cycle.

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | /api/store/account | mart | Stock received, audited sales, remittances, due, on shelf, current cycle |
| GET | /api/store/deliveries(/:id) | mart | Deliveries; the detail shows the delivery code until delivered |
| POST / GET | /api/store/sales | mart | Report sales for the current cycle |
| POST / GET | /api/store/remittances | mart | Report a remittance (RM-0001) |
| GET | /api/store/cycles | mart | Cycle dates and status |
| GET | /api/driver/:token | driver link | Delivery to complete: mart, address, bags |
| POST | /api/driver/:token/complete | driver link | Complete with the mart's code |
| GET | /api/holdings/:id/deliveries | unit holder | Deliveries for my stake |
| GET | /api/admin/deliveries?open=1&storeId=&kind= | any admin | All deliveries |
| GET | /api/admin/deliveries/:id | any admin | Lines, stage history, driver link |
| POST | /api/admin/deliveries | logistics | Raise a mart order |
| POST | /api/admin/deliveries/:id/advance | logistics | Move to the next stage |
| PATCH | /api/admin/deliveries/:id | logistics | Driver, vehicle, automatic stages on/off |
| POST | /api/admin/deliveries/:id/delay | logistics | Delay the next automatic stage |
| POST | /api/admin/deliveries/:id/complete | logistics | Complete with the mart's code |
| POST | /api/admin/deliveries/:id/override | logistics | Complete without the code, with a reason |
| POST | /api/admin/deliveries/:id/reissue-code | logistics | New code by SMS |
| GET | /api/admin/stores, /api/admin/stores/:id | any admin | Marts with accounts, cycles, remittances, sales |
| POST | /api/admin/stores/:id/audit | audit | Record day-28 audited sales |
| POST | /api/admin/stores/:id/reconcile | audit | Reconcile once remittance covers audited sales |
| GET | /api/admin/remittances?status= | any admin | Remittances |
| POST | /api/admin/remittances/:id/confirm, /reject | audit | Confirm or reject |
| GET | /api/admin/sms | any admin | SMS log (codes masked) |

Background jobs (every few minutes): automatic delivery stages, restock release, audit reminders, expired reservations.

## API (Stage 4)

**Payout formula** (per package, every 90 days, same as the website and console):
1. Tax = profit × 34% (company income tax 30% + development levy 4%).
2. Unit holders are paid first: target ₦166,667 per unit (8.33% of ₦2M), kept under the 35% annual cap.
3. If profit after tax is short of the target, the shortfall comes from the package's payout reserve (as far as it goes).
4. Reserve top-up = up to 10% of profit; FOODCORE's share = up to 10.1% of profit; the remainder goes to operations.

Example: ₦48M profit on 40 units: tax ₦16,320,000 · unit holders ₦6,666,680 · reserve ₦4,800,000 · FOODCORE ₦4,848,000 · operations ₦15,365,320.

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | /api/me/kyc/start | member | Smile ID web token for the identity check widget |
| GET | /api/me/kyc | member | Identity status and checks |
| POST | /webhooks/smileid | Smile ID | Signed result. Approved codes verify the member and confirm paid units; others go to manual review |
| GET | /api/me/wallet | member | Balance and transactions |
| POST / GET | /api/me/wallet/withdrawals | member | Withdraw (min ₦1,000, identity verified, to own bank account) |
| POST | /api/me/holdings/:id/redeem, /redeem/cancel | member | Redeem after the 12-month hold (90 days' notice) |
| GET | /api/admin/payouts?packageId= | any admin | Payout runs |
| GET | /api/admin/payouts/:packageId/preview?profit= | any admin | Full breakdown before paying, plus a suggested profit |
| POST | /api/admin/payouts/:packageId | payouts | Run the payout (once per cycle) and credit wallets |
| GET | /api/admin/withdrawals?status= | any admin | Withdrawals |
| POST | /api/admin/withdrawals/:id/pay, /reject | payouts | Pay (with bank transfer reference) or reject (money returns to wallet) |
| GET | /api/admin/redemptions | any admin | Redemption requests |
| POST | /api/admin/redemptions/:id/settle | payouts | Settle after the notice period: capital to wallet, units closed |
| GET | /api/admin/kyc?status=review | any admin | Smile ID results, including those needing review |
| GET | /api/admin/analytics | any admin | Capital raised, new capital, stock delivered, remittances, payouts by month; totals; units by status |

## Testing

`npm test` runs all tests on an in-memory database, including the stress tests in `tests/stress.test.js` (simultaneous reservations, duplicate payment reports, parallel withdrawals, double clicks on payouts, deliveries and remittances, access to other people's data, hostile input and a 300-request burst). `npm run test:mysql` runs the same tests on MySQL/MariaDB (set TEST_DB_USER and TEST_DB_PASSWORD). Paystack, Termii and Smile ID are simulated in tests; try each in its sandbox before going live.

## Deploying on InterServer

See [docs/deploy-interserver.md](docs/deploy-interserver.md).
