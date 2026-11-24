process.env.NODE_ENV = 'test';
process.env.DB_CLIENT = 'better-sqlite3';
process.env.DB_FILE = ':memory:';
const knexLib = require('knex');
const request = require('supertest');
const { setDb, getDb } = require('../src/db');
const { createApp } = require('../src/app');
const pw = require('../src/lib/passwords');
const { uuid } = require('../src/lib/util');
// Older suites (stages 1-4, stress) test other rules and run with the membership fee off.
// Pass { membershipFee: true } to keep the real ₦50,000 yearly fee (lifecycle and membership tests do).
async function setup(opts = {}) {
  let k;
  if (process.env.TEST_DB === 'mysql') { // run the same tests against MySQL/MariaDB: TEST_DB=mysql npm run test:mysql
    const conn = { host: process.env.TEST_DB_HOST || '127.0.0.1', port: 3306, user: process.env.TEST_DB_USER || 'tafiki', password: process.env.TEST_DB_PASSWORD || 'testpass' };
    const name = process.env.TEST_DB_NAME || 'tafiki_test';
    const root = knexLib({ client: 'mysql2', connection: conn }); await root.raw('DROP DATABASE IF EXISTS ??', [name]); await root.raw('CREATE DATABASE ?? CHARACTER SET utf8mb4', [name]); await root.destroy();
    k = knexLib({ client: 'mysql2', connection: { ...conn, database: name }, migrations: require('../knexfile').migrations });
  } else k = knexLib({ ...require('../knexfile'), connection: { filename: process.env.TEST_DB_FILE || ':memory:' }, pool: { min: 1, max: 1 } }); // TEST_DB_FILE keeps the result for a look in the browser
  setDb(k); await k.migrate.latest();
  if (!opts.membershipFee) await k('settings').insert({ key: 'terms', value: JSON.stringify({ membershipFee: 0 }) });
  const app = createApp();
  return { app, db: k };
}
async function addAdmin(role, email, password = 'Passw0rd!') { await getDb()('admins').insert({ id: uuid(), name: role + ' Person', email, role, password_hash: await pw.hash(password) }); return { email, password }; }
function agent(app) { const a = request.agent(app); const wrapM = (m) => (url) => a[m](url).set('X-Tafiki-Client', '1'); return { get: (u) => a.get(u), post: wrapM('post'), patch: wrapM('patch'), put: wrapM('put'), delete: wrapM('delete'), raw: a }; }
const lastEmail = async (to) => getDb()('emails').where({ to_email: to }).orderBy('created_at', 'desc').first();
module.exports = { setup, addAdmin, agent, lastEmail };
