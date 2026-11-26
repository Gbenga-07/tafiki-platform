// Timed jobs. Runs inside the API process (one instance). Stage 3 adds delivery stages and audit reminders.
const units = require('./lib/units');
function start() {
  const every = (ms, fn, name) => setInterval(() => fn().catch((e) => console.error('job', name, e.message)), ms);
  const ops = require('./lib/ops');
  every(60 * 1000, units.expireReservations, 'expireReservations');
  every(60 * 1000, ops.autoAdvance, 'autoAdvance');
  every(5 * 60 * 1000, ops.releaseRestocks, 'releaseRestocks');
  every(15 * 60 * 1000, ops.auditReminders, 'auditReminders');
  const daily = require('./routes/adminData').dailyBackup; every(60 * 60 * 1000, daily, 'dailyBackup'); setTimeout(() => daily().catch((e) => console.error('job dailyBackup', e.message)), 30 * 1000);
}
module.exports = { start };
