'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hm-healthcheck-'));
process.env.DATA_DIR=dir;
process.env.TOKEN_SECRET='healthcheck-test-token';
const db=require('./db');
const {signToken}=require('./auth');
const {createApiPerformanceTracker}=require('./api-performance');
const {registerSiteHealthRoutes,healthProbe,metrics,recentEvents,startHealthWatcher,stopHealthWatcher,
  appendEvent,nextLoopState,shouldProbeTemporaryStorage,TEMP_PROBE_INTERVAL_MS,
  TEMP_COMPARISON_FRESH_MS,isTemporaryProbeFresh,describeIoSpike,
  shouldWriteHeartbeat,isRestartGap,HEARTBEAT_INTERVAL_MS,RESTART_GAP_THRESHOLD_MS,
  shouldProbePersistentStorage,PERSISTENT_PROBE_INTERVAL_MS,
  flushMonitoringWrites,alertCooldownMs}=require('./site-health');
const routes=new Map(),router={get:(name,handler)=>routes.set(name,handler)};
registerSiteHealthRoutes(router);
async function call(pathname,role,id){
  const handler=routes.get(pathname);
  assert.ok(handler,'Missing route '+pathname);
  const res={
    code:0,headers:{},data:null,
    setHeader(key,value){this.headers[key]=value;},
    writeHead(code,headers){this.code=code;Object.assign(this.headers,headers||{});return this;},
    end(raw){this.data=JSON.parse(raw);}
  };
  await handler({headers:role?{authorization:'Bearer '+signToken({role,id})}:{}},res,
    {params:{},query:{},body:{}});
  return res;
}
test('liveness is lightweight, readiness actually checks SQLite and persistent disk',async()=>{
  const live=await call('/api/live');
  assert.equal(live.code,200);
  assert.deepEqual(live.data,{status:'ok'});
  const ready=await call('/api/health');
  assert.equal(ready.code,200);
  assert.equal(ready.data.status,'ok');
  assert.equal(ready.data.checks.database,'ok');
  assert.equal(ready.data.checks.storage,'ok');
  assert.equal(ready.headers['Cache-Control'],'no-store, no-cache, must-revalidate');
  assert.ok(Number.isFinite(ready.data.probe_ms));
  assert.ok(Number.isFinite(ready.data.probe_sqlite_ms));
  assert.ok(Number.isFinite(ready.data.probe_storage_ms));
  assert.ok(!JSON.stringify(ready.data).includes(dir),'never leak data path');
  assert.equal((await healthProbe(true)).status,'ok');
});
test('readiness becomes HTTP 503 if disk cannot be written, while liveness survives',async()=>{
  const original=fs.promises.open;
  fs.promises.open=async function(file,...rest) {
    if(String(file).includes('.hm-health-')){
      const error=new Error('Read only');
      error.code='EROFS';
      throw error;
    }
    return original.call(this,file,...rest);
  };
  try {
    const failed=await healthProbe(true);
    assert.equal(failed.status,'degraded');
    assert.equal(failed.checks.storage,'error');
    const reply=await call('/api/health');
    assert.equal(reply.code,503);
    assert.equal(reply.data.checks.storage,'error');
    assert.equal((await call('/api/live')).code,200);
    assert.ok(!JSON.stringify(reply.data).includes('EROFS'));
  }finally{
    fs.promises.open=original;
    await healthProbe(true);
  }
});
test('only active admin can inspect process metrics and persistent restart log',async()=>{
  db.prepare('INSERT INTO admins(id,login,password_hash,role,active) VALUES(?,?,?,?,?)')
    .run(5991,'hm-monitor-admin','ignored','admin',1);
  db.prepare('INSERT INTO admins(id,login,password_hash,role,active) VALUES(?,?,?,?,?)')
    .run(5992,'hm-monitor-disabled','ignored','admin',0);
  for(const [role,id]of [[null,null],['manager',5991],['founder',5991],['admin',5992]]){
    const reply=await call('/api/admin/system-health',role,id);
    assert.equal(reply.code,401);
    assert.equal(reply.data.events,undefined);
  }
  startHealthWatcher();
  appendEvent('restart_gap','warning','Обнаружен перерыв наблюдения');
  await flushMonitoringWrites();
  const r=await call('/api/admin/system-health','admin',5991);
  assert.equal(r.code,200);
  assert.ok(['ok','degraded'].includes(r.data.status));
  assert.ok(r.data.memory.rss_mb>0);
  assert.ok(r.data.uptime_seconds>=0);
  assert.ok(r.data.events.some(x=>x.event_type==='startup'));
  assert.ok(r.data.events.some(x=>x.event_type==='restart_gap'));
  assert.equal(r.headers['Cache-Control'],'private, no-store');
  assert.ok(recentEvents().length>=2);
  assert.equal(r.data.events.some(x=>x.path||x.user_id||x.token),false);
  assert.equal(r.data.events.some(x=>String(x.detail).includes(dir)),false);
  assert.ok((await metrics()).timestamp);
  assert.ok(r.data.api_performance);
  assert.ok(Array.isArray(r.data.slow_operations));
  assert.ok(Array.isArray(r.data.recent_slow_sync_operations));
  assert.ok(Array.isArray(r.data.event_loop_stalls));
  assert.ok(r.data.event_loop_stalls.length<=8);
  assert.ok(Array.isArray(r.data.health_history));
  assert.ok(r.data.health_history.length<=288);
  assert.ok(r.data.backup===null||typeof r.data.backup.running==='boolean');
  assert.ok(r.data.cpu_throttle===null || typeof r.data.cpu_throttle.available==='boolean');
  assert.ok(Array.isArray(r.data.api_performance.slow_routes));
  assert.equal(r.data.database_journal_mode,db.JOURNAL_MODE);
  assert.ok(['wal','delete'].includes(r.data.database_journal_mode));
  assert.ok(r.data.io_probe === null || r.data.io_probe.storage_probe_cached ||
    Number.isFinite(r.data.io_probe.storage_write_ms));
});


test('event-loop alerts are based on actual histogram latency and remain quiet on single spikes',()=>{
  let state={slowSamples:0,healthySamples:0,warning:false};
  state=nextLoopState(state,1550,25);
  assert.equal(state.warning,false,'one slow tick must not spam Telegram');
  state=nextLoopState(state,60,22);
  assert.equal(state.warning,false,'clean tick resets transient warning');
  state=nextLoopState(state,1600,35);
  state=nextLoopState(state,1800,27);
  assert.equal(state.warning,true,'repeated pauses should alert');
  state=nextLoopState(state,50,22);
  assert.equal(state.warning,true,'one recovery sample is not sufficient');
  state=nextLoopState(state,50,22);
  assert.equal(state.warning,false,'second clean sample recovers');
  state=nextLoopState(state,5200,100);
  assert.equal(state.warning,true,'extreme pause alerts immediately');
  const state2=nextLoopState({slowSamples:0,healthySamples:0,warning:false},150,800);
  assert.equal(state2.warning,false,'a single high p99 reading should not trigger');
  assert.equal(nextLoopState(state2,155,900).warning,true,'two high p99 readings trigger');
});

test('SQLite health heartbeat writes every five minutes, not every sample',()=>{
  const first=Date.parse('2026-11-19T08:00:00Z');
  assert.equal(HEARTBEAT_INTERVAL_MS,300000);
  assert.equal(RESTART_GAP_THRESHOLD_MS,480000);
  assert.equal(shouldWriteHeartbeat(first,0),true);
  assert.equal(shouldWriteHeartbeat(first+60000,first),false);
  assert.equal(shouldWriteHeartbeat(first+299999,first),false);
  assert.equal(shouldWriteHeartbeat(first+300000,first),true);
  assert.equal(shouldWriteHeartbeat(first,first+300000),true,
    'time corrections permit a new heartbeat');
});
test('restart gap warning accounts for stale heartbeat without hiding long outages',()=>{
  const now=Date.parse('2026-11-19T09:00:00Z');
  assert.equal(isRestartGap(now,new Date(now-3*60000).toISOString()),false);
  assert.equal(isRestartGap(now,new Date(now-8*60000).toISOString()),false);
  assert.equal(isRestartGap(now,new Date(now-8*60000-1000).toISOString()),true);
  assert.equal(isRestartGap(now,'not-a-date'),false);
  assert.equal(isRestartGap(now,new Date(now-35*24*3600000).toISOString()),false);
});
test('optional /tmp write tests back off while healthy and trigger immediately on anomalous I/O',()=>{
  const healthy={checks:{storage:'ok'},probe_storage_ms:12};
  const now=Date.parse('2026-11-19T15:00:00.000Z');
  assert.equal(TEMP_PROBE_INTERVAL_MS,900000);
  assert.equal(shouldProbeTemporaryStorage(now,0,healthy,20,15,0),true);
  assert.equal(shouldProbeTemporaryStorage(now,now-60000,healthy,20,15,0),false);
  assert.equal(shouldProbeTemporaryStorage(now,now-TEMP_PROBE_INTERVAL_MS,healthy,20,15,0),true);
  assert.equal(shouldProbeTemporaryStorage(now,now-60000,
    {checks:{storage:'error'},probe_storage_ms:10},20,15,0),true);
  assert.equal(shouldProbeTemporaryStorage(now,now-60000,
    {checks:{storage:'ok'},probe_storage_ms:2000},20,15,0),true);
  assert.equal(shouldProbeTemporaryStorage(now,now-60000,healthy,1800,15,0),true);
  assert.equal(shouldProbeTemporaryStorage(now,now-60000,healthy,20,850,0),true);
  assert.equal(shouldProbeTemporaryStorage(now,now-60000,healthy,20,15,1700),true);
});
test('file comparisons never infer a zero /tmp delay from missing or stale probes',()=>{
  const t=Date.parse('2026-11-19T12:00:00Z');
  assert.equal(TEMP_COMPARISON_FRESH_MS,120000);
  assert.equal(isTemporaryProbeFresh(t,t-60000),true);
  assert.equal(isTemporaryProbeFresh(t,t-121000),false);
  assert.equal(isTemporaryProbeFresh(t,0),false);
  assert.match(describeIoSpike({storage_write_ms:2600,temp_write_ms:null,temp_status:'stale'}),/Нет свежего измерения/);
  assert.match(describeIoSpike({storage_write_ms:2600,temp_write_ms:null,temp_status:'not_sampled'}),/Нет свежего измерения/);
  assert.equal(shouldProbeTemporaryStorage(t,t-60000,
    {checks:{storage:'ok'},probe_storage_ms:10,probe_sqlite_ms:1600},20,15,0),true);
});
test('diagnostics expose both timer drift and measured event-loop latency',async()=>{
  startHealthWatcher();
  const sample=await metrics();
  assert.ok(Number.isFinite(sample.event_loop_max_ms));
  assert.ok(Number.isFinite(sample.event_loop_p99_ms));
  assert.ok(Number.isFinite(sample.sample_schedule_drift_ms));
  assert.ok(sample.io_probe === null || Number.isFinite(sample.io_probe.sqlite_ms));
  assert.ok(sample.cpu_throttle===null || typeof sample.cpu_throttle.available==='boolean');
  assert.equal(sample.event_loop_delay_ms,sample.event_loop_max_ms,'legacy field tracks actual maximum');
});

test('API diagnostics use bounded samples and registered route templates',()=>{
  const tracker=createApiPerformanceTracker({maxRoutes:2,samplesPerRoute:3});
  tracker.record('GET /api/products',10,200);
  tracker.record('GET /api/products',20,200);
  tracker.record('GET /api/products',50,500);
  tracker.record('GET /api/products',30,200);
  tracker.record('POST /api/orders/:id',15,200);
  tracker.record('GET /api/*',70,404);
  const result=tracker.snapshot();
  assert.equal(result.total_requests,6);
  assert.equal(result.sample_window_per_route,3);
  assert.ok(result.tracked_routes<=3,'overflow must not grow without bound');
  const products=result.slow_routes.find(row=>row.route==='GET /api/products');
  assert.equal(products.requests,4);
  assert.equal(products.server_errors,1);
  assert.equal(products.samples,3);
  assert.equal(products.p95_ms,50);
  assert.equal(products.avg_ms,33);
  assert.equal(result.slow_routes.some(row=>row.route.includes('some-private-id')),false);
});


test('two separate async file probes distinguish /data from /tmp slowdown',()=>{
  assert.match(describeIoSpike({storage_write_ms:12500,temp_write_ms:40,temp_status:'ok'}),/\/data/);
  assert.match(describeIoSpike({storage_write_ms:5000,temp_write_ms:6000,temp_status:'ok'}),/Обе файловые пробы/);
  assert.match(describeIoSpike({storage_write_ms:15,temp_write_ms:20,temp_status:'ok'}),/Файловые пробы быстрые/);
  assert.match(describeIoSpike({storage_write_ms:15,temp_write_ms:6000,temp_status:'ok'}),/\/tmp/);
  assert.match(describeIoSpike({storage_write_ms:6000,temp_write_ms:100,temp_status:'error'}),/не прошло проверку/);
});

test('monitoring compares /data and /tmp without exposing private filesystem paths',async()=>{
  startHealthWatcher();
  const m=await metrics();
  assert.ok(m.io_probe===null || Number.isFinite(m.io_probe.sqlite_ms));
  if(m.io_probe!==null){
    assert.ok(m.io_probe.storage_probe_cached ||
      Number.isFinite(m.io_probe.storage_write_ms));
    assert.ok(Number.isFinite(m.io_probe.temp_write_ms));
    assert.ok(['ok','error'].includes(m.io_probe.temp_status));
  }
  const raw=JSON.stringify(m);
  assert.ok(!raw.includes(dir),'full data directory must never be returned to clients');
  stopHealthWatcher();
});

test('persistent storage write probes back off for five minutes but detect failure on force',async()=>{
  const now=Date.now();
  assert.equal(shouldProbePersistentStorage(now,0,'ok'),true);
  assert.equal(shouldProbePersistentStorage(now,now-60000,'ok'),false);
  assert.equal(shouldProbePersistentStorage(now,now-PERSISTENT_PROBE_INTERVAL_MS,'ok'),true);
  assert.equal(shouldProbePersistentStorage(now,now-60000,'error'),true);
  const original=fs.promises.open;
  let probes=0;
  fs.promises.open=async function(file,...args){
    if(String(file).startsWith(dir+path.sep) && String(file).includes('.hm-health-'))probes++;
    return original.call(this,file,...args);
  };
  try {
    const first=await healthProbe(true);
    const second=await healthProbe(true,{reuseStorage:true});
    assert.equal(first.checks.storage,'ok');
    assert.equal(second.storage_probe_cached,true);
    assert.equal(second.probe_storage_ms,null,'cached timing must not appear as a new measurement');
    assert.equal(probes,1,'one /data write check for short interval');
    const forced=await healthProbe(true);
    assert.equal(forced.storage_probe_cached,false);
    assert.equal(probes,2,'explicit forced health probe always checks disk');
  } finally {
    fs.promises.open=original;
  }
});

test('monitoring writes are delegated to a coalesced worker, not synchronous payment-thread SQL',async()=>{
  const {EventEmitter}=require('node:events');
  const {createHealthWriteQueue,MAX_PENDING_EVENTS}=require('./health-write-queue');
  let workers=0,latestBatch=null;
  class FakeWorker extends EventEmitter {
    constructor(_path,opts){
      super();
      workers++;
      latestBatch=opts.workerData;
      setImmediate(()=>this.emit('message',{ok:true}));
    }
    unref(){}
    terminate(){return Promise.resolve(0);}
  }
  const queue=createHealthWriteQueue({source:db.DB_PATH,WorkerClass:FakeWorker,debounceMs:1000});
  for(let i=0;i<MAX_PENDING_EVENTS+7;i++)
    queue.appendEvent('event_loop','warning','slow '+i);
  queue.updateHeartbeat(new Date().toISOString(),'test-boot');
  queue.pruneOldEvents();
  assert.equal(workers,0,'enqueue must never synchronously access a SQLite worker');
  await queue.flush();
  assert.equal(workers,1,'heartbeat, pruning and events must share one diagnostic transaction');
  assert.equal(latestBatch.events.length,MAX_PENDING_EVENTS,'queue must remain bounded during outage');
  assert.equal(latestBatch.events[0].detail,'slow 7');
  assert.equal(latestBatch.heartbeat.bootId,'test-boot');
  assert.equal(latestBatch.prune,true);
  assert.equal(alertCooldownMs('event_loop'),60*60000,'repeated stalls are grouped hourly');
  assert.equal(alertCooldownMs('database'),20*60000,'critical faults retain urgent warnings');
});
test('monitoring event and heartbeat actually persist via worker',async()=>{
  appendEvent('event_loop','warning','health-worker-persist-test');
  await flushMonitoringWrites();
  const rows=db.prepare("SELECT event_type,detail FROM site_health_events WHERE detail=?").all('health-worker-persist-test');
  assert.equal(rows.length,1);
  assert.equal(rows[0].event_type,'event_loop');
});
