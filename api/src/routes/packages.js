// Public: open packages, investment terms, certificate verification.
const express = require('express');
const { getDb } = require('../db');
const { HttpError } = require('../lib/util');
const { getTerms, getUnitPackage, packValue, getSetting } = require('../lib/terms');
const units = require('../lib/units');
const r = express.Router();
async function shape(p) { const taken = await units.unitsTaken(p.id); const confirmed = await units.unitsConfirmed(p.id); return { id: p.id, name: p.name, area: p.area, city: p.city, state: p.state, route: p.route, targetOpen: p.target_open, stage: p.stage, unitsTotal: p.units_total, unitsTaken: taken, unitsConfirmed: confirmed, unitsOpen: Math.max(0, p.units_total - taken), openedAt: p.opened_at }; }
r.get('/packages', async (req, res) => { const ps = await getDb()('packages').whereNot({ stage: 'closed' }).orderBy('created_at'); res.json({ packages: await Promise.all(ps.map(shape)) }); });
r.get('/packages/:id', async (req, res) => { const p = await getDb()('packages').where({ id: req.params.id }).first(); if (!p) throw new HttpError(404, 'Package not found.'); res.json({ package: await shape(p) }); });
r.get('/terms', async (req, res) => { const t = await getTerms(); const up = await getUnitPackage(); res.json({ terms: t, unitPackage: { ...up, value: packValue(up) }, escrow: await getSetting('escrow') }); });
r.get('/certificates/:certNo/verify', async (req, res) => {
  const h = await getDb()('holdings').where({ cert_no: req.params.certNo }).first();
  if (!h) return res.json({ valid: false });
  const u = await getDb()('users').where({ id: h.user_id }).first(); const p = await getDb()('packages').where({ id: h.package_id }).first();
  const code = String(req.query.code || '').toUpperCase();
  const valid = code === units.verifyCode(h.ref, h.cert_no, u.name) && units.CONFIRMED.includes(h.status);
  res.json(valid ? { valid, certificate: { certNo: h.cert_no, ref: h.ref, holder: u.name, package: p.name, units: h.units, issuedAt: h.issued_at, status: h.status } } : { valid: false });
});
module.exports = { router: r, shape };
