'use strict';
// Runs synchronous MVG/ImageMagick/PDF assembly off the HTTP event loop.
// Do not require weekly-report.js here: its import opens/migrates SQLite.
const { parentPort, workerData } = require('node:worker_threads');
try {
  if (!workerData || !workerData.report || !workerData.outputPath)
    throw new Error('Отсутствуют данные для формирования PDF');
  require('./weekly-report-pdf').buildPdf(workerData.report, workerData.outputPath);
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({ ok: false, error: String(error.message || error) });
}
