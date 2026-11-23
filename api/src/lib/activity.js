const { getDb } = require('../db');
async function log(actor, action, target, detail) {
  await getDb()('activity_log').insert({ actor_type: actor ? actor.type : 'system', actor_id: actor ? actor.id : null, action, target_type: target ? target.type : null, target_id: target ? target.id : null, detail: detail ? JSON.stringify(detail) : null });
}
module.exports = { log };
