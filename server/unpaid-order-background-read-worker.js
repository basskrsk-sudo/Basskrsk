'use strict';
// Background read-only candidate scan. Do not import ./db: it would run all
// startup migrations and potentially create extra writes on the slow volume.
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
let database;
try {
  if (!workerData || typeof workerData.source !== 'string' || !workerData.source)
    throw new Error('Missing database source');
  database = new DatabaseSync(workerData.source, { readOnly: true });
  database.exec('PRAGMA busy_timeout = 3000');
  const rows = database.prepare(
    "SELECT o.id, o.point_id, o.created_at, ml.order_id AS manager_logged, " +
    "al.target_chat_id AS admin_chat_id, al.status AS admin_status, " +
    "al.created_at AS admin_created_at, " +
    "al.created_at<=datetime('now','-30 seconds') AS admin_retry_due " +
    "FROM orders o " +
    "LEFT JOIN unpaid_order_alert_log ml " +
    "ON ml.order_id=o.id AND ml.alert_type='pending' " +
    "LEFT JOIN unpaid_order_admin_alert_log al " +
    "ON al.order_id=o.id AND al.alert_type='pending' " +
    "WHERE o.status='pending' AND o.reservation_status='active' " +
    "AND o.created_at>=datetime('now','-30 minutes') ORDER BY o.id"
  ).all();
  database.close();
  database = null;
  parentPort.postMessage({ ok: true, rows });
} catch (error) {
  try { database?.close(); } catch (_) {}
  // Do not leak SQL, filenames, personal information or payment details.
  parentPort.postMessage({ ok: false, code: error?.code || 'SQLITE_READ_ERROR' });
}
