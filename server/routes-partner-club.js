// Partner Club: persistent configuration, paid-sale drafts, analytics and previews.
// Deliberately NO Telegram integration or outbound network activity.
'use strict';
const { trackSync, trackAsync } = require('./runtime-diagnostics');
const db = require('./db');
const dailyRecords = require('./partner-club-daily-records').createDailySalesRecords(db);
const { sendJson } = require('./http-utils');
const { requireSuperAdmin } = require('./routes-auth');
const { safeMarkdownHtml, htmlFromTelegramEntities } = require('./telegram-formatting');
const { SALE_ENDINGS, saleEndingAt } = require('./partner-club-sale-endings');
const { saleMessage, saleMessageHtml, withSaleEnding } = require('./partner-club-sale-format');
const clubPhotos = require('./partner-club-photo-posts');

const FLAGS=['sales','record_check','record_day','first_sale','daily','weekly','milestones','new_points','tips','new_products','top_products_week','top_products_all'];
const DEFAULTS=Object.freeze({sales:true,record_check:true,record_day:true,first_sale:true,daily:true,weekly:true,milestones:true,new_points:true,tips:false,new_products:false,top_products_week:true,top_products_all:false,sales_mode:'all',hourly_limit:5,include_groomer_names:false,enabled:false,chat_id:null});
db.exec(`CREATE TABLE IF NOT EXISTS partner_club_settings(id INTEGER PRIMARY KEY CHECK(id=1),config_json TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS partner_club_events(id INTEGER PRIMARY KEY AUTOINCREMENT,event_key TEXT UNIQUE NOT NULL,event_type TEXT NOT NULL,message TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,status TEXT NOT NULL DEFAULT 'draft' CHECK(status='draft'));
CREATE INDEX IF NOT EXISTS idx_partner_club_events_created ON partner_club_events(created_at DESC);`);
// On first launch of anonymized reports, retire legacy unsent weekly messages containing names.
db.exec("CREATE TABLE IF NOT EXISTS partner_club_migrations (key TEXT PRIMARY KEY)");
if (!db.prepare("SELECT 1 FROM partner_club_migrations WHERE key='anonymous_weekly_v1'").get()) {
  db.prepare("DELETE FROM partner_club_events WHERE event_type='weekly'").run();
  db.prepare("INSERT INTO partner_club_migrations(key) VALUES('anonymous_weekly_v1')").run();
}
function settings(){let row=db.prepare('SELECT config_json FROM partner_club_settings WHERE id=1').get(),saved={};try{if(row)saved=JSON.parse(row.config_json)}catch(_){}
return {...DEFAULTS,...saved,include_groomer_names:false};}
function money(n){return new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(Number(n)||0)+' ₽';}
function queue(key,type,message){
  const inserted=db.prepare("INSERT OR IGNORE INTO partner_club_events(event_key,event_type,message,status) VALUES (?,?,?,'draft')").run(key,type,message).changes>0;
  // New sales wake moderation without waiting for a periodic SQLite scan.
  if(inserted)wakeClubWorker();
  return inserted;
}
function nextSaleEnding(){
  // Persist rotation via the database: rejected and pending posts still count.
  // No reset when the server restarts; retries of an order cannot add new events.
  const count=db.prepare("SELECT COUNT(*) AS n FROM partner_club_events WHERE event_type='sales'").get()?.n||0;
  return saleEndingAt(Number(count));
}
function safeText(v){return String(v||'').replace(/[<>\u0000-\u001f]/g,' ').trim().slice(0,100);}
function venueType(point) {
  // Prefer the registered point type; fall back to the manager point classification.
  const cols=db.prepare('PRAGMA table_info(points)').all().map(c=>c.name);
  const stored=point?.id && cols.includes('point_type')?db.prepare('SELECT point_type FROM points WHERE id=?').get(point.id)?.point_type:null;
  const managed=point?.id ? db.prepare('SELECT point_type FROM manager_points WHERE point_id=? ORDER BY id DESC LIMIT 1').get(point.id)?.point_type : null;
  const raw=String(stored||managed||'').toLowerCase();
  if(/вет|veterinar|clinic/.test(raw))return 'Ветеринарная клиника';
  if(/грум|groom/.test(raw))return 'Грумерский салон';
  return 'Партнёрская точка';
}
function welcomeNewPoint(point) {
  if (!point || !point.id || !settings().new_points) return false;
  const name = safeText(point.name || 'Новый минимаркет');
  const city = point.city_id ? db.prepare('SELECT name FROM cities WHERE id=?').get(point.city_id)?.name : null;
  const message = [
    '🎉 Приветствуем нового партнёра ХвостМаркета!',
    '🏪 '+venueType(point)+': «' + name + '»',
    city ? '📍 Город: ' + safeText(city) : '',
    '🐾 Наша сеть растёт! Желаем команде успешного старта, довольных клиентов и счастливых питомцев!',
    '💚 Добро пожаловать в Клуб партнёров!'
  ].filter(Boolean).join('\n');
  // Permanent idempotency key: further groomers at this point won't cause repeats.
  return queue('welcome:point:' + String(point.id), 'new_points', message);
}
// Broadcast a new all-time record in a separate moderated partner-club draft.
// The first eligible customer payment sets the baseline; ties are not records.
function recordCheckMessage(location,product,total,previous){
 return [
   '🏆 Новый рекорд ХвостМаркета по сумме чека!',
   '',
   location,
   '',
   '🦴 '+product,
   '',
   '💚 Рекордный чек:',
   money(total),
   '',
   '🥈 Предыдущий рекорд:',
   money(previous),
   '',
   '📈 Превышение:',
   '+'+money(total-previous),
   '',
   '🎉 Поздравляем команду! Вместе устанавливаем новые рекорды! 🐾'
 ].join('\n');
}
function queueRecordCheck(order,product,location){
 // A demo checkout has no YooKassa payment ID. Do not count test receipts.
 if(!settings().record_check || order.is_partner_self_order || !order.yookassa_payment_id)return false;
 const total=Number(order.total);
 if(!Number.isFinite(total)||total<=0)return false;
 const row=db.prepare(`
   SELECT MAX(total) AS previous_max FROM orders
   WHERE id<>? AND status='paid'
     AND yookassa_payment_id IS NOT NULL
     AND COALESCE(refund_status,'')!='refunded'
     AND COALESCE(is_partner_self_order,0)=0
 `).get(order.id);
 if(row?.previous_max==null)return false;
 const previous=Number(row.previous_max);
 if(!Number.isFinite(previous)||total<=previous)return false;
 return queue('record-check:'+String(order.id),'record_check',
   recordCheckMessage(location,product,total,previous));
}
function recordPaidOrder(order,items,demo=false){
 if(demo||!order||order.status!=='paid'||order.refund_status==='refunded')return false;
 const point=order.point_id?db.prepare('SELECT id,name FROM points WHERE id=?').get(order.point_id):null;
 const product=(items||[]).map(i=>safeText(i.name)+(i.qty>1?' ×'+i.qty:'')).join(', ').slice(0,190)||'товар для питомца';
 // A delivery address may be embedded in pickup_point. Never publish it to a group.
 const location=order.fulfillment_type==='home_delivery'||order.needs_delivery
   ? '🏪 Заказ через сайт с доставкой'
   : '🏪 '+venueType(point||{id:order.point_id})+': «'+safeText(point?.name||order.pickup_point||'Точка')+'»';
 let isFirstSale=false;
 let saleQueued=false;
 // First paid CUSTOMER order only. Other paid orders prevent retrospective greetings.
 // Permanent event key also prevents repeat milestones after restarts or order removal.
 if(point&&!order.is_partner_self_order&&settings().first_sale){
   const previous=db.prepare("SELECT 1 FROM orders WHERE point_id=? AND id<>? AND status='paid' AND COALESCE(is_partner_self_order,0)=0 LIMIT 1").get(point.id,order.id);
   if(!previous){
     isFirstSale=true;
     const message=saleMessage('🎉 Первая продажа!',location,'🦴 '+product,
       '💚 '+money(order.total),
       '👏 Поздравляем команду с первым успехом! Отличный старт — дальше больше! 💪🐾');
     saleQueued=queue('first-sale:point:'+String(point.id),'first_sale',message);
   }
 }
 if(!isFirstSale){
   const message=saleMessage('🐾 Новая покупка!',location,'🦴 '+product,
     '💚 '+money(order.total),nextSaleEnding());
   saleQueued=queue('paid:'+order.id,'sales',message);
 }
 const recordQueued=queueRecordCheck(order,product,location);
 return saleQueued||recordQueued;
}
function range(period){const now=new Date();const today=now.toISOString().slice(0,10);
  if(period==='yesterday')return {start:`date('now','-1 day')`,end:`date('now')`};
  if(period==='week')return {start:`date('now','-7 days')`,end:`datetime('now')`};
  return {start:`date('now')`,end:`datetime('now')`};
}
function analytics(period='yesterday'){
 const r=range(period);const where=`o.status='paid' AND COALESCE(o.refund_status,'')!='refunded' AND o.created_at >= ${r.start} AND o.created_at < ${r.end}`;
 const totals=db.prepare(`SELECT COUNT(*) sales, COALESCE(SUM(o.total),0) revenue, COUNT(DISTINCT o.point_id) active_points, COUNT(DISTINCT o.partner_id) active_groomers FROM orders o WHERE ${where}`).get();
 const points=db.prepare(`SELECT COALESCE(p.name,o.pickup_point,'Без точки') name,COUNT(*) sales,COALESCE(SUM(o.total),0) revenue FROM orders o LEFT JOIN points p ON p.id=o.point_id WHERE ${where} GROUP BY o.point_id,COALESCE(p.name,o.pickup_point) ORDER BY sales DESC,revenue DESC LIMIT 20`).all();
 const groomers=db.prepare(`SELECT o.partner_id id,COALESCE(p.full_name,'Без рекомендации') name,COUNT(*) sales FROM orders o LEFT JOIN partners p ON p.id=o.partner_id WHERE ${where} AND o.partner_id IS NOT NULL GROUP BY o.partner_id ORDER BY sales DESC LIMIT 10`).all();
 const top=db.prepare(`SELECT oi.name, SUM(oi.qty) qty FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE ${where} GROUP BY oi.name ORDER BY qty DESC LIMIT 1`).get();
 return {period,...totals,points,groomers,top_product:top||null,records:dailyRecords.metrics(),calculation_note:'Период рассчитывается по дате создания оплаченного заказа (UTC в БД), а не по времени подтверждения оплаты'};
}

function topProducts(period='week'){
 if(!['week','all'].includes(period)) throw new Error('Недопустимый период');
 const dateClause=period==='week' ? "AND o.created_at >= datetime('now','-7 days')" : "";
 // Group by SKU/variant when known, retaining separate weights for same product.
 const rows=db.prepare(`SELECT COALESCE(CAST(oi.variant_id AS TEXT),'legacy:'||oi.name||':'||COALESCE(oi.weight,'')) sku,
   MAX(oi.name) name,MAX(COALESCE(oi.weight,'')) weight,
   SUM(oi.qty) units, COUNT(DISTINCT o.id) orders,
   SUM(oi.price*oi.qty) gross_revenue
   FROM order_items oi JOIN orders o ON o.id=oi.order_id
   WHERE o.status='paid' AND COALESCE(o.refund_status,'')!='refunded'
   AND COALESCE(o.is_partner_self_order,0)=0 ${dateClause}
   GROUP BY COALESCE(CAST(oi.variant_id AS TEXT),'legacy:'||oi.name||':'||COALESCE(oi.weight,''))
   ORDER BY units DESC,orders DESC,sku ASC LIMIT 5`).all();
 return {period,items:rows,metric:'units',notes:'Количество проданных единиц; выручка по позициям без распределения скидок. Исключены полностью возвращённые и собственные заказы грумеров.'};
}
function topProductsMessage(period){
 const data=topProducts(period);
 const title=period==='week'?'🏆 Топ товаров за 7 дней':'🌟 Бестселлеры за всё время';
 return {message:title+'\n'+(data.items.length ? data.items.map((x,i)=>
  (i+1)+'. '+safeText(x.name)+(x.weight?' ('+safeText(x.weight)+')':'')+' — '+x.units+' шт.').join('\n') : 'Подтверждённых продаж пока нет.')+
 '\n🐾 Подсказывайте клиентам, что выбирают чаще всего!',stats:data};
}

function preview(type,data={}){
 const point=safeText(data.point||'БаркЛай'),item=safeText(data.product||'Лёгкое говяжье, 50 г');
 const count=Math.max(0,Math.floor(Number(data.count)||18)),amount=Math.max(0,Number(data.amount)||4500);
 switch(type){
  case 'sales':return saleMessage('🐾 Новая покупка!',
    '🏪 Партнёрская точка: «'+point+'»','🦴 '+item,'💚 '+money(amount),nextSaleEnding());
  case 'record_check':return recordCheckMessage('🏪 Партнёрская точка: «'+point+'»',item,amount,Math.max(0,Number(data.previous_amount)||3500));
  case 'record_day':return require('./partner-club-daily-records').message(
    '2026-11-12',Math.max(2,count),
    Math.min(Math.max(2,count)-1,Math.max(1,Number(data.previous_count)||12)),
    {point_name:point,sales:Math.max(1,Math.round(count/2))});
  case 'first_sale':return saleMessage('🎉 Первая продажа!',
    '🏪 Партнёрская точка: «'+point+'»','🦴 '+item,'💚 '+money(amount),
    '👏 Поздравляем команду с первым успехом! Отличный старт — дальше больше! 💪🐾');
  case 'daily':return '☀️ Итоги вчерашнего дня\n🐾 Продаж: '+count+'\n💚 Выручка: '+money(amount)+'\nСпасибо партнёрам!';
  case 'weekly':return '🏆 Итоги недели\n🐾 Продаж: '+count+'\nОтмечаем достижения без публичного сравнения неактивных партнёров.';
  case 'milestones':return '🎉 Новый рекорд: '+count+' продаж!';
  case 'new_points':return '🎉 Новый партнёр сети — партнёрская точка: «'+point+'»!';
  case 'tips':return '💡 Совет: предложите лакомство после груминга.';
  case 'new_products':return '🦴 Новинка: '+item+'!';
  case 'top_products_week':return topProductsMessage('week').message;
  case 'top_products_all':return topProductsMessage('all').message;
  default:return null;
 }
}
function report(type){
 const period=type==='daily'?'yesterday':'week';const a=analytics(period);
 let message=(type==='daily'?'☀️ Вчерашние итоги':'🏆 Итоги недели')+'\n🐾 Продаж: '+a.sales+'\n💚 Выручка: '+money(a.revenue)+'\n🏪 Активных точек: '+a.active_points+'\n👩‍🦰 Активных грумеров: '+a.active_groomers;
 if(a.top_product)message+='\n🦴 Хит: '+safeText(a.top_product.name);
 if(a.records.max_daily_sales)message+='\n🏆 Рекорд продаж за день: '+a.records.max_daily_sales.sales+' ('+a.records.max_daily_sales.day+')';

 return {message,stats:a};
}
function registerPartnerClubRoutes(router){
 const auth=(req,res,ctx)=>requireSuperAdmin(req,res,ctx);
 router.get('/api/admin/partner-club',(req,res,ctx)=>{if(!auth(req,res,ctx))return;sendJson(res,200,{settings:settings(),connected:!!settings().chat_id,delivery_enabled:!!settings().enabled});});
 router.put('/api/admin/partner-club',(req,res,ctx)=>{if(!auth(req,res,ctx))return;
  const body=ctx.body||{},next=settings();
  if(body.enabled===true||body.chat_id) return sendJson(res,409,{error:'Подключение Telegram-чата заблокировано до отдельного решения'});
  for(const flag of FLAGS){if(Object.hasOwn(body,flag)){if(typeof body[flag]!=='boolean')return sendJson(res,400,{error:'Некорректное поле '+flag});next[flag]=body[flag];}}
  if(Object.hasOwn(body,'sales_mode')){if(!['all','limit','digest'].includes(body.sales_mode))return sendJson(res,400,{error:'Некорректная частота'});next.sales_mode=body.sales_mode;}
  next.enabled=settings().enabled;next.chat_id=settings().chat_id;next.include_groomer_names=false;
  db.prepare('INSERT INTO partner_club_settings(id,config_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,updated_at=CURRENT_TIMESTAMP').run(JSON.stringify(next));
  wakeClubWorker();
  sendJson(res,200,{ok:true,settings:next,delivery_enabled:false});
 });
 // The club is an independent outbound channel; existing personal bot stays untouched.
 function clubStatus(){const c=settings();const drafts=db.prepare("SELECT COUNT(*) AS n FROM partner_club_events WHERE status='draft'").get().n;return {status:c.enabled?'running':c.chat_id?'stopped':'not_connected',status_label:c.enabled?'Работает':c.chat_id?'Остановлена':'Не подключён',running:!!c.enabled,connected:!!c.chat_id,can_start:!!c.chat_id&&!!process.env.TG_TOKEN,drafts,delivery_enabled:!!c.enabled,reason:c.enabled?'Рассылка активна':c.chat_id?'Группа готова. Рассылка отключена.':'Сначала подключите группу',personal_notifications_affected:false};}
 router.post('/api/admin/partner-club/reviewer',(req,res,ctx)=>{const admin=requireSuperAdmin(req,res,ctx);if(!admin)return;const linked=db.prepare('SELECT telegram_chat_id FROM admins WHERE id=? AND role=?').get(admin.id,'super');if(!linked?.telegram_chat_id)return sendJson(res,409,{error:'Сначала подключите Telegram в кабинете супер-администратора'});const cfg={...settings(),reviewer_admin_id:admin.id};db.prepare('INSERT INTO partner_club_settings(id,config_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json').run(JSON.stringify(cfg));wakeClubWorker();sendJson(res,200,{ok:true,message:'Черновики будут приходить в личный Telegram супер-администратора'});});
 router.get('/api/admin/partner-club/status',(req,res,ctx)=>{if(!auth(req,res,ctx))return;sendJson(res,200,clubStatus());});
 router.post('/api/admin/partner-club/start',(req,res,ctx)=>{if(!auth(req,res,ctx))return;const c=settings();if(!c.chat_id||!process.env.TG_TOKEN)return sendJson(res,409,{error:'Группа не настроена'});db.prepare('INSERT INTO partner_club_settings(id,config_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,updated_at=CURRENT_TIMESTAMP').run(JSON.stringify({...c,enabled:true,club_started_at:new Date().toISOString().slice(0,19).replace('T',' ')}));wakeClubWorker();sendJson(res,200,{ok:true,...clubStatus()});});
 router.post('/api/admin/partner-club/stop',(req,res,ctx)=>{if(!auth(req,res,ctx))return;const c=settings();db.prepare('INSERT INTO partner_club_settings(id,config_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,updated_at=CURRENT_TIMESTAMP').run(JSON.stringify({...c,enabled:false}));sendJson(res,200,{ok:true,...clubStatus()});});

 // Bind/test the group without enabling automatic broadcasts.
 router.post('/api/admin/partner-club/connect',async(req,res,ctx)=>{
   if(!requireSuperAdmin(req,res,ctx))return;
   const id=String(ctx.body?.chat_id||'').trim();
   if(!/^-100[0-9]{6,18}$/.test(id))return sendJson(res,400,{error:'Неверный ID супергруппы'});
   if(!process.env.TG_TOKEN)return sendJson(res,503,{error:'Telegram token не настроен'});
   try {
     const api=async(method,payload)=>{
       const r=await fetch('https://api.telegram.org/bot'+process.env.TG_TOKEN+'/'+method,{
         method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)});
       const j=await r.json();if(!j.ok)throw Error(j.description||'Telegram API error');return j.result;
     };
     const chat=await api('getChat',{chat_id:id});
     const bot=await api('getMe',{});
     const member=await api('getChatMember',{chat_id:id,user_id:bot.id});
     if(!['member','administrator','creator'].includes(member.status))return sendJson(res,409,{error:'Бот не является участником'});
     const conf={...settings(),chat_id:id,enabled:false,include_groomer_names:false};
     db.prepare('INSERT INTO partner_club_settings(id,config_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,updated_at=CURRENT_TIMESTAMP').run(JSON.stringify(conf));
     sendJson(res,200,{ok:true,chat_title:chat.title,chat_id:id,automatic_delivery:false});
   }catch(e){sendJson(res,502,{error:'Не удалось проверить группу: '+e.message});}
 });
 router.post('/api/admin/partner-club/test',async(req,res,ctx)=>{
   if(!requireSuperAdmin(req,res,ctx))return;
   const conf=settings();if(!conf.chat_id)return sendJson(res,409,{error:'Сначала привяжите группу'});
   const result=await require('./telegram').sendToChat(conf.chat_id,'🐾 ХвостМаркет: проверка связи с Клубом партнёров успешна. Автоматические рассылки выключены.');
   sendJson(res,result.ok?200:502,{ok:!!result.ok,error:result.ok?undefined:'Telegram не подтвердил отправку',automatic_delivery:false});
 });

 // Manual publication is always moderated and works even with scheduled broadcasts off.
 router.post('/api/admin/partner-club/manual',async(req,res,ctx)=>{
   const admin=requireSuperAdmin(req,res,ctx);if(!admin)return;
   const cfg=settings();
   if(!cfg.chat_id)return sendJson(res,409,{error:'Сначала подключите Telegram-группу'});
   if(Number(cfg.reviewer_admin_id)!==Number(admin.id))return sendJson(res,409,{error:'Нажмите «Подключить модерацию» для своего личного Telegram'});
   const reviewer=reviewerForClub();
   if(!reviewer)return sendJson(res,409,{error:'Telegram модератора не привязан к кабинету супер-администратора'});
   const body=String(ctx.body?.message||'').trim();
   if(!body||body.length>3000)return sendJson(res,400,{error:'Сообщение должно содержать от 1 до 3000 символов'});
   if(!process.env.TG_TOKEN)return sendJson(res,503,{error:'Telegram-бот не настроен'});
   const key='manual:'+require('node:crypto').randomUUID();
   const inserted=db.prepare("INSERT INTO partner_club_events(event_key,event_type,message,status) VALUES(?,'manual',?,'draft')").run(key,body);
   const id=Number(inserted.lastInsertRowid);
   const formatted=safeMarkdownHtml(body);
   saveClubFormat(id,formatted);
   const preview='🐾 <b>Ручная публикация в Клуб партнёров #'+id+'</b>\n\n'+formatted;
   const sent=await require('./telegram').sendToChat(reviewer,preview,{reply_markup:reviewButtons(id,false,true,false)});
   if(!sent.ok){
     db.prepare('DELETE FROM partner_club_events WHERE id=?').run(id);
     return sendJson(res,502,{error:'Черновик не доставлен модератору. Проверьте личный Telegram и повторите попытку.'});
   }
   db.prepare("INSERT INTO partner_club_reviews(event_id,state,reviewer_chat_id,requested_at) VALUES(?,'pending',?,CURRENT_TIMESTAMP)").run(id,reviewer);
   sendJson(res,200,{ok:true,id,message:'Черновик отправлен в ваш личный Telegram. В группе он появится только после нажатия «Отправить в группу».',published:false});
 });
 router.post('/api/admin/partner-club/preview',(req,res,ctx)=>{if(!auth(req,res,ctx))return;const msg=preview(String(ctx.body?.type||'sales'),ctx.body?.data);if(!msg)return sendJson(res,400,{error:'Неизвестный тип'});sendJson(res,200,{message:msg,delivered:false});});
 router.get('/api/admin/partner-club/analytics',(req,res,ctx)=>{if(!auth(req,res,ctx))return;const p=ctx.query.period||'yesterday';if(!['today','yesterday','week'].includes(p))return sendJson(res,400,{error:'Недопустимый период'});sendJson(res,200,analytics(p));});
 router.get('/api/admin/partner-club/top-products',(req,res,ctx)=>{if(!auth(req,res,ctx))return;const period=ctx.query.period||'week';if(!['week','all'].includes(period))return sendJson(res,400,{error:'Недопустимый период'});sendJson(res,200,topProducts(period));});
 router.get('/api/admin/partner-club/events',(req,res,ctx)=>{if(!auth(req,res,ctx))return;const limit=Math.min(100,Math.max(1,Number(ctx.query.limit)||30));sendJson(res,200,{events:db.prepare('SELECT * FROM partner_club_events ORDER BY id DESC LIMIT ?').all(limit),delivery_enabled:false});});
 router.post('/api/admin/partner-club/generate-report',async(req,res,ctx)=>{
    if(!auth(req,res,ctx))return;
    const mapped={daily:'clubdaily',weekly:'clubweekly',top_products_week:'clubtopweek',top_products_all:'clubtopall'};
    const type=mapped[ctx.body?.type];
    if(!type)return sendJson(res,400,{error:'Неизвестный тип отчёта'});
    const reviewer=reviewerForClub();
    if(!reviewer)return sendJson(res,409,{error:'Сначала подключите личный Telegram модератора Клуба партнёров'});
    const approval=await require('./report-approvals').requestReport(reviewer,type);
    sendJson(res,approval.ok?202:502,approval.ok?{ok:true,pending:true,message:approval.message}:{error:approval.error});
  });

}
db.exec("CREATE TABLE IF NOT EXISTS partner_club_delivery_log(event_id INTEGER PRIMARY KEY, delivered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
db.exec("CREATE TABLE IF NOT EXISTS partner_club_reviews(event_id INTEGER PRIMARY KEY, state TEXT NOT NULL DEFAULT 'pending', reviewer_chat_id TEXT, edited_message TEXT, requested_at TEXT, claimed_at TEXT)");
db.exec("CREATE TABLE IF NOT EXISTS partner_club_bot_inputs(chat_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('new','edit')), event_id INTEGER, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
db.exec("CREATE TABLE IF NOT EXISTS partner_club_message_formats(event_id INTEGER PRIMARY KEY REFERENCES partner_club_events(id) ON DELETE CASCADE,message_html TEXT,edited_html TEXT)");
// Persistent congratulations picked by the moderator. Do not modify sale records
// (including product, salon or amount), or lose the selected ending on restart.
db.exec("CREATE TABLE IF NOT EXISTS partner_club_sale_endings_override(event_id INTEGER PRIMARY KEY REFERENCES partner_club_events(id) ON DELETE CASCADE, ending_index INTEGER NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
const escapeHtml=v=>String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function richPost(rawText, entities=[], offset=0){
 const raw=String(rawText||'');
 const selected=raw.slice(offset),plain=selected.trim();
 const left=raw.indexOf(plain,offset);
 const safeStart=left>=0?left:offset;
 const valid=(Array.isArray(entities)?entities:[]).map(entity=>{
   const from=Math.max(safeStart, Number(entity?.offset));
   const to=Math.min(safeStart+plain.length,Number(entity?.offset)+Number(entity?.length));
   return {...entity,offset:from-safeStart,length:to-from};
 }).filter(e=>Number.isInteger(e.offset)&&Number.isInteger(e.length)&&e.length>0);
 return {plain,html:htmlFromTelegramEntities(plain,valid)};
}
function saveClubFormat(id,messageHtml,edited=false){
 db.prepare("INSERT INTO partner_club_message_formats(event_id,message_html,edited_html) VALUES(?,?,?) ON CONFLICT(event_id) DO UPDATE SET message_html=COALESCE(excluded.message_html,partner_club_message_formats.message_html),edited_html=COALESCE(excluded.edited_html,partner_club_message_formats.edited_html)")
   .run(id,edited?null:messageHtml,edited?messageHtml:null);
}
function clubMessageHtml(event){
 const rich=db.prepare('SELECT message_html,edited_html FROM partner_club_message_formats WHERE event_id=?').get(event.id);
 // A moderator's edits and saved rich formatting always take precedence.
 if (event.edited_message) return rich?.edited_html || safeMarkdownHtml(event.edited_message);
 if (rich?.message_html) return rich.message_html;
 // The chosen congratulation is stored separately from the purchase details.
 if (event.event_type === 'sales') {
   const chosen=db.prepare('SELECT ending_index FROM partner_club_sale_endings_override WHERE event_id=?').get(event.id);
   const index=chosen?.ending_index;
   const changed=Number.isSafeInteger(index) ? withSaleEnding(event.message, SALE_ENDINGS[index]) : null;
   return saleMessageHtml(changed || event.message);
 }
 // Older drafts and first sales keep the same paragraph spacing and bold salon.
 if (event.event_type === 'first_sale' || event.event_type === 'record_check' || event.event_type === 'record_day') return saleMessageHtml(event.message);
 return safeMarkdownHtml(event.message);
}

function reviewerForClub(){
 const c=settings();
 if(!c.reviewer_admin_id)return null;
 const r=db.prepare("SELECT telegram_chat_id,role,active FROM admins WHERE id=?").get(c.reviewer_admin_id);
 return r&&r.role==='super'&&r.active&&r.telegram_chat_id?String(r.telegram_chat_id):null;
}
function isClubModerator(chatId){return !!chatId&&String(chatId)===reviewerForClub();}
function reviewButtons(id, canChangeGreeting=false, manual=false, hasPhotos=false){
 return {inline_keyboard:[
   ...(canChangeGreeting ? [[{text:'🔄 Другое поздравление',callback_data:'club:reroll:'+id}]] : []),
   ...(manual ? [[{text:'📷 Добавить фотографии',callback_data:'club:addphoto:'+id},
     ...(hasPhotos ? [{text:'🗑 Убрать фотографии',callback_data:'club:clearphotos:'+id}] : [])]] : []),
   [{text:'✅ Отправить в группу',callback_data:'club:send:'+id},
    {text:'✏️ Скорректировать',callback_data:'club:edit:'+id}],
   [{text:'🚫 Отклонить',callback_data:'club:reject:'+id}]
 ]};
}

// The same preview is used after creating a post and after updating its photos.
async function sendClubReviewPreview(chatId, id, title='Черновик для Клуба партнёров'){
 const event=db.prepare('SELECT e.*,r.edited_message FROM partner_club_events e LEFT JOIN partner_club_reviews r ON r.event_id=e.id WHERE e.id=?').get(Number(id));
 if(!event)return {ok:false,error:'Черновик не найден'};
 const photos=clubPhotos.getEventPhotos(id);
 const manual=event.event_type==='manual';
 const markup=reviewButtons(id, false, manual, photos.length>0);
 const caption='🐾 <b>'+title+' #'+id+'</b>\n\n'+clubMessageHtml(event);
 const sender=require('./telegram');
 if(!photos.length)return sender.sendToChat(chatId,caption,{reply_markup:markup});
 const result=await sender.sendPhotosToChat(chatId,photos,caption,{
   ...(photos.length===1?{reply_markup:markup}:{})
 });
 if(!result.ok)return result;
 if(photos.length===1)return result;
 const buttons=await sender.sendToChat(chatId,
   '📷 Альбом из '+photos.length+' фото для черновика #'+id+
   '. Посмотрите альбом выше и подтвердите публикацию кнопками ниже.',
   {reply_markup:markup});
 // Avoid creating a second image post if the button message fails; caller can
 // ask the moderator to restart preview rather than silently publishing it.
 return buttons;
}

async function handleClubCallback(chatId,data){
 if(!/^club:(send|edit|reject|reroll):[0-9]+$/.test(data))return null;
 if(String(chatId)!==reviewerForClub())return {message:'Недостаточно прав',ok:false};
 const [,action,idText]=data.split(':');const id=Number(idText);
 const row=db.prepare("SELECT e.*,r.state,r.edited_message FROM partner_club_events e JOIN partner_club_reviews r ON r.event_id=e.id WHERE e.id=?").get(id);
 if(!row||row.state==='sent'||row.state==='rejected')return {message:'Этот черновик уже обработан',ok:false};
 if(row.state==='sending')return {message:'Публикация уже обрабатывается. Проверьте сообщения группы.',ok:false};
 if(clubPhotos.currentPhotoDraft(chatId)?.event_id===id)
   return {ok:false,message:'Сначала завершите прикрепление фотографий кнопкой «📷 Готово» либо отмените добавление.'};
 if(action==='reroll'){
   if(row.event_type!=='sales' || row.state!=='pending' || row.edited_message)
     return {ok:false,message:'Поздравление можно менять только в неотредактированном черновике обычной продажи.'};
   const previous=db.prepare('SELECT ending_index FROM partner_club_sale_endings_override WHERE event_id=?').get(id);
   // Respect the current ending, including a ten-ending draft created by an older version.
   const lastLine=String(row.message||'').trim().split(/\r?\n/).pop()?.trim();
   const initial=SALE_ENDINGS.indexOf(lastLine);
   const current=Number.isSafeInteger(previous?.ending_index) ? previous.ending_index : initial;
   const next=(current+1)%SALE_ENDINGS.length;
   if(!withSaleEnding(row.message,SALE_ENDINGS[next]))
     return {ok:false,message:'Не удалось найти поздравление в этом черновике. Используйте «Скорректировать».'};
   db.prepare("INSERT INTO partner_club_sale_endings_override(event_id,ending_index) VALUES(?,?) ON CONFLICT(event_id) DO UPDATE SET ending_index=excluded.ending_index,updated_at=CURRENT_TIMESTAMP").run(id,next);
   const preview='🐾 <b>Черновик для Клуба партнёров #'+id+'</b>\n\n'+clubMessageHtml(row);
   return {ok:true,rerolled:true,message:'🔄 Поздравление изменено (вариант '+(next+1)+' из '+SALE_ENDINGS.length+').',preview_html:preview,reply_markup:reviewButtons(id,true)};
 }
 if(action==='edit'){
   db.prepare("UPDATE partner_club_reviews SET state='editing' WHERE event_id=?").run(id);
   setClubInput(chatId,'edit',id);
   return {ok:true,message:'✏️ Отправьте следующим сообщением исправленный текст для черновика #'+id+'. Команда /cancel отменит редактирование.'};
 }
 if(action==='reject'){
   db.prepare("UPDATE partner_club_reviews SET state='rejected' WHERE event_id=? AND state IN ('pending','editing')").run(id);
   cancelClubInput(chatId);
   return {ok:true,message:'🚫 Публикация отклонена.'};
 }
 const c=settings();
 if(!c.chat_id || (!c.enabled && row.event_type!=='manual'))return {ok:false,message:'Рассылка выключена в админке'};
 // A refunded or deleted record-holder must not be celebrated after approval.
 if(row.event_type==='record_check'){
   const recordedOrderId=Number(String(row.event_key).replace(/^record-check:/,''));
   const recordedOrder=db.prepare('SELECT status,refund_status FROM orders WHERE id=?').get(recordedOrderId);
   if(!recordedOrder||recordedOrder.status!=='paid'||recordedOrder.refund_status==='refunded')
     return {ok:false,message:'Публикация заблокирована: рекордный заказ отменён или возвращён.'};
 }
 if(row.event_type==='record_day' && !dailyRecords.validate(row.event_key))
   return {ok:false,message:'Продажи изменились после создания черновика. Рекорд больше не актуален — публикация заблокирована.'};
 if(row.event_type==='sales'&&c.sales_mode==='limit'){
   const count=db.prepare("SELECT COUNT(*) n FROM partner_club_delivery_log WHERE delivered_at>=datetime('now','-1 hour')").get().n;
   if(count>=5)return {ok:false,message:'Лимит 5 публикаций за час достигнут. Можно подтвердить позднее.'};
 }
 if(row.state==='editing')return {ok:false,message:'Сначала отправьте исправленный текст черновика.'};
 const claimed=db.prepare("UPDATE partner_club_reviews SET state='sending',claimed_at=CURRENT_TIMESTAMP WHERE event_id=? AND state='pending'").run(id);
 if(!claimed.changes)return {ok:false,message:'Черновик сейчас недоступен для отправки.'};
 const message=clubMessageHtml(row);
 const photos=clubPhotos.getEventPhotos(id);
 let result;
 try{
   result=photos.length
     ? await require('./telegram').sendPhotosToChat(c.chat_id,photos,message)
     : await require('./telegram').sendToChat(c.chat_id,message);
 }catch(error){
   // After an exception on a photo request, Telegram might have accepted the
   // album already. Do not allow a blind retry that could duplicate photos.
   result={ok:false,uncertain:photos.length>0,error:error.message};
 }
 if(!result.ok||result.data?.ok===false){
   if(result.uncertain){
     return {ok:false,message:'⚠️ Telegram не подтвердил результат отправки фото. Повторная отправка заблокирована во избежание дублирования. Проверьте группу.'};
   }
   db.prepare("UPDATE partner_club_reviews SET state='pending' WHERE event_id=? AND state='sending'").run(id);
   return {ok:false,message:'Telegram не подтвердил публикацию. Попробуйте ещё раз.'};
 }
 db.prepare("UPDATE partner_club_reviews SET state='sent' WHERE event_id=?").run(id);
 db.prepare("INSERT OR IGNORE INTO partner_club_delivery_log(event_id) VALUES(?)").run(id);
 cancelClubInput(chatId);
 return {ok:true,message:'✅ Опубликовано в группе.'};
}
async function handleClubEdit(chatId,text,entities=[]){
 const match=String(text||'').match(/^\/clubtext(?:@\w+)?\s+(\d+)\s+([\s\S]+)$/i);
 if(!match)return null;
 if(String(chatId)!==reviewerForClub())return {ok:false,message:'Недостаточно прав'};
 const id=Number(match[1]);
 const formatted=richPost(text,entities,String(text).length-match[2].length);
 const body=formatted.plain;
 if(!body||body.length>3000)return {ok:false,message:'Длина текста должна быть от 1 до 3000 символов'};
 if(clubPhotos.getEventPhotos(id).length && !clubPhotos.formattedOk(formatted))
   return {ok:false,message:'Для сообщения с фото текст должен быть не длиннее 850 символов (с учётом форматирования).'};
 const entry=db.prepare("SELECT state FROM partner_club_reviews WHERE event_id=?").get(id);
 if(!entry||entry.state!=='editing')return {ok:false,message:'Черновик не находится на редактировании'};
 db.prepare("UPDATE partner_club_reviews SET edited_message=?,state='pending' WHERE event_id=?").run(body,id);
 saveClubFormat(id,formatted.html,true);
 cancelClubInput(chatId);
 if(clubPhotos.getEventPhotos(id).length){
   const refreshed=await sendClubReviewPreview(chatId,id,'Исправленный черновик для Клуба партнёров');
   return {ok:!!refreshed.ok,message:refreshed.ok
     ? '📝 Текст обновлён, фотографии сохранены. Проверьте предпросмотр выше.'
     : 'Текст обновлён, но предпросмотр не доставлен. Фото и текст сохранены.'};
 }
 return {ok:true,message:'📝 Обновлённый черновик:\n\n'+formatted.html,reply_markup:reviewButtons(id,false,true),parse_mode:'HTML'};
}
function setClubInput(chatId,mode,eventId=null){
 db.prepare("INSERT INTO partner_club_bot_inputs(chat_id,mode,event_id,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(chat_id) DO UPDATE SET mode=excluded.mode,event_id=excluded.event_id,updated_at=CURRENT_TIMESTAMP")
   .run(String(chatId),mode,eventId);
}
function cancelClubInput(chatId){
 const images=clubPhotos.clearPhotoDraft(chatId);
 const input=db.prepare('DELETE FROM partner_club_bot_inputs WHERE chat_id=?')
   .run(String(chatId)).changes>0;
 return images||input;
}
function startClubPost(chatId){
 if(!isClubModerator(chatId))return {ok:false,message:'Эта команда доступна только назначенному модератору Клуба партнёров.'};
 if(!settings().chat_id)return {ok:false,message:'Сначала подключите Telegram-группу в админке.'};
 const prev=db.prepare('SELECT mode,event_id FROM partner_club_bot_inputs WHERE chat_id=?').get(String(chatId));
 if(prev?.mode==='edit')db.prepare("UPDATE partner_club_reviews SET state='pending' WHERE event_id=? AND state='editing'").run(prev.event_id);
 setClubInput(chatId,'new');
 clubPhotos.beginPhotoDraft(chatId);
 return {ok:true,message:'✍️ Новое сообщение для Клуба партнёров.\n\nПришлите текст, одну фотографию или альбом (до 10 фото). Фото можно загрузить прямо из галереи Telegram — их не нужно добавлять в каталог.\n\nТекст без фотографий — до 3000 символов; с фото — до 850 символов. Можно прислать подпись вместе с первым фото.\n\nПосле фото нажмите «Готово» или отправьте текст сообщением. Бот покажет предпросмотр и кнопки согласования.\n\n/cancel — отмена.'};
}
async function handleClubPostInput(chatId,text,entities=[]){
 const pending=db.prepare('SELECT mode,event_id FROM partner_club_bot_inputs WHERE chat_id=?').get(String(chatId));
 if(!pending)return null;
 if(!isClubModerator(chatId)){cancelClubInput(chatId);return {ok:false,message:'Нет доступа к публикациям Клуба партнёров.'};}
 if(/^\/cancel(?:@\w+)?$/i.test(text.trim())){
   if(pending.mode==='edit')db.prepare("UPDATE partner_club_reviews SET state='pending' WHERE event_id=? AND state='editing'").run(pending.event_id);
   cancelClubInput(chatId);return {ok:true,message:'Действие отменено. Черновик в группу не опубликован.'};
 }
 if(/^\/[a-z]/i.test(text.trim()))return null;
 const formatted=richPost(text,entities);
 const body=formatted.plain;
 if(body.length<1||body.length>3000)return {ok:false,message:'Отправьте текст длиной от 1 до 3000 символов.'};
 const staged=clubPhotos.currentPhotoDraft(chatId);
 if(pending.mode==='new'&&staged?.photos.length&&!clubPhotos.formattedOk(formatted))
   return {ok:false,message:'К фотографиям можно прикрепить текст до 850 символов с учётом жирного шрифта и других выделений.'};
 if(pending.mode==='edit'){
   const id=pending.event_id;
   if(clubPhotos.getEventPhotos(id).length&&!clubPhotos.formattedOk(formatted))
     return {ok:false,message:'Для поста с фотографиями сократите текст до 850 символов.'};
   const changed=db.prepare("UPDATE partner_club_reviews SET edited_message=?,state='pending' WHERE event_id=? AND state='editing'").run(body,id);
   cancelClubInput(chatId);
   if(!changed.changes)return {ok:false,message:'Редактирование этого черновика уже завершено.'};
   saveClubFormat(id,formatted.html,true);
   if(clubPhotos.getEventPhotos(id).length){
     const refreshed=await sendClubReviewPreview(chatId,id,'Исправленный черновик для Клуба партнёров');
     return {ok:!!refreshed.ok,message:refreshed.ok
       ? '📝 Текст черновика #'+id+' обновлён, фото сохранены. Проверьте предпросмотр выше.'
       : 'Текст обновлён, но предпросмотр не доставлен. Фото и текст сохранены.'};
   }
   return {ok:true,message:'📝 Исправленный текст черновика #'+id+':\n\n'+formatted.html,reply_markup:reviewButtons(id,false,true),parse_mode:'HTML'};
 }
 if(!settings().chat_id){cancelClubInput(chatId);return {ok:false,message:'Telegram-группа не подключена.'};}
 const key='manual:bot:'+require('node:crypto').randomUUID();
 const created=db.prepare("INSERT INTO partner_club_events(event_key,event_type,message,status) VALUES(?,'manual',?,'draft')").run(key,body);
 const id=Number(created.lastInsertRowid);
 saveClubFormat(id,formatted.html);
 const photos=staged?.photos||[];
 if(photos.length)clubPhotos.attachEventPhotos(id,photos);
 const sent=await sendClubReviewPreview(chatId,id);
 if(!sent.ok||sent.data?.ok===false){
   db.prepare('DELETE FROM partner_club_event_photos WHERE event_id=?').run(id);
   db.prepare('DELETE FROM partner_club_message_formats WHERE event_id=?').run(id);
   db.prepare('DELETE FROM partner_club_events WHERE id=?').run(id);
   return {ok:false,message:'Не удалось доставить предпросмотр. В группу ничего не отправлено. Повторите публикацию.'};
 }
 db.prepare("INSERT INTO partner_club_reviews(event_id,state,reviewer_chat_id,requested_at) VALUES(?,'pending',?,CURRENT_TIMESTAMP)").run(id,String(chatId));
 cancelClubInput(chatId);
 return {ok:true,message:'✅ Черновик #'+id+' готов. Для публикации нажмите «Отправить в группу» под предпросмотром.'};
}
// Photos can arrive in a standalone Telegram message or as a media group.
// During a group album, only the first photo gets a response to avoid floods.
async function handleClubPhotoMessage(message){
 if(message?.chat?.type!=='private'||!Array.isArray(message.photo)||!message.photo.length)return null;
 const chatId=message.chat.id;
 if(!isClubModerator(chatId))return null;
 const pending=db.prepare('SELECT mode FROM partner_club_bot_inputs WHERE chat_id=?').get(String(chatId));
 const staging=clubPhotos.currentPhotoDraft(chatId);
 if(!staging && pending?.mode!=='new')return null;
 if(staging?.event_id == null&&pending?.mode!=='new')return null;
 const ids=clubPhotos.photoIdsFromMessage(message);
 if(!ids.length)return {ok:false,message:'Не удалось прочитать фотографию. Попробуйте отправить её как фото, а не документ.'};
 const formatted=message.caption&&staging?.event_id==null
   ? richPost(message.caption,message.caption_entities||[]) : null;
 const added=clubPhotos.stagePhoto(chatId,ids[0],formatted);
 if(!added.ok)return {ok:false,message:added.error};
 if(message.media_group_id && !added.first)return {ok:true,silent:true};
 const controls=staging?.event_id!=null
   ? {inline_keyboard:[
       [{text:'✅ Готово — сохранить фото',callback_data:'club:photosdone'}],
       [{text:'↩️ Отменить добавление',callback_data:'club:cancelphotos'}],
     ]}
   : {inline_keyboard:[
       [{text:'✅ Готово — показать черновик',callback_data:'club:done'}],
       [{text:'🚫 Отменить публикацию',callback_data:'club:cancelphotos'}],
     ]};
 return {ok:true,message:'📷 Фото добавлено ('+added.total+'/10). Можно прислать ещё фотографии.'+
   (staging?.event_id!=null?' После загрузки нажмите «Готово».':' Можно прислать текст отдельным сообщением или нажать «Готово».'),
   reply_markup:controls};
}

// Separate photo callbacks cannot collide with ordinary sale approvals.
async function handleClubPhotoCallback(chatId,action){
 if(!isClubModerator(chatId))return {ok:false,message:'Нет доступа к публикациям Клуба партнёров.'};
 const value=String(action||'');
 if(value==='club:cancelphotos'){
   const stage=clubPhotos.currentPhotoDraft(chatId);
   if(!stage)return {ok:false,message:'Фото не добавлялись.'};
   if(stage.event_id==null){
     cancelClubInput(chatId);
     return {ok:true,message:'🚫 Черновик отменён. Ничего не опубликовано.'};
   }
   clubPhotos.clearPhotoDraft(chatId);
   return {ok:true,message:'Добавление фотографий отменено; прежний черновик сохранён.'};
 }
 if(value==='club:done'){
   const input=db.prepare('SELECT mode FROM partner_club_bot_inputs WHERE chat_id=?').get(String(chatId));
   const draft=clubPhotos.currentPhotoDraft(chatId);
   if(input?.mode!=='new'||!draft||draft.event_id!=null)return {ok:false,message:'Нет активной подготовки публикации.'};
   if(!draft.photos.length)return {ok:false,message:'Сначала прикрепите фотографии.'};
   if(!draft.post_text)return {ok:false,message:'Пришлите текст сообщения (до 850 символов) и затем подтвердите черновик.'};
   // Preserve Telegram formatting stored from a photo's caption.
   return createClubPhotoDraft(chatId,draft);
 }
 const add=value.match(/^club:addphoto:(\d+)$/);
 const clear=value.match(/^club:clearphotos:(\d+)$/);
 if(add||clear){
   const id=Number((add||clear)[1]);
   const row=db.prepare("SELECT e.id,e.event_type,r.state FROM partner_club_events e JOIN partner_club_reviews r ON r.event_id=e.id WHERE e.id=?").get(id);
   if(!row||row.event_type!=='manual'||row.state!=='pending')
     return {ok:false,message:'Фотографии можно изменить только в неотправленном ручном сообщении.'};
   if(add){
     const event=db.prepare("SELECT e.*,r.edited_message FROM partner_club_events e JOIN partner_club_reviews r ON r.event_id=e.id WHERE e.id=?").get(id);
     if(clubMessageHtml(event).length>clubPhotos.MAX_PHOTO_CAPTION_HTML)
       return {ok:false,message:'Сначала сократите текст до 850 символов через «Скорректировать», затем добавьте фото.'};
     if(clubPhotos.getEventPhotos(id).length>=clubPhotos.MAX_PHOTOS)
       return {ok:false,message:'У черновика уже 10 фотографий. Сначала удалите вложения.'};
     clubPhotos.beginPhotoDraft(chatId,id);
     return {ok:true,message:'📷 Пришлите в этот чат новые фотографии (до 10 всего, альбомом или по одной). По окончании нажмите «Готово».',
       reply_markup:{inline_keyboard:[
         [{text:'✅ Готово — сохранить фото',callback_data:'club:photosdone'}],
         [{text:'↩️ Отменить добавление',callback_data:'club:cancelphotos'}]
       ]}};
   }
   clubPhotos.clearEventPhotos(id);
   const result=await sendClubReviewPreview(chatId,id);
   return {ok:result.ok,message:result.ok?'🗑 Фотографии удалены. Обновлённый черновик показан выше.':
     'Не удалось обновить предпросмотр. Текст не потерян.'};
 }
 if(value==='club:photosdone'){
   const draft=clubPhotos.currentPhotoDraft(chatId);
   if(!draft||draft.event_id==null)return {ok:false,message:'Нет прикрепляемых фотографий.'};
   const id=Number(draft.event_id);
   const row=db.prepare("SELECT e.event_type,r.state FROM partner_club_events e JOIN partner_club_reviews r ON r.event_id=e.id WHERE e.id=?").get(id);
   if(!row||row.event_type!=='manual'||row.state!=='pending')
     return {ok:false,message:'Этот черновик нельзя изменять.'};
   if(!draft.photos.length)return {ok:false,message:'Сначала пришлите хотя бы одну фотографию.'};
   const added=clubPhotos.attachEventPhotos(id,draft.photos);
   if(!added.ok)return {ok:false,message:added.error};
   clubPhotos.clearPhotoDraft(chatId);
   const result=await sendClubReviewPreview(chatId,id);
   return {ok:result.ok,message:result.ok?'✅ Добавлено фото: '+added.total+'. Черновик готов к согласованию.':
     'Фотографии сохранены, но предпросмотр не доставлен. Попробуйте открыть черновик снова.'};
 }
 return {ok:false,message:'Неизвестное действие.'};
}

async function createClubPhotoDraft(chatId,draft){
 if(!draft?.post_text||!clubPhotos.formattedOk({plain:draft.post_text,html:draft.post_html||''}))
   return {ok:false,message:'Добавьте короткий текст с подписью (до 850 символов).'};
 if(!settings().chat_id)return {ok:false,message:'Сначала подключите Клуб партнёров.'};
 const id=Number(db.prepare("INSERT INTO partner_club_events(event_key,event_type,message,status) VALUES(?,'manual',?,'draft')")
   .run('manual:bot:'+require('node:crypto').randomUUID(),draft.post_text).lastInsertRowid);
 saveClubFormat(id,draft.post_html);
 clubPhotos.attachEventPhotos(id,draft.photos);
 const sent=await sendClubReviewPreview(chatId,id);
 if(!sent.ok){
   db.prepare('DELETE FROM partner_club_event_photos WHERE event_id=?').run(id);
   db.prepare('DELETE FROM partner_club_message_formats WHERE event_id=?').run(id);
   db.prepare('DELETE FROM partner_club_events WHERE id=?').run(id);
   return {ok:false,message:'Не удалось показать предпросмотр. В группу ничего не отправлено.'};
 }
 db.prepare("INSERT INTO partner_club_reviews(event_id,state,reviewer_chat_id,requested_at) VALUES(?,'pending',?,CURRENT_TIMESTAMP)")
   .run(id,String(chatId));
 cancelClubInput(chatId);
 return {ok:true,message:'✅ Черновик #'+id+' готов. Для отправки нажмите кнопку под фотографией или альбомом выше.'};
}

// An idle partner club no longer scans SQLite every 30 seconds. A new sale
// wakes the moderator promptly; a five-minute safety pass recovers drafts
// after restarts and checks the completed Krasnoyarsk calendar day.
const CLUB_IDLE_MS=5*60*1000;
const CLUB_RETRY_MS=30*1000;
const CLUB_WAKE_MS=250;
let workerBusy=false,workerStarted=false,workerTimer=null,workerDueAt=0,workerWakeRequested=false;
function scheduleClubWorker(delayMs){
 if(!workerStarted)return;
 const wait=Math.max(0,delayMs);
 const due=Date.now()+wait;
 if(workerTimer&&workerDueAt<=due)return; // keep the earlier wake-up
 if(workerTimer)clearTimeout(workerTimer);
 workerDueAt=due;
 workerTimer=setTimeout(()=>{
   workerTimer=null;workerDueAt=0;
   void runClubWorker();
 },wait);
 workerTimer.unref?.();
}
function wakeClubWorker(){
 if(!workerStarted)return;
 if(workerBusy){workerWakeRequested=true;return;}
 scheduleClubWorker(CLUB_WAKE_MS);
}
async function sendClubUpdates(){
 if(workerBusy)return {hasMore:true};
 const cfg=settings();if(!cfg.enabled||!cfg.chat_id||!cfg.club_started_at)return {hasMore:false};
 const reviewer=reviewerForClub();if(!reviewer)return {hasMore:false};
 workerBusy=true;
 try{
  trackSync('club_daily_record',()=>dailyRecords.checkYesterday(new Date(),cfg,queue));
  // Disabled event types must not occupy the first five rows and hide new
  // sales. The query params come from fixed, known setting keys only.
  const enabled=FLAGS.filter(type=>cfg[type]===true);
  if(!enabled.length)return {hasMore:false};
  const placeholders=enabled.map(()=>'?').join(',');
  const events=db.prepare(
    "SELECT e.* FROM partner_club_events e LEFT JOIN partner_club_reviews r ON r.event_id=e.id "+
    "WHERE r.event_id IS NULL AND e.created_at>=? AND e.status='draft' "+
    "AND e.event_type IN ("+placeholders+") ORDER BY e.id LIMIT 6"
  ).all(cfg.club_started_at,...enabled);
  for(const ev of events.slice(0,5)){
   const latest=settings();
   if(!latest.enabled)return {hasMore:false};
   if(!latest[ev.event_type])continue;
   const message='🐾 <b>Черновик для Клуба партнёров #'+ev.id+'</b>\n\n'+clubMessageHtml(ev);
   const result=await require('./telegram').sendToChat(reviewer,message,{reply_markup:reviewButtons(ev.id,ev.event_type==='sales')});
   if(!result.ok)return {retry:true};
   db.prepare("INSERT OR IGNORE INTO partner_club_reviews(event_id,state,reviewer_chat_id,requested_at) VALUES(?,'pending',?,CURRENT_TIMESTAMP)").run(ev.id,reviewer);
  }
  return {hasMore:events.length>5};
 }catch(e){
  console.warn('Partner club moderation:',e.message);
  return {retry:true};
 }finally{workerBusy=false}
}
async function runClubWorker(){
 let outcome;
 try{outcome=await trackAsync('club_moderation',sendClubUpdates);}
 catch(e){console.warn('Partner club:',e.message);outcome={retry:true};}
 const wake=workerWakeRequested;
 workerWakeRequested=false;
 scheduleClubWorker(outcome?.retry?CLUB_RETRY_MS:
   outcome?.hasMore||wake?CLUB_WAKE_MS:CLUB_IDLE_MS);
}
function startPartnerClubWorker(){
 if(workerStarted)return;
 workerStarted=true;
 // A restart must recover queued drafts without waiting for five minutes.
 scheduleClubWorker(0);
}
function generateApprovedClubReport(type,{approved=false}={}){
  if(!approved)return {ok:false,error:'Сначала подтвердите формирование в Telegram'};
  const types={clubdaily:'daily',clubweekly:'weekly',clubtopweek:'top_products_week',clubtopall:'top_products_all'};
  const selected=types[type];
  if(!selected)return {ok:false,error:'Неизвестный отчёт'};
  const result=selected.startsWith('top_products_')
    ?topProductsMessage(selected==='top_products_week'?'week':'all'):report(selected);
  const key='report:'+selected+':'+new Date().toISOString().slice(0,10);
  return {ok:true,created:queue(key,selected,result.message),message:result.message};
}

module.exports={generateApprovedClubReport,registerPartnerClubRoutes,settings,preview,analytics,dailySalesRecords:dailyRecords.metrics,checkDailySalesRecord:(now)=>dailyRecords.checkYesterday(now,settings(),queue),report,topProducts,topProductsMessage,recordPaidOrder,welcomeNewPoint,startPartnerClubWorker,handleClubCallback,handleClubEdit,isClubModerator,startClubPost,handleClubPostInput,cancelClubInput,handleClubPhotoMessage,handleClubPhotoCallback,sendClubReviewPreview};
