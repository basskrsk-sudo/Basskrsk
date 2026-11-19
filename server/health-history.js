'use strict';
// Bounded RAM-only trend for site-health. No disk writes, network requests,
// periodic timers, customer data or full SQL logs.
function createHealthHistory({maxSamples=288,minSpacingMs=300000}={}){
  if(!Number.isInteger(maxSamples)||maxSamples<1||
    !Number.isFinite(minSpacingMs)||minSpacingMs<0)
    throw new RangeError('Invalid health history bounds');
  const samples=[];
  let lastAt=null;
  function record(values,nowMs=Date.now(),urgent=false){
    if(!Number.isFinite(nowMs))return false;
    if(lastAt!==null&&!urgent&&nowMs-lastAt<minSpacingMs)return false;
    // Only known fixed-metric keys are passed by the health sampler.
    const row={...values,at:new Date(nowMs).toISOString()};
    samples.push(row);
    if(samples.length>maxSamples)samples.shift();
    lastAt=nowMs;
    return true;
  }
  function snapshot(limit=maxSamples){
    const count=Math.max(0,Math.min(maxSamples,Math.floor(Number(limit)||0)));
    return samples.slice(-count).map(row=>({...row}));
  }
  return {record,snapshot,get size(){return samples.length;}};
}
module.exports={createHealthHistory};
