// Creates the first Super Admin. Usage: npm run create-admin (reads SUPERADMIN_* from .env)
// or: node scripts/create-admin.js "Full Name" email@tafiki.com "StrongPassword1"
require('dotenv').config();
const { getDb } = require('../src/db');
const pw = require('../src/lib/passwords');
const { uuid, lower } = require('../src/lib/util');
(async () => {
  const [n, e, p] = process.argv.slice(2);
  const name = n || process.env.SUPERADMIN_NAME, email = lower(e || process.env.SUPERADMIN_EMAIL), password = p || process.env.SUPERADMIN_PASSWORD;
  if (!name || !email || !pw.strongEnough(password)) { console.error('Provide a name, email and a password of 8+ characters with letters and a number.'); process.exit(1); }
  const db = getDb(); await db.migrate.latest();
  const ex = await db('admins').where({ email }).first();
  if (ex) { await db('admins').where({ id: ex.id }).update({ role: 'Super Admin', status: 'active', password_hash: await pw.hash(password) }); console.log('Updated existing administrator to Super Admin:', email); }
  else { await db('admins').insert({ id: uuid(), name, email, role: 'Super Admin', password_hash: await pw.hash(password) }); console.log('Created Super Admin:', email); }
  await db.destroy();
})().catch((x) => { console.error(x); process.exit(1); });
