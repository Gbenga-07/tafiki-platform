// Test-mode only: moves the clock forward for the whole platform by moving stored dates back N days,
// so the day-28 audit, restock, 90-day payouts, 12-month hold and redemption notice can be tried today.
// Usage (in api/):  npm run sim:advance -- 28
// Refuses to run unless SIMULATION=1 is in .env, Paystack is on a test key (or off) and Smile ID is in sandbox (or off).
require('dotenv').config();
const knexLib = require('knex');
const days = Number(process.argv[2]);
const e = process.env;
function refuse(m) { console.error('Not run: ' + m); process.exit(1); }
if (!(days > 0 && days <= 400)) refuse('give a number of days between 1 and 400, for example: npm run sim:advance -- 28');
if (e.SIMULATION !== '1') refuse('add SIMULATION=1 to api/.env first (and remove it before going live).');
if ((e.PAYSTACK_SECRET_KEY || '').startsWith('sk_live_')) refuse('Paystack is on a LIVE key.');
if (e.SMILE_ENV === 'production') refuse('Smile ID is in production.');
(async () => {
  const db = knexLib(require('../knexfile'));
  const ms = days * 864e5;
  const moves = [
    ['store_cycles', ['start_at', 'audit_at', 'restock_at']],
    ['packages', ['opened_at']],
    ['holdings', ['active_since']],
    ['payout_runs', ['period_start', 'period_end']],
    ['redemptions', ['settle_after']],
    ['delivery_log', ['at']],
  ];
  for (const [table, cols] of moves) {
    const rows = await db(table).select('id', ...cols); let n = 0;
    for (const r of rows) {
      const upd = {}; for (const c of cols) if (r[c] != null) { const d = typeof r[c] === 'string' && !/[zZ]|[+-]\d\d:?\d\d$/.test(r[c]) ? new Date(r[c].replace(' ', 'T') + 'Z') : new Date(r[c]); if (!isNaN(d)) upd[c] = new Date(d.getTime() - ms); }
      if (Object.keys(upd).length) { await db(table).where({ id: r.id }).update(upd); n++; }
    }
    console.log(`  ${table}: ${n} row(s) moved ${days} days back`);
  }
  console.log(`\nDone. The platform now behaves as if ${days} days have passed. Refresh the console.`);
  await db.destroy();
})().catch((err) => { console.error(err.message); process.exit(1); });
