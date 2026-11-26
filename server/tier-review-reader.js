'use strict';
// The once-daily candidate scan is read-only and never uses the main
// DatabaseSync connection. The actual rate/approval is always rechecked
// against fresh data on the main connection before any business write.
const {Worker,isMainThread,parentPort,workerData}=require('node:worker_threads');
function queryTierReviewCandidates(database,baseline,referralThreshold){
  return database.prepare(
    "SELECT id FROM partners WHERE active=1 AND partner_type='groomer' "+
    "AND (commission_rate<>? OR commission_rate IS NULL) "+
    "UNION SELECT p.id FROM partners p JOIN partners invited ON invited.referred_by_partner_id=p.id "+
    "WHERE p.active=1 AND p.partner_type='groomer' AND p.commission_rate=? "+
    "GROUP BY p.id HAVING COUNT(invited.id)>=? ORDER BY id"
  ).all(baseline,baseline,referralThreshold);
}
if(!isMainThread&&workerData?.kind==='tier-review-candidates'){
  let database;
  let result;
  try{
    const {DatabaseSync}=require('node:sqlite');
    database=new DatabaseSync(workerData.source,{readOnly:true});
    result={ok:true,rows:queryTierReviewCandidates(database,workerData.baseline,workerData.referralThreshold)};
  }catch(error){result={ok:false,code:error.code||'READ_FAILED'};}
  finally{try{database?.close();}catch(_){result={ok:false,code:'CLOSE_FAILED'};}}
  parentPort.postMessage(result);
}
function readTierReviewCandidates(source,baseline,referralThreshold,{WorkerClass=Worker,timeoutMs=120000}={}){
  if(typeof source!=='string'||!source||!Number.isFinite(baseline)||
    !Number.isSafeInteger(referralThreshold)||referralThreshold<1)
    return Promise.reject(new TypeError('Invalid tier review input'));
  return new Promise((resolve,reject)=>{
    let worker;
    try{worker=new WorkerClass(__filename,{workerData:{kind:'tier-review-candidates',source,baseline,referralThreshold},
      resourceLimits:{maxOldGenerationSizeMb:32}});}
    catch(error){reject(error);return;}
    let settled=false,result=null,failure=null,timedOut=false;
    function finish(error,rows){
      if(settled)return;settled=true;clearTimeout(timer);
      if(error)reject(error);else resolve(rows);
    }
    const timer=setTimeout(()=>{
      timedOut=true;
      // Keep the single-flight slot until native SQLite I/O has stopped.
      Promise.resolve(worker.terminate()).then(
        ()=>finish(new Error('Tier review reader timed out')),
        ()=>finish(new Error('Tier review reader termination failed')));
    },timeoutMs);
    worker.once('message',message=>{result=message;});
    worker.once('error',error=>{failure=error;});
    worker.once('exit',code=>{
      if(timedOut)return finish(new Error('Tier review reader timed out'));
      if(failure)return finish(failure);
      if(code!==0||result?.ok!==true||!Array.isArray(result.rows)||
        result.rows.some(row=>!Number.isSafeInteger(row.id)||row.id<=0))
        return finish(new Error('Tier review reader failed'));
      finish(null,result.rows);
    });
  });
}
module.exports={queryTierReviewCandidates,readTierReviewCandidates};
