const jwt = require('jsonwebtoken');
const config = require('../config');
const { getDb } = require('../db');
const { uuid, HttpError, addMinutes, now } = require('./util');
const { getSetting } = require('./settings');
const { can } = require('./permissions');
const COOKIE = { user: 'tf_s', admin: 'tf_a' };

function cookieOpts(expires) {
  return { httpOnly: true, secure: config.isProd, sameSite: 'lax', domain: config.isProd ? config.cookieDomain : undefined, path: '/', expires };
}
async function startSession(res, req, type, actorId, minutes) {
  const id = uuid();
  const expires = addMinutes(now(), minutes);
  await getDb()('sessions').insert({ id, actor_type: type, actor_id: actorId, expires_at: expires, ip: req.ip, user_agent: String(req.get('user-agent') || '').slice(0, 250) });
  const token = jwt.sign({ sid: id, t: type }, config.jwtSecret, { expiresIn: Math.ceil(minutes * 60) + 's' });
  res.cookie(COOKIE[type], token, cookieOpts(expires));
  return id;
}
async function endSession(req, res, type) {
  const s = req.session;
  if (s) await getDb()('sessions').where({ id: s.id }).update({ revoked_at: now() });
  res.clearCookie(COOKIE[type], cookieOpts());
}
async function revokeAll(type, actorId) { await getDb()('sessions').where({ actor_type: type, actor_id: actorId }).whereNull('revoked_at').update({ revoked_at: now() }); }

function loader(type) {
  return async (req, res, next) => {
    try {
      const token = req.cookies && req.cookies[COOKIE[type]];
      if (!token) return next();
      let p; try { p = jwt.verify(token, config.jwtSecret); } catch { return next(); }
      if (p.t !== type) return next();
      const db = getDb();
      const s = await db('sessions').where({ id: p.sid }).first();
      if (!s || s.revoked_at || new Date(s.expires_at) < now()) return next();
      const table = type === 'admin' ? 'admins' : 'users';
      const actor = await db(table).where({ id: s.actor_id }).first();
      if (!actor || actor.status !== 'active') return next();
      if (type === 'admin') { // sliding inactivity timeout
        const sec = await getSetting('security');
        const exp = addMinutes(now(), sec.timeoutMinutes);
        if (exp - new Date(s.expires_at) > 60000) { await db('sessions').where({ id: s.id }).update({ expires_at: exp }); res.cookie(COOKIE.admin, jwt.sign({ sid: s.id, t: 'admin' }, config.jwtSecret, { expiresIn: sec.timeoutMinutes * 60 + 's' }), cookieOpts(exp)); }
      }
      req.session = s; req[type] = actor;
      next();
    } catch (e) { next(e); }
  };
}
const requireUser = (req, res, next) => (req.user ? next() : next(new HttpError(401, 'Please sign in.')));
const requireAdmin = (req, res, next) => (req.admin ? next() : next(new HttpError(401, 'Please sign in to the console.')));
const requirePerm = (group) => (req, res, next) => {
  if (!req.admin) return next(new HttpError(401, 'Please sign in to the console.'));
  if (!can(req.admin.role, group)) return next(new HttpError(403, 'Your role does not allow this change.', { needs: group }));
  next();
};
const actorOf = (req) => (req.admin ? { type: 'admin', id: req.admin.id } : req.user ? { type: 'user', id: req.user.id } : null);
module.exports = { startSession, endSession, revokeAll, loader, requireUser, requireAdmin, requirePerm, actorOf, COOKIE };
