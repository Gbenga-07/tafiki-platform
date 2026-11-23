process.env.NODE_ENV = 'test';
process.env.DB_CLIENT = 'better-sqlite3';
process.env.DB_FILE = ':memory:';
const knexLib = require('knex');
const request = require('supertest');
const { setDb, getDb } = require('../src/db');
const { createApp } = require('../src/app');
const pw = require('../src/lib/passwords');
const { uuid } = require('../src/lib/util');
async function setup() {
  const k = knexLib({ ...require('../knexfile'), connection: { filename: ':memory:' }, pool: { min: 1, max: 1 } });
  setDb(k); await k.migrate.latest();
  const app = createApp();
  return { app, db: k };
}
async function addAdmin(role, email, password = 'Passw0rd!') { await getDb()('admins').insert({ id: uuid(), name: role + ' Person', email, role, password_hash: await pw.hash(password) }); return { email, password }; }
function agent(app) { const a = request.agent(app); const wrapM = (m) => (url) => a[m](url).set('X-Tafiki-Client', '1'); return { get: (u) => a.get(u), post: wrapM('post'), patch: wrapM('patch'), put: wrapM('put'), raw: a }; }
const lastEmail = async (to) => getDb()('emails').where({ to_email: to }).orderBy('created_at', 'desc').first();
module.exports = { setup, addAdmin, agent, lastEmail };
