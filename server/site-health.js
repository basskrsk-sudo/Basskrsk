'use strict';

// Lightweight, privacy-safe health/readiness and in-process diagnostics.
// Public endpoints expose only "ok"/"error"; internal metrics require an
// active admin account. Independent outage detection lives in GitHub Actions.
const fs = require('node:fs');
const path = require('node:path');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireActiveAdmin } = require('./routes-auth');
const { sendTelegram } = require('./telegram');
const { snapshotApiPerformance } = require('./api-performance');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const BOOTED_AT = Date.now();
const HEALTH_CACHE_MS = 10000;
const SAMPLE_INTERVAL_MS = 60000;
const ALERT_COOLDOWN_MS = 20 * 60 * 1000;
const MAX_RECENT_EVENTS = 35;
const WARNING_RSS_RATIO = 0.85;
const WARNING_DISK_BYTES = 100 * 1024 * 1024;
let currentHealth = null;
let lastHealthAt = 0;
let healthInFlight = null;
let sampleInFlight = false;
let healthFileCounter = 0;
let lastSample = null;
let previousSampleAt = BOOTED_AT;
let previousCpuUsage = process.cpuUsage();
let highCpuSamples = 0;
const loopHistogram = monitorEventLoopDelay({resolution:20});
let loopState={slowSamples:0,healthySamples:0,warning:false};
let watcher = null;
let lastPruneDay = '';
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
async function checkStorageWritable() {
  const started = performance.now();
  let storage = 'ok', handle = null;
  const dataDir = path.resolve(DATA_DIR);
  const name = path.join(dataDir, '.hm-health-' + process.pid + '-' +
    Date.now() + '-' + (++healthFileCounter));
  try {
    await fs.promises.mkdir(dataDir, { recursive: true });
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
async function healthProbe(force = false) {
  const now = Date.now();
  if (!force && currentHealth && now - lastHealthAt < HEALTH_CACHE_MS) return currentHealth;
  // One shared probe for concurrent readiness requests and the watcher.
  if (healthInFlight) return healthInFlight;
  healthInFlight = (async () => {
    const started = performance.now();
    const sqliteStart = performance.now();
    let database = 'ok';
    try { db.prepare('SELECT 1 AS ok').get(); }
    catch (_) { database = 'error'; }
    const sqliteMs = Math.round(performance.now() - sqliteStart);
    const disk = await checkStorageWritable();
    const result = {
      status: database === 'ok' && disk.storage === 'ok' ? 'ok' : 'degraded',
      checks: { database, storage: disk.storage },
      probe_ms: Math.round(performance.now() - started),
      probe_sqlite_ms: sqliteMs,
      probe_storage_ms: disk.durationMs,
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
    api_performance:snapshotApiPerformance(),
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
      cpu_percent:cpuPercent,io_probe:null};

    const health = await healthProbe(true);
    const statStarted = performance.now();
    const free = await storageFreeBytes();
    const statMs = Math.round(performance.now() - statStarted);
    lastSample.io_probe = {
      sqlite_ms: health.probe_sqlite_ms,
      storage_write_ms: health.probe_storage_ms,
      storage_stat_ms: statMs,
    };
    const cap = limitMemory();
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
      ' мс; CPU '+cpuPercent+'%, RAM '+rssMb+' МБ. '+
      'Проверки: SQLite '+health.probe_sqlite_ms+' мс, диск '+
      health.probe_storage_ms+' мс. Проверьте длительные синхронные операции.');
    try {
      db.prepare('INSERT INTO site_health_heartbeat(id,last_seen_at,boot_id) VALUES(1,?,?) '+
        'ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at,boot_id=excluded.boot_id')
        .run(new Date(now).toISOString(),bootId);
    } catch (e) { console.warn('[health] heartbeat unavailable:',e.code||'unknown'); }
    // Limit history to 90 days. Pruning once per UTC day avoids churn.
    const day = new Date(now).toISOString().slice(0,10);
    if (day !== lastPruneDay) {
      lastPruneDay = day;
      try { db.prepare("DELETE FROM site_health_events WHERE created_at < datetime('now','-90 days')").run(); }
      catch (_) {}
    }
  } finally { sampleInFlight = false; }
}
function startHealthWatcher() {
  if (watcher) return;
  try {
    const prev=db.prepare('SELECT last_seen_at FROM site_health_heartbeat WHERE id=1').get();
    if (prev) {
      const gap=Date.now()-Date.parse(prev.last_seen_at);
      if (Number.isFinite(gap)&&gap>180000&&gap<30*24*3600000)
      {
        appendEvent('restart_gap','warning','После перезапуска обнаружен перерыв наблюдения более 3 минут');
        void alert('restart_gap','warning','Сервер перезапущен после перерыва наблюдения более 3 минут.');
      }
    }
  } catch (_) {}
  appendEvent('startup','info','Процесс Node.js запущен');
  loopHistogram.enable();
  previousSampleAt=Date.now()-SAMPLE_INTERVAL_MS;
  void sample().catch(e => console.warn('[health] sample failed:', e.code || 'unknown'));
  previousSampleAt=Date.now();
  watcher=setInterval(() => {
    void sample().catch(e => console.warn('[health] sample failed:', e.code || 'unknown'));
  },SAMPLE_INTERVAL_MS);
  if (watcher.unref) watcher.unref();
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
  sample,startHealthWatcher,limitMemory,storageFreeBytes,appendEvent,nextLoopState};
