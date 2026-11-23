// Timed jobs. Runs inside the API process (one instance). Stage 3 adds delivery stages and audit reminders.
const units = require('./lib/units');
function start() {
  const every = (ms, fn, name) => setInterval(() => fn().catch((e) => console.error('job', name, e.message)), ms);
  every(60 * 1000, units.expireReservations, 'expireReservations');
}
module.exports = { start };
