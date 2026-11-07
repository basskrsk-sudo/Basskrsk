'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createSingleFlightJob}=require('./single-flight-job');

test('recurring background work cannot overlap and starts again after completion',async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  let starts=0;
  const run=createSingleFlightJob(async()=>{
    starts++;
    if(starts===1)await gate;
    return {ok:true};
  });
  const first=run();
  const second=await run();
  assert.deepEqual(second,{skipped:true,reason:'still_running'});
  assert.equal(starts,1);
  release();
  assert.deepEqual(await first,{ok:true});
  assert.deepEqual(await run(),{ok:true});
  assert.equal(starts,2);
});

test('failed scheduler tick is contained and does not prevent later work',async()=>{
  const errors=[];
  let attempt=0;
  const run=createSingleFlightJob(async()=>{
    attempt++;
    if(attempt===1)throw Error('upstream timeout');
    return {ok:true};
  },error=>errors.push(error.message));
  const first=await run();
  assert.deepEqual(first,{ok:false,error:'upstream timeout'});
  assert.deepEqual(errors,['upstream timeout']);
  assert.deepEqual(await run(),{ok:true});
});

test('single-flight validates its callback',()=>{
  assert.throws(()=>createSingleFlightJob(null),/job must be a function/);
});
