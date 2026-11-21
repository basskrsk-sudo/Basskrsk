'use strict';
// Low-priority SQLite diagnostics in a dedicated worker thread.
// Checkout/webhooks never wait for this work. Short busy timeout prevents
// the diagnostic database connection from competing with payments.
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');

let db;
try {
  if (!workerData || typeof workerData.source !== 'string' ||
      !workerData.source) throw new Error('Missing SQLite source');
  db = new DatabaseSync(workerData.source);
  db.exec('PRAGMA busy_timeout=200');
  db.exec('BEGIN IMMEDIATE');
  try {
    const insert = db.prepare(
      'INSERT INTO site_health_events(event_type,severity,detail,created_at) VALUES(?,?,?,?)'
    );
    for (const event of Array.isArray(workerData.events) ? workerData.events : []) {
      if (!['startup','restart_gap','recovered','database','storage',
             'memory','disk','cpu','event_loop'].includes(event.type) ||
          !['info','warning','critical'].includes(event.severity)) continue;
      const at = String(event.at || '').slice(0,19).replace('T',' ');
      insert.run(event.type, event.severity, String(event.detail).slice(0,160), at);
    }
    if (workerData.heartbeat) {
      const {at,bootId} = workerData.heartbeat;
      db.prepare('INSERT INTO site_health_heartbeat(id,last_seen_at,boot_id) VALUES(1,?,?) '+
        'ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at,boot_id=excluded.boot_id')
        .run(String(at), String(bootId));
    }
    if (workerData.prune)
      db.prepare("DELETE FROM site_health_events WHERE created_at < datetime('now','-90 days')").run();
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
  db.close();
  db = null;
  parentPort.postMessage({ok:true});
} catch (error) {
  try { db?.close(); } catch (_) {}
  parentPort.postMessage({ok:false,code:error?.code || 'HEALTH_WRITE_ERROR'});
}
