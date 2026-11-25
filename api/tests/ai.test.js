// Console assistant: every read-only tool runs against the database, and the tool loop answers from tool results.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, addAdmin, agent } = require('./helpers');
const ai = require('../src/lib/ai');
let app, db, sup;
before(async () => {
  ({ app, db } = await setup());
  await addAdmin('Super Admin', 'ops@tafiki.com'); sup = agent(app); await sup.post('/api/admin/auth/login').send({ email: 'ops@tafiki.com', password: 'Passw0rd!' });
  await sup.post('/api/admin/packages').send({ name: 'FOODCORE Mart Ikotun', area: 'Ikotun', city: 'Lagos', unitsTotal: 40 });
  await agent(app).post('/api/auth/register').send({ role: 'investor', firstName: 'Ada', lastName: 'Obi', email: 'ada@example.com', phone: '08031234567', password: 'Secret123', agreeTerms: true });
});
after(async () => { await db.destroy(); delete process.env.ANTHROPIC_API_KEY; });

test('every tool runs on real data without errors', async () => {
  const args = { get_package: { name: 'Ikotun' }, find_member: { query: 'Ada' }, list_pending: { type: 'payments' }, search_emails: { query: 'Welcome' } };
  for (const t of ai.TOOLS) { const out = await t.run(db, args[t.name] || {}); assert.ok(out && !out.error, t.name + ' ' + JSON.stringify(out)); }
  for (const type of ['withdrawals', 'remittances', 'ids', 'redemptions', 'deliveries', 'refunds']) await ai.TOOLS.find((x) => x.name === 'list_pending').run(db, { type });
  assert.equal((await ai.TOOLS.find((x) => x.name === 'get_package').run(db, { name: 'Ikotun' })).mart, 'FOODCORE Mart Ikotun');
});

test('without a key it says how to switch it on; with a key it calls tools then answers', async () => {
  assert.match((await sup.post('/api/admin/ai').send({ messages: [{ role: 'user', content: 'hi' }] })).body.text, /ANTHROPIC_API_KEY/);
  process.env.ANTHROPIC_API_KEY = 'test';
  const calls = [];
  ai.setFetch(async (url, o) => { const b = JSON.parse(o.body); calls.push(b);
    if (calls.length === 1) return { ok: true, json: async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'list_packages', input: {} }] }) };
    const tr = b.messages[b.messages.length - 1].content[0]; assert.equal(tr.type, 'tool_result'); assert.match(tr.content, /Ikotun/);
    return { ok: true, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ikotun is funding.' }] }) }; });
  const r = await sup.post('/api/admin/ai').send({ messages: [{ role: 'user', content: 'Which marts are funding?' }] });
  assert.equal(r.body.text, 'Ikotun is funding.'); assert.match(calls[0].system, /Always call tools/); assert.equal(calls[0].tools.length, ai.TOOLS.length);
  assert.equal((await agent(app).post('/api/admin/ai').send({ messages: [] })).status, 401, 'console sign-in required');
});
