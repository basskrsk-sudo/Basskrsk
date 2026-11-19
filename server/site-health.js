'use strict';

// Lightweight, privacy-safe health/readiness and in-process diagnostics.
// Public endpoints expose only "ok"/"error"; internal metrics require an
// active admin account. Independent outage detection lives in GitHub Actions.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireActiveAdmin } = require('./routes-auth');
const { sendTelegram } = require('./telegram');
const { snapshotApiPerformance } = require('./api-performance');
const { sampleCpuThrottling, snapshotOperations, snapshotSlowSyncOperations } = require('./runtime-diagnostics');
const { eventLoopStallProfiler } = require('./event-loop-stall-profiler');
const { createHealthHistory } = require('./health-history');
// Backup module is loaded lazily to avoid initializing its scheduler during
// lightweight public readiness checks. Sampling never reads its SQLite state.
function backupStatus(includeSchedule=false){
  try{return require('./backup').getBackupRuntimeStatus(includeSchedule);}
  catch(_){return null;}
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const BOOTED_AT = Date.now();
const HEALTH_CACHE_MS = 10000;
const SAMPLE_INTERVAL_MS = 60000;
// The heartbeat is for restart-gap diagnostics, NOT liveness/readiness.
// The independent uptime monitor checks the public site every five minutes.
// Coalesce 5 one-minute samples into one SQLite write while the server is idle.
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const RESTART_GAP_THRESHOLD_MS = HEARTBEAT_INTERVAL_MS + 3 * 60 * 1000;
// SQLite is probed every minute; an idle healthy /data needs a real write
// probe only once in five minutes. Errors and forced checks bypass the cache.
const PERSISTENT_PROBE_INTERVAL_MS = 5 * 60 * 1000;
const TEMP_PROBE_INTERVAL_MS = 15 * 60 * 1000;
const TEMP_COMPARISON_FRESH_MS = 2 * 60 * 1000;
// No new timers or persistent metric writes: a bounded 5-minute snapshot is
// added to the existing one-minute health sample, with an extra row on spikes.
const healthHistory=createHealthHistory({maxSamples:288,minSpacingMs:5*60*1000});
const ALERT_COOLDOWN_MS = 20 * 60 * 1000;
const MAX_RECENT_EVENTS = 35;
const WARNING_RSS_RATIO = 0.85;
const WARNING_DISK_BYTES = 100 * 1024 * 1024;
let currentHealth = null;
let lastHealthAt = 0;
let healthInFlight = null;
let lastPersistentStorageProbe = null;
let lastPersistentStorageProbeAt = 0;
let sampleInFlight = false;
let healthFileCounter = 0;
let lastSample = null;
let previousSampleAt = BOOTED_AT;
let previousCpuUsage = process.cpuUsage();
let lastTemporaryStorageProbe = null;
let lastTemporaryStorageProbeAt = 0;
let highCpuSamples = 0;
// Long pauses (>750ms p99, >1500ms max) are still measured accurately with
// a 100ms sampling resolution instead of a continuous 20ms timer.
const loopHistogram = monitorEventLoopDelay({resolution:100});
let loopState={slowSamples:0,healthySamples:0,warning:false};
let watcher = null;
let lastPruneDay = '';
let lastHeartbeatAt = 0;
const lastAlerts = new Map();
const states = new Map();

db.exec("CREATE TABLE IF NOT EXISTS site_health_events (" +
  "id INTEGER PRIMARY KEY AUTOINCREMENT," +
  "event_type TEXT NOT NULL CHECK(event_type IN (" +
    "'startup','restart_gap','recovered','database','storage','memory','disk','cpu','event_loop'))," +
  "severity TEXT NOT NULL CHECK(severity IN ('info','warning','critical'))," +
  "detail TEXT NOT NULL," +
  "created_at TEXT NOT NULL DEFAULT (datetime('now')))");
db.exec("CREATE INDEX IF NOT EXISTS idx_site_health_events_created ON site_health_events(created_at)");
db.exec("CREATE TABLE IF NOT EXISTS site_health_heartbeat (" +
  "id INTEGER PRIMARY KEY CHECK(id=1)," +
  "last_seen_at TEXT NOT NULL,boot_id TEXT NOT NULL)");

const bootId = String(BOOTED_AT) + '-' + process.pid;
function limitMemory() {
  const defined = Number(process.env.CONTAINER_MEMORY_LIMIT_MB || 0);
  if (Number.isFinite(defined) && defined > 0) return Math.round(defined * 1024 * 1024);
  try {
    const raw = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    if (raw !== 'max') {
      const n = Number(raw);
      if (Number.isSafeInteger(n) && n > 0 && n < 1024 * 1024 * 1024 * 1024) return n;
    }
  } catch (_) {}
  return null;
}
async function storageFreeBytes() {
  try {
    if (typeof fs.promises.statfs !== 'function') return null;
    const stat = await fs.promises.statfs(DATA_DIR);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch (_) { return null; }
}
function appendEvent(type, severity, detail) {
  // All keys/details are server-created, bounded strings. No HTTP input is saved.
  if (!['startup','restart_gap','recovered','database','storage','memory','disk','event_loop'].includes(type)) return;
  if (!['info','warning','critical'].includes(severity)) return;
  try {
    db.prepare('INSERT INTO site_health_events(event_type,severity,detail) VALUES(?,?,?)')
      .run(type,severity,String(detail).slice(0,160));
  } catch (e) { console.warn('[health] event persist failed:', e.code || 'unknown'); }
}
// Persistent-storage readiness is intentionally asynchronous: a slow /data
// mount must never freeze HTTP requests, Telegram polling or payments.
async function checkStorageWritable(directory = DATA_DIR) {
  const started = performance.now();
  let storage = 'ok', handle = null;
  const probeDir = path.resolve(directory);
  const name = path.join(probeDir, '.hm-health-' + process.pid + '-' +
    Date.now() + '-' + (++healthFileCounter));
  try {
    await fs.promises.mkdir(probeDir, { recursive: true });
    handle = await fs.promises.open(name, 'wx', 0o600);
    await handle.writeFile('1');
  } catch (_) { storage = 'error'; }
  finally {
    if (handle) {
      try { await handle.close(); }
      catch (_) { storage = 'error'; }
    }
    try { await fs.promises.unlink(name); }
    catch (error) { if (error.code !== 'ENOENT') storage = 'error'; }
  }
  return { storage, durationMs: Math.round(performance.now() - started) };
}
function shouldProbePersistentStorage(nowMs,lastAt,lastStatus) {
  return !lastAt || nowMs < lastAt ||
    nowMs - lastAt >= PERSISTENT_PROBE_INTERVAL_MS || lastStatus !== 'ok';
}
async function healthProbe(force = false, {reuseStorage = !force} = {}) {
  const now = Date.now();
  if (!force && currentHealth && now - lastHealthAt < HEALTH_CACHE_MS) return currentHealth;
  if (healthInFlight) return healthInFlight;
  healthInFlight = (async () => {
    const started = performance.now();
    const sqliteStart = performance.now();
    let database = 'ok';
    try { db.prepare('SELECT 1 AS ok').get(); }
    catch (_) { database = 'error'; }
    const sqliteMs = Math.round(performance.now() - sqliteStart);
    const cached = reuseStorage && !shouldProbePersistentStorage(
      Date.now(),lastPersistentStorageProbeAt,lastPersistentStorageProbe?.storage) &&
      database === 'ok' && lastPersistentStorageProbe.durationMs < 1500;
    const disk = cached ? lastPersistentStorageProbe : await checkStorageWritable();
    if (!cached) {
      lastPersistentStorageProbe = disk;
      lastPersistentStorageProbeAt = Date.now();
    }
    const result = {
      status: database === 'ok' && disk.storage === 'ok' ? 'ok' : 'degraded',
      checks: { database, storage: disk.storage },
      probe_ms: Math.round(performance.now() - started),
      probe_sqlite_ms: sqliteMs,
      // Cached timing is unknown: never represent a stale measurement as 0.
      probe_storage_ms: cached ? null : disk.durationMs,
      storage_probe_cached: cached,
      storage_probe_age_ms: Math.max(0,Date.now() - lastPersistentStorageProbeAt),
    };
    currentHealth = result;
    lastHealthAt = Date.now();
    return result;
  })();
  try { return await healthInFlight; }
  finally { healthInFlight = null; }
}

function recentEvents(limit = MAX_RECENT_EVENTS) {
  return db.prepare(
    'SELECT event_type,severity,detail,created_at FROM site_health_events ' +
    'ORDER BY id DESC LIMIT ?'
  ).all(Math.min(100,Math.max(1,Number(limit)||MAX_RECENT_EVENTS)));
}
async function metrics() {
  const mem = process.memoryUsage();
  const [health, free] = await Promise.all([healthProbe(), storageFreeBytes()]);
  const limit = limitMemory();
  return {
    ...health,
    timestamp:new Date().toISOString(),
    uptime_seconds:Math.floor((Date.now()-BOOTED_AT)/1000),
    memory:{rss_mb:Math.round(mem.rss/1048576),heap_used_mb:Math.round(mem.heapUsed/1048576),
      limit_mb:limit?Math.round(limit/1048576):null},
    storage_free_mb:Number.isFinite(free)?Math.round(free/1048576):null,
    event_loop_delay_ms:lastSample ? lastSample.event_loop_delay_ms : null,
    event_loop_p99_ms:lastSample ? lastSample.event_loop_p99_ms : null,
    event_loop_max_ms:lastSample ? lastSample.event_loop_max_ms : null,
    sample_schedule_drift_ms:lastSample ? lastSample.sample_schedule_drift_ms : null,
    cpu_percent:lastSample ? lastSample.cpu_percent : null,
    sampled_at:lastSample ? lastSample.time : null,
    io_probe:lastSample ? lastSample.io_probe : null,
    health_history:healthHistory.snapshot(),
    backup:backupStatus(true),
    api_performance:snapshotApiPerformance(),
    cpu_throttle:lastSample ? lastSample.cpu_throttle : null,
    slow_operations:snapshotOperations(),
    recent_slow_sync_operations:snapshotSlowSyncOperations(),
    event_loop_stalls:eventLoopStallProfiler.snapshot(),
  };
}
async function alert(type, severity, detail) {
  const now = Date.now();
  if (now - (lastAlerts.get(type) || 0) < ALERT_COOLDOWN_MS) return;
  lastAlerts.set(type,now);
  const label = severity==='critical'?'🔴':'🟡';
  // Does not work while the whole server is down. GitHub Actions is the
  // independent source of Telegram downtime/recovery alerts.
  try {
    await sendTelegram(label + ' <b>ХвостМаркет · Состояние системы</b>\n' +
      detail + '\nМониторинг внутри Amvera; полные отключения проверяет GitHub.');
  } catch (_) {}
}
function transition(type, bad, severity, detail) {
  const previous = states.get(type);
  if (bad && previous !== true) {
    appendEvent(type,severity,detail);
    void alert(type,severity,detail);
  }
  if (!bad && previous === true) appendEvent('recovered','info','Восстановлено: ' + type);
  states.set(type,!!bad);
}
// The scheduler timer's drift is not the same as Node's event-loop latency.
// Two consecutive abnormal minute-long samples avoid noise from isolated
// scheduler slippage, while an extreme >=5s pause is reported immediately.
// Two clean samples are required before declaring a recovery.
function describeIoSpike(probe) {
  if (!probe) return 'Источник задержки ввода-вывода не установлен.';
  if (probe.storage_write_ms == null)
    return 'Нет свежей пробы записи в /data; используется предыдущий результат.';
  const data = Number(probe.storage_write_ms);
  // Missing or stale readings must NEVER become a fabricated 0ms /tmp probe.
  if(probe.temp_status==='stale' || probe.temp_status==='not_sampled' ||
      probe.temp_write_ms==null)
    return 'Нет свежего измерения /tmp; сравнение со временем /data сейчас недоступно.';
  const tmp = Number(probe.temp_write_ms);
  if (!Number.isFinite(data) || !Number.isFinite(tmp))
    return 'Недостаточно данных для сравнения /data и /tmp.';
  if (probe.temp_status !== 'ok')
    return 'Временное хранилище /tmp также не прошло проверку записи.';
  if (data >= 1500 && data >= Math.max(1200, tmp * 3))
    return 'Проба /data существенно медленнее /tmp: проверьте постоянное хранилище и синхронные операции SQLite.';
  if (data >= 1500 && tmp >= 1500)
    return 'Обе файловые пробы медленные: возможны пауза event loop или общая задержка файловых операций.';
  if (tmp >= 1500)
    return 'Медленная проба /tmp: проверьте общие задержки Node.js и дисковой подсистемы.';
  return 'Файловые пробы быстрые; ищите синхронный код и длительные SQL-запросы.';
}

function isTemporaryProbeFresh(nowMs,lastAt){
  return !!lastAt && nowMs>=lastAt && nowMs-lastAt<=TEMP_COMPARISON_FRESH_MS;
}
function shouldProbeTemporaryStorage(nowMs,lastAt,health,maxLoopDelayMs,p99LoopDelayMs,driftMs) {
  return !lastAt || nowMs-lastAt>=TEMP_PROBE_INTERVAL_MS ||
    health?.checks?.storage !== 'ok' ||
    Number(health?.probe_storage_ms)>=1500 ||
    Number(health?.probe_sqlite_ms)>=1500 ||
    maxLoopDelayMs>1500 || p99LoopDelayMs>750 || driftMs>1500;
}
function nextLoopState(previous,maxMs,p99Ms) {
  const abnormal=maxMs>1500 || p99Ms>750;
  const slowSamples=abnormal?previous.slowSamples+1:0;
  const healthySamples=abnormal?0:previous.healthySamples+1;
  const warning=maxMs>=5000 ||
    (previous.warning ? healthySamples<2 : slowSamples>=2);
  return {slowSamples,healthySamples,warning};
}

// The histogram is read before any asynchronous storage checks. Samples never
// overlap: a stalled mount cannot queue up minute-by-minute probe work.
async function sample() {
  if (sampleInFlight) return;
  sampleInFlight = true;
  try {
    const now = Date.now();
    const elapsedMs = Math.max(1, now - previousSampleAt);
    const delay = Math.max(0, elapsedMs - SAMPLE_INTERVAL_MS);
    previousSampleAt = now;
    const cpuNow = process.cpuUsage();
    const elapsedCpu = (cpuNow.user - previousCpuUsage.user) +
      (cpuNow.system - previousCpuUsage.system);
    previousCpuUsage = cpuNow;
    const cpuPercent = Math.min(10000, Math.round(elapsedCpu / elapsedMs / 10));
    highCpuSamples = cpuPercent >= 90 ? highCpuSamples + 1 : 0;
    const maxLoopDelayMs = Math.round(loopHistogram.max / 1e6);
    const p99LoopDelayMs = Math.round(loopHistogram.percentile(99) / 1e6);
    loopHistogram.reset();
    loopState = nextLoopState(loopState, maxLoopDelayMs, p99LoopDelayMs);
    const memory = process.memoryUsage();
    const rssMb = Math.round(memory.rss / 1048576);
    lastSample = {time:new Date(now).toISOString(),
      event_loop_delay_ms:maxLoopDelayMs,event_loop_max_ms:maxLoopDelayMs,
      event_loop_p99_ms:p99LoopDelayMs,sample_schedule_drift_ms:Math.round(delay),
      cpu_percent:cpuPercent,cpu_throttle:null,io_probe:null};

    // Keep SQLite, persistent /data and CPU diagnostics every minute.
    // Sample /tmp only every 15 minutes when healthy, but immediately after
    // a delayed timer, stalled event-loop or slow/failing persistent disk.
    const [health, cpuThrottle] = await Promise.all([
      healthProbe(true, {reuseStorage: maxLoopDelayMs < 1500 &&
        p99LoopDelayMs < 750 && delay < 1500}), sampleCpuThrottling(),
    ]);
    let temporary=lastTemporaryStorageProbe;
    if(shouldProbeTemporaryStorage(Date.now(),lastTemporaryStorageProbeAt,
        health,maxLoopDelayMs,p99LoopDelayMs,delay)) {
      temporary=await checkStorageWritable(os.tmpdir());
      lastTemporaryStorageProbe=temporary;
      lastTemporaryStorageProbeAt=Date.now();
    }
    lastSample.cpu_throttle = cpuThrottle;
    const statStarted = performance.now();
    const free = await storageFreeBytes();
    const statMs = Math.round(performance.now() - statStarted);
    const freshTemp=isTemporaryProbeFresh(Date.now(),lastTemporaryStorageProbeAt);
    lastSample.io_probe = {
      sqlite_ms: health.probe_sqlite_ms,
      storage_write_ms: health.probe_storage_ms,
      storage_probe_cached: health.storage_probe_cached,
      storage_probe_age_ms: health.storage_probe_age_ms,
      temp_write_ms: freshTemp ? temporary?.durationMs ?? null : null,
      temp_status: freshTemp ? (temporary?.storage || 'not_sampled') :
        (lastTemporaryStorageProbeAt ? 'stale' : 'not_sampled'),
      temp_sampled_at: lastTemporaryStorageProbeAt ?
        new Date(lastTemporaryStorageProbeAt).toISOString() : null,
      storage_stat_ms: statMs,
    };
    const currentBackup=backupStatus(false);
    const criticalSample=health.status!=='ok'||maxLoopDelayMs>=1500||
      p99LoopDelayMs>=750||cpuPercent>=90;
    healthHistory.record({
      rss_mb:rssMb,heap_used_mb:Math.round(memory.heapUsed/1048576),
      cpu_percent:cpuPercent,event_loop_max_ms:maxLoopDelayMs,
      event_loop_p99_ms:p99LoopDelayMs,sqlite_ms:health.probe_sqlite_ms,
      storage_write_ms:health.probe_storage_ms,
      temp_write_ms:lastSample.io_probe.temp_write_ms,
      temp_status:lastSample.io_probe.temp_status,
      cpu_throttle_pct:cpuThrottle.throttled_periods_pct ?? null,
      backup_phase:currentBackup?.phase||'unknown',
      backup_result:currentBackup?.result||null,
      backup_duration_ms:currentBackup?.duration_ms??null,
    },now,criticalSample);
    const cap = limitMemory();
    // A one-minute histogram maximum is not enough to identify a culprit.
    // Include CPU consumed during the actual pause, and any known synchronous
    // job completed near it. A low CPU value does not distinguish host
    // descheduling from blocked synchronous I/O.
    const latestStall = eventLoopStallProfiler.snapshot()[0];
    const recentStall = latestStall &&
      now - Date.parse(latestStall.at) >= 0 &&
      now - Date.parse(latestStall.at) <= SAMPLE_INTERVAL_MS + 10000
      ? latestStall : null;
    const recentSync = snapshotSlowSyncOperations().find(entry =>
      now - Date.parse(entry.at) >= 0 &&
      now - Date.parse(entry.at) <= SAMPLE_INTERVAL_MS + 10000);
    transition('database',health.checks.database!=='ok','critical','SQLite не отвечает на проверку');
    transition('storage',health.checks.storage!=='ok','critical','Постоянное хранилище недоступно для записи');
    transition('memory',!!(cap && memory.rss/cap>=WARNING_RSS_RATIO),'warning',
      'Потребление памяти контейнера выше 85% доступного лимита');
    transition('disk',Number.isFinite(free)&&free<WARNING_DISK_BYTES,'warning',
      'В постоянном хранилище осталось менее 100 МБ');
    transition('cpu',highCpuSamples>=2,'warning',
      'Нагрузка Node.js на одно ядро выше 90% два измерения подряд');
    transition('event_loop',loopState.warning,'warning',
      'Задержка Node.js: максимум '+maxLoopDelayMs+' мс, p99 '+p99LoopDelayMs+
      ' мс; отклонение таймера '+Math.round(delay)+' мс; CPU '+cpuPercent+'%, RAM '+rssMb+' МБ. '+
      (cpuThrottle.available && cpuThrottle.throttled_periods_pct != null
        ? 'CPU cgroup throttled '+cpuThrottle.throttled_periods_pct+'% периодов, '+
          cpuThrottle.throttled_ms+' мс. ' : '')+
      'Проверки: SQLite '+health.probe_sqlite_ms+' мс, /data '+
      (health.probe_storage_ms==null?'нет свежей пробы':health.probe_storage_ms+' мс')+', /tmp '+
      (lastSample.io_probe.temp_write_ms==null?'нет свежих данных':
        lastSample.io_probe.temp_write_ms+' мс')+', statfs '+statMs+
      ' мс. '+
      (recentStall
        ? 'Снимок паузы: '+recentStall.at+', лаг '+recentStall.late_by_ms+
          ' мс, CPU процесса '+recentStall.process_cpu_ms+' мс ('+
          recentStall.process_cpu_pct+'% от окна). '
        : 'Снимок паузы: недоступен. ')+
      (recentSync
        ? 'Медленная отслеживаемая синхронная операция: '+
          recentSync.name+' '+recentSync.duration_ms+' мс. '
        : '')+
      describeIoSpike(lastSample.io_probe));
    if (shouldWriteHeartbeat(now,lastHeartbeatAt)) {
      try {
        db.prepare('INSERT INTO site_health_heartbeat(id,last_seen_at,boot_id) VALUES(1,?,?) '+
          'ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at,boot_id=excluded.boot_id')
          .run(new Date(now).toISOString(),bootId);
        // Advance only after a successful write; a failed disk write retries
        // on the next one-minute sample without spawning additional timers.
        lastHeartbeatAt=now;
      } catch (e) { console.warn('[health] heartbeat unavailable:',e.code||'unknown'); }
    }
    // Limit history to 90 days. Pruning once per UTC day avoids churn.
    const day = new Date(now).toISOString().slice(0,10);
    if (day !== lastPruneDay) {
      lastPruneDay = day;
      try { db.prepare("DELETE FROM site_health_events WHERE created_at < datetime('now','-90 days')").run(); }
      catch (_) {}
    }
  } finally { sampleInFlight = false; }
}
function shouldWriteHeartbeat(now,lastWrittenAt) {
  return !lastWrittenAt || now<lastWrittenAt ||
    now-lastWrittenAt>=HEARTBEAT_INTERVAL_MS;
}
function isRestartGap(now,lastSeenAt) {
  const gap=now-Date.parse(lastSeenAt||'');
  return Number.isFinite(gap)&&gap>RESTART_GAP_THRESHOLD_MS&&gap<30*24*3600000;
}
function startHealthWatcher() {
  if (watcher) return;
  try {
    const prev=db.prepare('SELECT last_seen_at FROM site_health_heartbeat WHERE id=1').get();
    if (prev) {
      if (isRestartGap(Date.now(),prev.last_seen_at)) {
        // After a 5-minute heartbeat, the old 3-minute cutoff could falsely
        // warn on a normal restart. Keep a 3-minute safety allowance.
        appendEvent('restart_gap','warning','После перезапуска обнаружен перерыв наблюдения более 8 минут');
        void alert('restart_gap','warning','Сервер перезапущен после перерыва наблюдения более 8 минут.');
      }
    }
  } catch (_) {}
  appendEvent('startup','info','Процесс Node.js запущен');
  loopHistogram.enable();
  eventLoopStallProfiler.start();
  previousSampleAt=Date.now()-SAMPLE_INTERVAL_MS;
  void sample().catch(e => console.warn('[health] sample failed:', e.code || 'unknown'));
  previousSampleAt=Date.now();
  watcher=setInterval(() => {
    void sample().catch(e => console.warn('[health] sample failed:', e.code || 'unknown'));
  },SAMPLE_INTERVAL_MS);
  if (watcher.unref) watcher.unref();
}
function stopHealthWatcher() {
  if(watcher) clearInterval(watcher);
  watcher=null;
  loopHistogram.disable();
  eventLoopStallProfiler.stop();
}
function registerSiteHealthRoutes(router) {
  router.get('/api/live',(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    sendJson(res,200,{status:'ok'});
  });
  router.get('/api/health',async(req,res)=>{
    const result=await healthProbe();
    res.setHeader('Cache-Control','no-store, no-cache, must-revalidate');
    sendJson(res,result.status==='ok'?200:503,result);
  });
  router.get('/api/admin/system-health',async(req,res,ctx)=>{
    if(!requireActiveAdmin(req,res,ctx))return;
    res.setHeader('Cache-Control','private, no-store');
    const payload=await metrics();
    try {payload.events=recentEvents();}
    catch (_) {payload.events=[];}
    sendJson(res,200,payload);
  });
}
module.exports={registerSiteHealthRoutes,healthProbe,metrics,recentEvents,
  sample,startHealthWatcher,stopHealthWatcher,limitMemory,storageFreeBytes,
  appendEvent,nextLoopState,shouldProbeTemporaryStorage,TEMP_PROBE_INTERVAL_MS,
  TEMP_COMPARISON_FRESH_MS,isTemporaryProbeFresh,describeIoSpike,
  shouldWriteHeartbeat,isRestartGap,HEARTBEAT_INTERVAL_MS,RESTART_GAP_THRESHOLD_MS,
  shouldProbePersistentStorage,PERSISTENT_PROBE_INTERVAL_MS};
