'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const MAX_WORKER_TIME_MS = 120000;

// Caller holds a single-flight slot. A hung /data I/O never stacks readers.
function createReservationCleanupReader({
  WorkerClass = Worker,
  workerPath = path.join(__dirname, 'reservation-cleanup-reader-worker.js'),
  timeoutMs = MAX_WORKER_TIME_MS,
} = {}) {
  return function readExpiredReservationsBatch(source, afterId = 0, limit = 8) {
    if (typeof source !== 'string' || !source)
      return Promise.reject(new TypeError('Database source is required'));
    const cursor = Number.isSafeInteger(afterId) && afterId > 0 ? afterId : 0;
    const size = Number.isSafeInteger(limit) ? Math.max(1, Math.min(20, limit)) : 8;
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new WorkerClass(workerPath, {
          workerData: { source, afterId: cursor, limit: size },
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
      // Wait for worker termination before releasing the single-flight slot.
      const timeout = setTimeout(() => {
        Promise.resolve(worker.terminate()).then(
          () => finish(new Error('Reservation cleanup reader timed out')),
          () => finish(new Error('Reservation cleanup reader termination failed'))
        );
      }, timeoutMs);
      worker.once('message', (message) => {
        if (message?.ok === true && Array.isArray(message.rows))
          finish(null, message.rows);
        else finish(new Error('Reservation cleanup reader: '+(message?.code || 'invalid response')));
      });
      worker.once('error', finish);
      worker.once('exit', (code) => {
        if (!settled) finish(new Error('Reservation cleanup reader exited: '+code));
      });
    });
  };
}
function createReservationDeadlineReader({
  WorkerClass=Worker,
  workerPath=path.join(__dirname,'reservation-cleanup-reader-worker.js'),
  timeoutMs=MAX_WORKER_TIME_MS,
}={}) {
  return function readEarliestReservationExpiry(source) {
    if(typeof source!=='string'||!source)
      return Promise.reject(new TypeError('Database source is required'));
    return new Promise((resolve,reject)=>{
      let worker;
      try {
        worker=new WorkerClass(workerPath,{
          workerData:{source,deadlineOnly:true},
          resourceLimits:{maxOldGenerationSizeMb:32},
        });
      }catch(error){reject(error);return;}
      let settled=false;
      const finish=(error,expiry)=>{
        if(settled)return;
        settled=true;
        clearTimeout(timeout);
        if(error)reject(error);
        else resolve(expiry);
      };
      // Never run another deadline reader until native blocked I/O stops.
      const timeout=setTimeout(()=>{
        Promise.resolve(worker.terminate()).then(
          ()=>finish(new Error('Reservation deadline reader timed out')),
          ()=>finish(new Error('Reservation deadline reader termination failed'))
        );
      },timeoutMs);
      timeout.unref?.();
      worker.once('message',message=>{
        if(message?.ok===true && (message.expiry===null || typeof message.expiry==='string'))
          finish(null,message.expiry);
        else finish(new Error('Reservation deadline reader: '+(message?.code||'invalid response')));
      });
      worker.once('error',finish);
      worker.once('exit',code=>{
        if(!settled)finish(new Error('Reservation deadline reader exited: '+code));
      });
    });
  };
}
const readExpiredReservationsBatch=createReservationCleanupReader();
const readEarliestReservationExpiry=createReservationDeadlineReader();
module.exports={
  createReservationCleanupReader, readExpiredReservationsBatch,
  createReservationDeadlineReader, readEarliestReservationExpiry,
};

