'use strict';
// Reads SQLite on a dedicated thread. A slow /data mount must not block HTTP.
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { EXPIRED_RESERVATIONS_BATCH_SQL } = require('./reservation-cleanup-query');
let database;
try {
  if (!workerData || typeof workerData.source !== 'string' || !workerData.source)
    throw new Error('Missing database source');
  database = new DatabaseSync(workerData.source, { readOnly: true });
  // SQLite lock waits belong to this thread, not the checkout event loop.
  database.exec('PRAGMA busy_timeout = 3000');
  const rows = database.prepare(EXPIRED_RESERVATIONS_BATCH_SQL)
    .all(workerData.afterId, workerData.limit);
  database.close();
  database = null;
  parentPort.postMessage({ ok: true, rows });
} catch (error) {
  try { database?.close(); } catch (_) {}
  // Never expose SQL text, payment identifiers or filesystem paths.
  parentPort.postMessage({ ok: false, code: error?.code || 'SQLITE_READ_ERROR' });
}
