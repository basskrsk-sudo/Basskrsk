'use strict';
// VACUUM INTO is synchronous inside SQLite, so it must run outside the HTTP
// event loop. Independent read-only WAL connection keeps website requests
// responsive while a backup is being built.
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const MAX_SNAPSHOT_TIME_MS = 120000;
let queue = Promise.resolve();

function runWorker(source, destination, timeoutMs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'database-snapshot-worker.js'), {
      workerData: { source, destination },
    });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(destination);
    };
    const timeout = setTimeout(() => {
      void worker.terminate().then(
        () => finish(new Error('Превышено время создания резервной копии SQLite')),
        () => finish(new Error('Не удалось остановить создание резервной копии SQLite'))
      );
    }, timeoutMs);
    worker.once('message', (message) => {
      if (message?.ok === true) finish();
      else finish(new Error(message?.error || 'Не удалось создать резервную копию SQLite'));
    });
    worker.once('error', finish);
    worker.once('exit', (code) => {
      if (!settled) finish(new Error('Поток резервного копирования остановился (код ' + code + ')'));
    });
  });
}

function createDatabaseSnapshot(source, destination, { timeoutMs = MAX_SNAPSHOT_TIME_MS } = {}) {
  if (!source || !destination) return Promise.reject(new Error('Не указан путь базы данных или снимка'));
  // Never launch two VACUUM INTO operations in parallel. Failed jobs must not
  // poison the queue and block all later backups.
  const job = queue.then(() => runWorker(source, destination, timeoutMs));
  queue = job.catch(() => {});
  return job;
}

module.exports = { createDatabaseSnapshot };
