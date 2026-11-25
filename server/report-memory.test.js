'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {readContainerMemory,memoryMetrics,MiB}=require('./container-memory');
const {createPdfResourceGate}=require('./pdf-resource-gate');
const mem={rss:50*MiB,heapUsed:20*MiB,external:5*MiB};
function sample(values,env={}){
 return readContainerMemory({mem,env,readFile:p=>{if(!(p in values))throw Error('missing');return String(values[p]);}});
}
test('cgroup working set includes subprocesses, excludes inactive file cache, keeps RSS and raw separately',()=>{
 const m=sample({'/sys/fs/cgroup/memory.current':200*MiB,'/sys/fs/cgroup/memory.max':256*MiB,
 '/sys/fs/cgroup/memory.stat':'anon 150\ninactive_file '+20*MiB});
 assert.equal(m.working,180*MiB);assert.equal(m.rss,50*MiB);
 assert.deepEqual(memoryMetrics(m),{source:'cgroup_v2',limit_mb:256,rss_mb:50,heap_used_mb:20,
 external_mb:5,container_used_mb:200,container_working_set_mb:180,usage_percent:70});
});
test('cgroup v1 and configured fallback are labelled, unknown limit stays unknown',()=>{
 const m=sample({'/sys/fs/cgroup/memory/memory.usage_in_bytes':200*MiB,
 '/sys/fs/cgroup/memory/memory.limit_in_bytes':256*MiB,
 '/sys/fs/cgroup/memory/memory.stat':'total_inactive_file '+25*MiB});
 assert.equal(m.source,'cgroup_v1');assert.equal(m.working,175*MiB);
 const fallback=sample({}, {CONTAINER_MEMORY_LIMIT_MB:'100'});
 assert.equal(fallback.source,'node_rss');assert.equal(fallback.ratio,.5);
 assert.equal(sample({}).ratio,null);
});
test('single gate refuses overlapping PDFs, low headroom, and mid-render pressure; releases after failure',()=>{
 const logs=[];let used=100;
 const readMemory=()=>sample({'/sys/fs/cgroup/memory.current':used*MiB,'/sys/fs/cgroup/memory.max':256*MiB});
 const gate=createPdfResourceGate({readMemory,log:s=>logs.push(s)});
 let first=gate.acquire('personal');
 assert.throws(()=>gate.acquire('weekly'),{statusCode:503,publicMessage:true});
 used=240;assert.throws(()=>first.checkpoint(),{statusCode:503});
 first.release();first.release();assert.equal(logs.length,1);
 assert.throws(()=>gate.acquire('payout'),{statusCode:503});
 used=100;const second=gate.acquire('weekly');second.release();
 assert.equal(logs.length,2);assert.match(logs[0],/sampled_peak_mb":240/);
});
test('all main PDF renderers share the slot; payout uses streaming assembly and one ImageMagick thread',()=>{
 const fs=require('node:fs'),path=require('node:path');
 for(const name of ['payout-brief-pdf.js','payout-report-pdf.js','task-daily-digest-pdf.js','weekly-report-pdf-runner.js']){
  const source=fs.readFileSync(path.join(__dirname,name),'utf8');
  assert.match(source,/acquirePdfSlot/);
  if(!name.includes('runner')){
   assert.match(source,/writePdfFromJpegsAsync/);
   assert.match(source,/'-limit','thread','1'/);
   assert.doesNotMatch(source,/require\('\.\/weekly-report'\)/);
  }
 }
});

test('active-only sampling captures memory between page checkpoints',async()=>{
 const logs=[];let used=100;
 const readMemory=()=>sample({'/sys/fs/cgroup/memory.current':used*MiB,'/sys/fs/cgroup/memory.max':256*MiB});
 const gate=createPdfResourceGate({readMemory,log:s=>logs.push(s),sampleIntervalMs:5});
 const slot=gate.acquire('personal');
 try{used=180;await new Promise(resolve=>setTimeout(resolve,25));used=100;}
 finally{slot.release();}
 assert.match(logs[0],/sampled_peak_mb":180/);
});
