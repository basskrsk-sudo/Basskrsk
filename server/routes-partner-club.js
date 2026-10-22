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
function settings(){let row=db.prepare('SELECT config_json FROM partner_club_settings WHERE id=1').get(),saved={};try{if(row)saved=JSON.parse(row.config_json)}catch(_){}
return {...DEFAULTS,...saved,enabled:false,chat_id:null,include_groomer_names:false};}
function money(n){return new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(Number(n)||0)+' ₽';}
function queue(key,type,message){return db.prepare("INSERT OR IGNORE INTO partner_club_events(event_key,event_type,message,status) VALUES (?,?,?,'draft')").run(key,type,message).changes>0;}
function safeText(v){return String(v||'').replace(/[<>\u0000-\u001f]/g,' ').trim().slice(0,100);}
function welcomeNewPoint(point) {
  if (!point || !point.id || !settings().new_points) return false;
  const name = safeText(point.name || 'Новый минимаркет');
  const city = point.city_id ? db.prepare('SELECT name FROM cities WHERE id=?').get(point.city_id)?.name : null;
  const message = [
    '🎉 Приветствуем нового партнёра ХвостМаркета!',
    '🏪 Минимаркет: «' + name + '»',
    city ? '📍 Город: ' + safeText(city) : '',
    '🐾 Наша сеть растёт! Желаем команде успешного старта, довольных клиентов и счастливых питомцев!',
    '💚 Добро пожаловать в Клуб партнёров!'
  ].filter(Boolean).join('\n');
  // Permanent idempotency key: further groomers at this point won't cause repeats.
  return queue('welcome:point:' + String(point.id), 'new_points', message);
}
function recordPaidOrder(order,items,demo=false){
  if(demo||!order||order.status!=='paid'||order.refund_status==='refunded')return false;
  const point=db.prepare('SELECT name FROM points WHERE id=?').get(order.point_id);
  const product=items.map(i=>safeText(i.name)+(i.qty>1?' ×'+i.qty:'')).join(', ').slice(0,190)||'товар для питомца';
  const message='🐾 Новая покупка!\n🏪 '+safeText(point?.name||order.pickup_point||'Минимаркет')+'\n🦴 '+product+'\n💚 '+money(order.total)+'\nСпасибо за покупку!';
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
  case 'sales':return '🐾 Новая покупка!\n🏪 '+point+'\n🦴 '+item+'\n💚 '+money(amount);
  case 'daily':return '☀️ Итоги вчерашнего дня\n🐾 Продаж: '+count+'\n💚 Выручка: '+money(amount)+'\nСпасибо партнёрам!';
  case 'weekly':return '🏆 Итоги недели\n🐾 Продаж: '+count+'\nОтмечаем достижения без публичного сравнения неактивных партнёров.';
  case 'milestones':return '🎉 Новый рекорд: '+count+' продаж!';
  case 'new_points':return '🎉 Новый партнёр сети: «'+point+'»!';
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
 if(type==='weekly'&&a.groomers.length)message+='\n🏅 Лидеры по продажам:\n'+a.groomers.slice(0,3).map((g,i)=>(i+1)+'. '+safeText(g.name)+' — '+g.sales).join('\n');
 return {message,stats:a};
}
function registerPartnerClubRoutes(router){
 const auth=(req,res,ctx)=>requireSuperAdmin(req,res,ctx);
 router.get('/api/admin/partner-club',(req,res,ctx)=>{if(!auth(req,res,ctx))return;sendJson(res,200,{settings:settings(),connected:false,delivery_enabled:false});});
 router.put('/api/admin/partner-club',(req,res,ctx)=>{if(!auth(req,res,ctx))return;
  const body=ctx.body||{},next=settings();
  if(body.enabled===true||body.chat_id) return sendJson(res,409,{error:'Подключение Telegram-чата заблокировано до отдельного решения'});
  for(const flag of FLAGS){if(Object.hasOwn(body,flag)){if(typeof body[flag]!=='boolean')return sendJson(res,400,{error:'Некорректное поле '+flag});next[flag]=body[flag];}}
  if(Object.hasOwn(body,'sales_mode')){if(!['all','limit','digest'].includes(body.sales_mode))return sendJson(res,400,{error:'Некорректная частота'});next.sales_mode=body.sales_mode;}
  next.enabled=false;next.chat_id=null;next.include_groomer_names=false;
  db.prepare('INSERT INTO partner_club_settings(id,config_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,updated_at=CURRENT_TIMESTAMP').run(JSON.stringify(next));
  sendJson(res,200,{ok:true,settings:next,delivery_enabled:false});
 });
 router.post('/api/admin/partner-club/preview',(req,res,ctx)=>{if(!auth(req,res,ctx))return;const msg=preview(String(ctx.body?.type||'sales'),ctx.body?.data);if(!msg)return sendJson(res,400,{error:'Неизвестный тип'});sendJson(res,200,{message:msg,delivered:false});});
 router.get('/api/admin/partner-club/analytics',(req,res,ctx)=>{if(!auth(req,res,ctx))return;const p=ctx.query.period||'yesterday';if(!['today','yesterday','week'].includes(p))return sendJson(res,400,{error:'Недопустимый период'});sendJson(res,200,analytics(p));});
 router.get('/api/admin/partner-club/top-products',(req,res,ctx)=>{if(!auth(req,res,ctx))return;const period=ctx.query.period||'week';if(!['week','all'].includes(period))return sendJson(res,400,{error:'Недопустимый период'});sendJson(res,200,topProducts(period));});
 router.get('/api/admin/partner-club/events',(req,res,ctx)=>{if(!auth(req,res,ctx))return;const limit=Math.min(100,Math.max(1,Number(ctx.query.limit)||30));sendJson(res,200,{events:db.prepare('SELECT * FROM partner_club_events ORDER BY id DESC LIMIT ?').all(limit),delivery_enabled:false});});
 router.post('/api/admin/partner-club/generate-report',(req,res,ctx)=>{if(!auth(req,res,ctx))return;const type=ctx.body?.type;if(!['daily','weekly','top_products_week','top_products_all'].includes(type))return sendJson(res,400,{error:'Неизвестный тип отчёта'});const result=type.startsWith('top_products_')?topProductsMessage(type==='top_products_week'?'week':'all'):report(type);const key='report:'+type+':'+(type==='daily'?new Date(Date.now()-86400000).toISOString().slice(0,10):new Date().toISOString().slice(0,10));const created=queue(key,type,result.message);sendJson(res,200,{created,message:result.message,stats:result.stats,delivered:false});});
}
module.exports={registerPartnerClubRoutes,settings,preview,analytics,report,topProducts,topProductsMessage,recordPaidOrder,welcomeNewPoint};
