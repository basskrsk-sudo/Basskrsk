'use strict';
const fs=require('node:fs');
const MiB=1024*1024;
// cgroup v2 and v1; subtract only reclaimable inactive file cache, as in
// conventional container working-set metrics. Keep raw usage separately.
function readContainerMemory({readFile=fs.readFileSync,mem=process.memoryUsage(),env=process.env}={}){
  const read=p=>{try{return String(readFile(p,'utf8')).trim();}catch(_){return '';}};
  const bytes=s=>/^\d+$/.test(s)&&Number.isSafeInteger(Number(s))?Number(s):null;
  const cap=s=>{const n=bytes(s);return n>0&&n<1024**4?n:null;};
  let current=bytes(read('/sys/fs/cgroup/memory.current'));
  let limit=cap(read('/sys/fs/cgroup/memory.max'));
  let stats='',source='cgroup_v2';
  if(current!==null)stats=read('/sys/fs/cgroup/memory.stat');
  else{
    source='cgroup_v1';
    current=bytes(read('/sys/fs/cgroup/memory/memory.usage_in_bytes'));
    limit=cap(read('/sys/fs/cgroup/memory/memory.limit_in_bytes'));
    if(current!==null)stats=read('/sys/fs/cgroup/memory/memory.stat');
  }
  const configured=Number(env.CONTAINER_MEMORY_LIMIT_MB)*MiB;
  if(Number.isFinite(configured)&&configured>0)limit=limit?Math.min(limit,configured):configured;
  const key=source==='cgroup_v2'?'inactive_file':'total_inactive_file';
  const match=stats.match(new RegExp('^'+key+' (\\d+)$','m'));
  const inactive=match?Number(match[1]):0;
  const working=current===null?mem.rss:Math.max(0,current-Math.min(current,inactive));
  return {source:current===null?'node_rss':source,limit,raw:current,working,rss:mem.rss,
    heap:mem.heapUsed,external:mem.external,ratio:limit?working/limit:null};
}
function memoryMetrics(m){
  const mb=n=>Number.isFinite(n)?Math.round(n/MiB):null;
  return {source:m.source,limit_mb:mb(m.limit),rss_mb:mb(m.rss),heap_used_mb:mb(m.heap),
    external_mb:mb(m.external),container_used_mb:mb(m.raw),
    container_working_set_mb:m.raw===null?null:mb(m.working),
    usage_percent:m.ratio===null?null:Math.round(m.ratio*100)};
}
module.exports={readContainerMemory,memoryMetrics,MiB};
