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
const {registerSiteHealthRoutes,healthProbe,metrics,recentEvents,startHealthWatcher,appendEvent,nextLoopState}=require('./site-health');
const routes=new Map(),router={get:(name,handler)=>routes.set(name,handler)};
registerSiteHealthRoutes(router);
function call(pathname,role,id){
  const handler=routes.get(pathname);
  assert.ok(handler,'Missing route '+pathname);
  const res={
    code:0,headers:{},data:null,
    setHeader(key,value){this.headers[key]=value;},
    writeHead(code,headers){this.code=code;Object.assign(this.headers,headers||{});return this;},
    end(raw){this.data=JSON.parse(raw);}
  };
  handler({headers:role?{authorization:'Bearer '+signToken({role,id})}:{}},res,
    {params:{},query:{},body:{}});
  return res;
}
test('liveness is lightweight, readiness actually checks SQLite and persistent disk',()=>{
  const live=call('/api/live');
  assert.equal(live.code,200);
  assert.deepEqual(live.data,{status:'ok'});
  const ready=call('/api/health');
  assert.equal(ready.code,200);
  assert.equal(ready.data.status,'ok');
  assert.equal(ready.data.checks.database,'ok');
  assert.equal(ready.data.checks.storage,'ok');
  assert.equal(ready.headers['Cache-Control'],'no-store, no-cache, must-revalidate');
  assert.ok(Number.isFinite(ready.data.probe_ms));
  assert.ok(!JSON.stringify(ready.data).includes(dir),'never leak data path');
  assert.equal(healthProbe(true).status,'ok');
});
test('readiness becomes HTTP 503 if disk cannot be written, while liveness survives',()=>{
  const original=fs.writeFileSync;
  fs.writeFileSync=function(file,...rest) {
    if(String(file).includes('.hm-health-')){
      const error=new Error('Read only');
      error.code='EROFS';
      throw error;
    }
    return original.call(this,file,...rest);
  };
  try {
    const failed=healthProbe(true);
    assert.equal(failed.status,'degraded');
    assert.equal(failed.checks.storage,'error');
    const reply=call('/api/health');
    assert.equal(reply.code,503);
    assert.equal(reply.data.checks.storage,'error');
    assert.equal(call('/api/live').code,200);
    assert.ok(!JSON.stringify(reply.data).includes('EROFS'));
  }finally{
    fs.writeFileSync=original;
    healthProbe(true);
  }
});
test('only active admin can inspect process metrics and persistent restart log',()=>{
  db.prepare('INSERT INTO admins(id,login,password_hash,role,active) VALUES(?,?,?,?,?)')
    .run(5991,'hm-monitor-admin','ignored','admin',1);
  db.prepare('INSERT INTO admins(id,login,password_hash,role,active) VALUES(?,?,?,?,?)')
    .run(5992,'hm-monitor-disabled','ignored','admin',0);
  for(const [role,id]of [[null,null],['manager',5991],['founder',5991],['admin',5992]]){
    const reply=call('/api/admin/system-health',role,id);
    assert.equal(reply.code,401);
    assert.equal(reply.data.events,undefined);
  }
  startHealthWatcher();
  appendEvent('restart_gap','warning','Обнаружен перерыв наблюдения');
  const r=call('/api/admin/system-health','admin',5991);
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
  assert.ok(metrics().timestamp);
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

test('diagnostics expose both timer drift and measured event-loop latency',()=>{
  startHealthWatcher();
  const sample=metrics();
  assert.ok(Number.isFinite(sample.event_loop_max_ms));
  assert.ok(Number.isFinite(sample.event_loop_p99_ms));
  assert.ok(Number.isFinite(sample.sample_schedule_drift_ms));
  assert.equal(sample.event_loop_delay_ms,sample.event_loop_max_ms,'legacy field tracks actual maximum');
});
