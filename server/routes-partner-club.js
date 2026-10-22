// Partner Club: persistent configuration, paid-sale drafts, analytics and previews.
// Deliberately NO Telegram integration or outbound network activity.
'use strict';
const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireSuperAdmin } = require('./routes-auth');

const FLAGS=['sales','daily','weekly','milestones','new_points','tips','new_products','top_products_week','top_products_all'];
const DEFAULTS=Object.freeze({sales:true,daily:true,weekly:true,milestones:true,new_points:true,tips:false,new_products:false,top_products_week:true,top_products_all:false,sales_mode:'all',hourly_limit:5,include_groomer_names:false,enabled:false,chat_id:null});
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
function queue(key,type,message){return db.prepare("INSERT OR IGNORE INTO partner_club_events(event_key,event_type,message,status) VALUES (?,?,?,'draft')").run(key,type,message).changes>0;}
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
function recordPaidOrder(order,items,demo=false){
  if(demo||!order||order.status!=='paid'||order.refund_status==='refunded')return false;
  const point=db.prepare('SELECT id,name FROM points WHERE id=?').get(order.point_id);
  const product=items.map(i=>safeText(i.name)+(i.qty>1?' ×'+i.qty:'')).join(', ').slice(0,190)||'товар для питомца';
  const message='🐾 Новая покупка!\n🏪 '+venueType(point||{id:order.point_id})+': «'+safeText(point?.name||order.pickup_point||'Точка')+'»'+'\n🦴 '+product+'\n💚 '+money(order.total)+'\nСпасибо за покупку!';
  return queue('paid:'+order.id,'sales',message);
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
 return {period,...totals,points,groomers,top_product:top||null,calculation_note:'Период рассчитывается по дате создания оплаченного заказа (UTC в БД), а не по времени подтверждения оплаты'};
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
  case 'sales':return '🐾 Новая покупка!\n🏪 Партнёрская точка: «'+point+'»'+'\n🦴 '+item+'\n💚 '+money(amount);
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
  sendJson(res,200,{ok:true,settings:next,delivery_enabled:false});
 });
 // The club is an independent outbound channel; existing personal bot stays untouched.
 function clubStatus(){const c=settings();const drafts=db.prepare("SELECT COUNT(*) AS n FROM partner_club_events WHERE status='draft'").get().n;return {status:c.enabled?'running':c.chat_id?'stopped':'not_connected',status_label:c.enabled?'Работает':c.chat_id?'Остановлена':'Не подключён',running:!!c.enabled,connected:!!c.chat_id,can_start:!!c.chat_id&&!!process.env.TG_TOKEN,drafts,delivery_enabled:!!c.enabled,reason:c.enabled?'Рассылка активна':c.chat_id?'Группа готова. Рассылка отключена.':'Сначала подключите группу',personal_notifications_affected:false};}
 router.get('/api/admin/partner-club/status',(req,res,ctx)=>{if(!auth(req,res,ctx))return;sendJson(res,200,clubStatus());});
 router.post('/api/admin/partner-club/start',(req,res,ctx)=>{if(!auth(req,res,ctx))return;const c=settings();if(!c.chat_id||!process.env.TG_TOKEN)return sendJson(res,409,{error:'Группа не настроена'});db.prepare('INSERT INTO partner_club_settings(id,config_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,updated_at=CURRENT_TIMESTAMP').run(JSON.stringify({...c,enabled:true}));sendJson(res,200,{ok:true,...clubStatus()});});
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
 router.post('/api/admin/partner-club/preview',(req,res,ctx)=>{if(!auth(req,res,ctx))return;const msg=preview(String(ctx.body?.type||'sales'),ctx.body?.data);if(!msg)return sendJson(res,400,{error:'Неизвестный тип'});sendJson(res,200,{message:msg,delivered:false});});
 router.get('/api/admin/partner-club/analytics',(req,res,ctx)=>{if(!auth(req,res,ctx))return;const p=ctx.query.period||'yesterday';if(!['today','yesterday','week'].includes(p))return sendJson(res,400,{error:'Недопустимый период'});sendJson(res,200,analytics(p));});
 router.get('/api/admin/partner-club/top-products',(req,res,ctx)=>{if(!auth(req,res,ctx))return;const period=ctx.query.period||'week';if(!['week','all'].includes(period))return sendJson(res,400,{error:'Недопустимый период'});sendJson(res,200,topProducts(period));});
 router.get('/api/admin/partner-club/events',(req,res,ctx)=>{if(!auth(req,res,ctx))return;const limit=Math.min(100,Math.max(1,Number(ctx.query.limit)||30));sendJson(res,200,{events:db.prepare('SELECT * FROM partner_club_events ORDER BY id DESC LIMIT ?').all(limit),delivery_enabled:false});});
 router.post('/api/admin/partner-club/generate-report',(req,res,ctx)=>{if(!auth(req,res,ctx))return;const type=ctx.body?.type;if(!['daily','weekly','top_products_week','top_products_all'].includes(type))return sendJson(res,400,{error:'Неизвестный тип отчёта'});const result=type.startsWith('top_products_')?topProductsMessage(type==='top_products_week'?'week':'all'):report(type);const key='report:'+type+':'+(type==='daily'?new Date(Date.now()-86400000).toISOString().slice(0,10):new Date().toISOString().slice(0,10));const created=queue(key,type,result.message);sendJson(res,200,{created,message:result.message,stats:result.stats,delivered:false});});
}
module.exports={registerPartnerClubRoutes,settings,preview,analytics,report,topProducts,topProductsMessage,recordPaidOrder,welcomeNewPoint};
