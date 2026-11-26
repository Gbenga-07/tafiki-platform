const express = require('express');
const { getDb } = require('../db');
const { requireAdmin } = require('../lib/auth');
const r = express.Router();
r.use(requireAdmin);
// Email template library: one sample of every email the platform sends, in the approved design (built by npm run email-templates).
let TPL = null;
const loadTpl = () => { if (!TPL) { try { TPL = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '../../assets/email-templates.json'), 'utf8')); } catch (e) { TPL = { generated: null, templates: [] }; } } return TPL; };
r.get('/email-templates', (req, res) => { const d = loadTpl(); res.json({ generated: d.generated, templates: d.templates.map(({ html, ...t }) => t) }); });
r.get('/email-templates/:id', (req, res) => { const t = loadTpl().templates.find((x) => x.id === req.params.id); if (!t) return res.status(404).json({ error: 'Template not found.' }); res.json({ template: t }); });
r.get('/activity', async (req, res) => res.json({ activity: await getDb()('activity_log').orderBy('id', 'desc').limit(Math.min(500, +(req.query.limit || 100))) }));
// Email records: filter by category, status, direction and words; summary counts per category for the console tabs.
r.get('/emails', async (req, res) => {
  const db = getDb(); const qy = req.query;
  let q = db('emails').select('id', 'to_email', 'to_name', 'category', 'subject', 'ref', 'status', 'error', 'created_at', 'sent_at', 'receipt_no', 'amount', 'direction', 'audience', 'attach').orderBy('created_at', 'desc').limit(Math.min(1000, +(qy.limit || 300)));
  if (qy.category) q = q.where({ category: qy.category });
  if (qy.status) q = q.where({ status: qy.status });
  if (qy.audience) q = q.where({ audience: qy.audience });
  if (qy.direction) q = q.where({ direction: qy.direction });
  if (qy.receipts === '1') q = q.whereNotNull('receipt_no');
  if (qy.q) { const w = '%' + String(qy.q).slice(0, 80) + '%'; q = q.where((b) => b.where('to_email', 'like', w).orWhere('to_name', 'like', w).orWhere('subject', 'like', w).orWhere('ref', 'like', w).orWhere('receipt_no', 'like', w)); }
  const summary = await db('emails').select('audience', 'category').count({ n: '*' }).sum({ amount: 'amount' }).groupBy('audience', 'category');
  const failed = await db('emails').where({ status: 'failed' }).count({ n: '*' }).first();
  res.json({ emails: (await q).map((e) => { const sp = e.attach ? JSON.parse(e.attach) : []; delete e.attach; return { ...e, attachments: require('../lib/mailer').attachNames(sp) }; }), summary: summary.map((x) => ({ audience: x.audience || 'other', category: x.category, count: Number(x.n), amount: Number(x.amount) || 0 })), failed: Number(failed.n) });
});
// Send a failed or held email again.
r.post('/emails/:id/resend', async (req, res) => {
  const db = getDb(); const e = await db('emails').where({ id: req.params.id }).first(); if (!e) return res.status(404).json({ error: 'Email not found.' });
  if (!['failed', 'logged'].includes(e.status)) return res.status(400).json({ error: 'Only failed or held emails can be sent again.' });
  const out = await require('../lib/mailer').resend(e);
  await require('../lib/activity').log({ type: 'admin', id: req.admin.id }, 'email.resent', { type: 'email', id: e.id }, { status: out.status });
  res.json({ status: out.status });
});
r.get('/emails/:id', async (req, res) => { const e = await getDb()('emails').where({ id: req.params.id }).first(); if (!e) return res.status(404).json({ error: 'Email not found.' }); const spec = e.attach ? JSON.parse(e.attach) : []; delete e.attach; res.json({ email: { ...e, attachments: require('../lib/mailer').attachNames(spec) } }); });
// download an email's PDF attachment (rebuilt from what was sent)
r.get('/emails/:id/attachments/:n', async (req, res) => {
  const e = await getDb()('emails').where({ id: req.params.id }).first(); if (!e || !e.attach) return res.status(404).json({ error: 'This email has no attachment.' });
  const spec = JSON.parse(e.attach); const a = spec[Number(req.params.n)]; if (!a) return res.status(404).json({ error: 'Attachment not found.' });
  const [file] = await require('../lib/mailer').buildAttachments([a]); if (!file) return res.status(500).json({ error: 'The PDF could not be made.' });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${file.filename}"` }).send(file.content);
});
// Console assistant: read-only answers from live data (needs ANTHROPIC_API_KEY on the server).
const aiLimit = new Map();
r.post('/ai', async (req, res) => {
  const k = req.admin.id, now = Date.now(), hits = (aiLimit.get(k) || []).filter((t) => now - t < 60000); if (hits.length >= 15) return res.status(429).json({ error: 'Too many questions at once. Wait a minute.' }); hits.push(now); aiLimit.set(k, hits);
  const out = await require('../lib/ai').ask(req.admin, (req.body && req.body.messages) || []);
  res.json(out);
});
r.get('/ai/status', (req, res) => res.json({ enabled: !!process.env.ANTHROPIC_API_KEY }));
module.exports = r;
