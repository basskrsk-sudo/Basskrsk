'use strict';

// Do not stack recurring background checks when Telegram/API responses are
// slow. One in-flight check owns the work; the next timer tick is skipped.
// Errors are contained so they do not produce unhandled Promise rejections.
function createSingleFlightJob(job, onError = () => {}) {
  if (typeof job !== 'function') throw new TypeError('job must be a function');
  let active=false;
  return async (...args) => {
    if (active) return {skipped:true,reason:'still_running'};
    active=true;
    try {
      return await job(...args);
    } catch(error) {
      try { onError(error); } catch (_) {}
      return {ok:false,error:String(error?.message||'unknown')};
    } finally {
      active=false;
    }
  };
}

module.exports={createSingleFlightJob};
