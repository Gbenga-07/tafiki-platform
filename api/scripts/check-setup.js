// Checks the server's setup without changing anything: database, settings, and each third-party account.
// Run on the server: npm run check
// It never prints keys or passwords.
require('dotenv').config();
const knexLib = require('knex');
const ok = (m) => console.log('  ✔ ' + m), warn = (m) => console.log('  ! ' + m), bad = (m) => { console.log('  ✘ ' + m); process.exitCode = 1; };
const mask = (v) => (v ? v.slice(0, 8) + '…' : '(empty)');
(async () => {
  const e = process.env;
  console.log('\nTafiki setup check\n');
  console.log('Basics');
  e.NODE_ENV === 'production' ? ok('NODE_ENV is production') : warn(`NODE_ENV is "${e.NODE_ENV || ''}" (use production on the server)`);
  (e.JWT_SECRET || '').length >= 40 && !/replace/.test(e.JWT_SECRET) ? ok('JWT_SECRET is set and long') : bad('JWT_SECRET is missing or too short');
  if (e.SIMULATION === '1') ((e.PAYSTACK_SECRET_KEY || '').startsWith('sk_live_') || (e.FLW_SECRET_KEY || '').startsWith('FLWSECK-') || e.SMILE_ENV === 'production' ? bad('SIMULATION=1 is on with live keys: remove SIMULATION from .env') : warn('SIMULATION=1: the time-travel script is allowed (test data only)'));
  e.APP_URL && e.API_URL ? ok(`Website ${e.APP_URL} · API ${e.API_URL}`) : bad('APP_URL and API_URL must be set');

  console.log('\nDatabase');
  try {
    const db = knexLib(require('../knexfile'));
    await db.raw('select 1');
    const [done] = await db.migrate.list(); ok(`Connected · ${done.length} migrations applied`);
    const admins = await db('admins').where({ role: 'Super Admin', status: 'active' }).count({ n: '*' }).first();
    Number(admins.n) ? ok(`${admins.n} active Super Admin(s)`) : bad('No Super Admin yet: run npm run create-admin');
    await db.destroy();
  } catch (err) { bad('Database: ' + err.message); }

  console.log('\nFlutterwave');
  const fk = e.FLW_SECRET_KEY || '';
  if (!fk) warn('No FLW_SECRET_KEY: online payment is off (bank transfer still works)');
  else {
    fk.startsWith('FLWSECK_TEST') ? ok(`Test key ${mask(fk)} (simulation: no real money)`) : fk.startsWith('FLWSECK-') ? warn(`LIVE key ${mask(fk)}: real money moves`) : bad('FLW_SECRET_KEY should start with FLWSECK_TEST- or FLWSECK-');
    try { const r = await fetch('https://api.flutterwave.com/v3/banks/NG', { headers: { Authorization: 'Bearer ' + fk } }); r.ok ? ok('Flutterwave accepted the key') : bad('Flutterwave rejected the key (HTTP ' + r.status + ')'); } catch (err) { warn('Could not reach Flutterwave: ' + err.message); }
    e.FLW_SECRET_HASH ? ok('Webhook secret hash is set') : bad('FLW_SECRET_HASH is empty: payment confirmations from Flutterwave will be refused');
    console.log('    Set the webhook URL in Flutterwave (Settings > Webhooks): ' + (e.API_URL || 'https://api.tafiki.com') + '/webhooks/flutterwave');
  }
  console.log('\nBank transfer');
  ['0', 'false', 'off'].includes(String(e.MANUAL_TRANSFERS || 'on').toLowerCase()) ? warn('MANUAL_TRANSFERS=off: bank transfer is hidden at checkout') : ok(`Bank transfer is offered; units are held ${e.RELEASE_AFTER_HOURS || 24} hours`);

  console.log('\nPaystack (older payments only)');
  const pk = e.PAYSTACK_SECRET_KEY || '';
  if (!pk) warn('No PAYSTACK_SECRET_KEY: card payments are off (bank transfer still works)');
  else {
    pk.startsWith('sk_test_') ? ok(`Test key ${mask(pk)} (simulation: no real money)`) : pk.startsWith('sk_live_') ? warn(`LIVE key ${mask(pk)}: real money moves`) : bad('PAYSTACK_SECRET_KEY should start with sk_test_ or sk_live_');
    try { const r = await fetch('https://api.paystack.co/bank?country=nigeria&perPage=1', { headers: { Authorization: 'Bearer ' + pk } }); r.ok ? ok('Paystack accepted the key') : bad('Paystack rejected the key (HTTP ' + r.status + ')'); } catch (err) { bad('Cannot reach Paystack: ' + err.message); }
    console.log('    Set the webhook URL in Paystack (same mode as the key): ' + (e.API_URL || 'https://api.tafiki.com') + '/webhooks/paystack');
  }

  console.log('\nSmile ID');
  if (!e.SMILE_PARTNER_ID || !e.SMILE_API_KEY) warn('Smile ID keys are empty: identity checks are off (admins can verify members by hand)');
  else {
    e.SMILE_ENV === 'production' ? warn('SMILE_ENV=production: real ID checks, billed') : ok('SMILE_ENV=sandbox (simulation: use Smile ID test ID numbers)');
    { const t = (e.SMILE_ID_TYPES || 'NIN_V2,BVN,VOTER_ID').trim(); ok(/^all$/i.test(t) ? 'ID types: every type your Smile ID account allows' : 'ID types offered: ' + t.split(',').map((x) => x.trim()).join(', ') + ' (NIN and BVN must be switched on for your Smile ID account)'); }
    try {
      const smile = require('smile-identity-core');
      const conn = new smile.WebApi(e.SMILE_PARTNER_ID, e.SMILE_CALLBACK_URL || (e.API_URL || '') + '/webhooks/smileid', e.SMILE_API_KEY, e.SMILE_ENV === 'production' ? 1 : 0);
      const t = await conn.get_web_token({ user_id: 'setup-check', job_id: 'setup-check-' + Date.now(), product: 'biometric_kyc', callback_url: (e.API_URL || '') + '/webhooks/smileid' });
      t && t.token ? ok('Smile ID issued a web token') : bad('Smile ID did not return a token');
    } catch (err) { bad('Smile ID: ' + (err.message || err)); }
    console.log('    Register this callback URL in the Smile ID portal: ' + (e.API_URL || 'https://api.tafiki.com') + '/webhooks/smileid');
  }

  console.log('\nSecurity codes');
  ['0', 'false', 'off'].includes(String(e.OTP_REQUIRED || 'on').toLowerCase()) ? warn('OTP_REQUIRED is off: withdrawals and bank changes do not ask for a code') : ok('Withdrawals and bank changes need a 6-digit code sent by email');

  console.log('\nEmail');
  e.SMTP_HOST ? ok(`SMTP ${e.SMTP_HOST}:${e.SMTP_PORT || 587} as ${e.SMTP_USER || '(no user)'}`) : warn('No SMTP: emails are kept in the console (Email Correspondence) and not sent');
  console.log(process.exitCode ? '\nSome checks failed. Fix the ✘ lines above.\n' : '\nAll required checks passed.\n');
})();
