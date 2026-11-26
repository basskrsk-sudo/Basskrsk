'use strict';
// Instrument the actual main SQLite connection without replacing native
// objects or modifying their prototypes. Fast calls only read a monotonic
// clock; slow calls retain a bounded, RAM-only record. Never retain SQL,
// bound parameters, returned rows, exception messages or absolute paths.
const {performance}=require('node:perf_hooks');
const path=require('node:path');
const SLOW_SQLITE_MS=500;
const MAX_SQLITE_EVENTS=32;
const OPERATIONS=new Set(['sqlite_prepare','sqlite_exec','sqlite_get','sqlite_all',
  'sqlite_run','sqlite_iterate','sqlite_next','sqlite_return','sqlite_open',
  'sqlite_close','sqlite_apply_changeset','sqlite_load_extension']);
function callerLocation(){
  const holder={};Error.captureStackTrace(holder,callerLocation);
  const prefix=__dirname+path.sep;
  for(const frame of String(holder.stack||'').split('\n')){
    const i=frame.lastIndexOf(prefix);
    if(i<0)continue;
    const m=/^([a-zA-Z0-9_-]+\.js):(\d+):\d+\)?$/.exec(frame.slice(i+prefix.length));
    if(m&&m[1]!==path.basename(__filename))return m[1]+':'+m[2];
  }
  return null;
}
function createSqliteDiagnostics({now=()=>performance.now(),wallNow=Date.now,
    getSource=callerLocation,thresholdMs=SLOW_SQLITE_MS,maxEvents=MAX_SQLITE_EVENTS}={}){
  if(!Number.isFinite(thresholdMs)||thresholdMs<0||
    !Number.isInteger(maxEvents)||maxEvents<1||maxEvents>MAX_SQLITE_EVENTS)
    throw new RangeError('Invalid SQLite diagnostic bounds');
  const recent=[],instrumented=new WeakSet();
  function observe(name,fn){
    if(!OPERATIONS.has(name))throw new TypeError('Unknown SQLite operation');
    const started=now();
    try{return fn();}
    finally{
      const elapsed=now()-started;
      if(Number.isFinite(elapsed)&&elapsed>=thresholdMs){
        // Monitoring must never replace an original SQLite return or exception.
        try{
          const at=wallNow(),location=getSource();
          const source=typeof location==='string'&&/^[a-zA-Z0-9_-]{1,100}\.js:\d{1,8}$/.test(location)?location:null;
          recent.push({name,duration_ms:Math.round(elapsed),source,
            started_at:new Date(at-elapsed).toISOString(),at:new Date(at).toISOString()});
          if(recent.length>maxEvents)recent.shift();
        }catch(_){}
      }
    }
  }
  function wrap(target,method,name,after){
    const original=target[method];
    if(typeof original!=='function')return;
    Object.defineProperty(target,method,{configurable:true,writable:true,enumerable:false,
      value:function(...args){
        const result=observe(name,()=>Reflect.apply(original,this,args));
        return after?after(result):result;
      }});
  }
  function instrumentIterator(iterator){
    wrap(iterator,'next','sqlite_next');
    wrap(iterator,'return','sqlite_return');
    return iterator;
  }
  function instrumentStatement(statement){
    wrap(statement,'get','sqlite_get');
    wrap(statement,'all','sqlite_all');
    wrap(statement,'run','sqlite_run');
    wrap(statement,'iterate','sqlite_iterate',instrumentIterator);
    return statement;
  }
  function instrument(database){
    if(instrumented.has(database))return database;
    wrap(database,'prepare','sqlite_prepare',instrumentStatement);
    wrap(database,'exec','sqlite_exec');
    wrap(database,'open','sqlite_open');
    wrap(database,'close','sqlite_close');
    wrap(database,'applyChangeset','sqlite_apply_changeset');
    wrap(database,'loadExtension','sqlite_load_extension');
    instrumented.add(database);
    return database;
  }
  return {observe,instrument,snapshot:()=>recent.slice().reverse().map(row=>({...row}))};
}
// Compare the SQL operation's actual interval with the observed stall
// window. Without an exact stall, use the current histogram's time window.
// Coincidence is diagnostic evidence, not proof of causation.
function selectSqliteOperation(entries,stall,nowMs=Date.now(),windowMs=70000){
  const end=stall?Date.parse(stall.at):nowMs;
  const span=stall?Number(stall.sample_window_ms||stall.late_by_ms):windowMs;
  if(!Number.isFinite(end)||!Number.isFinite(span)||span<=0)return null;
  const start=end-span;
  let best=null,bestOverlap=-1;
  for(const row of entries||[]){
    const a=Date.parse(row.started_at),b=Date.parse(row.at);
    if(!Number.isFinite(a)||!Number.isFinite(b)||b<a||a>end||b<start)continue;
    const overlap=Math.max(0,Math.min(b,end)-Math.max(a,start));
    if(overlap>bestOverlap||(overlap===bestOverlap&&row.duration_ms>best.duration_ms)){
      best=row;bestOverlap=overlap;
    }
  }
  return best;
}
const shared=createSqliteDiagnostics();
module.exports={createSqliteDiagnostics,selectSqliteOperation,
  instrumentSqlite:shared.instrument,observeSqlite:shared.observe,
  snapshotSlowSqlite:shared.snapshot,SLOW_SQLITE_MS,MAX_SQLITE_EVENTS};
