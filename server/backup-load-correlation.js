'use strict';

// Read-only comparison of the most recent snapshot window with monitoring
// signals. This detects temporal coincidence, NOT evidence of causation.
// No extra SQL reads, timers or writes: both inputs already exist in /system-health.
const WINDOW_MS=5*60*1000;
const EVENT_TYPES=new Set(['event_loop','storage','database','cpu','memory']);
function timeUtc(raw){
  if(typeof raw!=='string'||!raw.trim())return NaN;
  const value=raw.trim();
  if(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value))
    return Date.parse(value.replace(' ','T')+'Z');
  return Date.parse(value);
}
function correlateBackupWithHealth(backup,events=[],samples=[],{now=new Date().toISOString()}={}){
  const start=timeUtc(backup?.started_at);
  const finish=timeUtc(backup?.finished_at);
  const end=Number.isFinite(finish)?finish:backup?.running?timeUtc(now):NaN;
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)
    return {status:'insufficient_data',reason:'backup_window_unavailable',
      events_count:0,spike_samples:0,coverage_samples:0};
  // One monitoring sample is normally taken every five minutes. Include its
  // neighboring interval to catch spikes immediately after a snapshot.
  const from=start-WINDOW_MS,to=end+WINDOW_MS;
  const inWindow=value=>{
    const stamp=timeUtc(value);
    return Number.isFinite(stamp)&&stamp>=from&&stamp<=to;
  };
  const matchedEvents=(Array.isArray(events)?events:[]).filter(event=>
    EVENT_TYPES.has(event?.event_type)&&
    (event?.severity==='warning'||event?.severity==='critical')&&
    inWindow(event.created_at));
  const nearby=(Array.isArray(samples)?samples:[]).filter(sample=>inWindow(sample?.at));
  const spikes=nearby.filter(sample=>
    Number(sample.event_loop_max_ms)>=1500||
    Number(sample.cpu_percent)>=90||
    Number(sample.sqlite_ms)>=750||
    Number(sample.storage_write_ms)>=1500);
  const maxPause=spikes.length?
    Math.max(...spikes.map(s=>Number(s.event_loop_max_ms)||0)):null;
  return {
    status:matchedEvents.length||spikes.length?'coincident':
      nearby.length?'not_observed':'insufficient_data',
    reason:null,
    window_started_at:new Date(start).toISOString(),
    window_finished_at:new Date(end).toISOString(),
    events_count:matchedEvents.length,spike_samples:spikes.length,
    coverage_samples:nearby.length,
    peak_event_loop_ms:maxPause,
  };
}

 // Compare the latest known backup against the exact stall window rather
 // than treating any failed backup on the same night as a causal match.
function backupStallContext(backup,stall,{now=Date.now(),windowMs=70000}={}){
  if(!backup)return {status:'unknown'};
  if(backup.configured===false)return {status:'disabled'};
  const start=timeUtc(backup.started_at),finish=timeUtc(backup.finished_at);
  const end=Number.isFinite(finish)?finish:backup.running?now:NaN;
  const stallEnd=stall?timeUtc(stall.at):now;
  const span=stall?Number(stall.sample_window_ms||stall.late_by_ms):windowMs;
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||
    !Number.isFinite(stallEnd)||!Number.isFinite(span)||span<=0)
    return {status:'unknown'};
  const phase=['preparing','snapshot','sending','idle'].includes(backup.phase)?backup.phase:'unknown';
  return {status:start<=stallEnd&&end>=stallEnd-span?'overlap':'outside',
    started_at:new Date(start).toISOString(),finished_at:Number.isFinite(finish)?new Date(finish).toISOString():null,
    phase,result:backup.result==='success'||backup.result==='failed'?backup.result:null};
}
function describeBackupStall(backup,stall,options){
  const context=backupStallContext(backup,stall,options);
  if(context.status==='disabled')return 'Бэкап не настроен. ';
  if(context.status==='unknown')return 'Бэкап: время последней попытки неизвестно. ';
  const phase={preparing:'подготовка',snapshot:'снимок SQLite',sending:'отправка',idle:'завершён',unknown:'неизвестно'}[context.phase];
  return 'Бэкап (UTC): '+context.started_at+' — '+(context.finished_at||'выполняется')+
    '; состояние '+phase+(context.result==='failed'?' (ошибка)':context.result==='success'?' (успешно)':'')+
    '. '+(context.status==='overlap'?'Совпадение по времени с '+(stall?'паузой':'окном наблюдения')+'; причина не доказана. ':
      'Последняя известная попытка вне '+(stall?'окна паузы':'окна наблюдения')+'. ');
}
module.exports={correlateBackupWithHealth,timeUtc,WINDOW_MS,backupStallContext,describeBackupStall};
