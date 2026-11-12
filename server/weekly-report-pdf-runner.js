'use strict';
// One PDF worker at a time; one waiting request at most. On low-RAM Amvera,
// parallel ImageMagick renderers can exhaust the container.
const path = require('node:path');
const { Worker } = require('node:worker_threads');

function createWeeklyPdfRunner({
  WorkerClass = Worker,
  workerPath = path.join(__dirname, 'weekly-report-pdf-worker.js'),
  timeoutMs = 180000,
  maxQueued = 1,
} = {}) {
  let running = false;
  const queue = [];

  function runWorker(report, outputPath) {
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new WorkerClass(workerPath, {
          workerData: { report, outputPath },
          resourceLimits: { maxOldGenerationSizeMb: 128 },
        });
      } catch (error) { return reject(error); }

      let settled = false;
      const complete = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(outputPath);
      };
      const timer = setTimeout(() => {
        // Wait for worker termination before releasing the single-flight slot.
        Promise.resolve(worker.terminate()).then(
          () => complete(new Error('Превышено время формирования PDF')),
          () => complete(new Error('Не удалось остановить формирование PDF'))
        );
      }, timeoutMs);
      worker.once('message', (msg) =>
        msg && msg.ok === true ? complete() :
          complete(new Error(msg?.error || 'PDF не сформирован')));
      worker.once('error', complete);
      worker.once('exit', (code) => {
        if (!settled) complete(new Error('Формирование PDF остановлено (код ' + code + ')'));
      });
    });
  }

  function drain() {
    if (running || !queue.length) return;
    running = true;
    const task = queue.shift();
    runWorker(task.report, task.outputPath).then(task.resolve, task.reject)
      .finally(() => { running = false; drain(); });
  }

  return function renderWeeklyPdf(report, outputPath) {
    if (!report || typeof report !== 'object' ||
        typeof outputPath !== 'string' || !outputPath) {
      return Promise.reject(new TypeError('Некорректные данные PDF'));
    }
    if (running && queue.length >= maxQueued) {
      const error = new Error('Формирование отчётов занято. Повторите запрос позднее.');
      error.statusCode = 503;
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      queue.push({ report, outputPath, resolve, reject });
      drain();
    });
  };
}
const renderWeeklyPdf = createWeeklyPdfRunner();
module.exports = { createWeeklyPdfRunner, renderWeeklyPdf };
