require('dotenv').config();
const path = require('path');
const client = process.env.DB_CLIENT || 'mysql2';
const base = { client, migrations: { directory: path.join(__dirname, 'migrations') } };
module.exports = client === 'better-sqlite3'
  ? { ...base, connection: { filename: process.env.DB_FILE || ':memory:' }, useNullAsDefault: true }
  : { ...base, connection: { host: process.env.DB_HOST, port: +(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, charset: 'utf8mb4', dateStrings: false }, pool: { min: 0, max: 10 } };
