'use strict';

// Network and public-page parsing live in this Worker Thread. No SQLite,
// payment modules, user data, bot tokens or credentials are loaded here.
const { parentPort, workerData } = require('node:worker_threads');
const { collectPetNewsSources } = require('./pet-news-digest');

(async () => {
  const result = await collectPetNewsSources(workerData.sources);
  parentPort.postMessage({ok:true, result});
})().catch(error => {
  parentPort.postMessage({ok:false,
    error:String(error?.message || error).slice(0,200)});
});
