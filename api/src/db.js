const knexLib = require('knex');
let db = null;
function getDb() { if (!db) db = knexLib(require('../knexfile')); return db; }
function setDb(k) { db = k; }
module.exports = { getDb, setDb };
