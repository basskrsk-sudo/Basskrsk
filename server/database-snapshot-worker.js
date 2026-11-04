'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');

let db;
try {
  db = new DatabaseSync(workerData.source, { readOnly: true });
  db.exec('PRAGMA busy_timeout=10000');
  const target = "'" + workerData.destination.replace(/'/g, "''") + "'";
  db.exec('VACUUM INTO ' + target);
  db.close();
  db = null;
  parentPort.postMessage({ ok: true });
} catch (error) {
  if (db) try { db.close(); } catch (_) {}
  parentPort.postMessage({ ok: false, error: 'Не удалось создать снимок SQLite: ' + (error.code || 'unknown') });
}
