const { getDb } = require('../db');
const DEFAULTS = { security: { twofa: false, timeoutMinutes: 60, maxFailures: 5, lockMinutes: 15 } };
async function getSetting(key) { const row = await getDb()('settings').where({ key }).first(); return row ? { ...DEFAULTS[key], ...JSON.parse(row.value) } : { ...DEFAULTS[key] }; }
async function putSetting(key, value) { const db = getDb(); const v = JSON.stringify(value); const ex = await db('settings').where({ key }).first(); if (ex) await db('settings').where({ key }).update({ value: v, updated_at: new Date() }); else await db('settings').insert({ key, value: v }); return value; }
module.exports = { getSetting, putSetting, DEFAULTS };
