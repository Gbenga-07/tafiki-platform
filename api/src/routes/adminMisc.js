const express = require('express');
const { getDb } = require('../db');
const { requireAdmin } = require('../lib/auth');
const r = express.Router();
r.use(requireAdmin);
r.get('/activity', async (req, res) => res.json({ activity: await getDb()('activity_log').orderBy('id', 'desc').limit(Math.min(500, +(req.query.limit || 100))) }));
r.get('/emails', async (req, res) => {
  let q = getDb()('emails').select('id', 'to_email', 'to_name', 'category', 'subject', 'ref', 'status', 'error', 'created_at', 'sent_at').orderBy('created_at', 'desc').limit(Math.min(500, +(req.query.limit || 100)));
  if (req.query.category) q = q.where({ category: req.query.category });
  res.json({ emails: await q });
});
r.get('/emails/:id', async (req, res) => res.json({ email: await getDb()('emails').where({ id: req.params.id }).first() }));
module.exports = r;
