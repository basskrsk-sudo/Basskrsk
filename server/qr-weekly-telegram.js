'use strict';
// Weekly point-level QR analytics -> internal Telegram bot; separate from public partner club.
const db = require('./db');
const fs = require('node:fs');
const path = require('node:path');
const { sendTelegram, sendTelegramDocument } = require('./telegram');
const { requireSuperAdmin } = require('./routes-auth');
const { sendJson } = require('./http-utils');
const TIME_ZONE = 'Asia/Krasnoyarsk';
const LOCAL_OFFSET_MS = 7 * 60 * 60 * 1000; // Krasnoyarsk has no DST.
const DAY_MS = 24 * 60 * 60 * 1000;
const REPORT_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'reports', 'qr-weekly');
let started = false;
let inFlight = false;
db.exec(`
 CREATE TABLE IF NOT EXISTS qr_weekly_telegram_schedule (
   id INTEGER PRIMARY KEY CHECK(id=1),
   activated_at TEXT NOT NULL
 );
 CREATE TABLE IF NOT EXISTS qr_weekly_telegram_delivery (
   week_start TEXT PRIMARY KEY,
   week_end TEXT NOT NULL,
   summary_sent_at TEXT,
   file_sent_at TEXT,
   last_error TEXT,
   created_at TEXT NOT NULL DEFAULT (datetime('now'))
 );
`);
// First new installation waits for the next scheduled Monday instead of backfilling.
db.prepare('INSERT OR IGNORE INTO qr_weekly_telegram_schedule(id, activated_at) VALUES(1,?)')
  .run(new Date().toISOString());
function sqlUtc(ms) { return new Date(ms).toISOString().slice(0,19).replace('T',' '); }
function localDay(ms) { return new Date(ms + LOCAL_OFFSET_MS).toISOString().slice(0,10); }
function previousCompletedWeek(now = new Date()) {
  const local = new Date(now.getTime() + LOCAL_OFFSET_MS);
  const midnight = Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate()) - LOCAL_OFFSET_MS;
  const monday = midnight - ((local.getUTCDay()+6)%7)*DAY_MS;
  const start = monday - 7*DAY_MS;
  return {weekStart:localDay(start), weekEnd:localDay(monday-DAY_MS),
    startUtc:sqlUtc(start), endExclusiveUtc:sqlUtc(monday), dueUtcMs:monday+9*60*60*1000};
}
function nextDue(now=new Date()) {
  const due=previousCompletedWeek(now).dueUtcMs;
  return new Date(now.getTime()<due?due:due+7*DAY_MS).toISOString();
}
function numeric(n) { return Number(n)||0; }
function rubles(n) { return new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(numeric(n))+' ₽'; }
function percent(n,d) { return d?(numeric(n)*100/numeric(d)).toFixed(1).replace('.',',')+'%':'—'; }
function escapeHtml(v) { return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function russianDate(localYmd) {
 const [y,m,d]=localYmd.split('-').map(Number);
 return new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(Date.UTC(y,m-1,d)));
}
function readWeeklyPointStats(week) {
 const range=[week.startUtc,week.endExclusiveUtc];
 const qr=db.prepare(`
 SELECT point_id,
 SUM(CASE WHEN event_type='open' THEN 1 ELSE 0 END) opens,
 COUNT(DISTINCT CASE WHEN event_type='open' THEN visit_id ELSE NULL END) visits,
 SUM(CASE WHEN event_type='checkout' THEN 1 ELSE 0 END) checkouts,
 COUNT(DISTINCT CASE WHEN event_type='payment_created' THEN order_code ELSE NULL END) payments
 FROM qr_funnel_events WHERE created_at>=? AND created_at<? GROUP BY point_id
 `).all(...range);
 const samples=db.prepare(`
 SELECT point_id,COUNT(*) scans FROM sample_qr_scans
 WHERE created_at>=? AND created_at<? GROUP BY point_id
 `).all(...range);
 // EXISTS prevents duplicate counting for multi-product orders.
 const sold=db.prepare(`
 SELECT o.point_id,COUNT(*) paid_orders,COALESCE(SUM(o.total),0) revenue
 FROM orders o WHERE o.status='paid'
 AND COALESCE(o.refund_status,'none')!='refunded' AND o.point_id IS NOT NULL
 AND o.created_at>=? AND o.created_at<?
 AND EXISTS (SELECT 1 FROM qr_funnel_events e WHERE e.point_id=o.point_id
   AND e.order_code=o.order_code AND e.event_type='payment_created'
   AND e.created_at>=? AND e.created_at<?)
 GROUP BY o.point_id
 `).all(...range,...range);
 const known=db.prepare('SELECT id,name,active FROM points WHERE COALESCE(is_hub,0)=0').all();
 const pointsById=new Map(known.map(p=>[String(p.id),{id:String(p.id),name:p.name,active:!!p.active,
   opens:0,visits:0,checkouts:0,payments:0,paid_orders:0,revenue:0,sample_scans:0}]));
 function get(id) {
   id=String(id);
   if(!pointsById.has(id))pointsById.set(id,{id,name:'Архивная точка ('+id+')',active:false,
     opens:0,visits:0,checkouts:0,payments:0,paid_orders:0,revenue:0,sample_scans:0});
   return pointsById.get(id);
 }
 for(const r of qr){const p=get(r.point_id);for(const k of ['opens','visits','checkouts','payments'])p[k]=numeric(r[k]);}
 for(const r of samples)get(r.point_id).sample_scans=numeric(r.scans);
 for(const r of sold){const p=get(r.point_id);p.paid_orders=numeric(r.paid_orders);p.revenue=numeric(r.revenue);}
 const points=[...pointsById.values()].filter(p=>p.active||p.opens||p.sample_scans||p.paid_orders)
   .sort((a,b)=>(b.opens+b.sample_scans)-(a.opens+a.sample_scans)||b.paid_orders-a.paid_orders||a.name.localeCompare(b.name,'ru'));
 const totals={opens:0,visits:0,checkouts:0,payments:0,paid_orders:0,revenue:0,sample_scans:0,active_points:0};
 for(const p of points){
   if(p.opens||p.sample_scans)totals.active_points++;
   for(const k of ['opens','visits','checkouts','payments','paid_orders','revenue','sample_scans'])totals[k]+=p[k];
 }
 return {week,points,totals};
}
function makeSummary(report) {
 const {week,points,totals:t}=report;
 const lines=[
   '📊 <b>ХвостМаркет — QR-аналитика по точкам</b>',
   '🗓 '+russianDate(week.weekStart)+' — '+russianDate(week.weekEnd),'',
   '🏪 Точек в отчёте: '+points.length+' (сканирования были на '+t.active_points+')',
   '📱 QR товаров: '+t.opens+' открытий, '+t.visits+' уникальных визитов',
   '🎁 QR пробников: '+t.sample_scans+' сканирований',
   '🛒 Начали оформление: '+t.checkouts,
   '💳 Запросов оплаты: '+t.payments,
   '✅ Оплачено после товарных QR: '+t.paid_orders+' заказов на '+rubles(t.revenue),
   '📈 Конверсия визитов в оплату: '+percent(t.paid_orders,t.visits),
   '', '🏪 <b>По точкам:</b>',
 ];
 let shown=0;
 for(const p of points){
   const row=(shown+1)+'. <b>'+escapeHtml(p.name)+'</b>: QR '+p.opens+
     ' / визиты '+p.visits+' / пробники '+p.sample_scans+
     ' / оплачено '+p.paid_orders+' ('+rubles(p.revenue)+')';
   if(lines.join('\n').length+row.length>3550||shown>=18)break;
   lines.push(row);shown++;
 }
 if(!points.length)lines.push('Нет зарегистрированных точек за период.');
 if(points.length>shown)lines.push('… остальные '+(points.length-shown)+' точек — в приложенном CSV.');
 lines.push('','📎 Таблица по всем точкам прилагается в CSV.',
   'ℹ️ QR товаров — события воронки. Пробники считаются отдельно. Общие продажи без QR здесь не учитываются.');
 return lines.join('\n');
}
function csvField(value) {
 let str=String(value??'').replace(/[\r\n]+/g,' ');
 // Block spreadsheet formula injection from editable point names.
 if(/^[=+@\t-]/.test(str))str="'"+str;
 return '"'+str.replace(/"/g,'""')+'"';
}
function buildCsv(report){
 const header=['Точка','ID точки','Активная','QR товаров: открытия','QR товаров: уникальные визиты',
   'Начали оформление','Запросы оплаты','Оплаченные QR-заказы','Выручка QR, руб','QR пробников: сканирования','Конверсия визит-оплата'];
 const rows=report.points.map(p=>[p.name,p.id,p.active?'да':'нет',p.opens,p.visits,p.checkouts,p.payments,
   p.paid_orders,p.revenue,p.sample_scans,percent(p.paid_orders,p.visits)]);
 const t=report.totals;
 rows.push(['ИТОГО','','',t.opens,t.visits,t.checkouts,t.payments,t.paid_orders,t.revenue,t.sample_scans,percent(t.paid_orders,t.visits)]);
 return '\uFEFF'+[header,...rows].map(row=>row.map(csvField).join(';')).join('\r\n')+'\r\n';
}
function writeCsv(report){
 fs.mkdirSync(REPORT_DIR,{recursive:true});
 const file=path.join(REPORT_DIR,'qr-weekly-'+report.week.weekStart+'_'+report.week.weekEnd+'.csv');
 fs.writeFileSync(file,buildCsv(report),'utf8');return file;
}
function getDelivery(weekStart){
 return db.prepare('SELECT * FROM qr_weekly_telegram_delivery WHERE week_start=?').get(weekStart)||null;
}
async function sendWeeklyQrReport(options={}){
 if(inFlight)return {ok:false,busy:true,error:'Отправка уже выполняется'};
 const now=options.now||new Date(), week=previousCompletedWeek(now);
 if(!options.manual){
   if(now.getTime()<week.dueUtcMs)return {ok:false,skipped:true,reason:'Время отчёта ещё не наступило'};
   const activated=Date.parse(db.prepare('SELECT activated_at FROM qr_weekly_telegram_schedule WHERE id=1').get().activated_at);
   if(activated>week.dueUtcMs)return {ok:false,skipped:true,reason:'Первый отчёт будет после следующего понедельника'};
 }
 if(!process.env.TG_TOKEN||!process.env.TG_CHAT_ID)return {ok:false,error:'TG_TOKEN или TG_CHAT_ID не настроены в Amvera'};
 inFlight=true;
 try{
   const report=readWeeklyPointStats(week);
   db.prepare('INSERT OR IGNORE INTO qr_weekly_telegram_delivery(week_start,week_end) VALUES(?,?)').run(week.weekStart,week.weekEnd);
   let record=getDelivery(week.weekStart);
   if(record.summary_sent_at&&record.file_sent_at)return {ok:true,skipped:true,week:week.weekStart,message:'Отчёт уже доставлен'};
   if(!record.summary_sent_at){
     const sent=await sendTelegram(makeSummary(report));
     if(!sent?.ok||sent.data?.ok===false)throw new Error('Telegram не подтвердил отправку сообщения: '+(sent?.data?.description||sent?.error||'нет ответа'));
     db.prepare("UPDATE qr_weekly_telegram_delivery SET summary_sent_at=datetime('now'),last_error=NULL WHERE week_start=?").run(week.weekStart);
   }
   record=getDelivery(week.weekStart);
   if(!record.file_sent_at){
     const file=writeCsv(report);
     const sent=await sendTelegramDocument(file,'ХвостМаркет • QR-аналитика по точкам • '+week.weekStart+' — '+week.weekEnd);
     if(!sent?.ok||sent.data?.ok===false)throw new Error('Telegram не подтвердил отправку CSV: '+(sent?.data?.description||sent?.error||'нет ответа'));
     db.prepare("UPDATE qr_weekly_telegram_delivery SET file_sent_at=datetime('now'),last_error=NULL WHERE week_start=?").run(week.weekStart);
   }
   return {ok:true,week:week.weekStart,week_end:week.weekEnd,points:report.points.length,sent:true};
 }catch(err){
   db.prepare('UPDATE qr_weekly_telegram_delivery SET last_error=? WHERE week_start=?').run(String(err.message).slice(0,450),week.weekStart);
   console.warn('QR Telegram weekly report:',err.message);
   return {ok:false,error:err.message,week:week.weekStart};
 }finally{inFlight=false}
}
function getStatus(now=new Date()){
 const w=previousCompletedWeek(now);
 const last=db.prepare('SELECT * FROM qr_weekly_telegram_delivery ORDER BY week_start DESC LIMIT 1').get()||null;
 return {enabled:true,time_zone:TIME_ZONE,schedule:'Каждый понедельник в 09:00 по Красноярску',
   next_run_utc:nextDue(now),last_report:last,last_completed_week:{start:w.weekStart,end:w.weekEnd},
   telegram_configured:!!process.env.TG_TOKEN&&!!process.env.TG_CHAT_ID,
   destination:'Служебный Telegram-чат, указанный в TG_CHAT_ID'};
}
function registerQrWeeklyTelegramRoutes(router){
 router.get('/api/admin/qr-weekly-telegram/status',(req,res,ctx)=>{
   if(!requireSuperAdmin(req,res,ctx))return;
   sendJson(res,200,getStatus());
 });
 router.get('/api/admin/qr-weekly-telegram/preview',(req,res,ctx)=>{
   if(!requireSuperAdmin(req,res,ctx))return;
   const report=readWeeklyPointStats(previousCompletedWeek());
   sendJson(res,200,{text:makeSummary(report).replace(/<\/?b>/g,''),week:report.week,points:report.points.length,totals:report.totals});
 });
 router.post('/api/admin/qr-weekly-telegram/send-now',async(req,res,ctx)=>{
   if(!requireSuperAdmin(req,res,ctx))return;
   const result=await sendWeeklyQrReport({manual:true});
   sendJson(res,result.ok?200:result.busy?409:502,result);
 });
}
function scheduleWeeklyQrTelegramReport(){
 if(started)return;started=true;
 const check=()=>sendWeeklyQrReport().catch(err=>console.warn('QR weekly schedule:',err.message));
 const initial=setTimeout(check,35000),interval=setInterval(check,10*60*1000);
 initial.unref?.();interval.unref?.();
}
module.exports={TIME_ZONE,previousCompletedWeek,readWeeklyPointStats,makeSummary,buildCsv,
 getStatus,sendWeeklyQrReport,registerQrWeeklyTelegramRoutes,scheduleWeeklyQrTelegramReport};
