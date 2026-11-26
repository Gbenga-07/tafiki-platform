// Builds the console's email template library (assets/email-templates.json) from the real emails the
// test suite sends, so every template shows exactly the approved design and wording, with sample data.
// Run: npm run email-templates   (takes a minute or two; uses SQLite test databases only)
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const root = path.join(__dirname, '..');
const tmp = path.join(os.tmpdir(), `tafiki-email-catalog-${process.pid}.jsonl`);
try { fs.unlinkSync(tmp); } catch (e) { /* none yet */ }
const tests = fs.readdirSync(path.join(root, 'tests')).filter((f) => f.endsWith('.test.js')).map((f) => path.join('tests', f));
const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests], { cwd: root, env: { ...process.env, EMAIL_CATALOG: tmp, TEST_DB: '' }, stdio: 'inherit' });
if (run.status !== 0) { console.error('Tests failed, so the template library was not rebuilt.'); process.exit(1); }
const rows = fs.readFileSync(tmp, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
fs.unlinkSync(tmp);
const norm = (s) => s.replace(/FOODCORE( Mart)? [A-Z][\w'-]*( [A-Z][\w'-]*)?/g, 'FOODCORE X').replace(/₦[\d,.]+[kKmM]?/g, '₦N').replace(/[A-Z]{2,4}-[\dA-Z-]+/g, 'REF').replace(/#\d+/g, '#N').replace(/\d[\d,.]*/g, 'N');
const ORDER = ['account', 'security', 'units', 'receipts', 'payouts', 'wallet', 'delivery', 'remittance', 'audit', 'operations'];
const seen = new Map();
for (const r of rows) { const k = [r.category, r.audience || 'other', norm(r.subject)].join('|'); if (!seen.has(k)) seen.set(k, { ...r, pattern: norm(r.subject), uses: 0 }); seen.get(k).uses++; }
const list = [...seen.values()].sort((a, b) => (ORDER.indexOf(a.category) + 1 || 99) - (ORDER.indexOf(b.category) + 1 || 99) || String(a.audience).localeCompare(String(b.audience)) || a.pattern.localeCompare(b.pattern))
  .map((r, i) => ({ id: 't' + String(i + 1).padStart(2, '0'), category: r.category, audience: r.audience || 'other', team: r.team, subject: r.subject, pattern: r.pattern, attachments: r.attachments, html: r.html.replace(/https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/img\//g, 'img/').replace(/https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/g, 'https://tafiki.com') }));
const out = path.join(root, 'assets', 'email-templates.json');
fs.writeFileSync(out, JSON.stringify({ generated: new Date().toISOString(), count: list.length, templates: list }));
console.log(`Saved ${list.length} email templates to assets/email-templates.json`);
