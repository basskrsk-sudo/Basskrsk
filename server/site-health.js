'use strict';

// Lightweight, privacy-safe health/readiness and in-process diagnostics.
// Public endpoints expose only "ok"/"error"; internal metrics require an
// active admin account. Independent outage detection lives in GitHub Actions.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireActiveAdmin } = require('./routes-auth');
const { sendTelegram } = require('./telegram');

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
let lastSample = null;
let previousSampleAt = BOOTED_AT;
let watcher = null;
const lastAlerts = new Map();
const states = new Map();

db.exec("CREATE TABLE IF NOT EXISTS site_health_events (" +
  "id INTEGER PRIMARY KEY AUTOINCREMENT," +
  "event_type TEXT NOT NULL CHECK(event_type IN (" +
    "'startup','restart_gap','recovered','database','storage','memory','disk','event_loop'))," +
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
function storageFreeBytes() {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const stat = fs.statfsSync(DATA_DIR);
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
function healthProbe(force = false) {
  const now = Date.now();
  if (!force && currentHealth && now - lastHealthAt < HEALTH_CACHE_MS) return currentHealth;
  const started = Date.now();
  let database = 'ok', storage = 'ok';
  try { db.prepare('SELECT 1 AS ok').get(); }
  catch (_) { database = 'error'; }
  // This checks actual writeability, not just directory metadata, and never
  // exposes the persistent path or filesystem errors to public callers.
  let name = '';
  try {
    const dataDir = path.resolve(DATA_DIR);
    fs.mkdirSync(dataDir, {recursive:true});
    name = path.join(dataDir,'.hm-health-' + process.pid + '-' + Date.now());
    fs.writeFileSync(name, '1', {flag:'wx',mode:0o600});
  } catch (_) { storage = 'error'; }
  finally { if (name) try {fs.unlinkSync(name);} catch (_){} }
  currentHealth = {
    status: database === 'ok' && storage === 'ok' ? 'ok' : 'degraded',
    checks:{database,storage},
    probe_ms:Math.max(0,Date.now()-started),
  };
  lastHealthAt = now;
  return currentHealth;
}
function recentEvents(limit = MAX_RECENT_EVENTS) {
  return db.prepare(
    'SELECT event_type,severity,detail,created_at FROM site_health_events ' +
    'ORDER BY id DESC LIMIT ?'
  ).all(Math.min(100,Math.max(1,Number(limit)||MAX_RECENT_EVENTS)));
}
function metrics() {
  const mem = process.memoryUsage();
  const free = storageFreeBytes();
  const limit = limitMemory();
  const health = healthProbe();
  return {
    ...health,
    timestamp:new Date().toISOString(),
    uptime_seconds:Math.floor((Date.now()-BOOTED_AT)/1000),
    memory:{rss_mb:Math.round(mem.rss/1048576),heap_used_mb:Math.round(mem.heapUsed/1048576),
      limit_mb:limit?Math.round(limit/1048576):null},
    storage_free_mb:Number.isFinite(free)?Math.round(free/1048576):null,
    event_loop_delay_ms:lastSample ? lastSample.event_loop_delay_ms : null,
    sampled_at:lastSample ? lastSample.time : null,
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
function sample() {
  const now = Date.now();
  const delay = Math.max(0,now-previousSampleAt-SAMPLE_INTERVAL_MS);
  previousSampleAt=now;
  const health=healthProbe(true),memory=process.memoryUsage();
  const cap=limitMemory(),free=storageFreeBytes();
  lastSample={time:new Date(now).toISOString(),event_loop_delay_ms:Math.round(delay)};
  transition('database',health.checks.database!=='ok','critical','SQLite не отвечает на проверку');
  transition('storage',health.checks.storage!=='ok','critical','Постоянное хранилище недоступно для записи');
  transition('memory',!!(cap && memory.rss/cap>=WARNING_RSS_RATIO),'warning',
    'Потребление памяти контейнера выше 85% доступного лимита');
  transition('disk',Number.isFinite(free)&&free<WARNING_DISK_BYTES,'warning',
    'В постоянном хранилище осталось менее 100 МБ');
  transition('event_loop',delay>1500,'warning',
    'Задержка обработки событий Node.js более 1,5 секунды');
  try {
    db.prepare('INSERT INTO site_health_heartbeat(id,last_seen_at,boot_id) VALUES(1,?,?) '+
      'ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at,boot_id=excluded.boot_id')
      .run(new Date(now).toISOString(),bootId);
  } catch (e) { console.warn('[health] heartbeat unavailable:',e.code||'unknown'); }
  // Limit history to 90 days; not executed on each public request.
  if (now%12 < 2) try {
    db.prepare("DELETE FROM site_health_events WHERE created_at < datetime('now','-90 days')").run();
  } catch (_) {}
}
function startHealthWatcher() {
  if (watcher) return;
  try {
    const prev=db.prepare('SELECT last_seen_at FROM site_health_heartbeat WHERE id=1').get();
    if (prev) {
      const gap=Date.now()-Date.parse(prev.last_seen_at);
      if (Number.isFinite(gap)&&gap>180000&&gap<30*24*3600000)
        appendEvent('restart_gap','warning','После перезапуска обнаружен перерыв наблюдения более 3 минут');
    }
  } catch (_) {}
  appendEvent('startup','info','Процесс Node.js запущен');
  previousSampleAt=Date.now()-SAMPLE_INTERVAL_MS;
  sample();
  previousSampleAt=Date.now();
  watcher=setInterval(sample,SAMPLE_INTERVAL_MS);
  if (watcher.unref) watcher.unref();
}
function registerSiteHealthRoutes(router) {
  router.get('/api/live',(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    sendJson(res,200,{status:'ok'});
  });
  router.get('/api/health',(req,res)=>{
    const result=healthProbe();
    res.setHeader('Cache-Control','no-store, no-cache, must-revalidate');
    sendJson(res,result.status==='ok'?200:503,result);
  });
  router.get('/api/admin/system-health',(req,res,ctx)=>{
    if(!requireActiveAdmin(req,res,ctx))return;
    res.setHeader('Cache-Control','private, no-store');
    const payload=metrics();
    try {payload.events=recentEvents();}
    catch (_) {payload.events=[];}
    sendJson(res,200,payload);
  });
}
module.exports={registerSiteHealthRoutes,healthProbe,metrics,recentEvents,
  sample,startHealthWatcher,limitMemory,storageFreeBytes,appendEvent};
