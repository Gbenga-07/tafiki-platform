const { getDb } = require('../db');
const { uuid, sha256, randomCode, randomToken, addMinutes, now } = require('./util');
// One-time codes and tokens are stored only as hashes.
async function issue(purpose, subjectType, subjectId, { minutes = 10, token = false } = {}) {
  const db = getDb();
  await db('codes').where({ purpose, subject_type: subjectType, subject_id: subjectId }).whereNull('used_at').update({ used_at: now() });
  const value = token ? randomToken() : randomCode(6);
  const id = uuid();
  await db('codes').insert({ id, purpose, subject_type: subjectType, subject_id: subjectId, code_hash: sha256(value), expires_at: addMinutes(now(), minutes), created_at: new Date() });
  return { id, value };
}
async function check(purpose, subjectType, subjectId, value, maxAttempts = 5) {
  const db = getDb();
  const row = await db('codes').where({ purpose, subject_type: subjectType, subject_id: subjectId }).whereNull('used_at').orderBy('created_at', 'desc').first();
  if (!row || new Date(row.expires_at) < now()) return { ok: false, reason: 'expired' };
  if (row.attempts >= maxAttempts) return { ok: false, reason: 'too_many' };
  if (row.code_hash !== sha256(String(value || '').trim())) { await db('codes').where({ id: row.id }).increment('attempts', 1); return { ok: false, reason: 'wrong' }; }
  await db('codes').where({ id: row.id }).update({ used_at: now() });
  return { ok: true };
}
async function byToken(purpose, token) {
  const row = await getDb()('codes').where({ purpose, code_hash: sha256(String(token || '')) }).whereNull('used_at').first();
  if (!row || new Date(row.expires_at) < now()) return null;
  return row;
}
async function consume(id) { await getDb()('codes').where({ id }).update({ used_at: now() }); }
module.exports = { issue, check, byToken, consume };
