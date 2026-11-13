'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

// Sequential source fetches: at most 9 * 8-second timeouts, plus overhead.
// Kill a stuck worker rather than letting background work grow without bound.
const WORKER_TIMEOUT_MS = 90000;
let inFlight = null;

function runPetNewsWorker(sources, {timeoutMs = WORKER_TIMEOUT_MS} = {}) {
  if (inFlight) return inFlight;
  if (!Array.isArray(sources) || sources.length > 12)
    return Promise.reject(new RangeError('Too many news sources'));
  if (!Number.isFinite(timeoutMs) || timeoutMs < 50 || timeoutMs > 120000)
    return Promise.reject(new RangeError('Invalid news worker timeout'));

  const run = new Promise((resolve,reject) => {
    const worker = new Worker(path.join(__dirname,'pet-news-worker.js'),{
      workerData:{sources},
      resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8,stackSizeMb:4},
    });
    let finished = false;
    let timer;
    function settle(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // Worker lifetime is one refresh. Release heap/native resources before
      // the next one even if the script unexpectedly kept open handles.
      void worker.terminate().catch(() => {});
      if (error) reject(error);
      else resolve(result);
    }
    worker.once('message',message => {
      if (message?.ok && message.result && Array.isArray(message.result.articles))
        settle(null,message.result);
      else settle(new Error(String(message?.error || 'News worker invalid result')));
    });
    worker.once('error',error => settle(error));
    worker.once('exit',code => {
      if (!finished) settle(new Error('News worker exited before returning data: '+code));
    });
    timer = setTimeout(() => settle(new Error('News worker timeout')),timeoutMs);
  });
  inFlight = run.finally(() => { inFlight = null; });
  return inFlight;
}

module.exports = { runPetNewsWorker, WORKER_TIMEOUT_MS };
