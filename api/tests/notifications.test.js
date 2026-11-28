// Notifications screen and the "account is verified" email after a manual check.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, addAdmin, agent } = require('./helpers');
let app, db, a, uid, sup;
before(async () => {
  ({ app, db } = await setup());
  await addAdmin('Super Admin', 'ops@tafiki.com'); sup = agent(app); await sup.post('/api/admin/auth/login').send({ email: 'ops@tafiki.com', password: 'Passw0rd!' });
  a = agent(app);
  const r = await a.post('/api/auth/register').send({ role: 'investor', firstName: 'Tolu', lastName: 'Bade', email: 'tolu@example.com', phone: '08031113333', password: 'Secret123', agreeTerms: true, bank: { name: 'GTBank', account: '0123456789', accountName: 'Tolu Bade' } });
  assert.equal(r.status, 201); uid = r.body.user.id;
});
after(async () => { await db.destroy(); });

test('account emails show in Notifications; codes and links do not', async () => {
  await a.post('/api/me/otp').send({ purpose: 'withdraw' });
  const n = await a.get('/api/me/notifications'); assert.equal(n.status, 200);
  const titles = n.body.notes.map((x) => x.title);
  assert.ok(titles.some((t) => /Welcome to Tafiki/.test(t)), titles.join(' | '));
  assert.ok(!titles.some((t) => /code|Confirm your email/i.test(t)), 'no codes or links: ' + titles.join(' | '));
  assert.ok(n.body.unread >= 1); assert.ok(n.body.notes[0].text.length > 0);
  assert.equal((await a.post('/api/me/notifications/seen')).status, 200);
  assert.equal((await a.get('/api/me/notifications')).body.unread, 0);
});
test('manual verification by an admin sends "Your Tafiki account is verified" and a notification, not "details updated"', async () => {
  const r = await sup.patch('/api/admin/users/' + uid).send({ kycStatus: 'verified' }); assert.equal(r.status, 200, JSON.stringify(r.body));
  const v = await db('emails').where({ to_email: 'tolu@example.com', subject: 'Your Tafiki account is verified' });
  assert.equal(v.length, 1); assert.match(v[0].body_text, /Tafiki team \(manual review\)/);
  assert.equal((await db('emails').where({ to_email: 'tolu@example.com', subject: 'Your Tafiki account details were updated' })).length, 0);
  const n = await a.get('/api/me/notifications'); assert.equal(n.body.notes[0].title, 'Your Tafiki account is verified'); assert.equal(n.body.notes[0].unread, true);
});
