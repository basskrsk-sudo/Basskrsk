'use strict';

// Aggregated, privacy-safe Mini App reliability metrics. We never retain
// phone numbers, Telegram IDs, IP addresses, URLs, tokens, initData or
// client error messages. Clients can submit only strict enumerated labels.
const db = require('./db');
const {sendJson} = require('./http-utils');
const {requireActiveAdmin} = require('./routes-auth');

db.exec("CREATE TABLE IF NOT EXISTS miniapp_diagnostic_aggregate (" +
  "day TEXT NOT NULL,stage TEXT NOT NULL,result TEXT NOT NULL," +
  "code TEXT NOT NULL,platform TEXT NOT NULL,build TEXT NOT NULL," +
  "telegram_version TEXT NOT NULL,occurrences INTEGER NOT NULL DEFAULT 0," +
  "duration_sum_ms INTEGER NOT NULL DEFAULT 0," +
  "PRIMARY KEY(day,stage,result,code,platform,build,telegram_version))");
const STAGES=new Set(['startup','authorization','catalog','cabinet','network','recovery','runtime','payment']);
const RESULTS=new Set(['success','failure']);
const CODES=new Set(['ok','timeout','offline','network','server','forbidden','runtime','invalid_response','unknown']);
const PLATFORMS=new Set(['ios','android','desktop','unknown']);
const ALLOWED=new Set(['stage','result','code','platform','build','telegram_version','duration_ms']);
// Global admission rate limiting for public, anonymous telemetry (not per user).
let windowStart=0, windowEvents=0, lastPrunedDay='';
function validPayload(body){
  if (!body || typeof body!=='object' || Array.isArray(body) ||
      Object.keys(body).some(k=>!ALLOWED.has(k)))return null;
  const {stage,result,code,platform,build,telegram_version,duration_ms}=body;
  if (![STAGES.has(stage),RESULTS.has(result),CODES.has(code),PLATFORMS.has(platform)].every(Boolean))return null;
  if(typeof build!=='string'||!/^[a-zA-Z0-9._-]{1,40}$/.test(build))return null;
  if(typeof telegram_version!=='string'||!/^(?:unknown|[0-9.]{1,20})$/.test(telegram_version))return null;
  if(!Number.isInteger(duration_ms)||duration_ms<0||duration_ms>120000)return null;
  return {stage,result,code,platform,build,telegram_version,duration_ms};
}
function registerMiniAppDiagnosticRoutes(router) {
  router.post('/api/miniapp/diagnostics',(req,res,ctx)=>{
    const body=validPayload(ctx.body);
    if(!body)return sendJson(res,400,{error:'Некорректная диагностическая метрика'});
    const now=Date.now();
    if(now-windowStart>=60000){windowStart=now;windowEvents=0;}
    if(++windowEvents>1200)return sendJson(res,429,{error:'Превышен лимит телеметрии'});
    const day=new Date(now).toISOString().slice(0,10);
    if(lastPrunedDay!==day){
      db.prepare("DELETE FROM miniapp_diagnostic_aggregate WHERE day<date('now','-30 days')").run();
      lastPrunedDay=day;
    }
    db.prepare(
      'INSERT INTO miniapp_diagnostic_aggregate '+
      '(day,stage,result,code,platform,build,telegram_version,occurrences,duration_sum_ms) '+
      'VALUES (?,?,?,?,?,?,?,1,?) '+
      'ON CONFLICT(day,stage,result,code,platform,build,telegram_version) DO UPDATE SET '+
      'occurrences=occurrences+1,duration_sum_ms=duration_sum_ms+excluded.duration_sum_ms'
    ).run(day,body.stage,body.result,body.code,body.platform,body.build,body.telegram_version,body.duration_ms);
    sendJson(res,200,{ok:true});
  });
  router.get('/api/miniapp/diagnostics-summary',(req,res,ctx)=>{
    if(!requireActiveAdmin(req,res,ctx))return;
    const rows=db.prepare(
      "SELECT day,stage,result,code,platform,build,telegram_version,occurrences,"+
      "duration_sum_ms FROM miniapp_diagnostic_aggregate "+
      "WHERE day>=date('now','-6 days') ORDER BY day DESC,occurrences DESC LIMIT 250"
    ).all();
    const totals=db.prepare(
      "SELECT SUM(CASE WHEN stage='startup' AND result='success' THEN occurrences ELSE 0 END) AS successful_launches,"+
      "SUM(CASE WHEN result='failure' THEN occurrences ELSE 0 END) AS reported_errors,"+
      "SUM(occurrences) AS events FROM miniapp_diagnostic_aggregate WHERE day>=date('now','-6 days')"
    ).get();
    sendJson(res,200,{range:'7d',summary:{
      successful_launches:Number(totals.successful_launches||0),
      reported_errors:Number(totals.reported_errors||0),
      events:Number(totals.events||0),
    },rows});
  });
}
module.exports={registerMiniAppDiagnosticRoutes,validPayload};
