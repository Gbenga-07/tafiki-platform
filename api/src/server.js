const config = require('./config');
const { getDb } = require('./db');
const { createApp } = require('./app');
(async () => {
  await getDb().migrate.latest();
  createApp().listen(config.port, () => console.log(`Tafiki API listening on port ${config.port} (${config.env})`));
})().catch((e) => { console.error(e); process.exit(1); });
