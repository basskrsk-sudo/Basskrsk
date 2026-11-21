'use strict';
// Spawn read-only SQLite work away from the HTTP/payment Node.js event loop.
// The scheduler is single-flight, so a hung persistent volume cannot queue
// unbounded new workers. Only routing metadata, never PII, crosses threads.
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const MAX_READ_MS = 120000;

function createPendingOrderBackgroundReader({
  WorkerClass = Worker,
  workerPath = path.join(__dirname, 'unpaid-order-background-read-worker.js'),
  timeoutMs = MAX_READ_MS,
} = {}) {
  return function readPendingOrderBackgroundRows(source) {
    if (typeof source !== 'string' || !source)
      return Promise.reject(new TypeError('Database source is required'));
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new WorkerClass(workerPath, {
          workerData: { source },
          resourceLimits: { maxOldGenerationSizeMb: 32 },
        });
      } catch (error) { reject(error); return; }

      let settled = false;
      const finish = (error, rows) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(rows);
      };
      // Wait for native SQLite I/O to stop before the scheduler can retry.
      // We must not create overlapping workers against a stalled /data.
      const timeout = setTimeout(() => {
        Promise.resolve(worker.terminate()).then(
          () => finish(new Error('Unpaid-order reader timed out')),
          () => finish(new Error('Unpaid-order reader termination failed'))
        );
      }, timeoutMs);
      timeout.unref?.();
      worker.once('message', message => {
        if (message?.ok === true && Array.isArray(message.rows))
          finish(null, message.rows);
        else finish(new Error('Unpaid-order reader: '+(message?.code || 'invalid response')));
      });
      worker.once('error', finish);
      worker.once('exit', code => {
        if (!settled) finish(new Error('Unpaid-order reader exited: '+code));
      });
    });
  };
}
const readPendingOrderBackgroundRows = createPendingOrderBackgroundReader();
module.exports = { createPendingOrderBackgroundReader, readPendingOrderBackgroundRows };
