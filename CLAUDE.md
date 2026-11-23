# Tafiki platform: notes for Claude

This repository runs tafiki.com: the public website, the investor portal, the FOODCORE store portal and the admin console, plus the API behind them.

## Layout
- `web/index.html`: the whole website as one file (with `web/img/`). It runs in **demo mode** when the `<meta name="tafiki-api" content="">` tag near the top is empty, and in **live mode** when it holds the API address (`https://api.tafiki.com`).
- `api/`: Node 20 + Express + Knex. MariaDB/MySQL in production, SQLite for tests.
  - `api/.env.example`: every setting, with comments. The real `api/.env` lives only on the server.
  - `api/docs/deploy-interserver.md`: the manual deployment steps (Ubuntu VPS, Nginx, PM2, Certbot).
  - `api/docs/go-live-with-claude.md`: the owner's step-by-step plan for a test-mode launch, then going live.

## Commands (run in `api/`)
- `npm ci --omit=dev`: install
- `npm run migrate`: create or update tables
- `npm run create-admin`: first Super Admin (reads SUPERADMIN_* from .env, or `npm run create-admin -- "Name" email password`)
- `npm run check`: checks database, keys and third-party accounts without printing secrets
- `npm test`: tests on SQLite. `npm run test:mysql`: the same tests on MariaDB (needs a test database user)
- `pm2 start src/server.js --name tafiki-api`, `pm2 restart tafiki-api`, `pm2 logs tafiki-api`

## Rules when working on the server
1. **Secrets.** Never print, echo, cat, log or commit `api/.env` or any key, password or token. To change a secret, ask the owner to edit `api/.env` himself with `nano`. Do not ask for keys in chat. Use `npm run check` to confirm settings.
2. **Test before live.** Use Paystack test keys (`sk_test_`), `SMILE_ENV=sandbox`, and leave `TERMII_API_KEY` and `SMTP_HOST` empty until the owner says, in his own words, to go live.
3. **Money and data.** Never insert, edit or delete payments, holdings, wallet transactions, withdrawals or payouts by hand in the database, except on a database the owner has said is test data. Back up (`mysqldump`) before any reset or migration.
4. **Ask first** before anything that cannot be undone: dropping a database, deleting files, changing DNS, firewall rules that could lock out SSH, or switching keys to live.
5. **Stay in scope.** Do not change the investment terms, payout formula, yearly membership fee or legal text. Those are set in the console by the owner and confirmed by counsel.
6. After code changes, run `npm test` and keep it at 0 failures before restarting.
7. The yearly cooperative membership fee (default ₦50,000) is charged only on a member's first stake payment of each membership year. It is never unit capital: it must not count toward capital, returns, payouts or redemptions, and it is non-refundable (see `api/src/lib/membership.js`).
8. Do not put the word "investor" in the store portal or store emails.
