// Partner Club: persistent configuration, paid-sale drafts, analytics and previews.
// Deliberately NO Telegram integration or outbound network activity.
'use strict';
const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireSuperAdmin } = require('./routes-auth');
const { safeMarkdownHtml, htmlFromTelegramEntities } = require('./telegram-formatting');
const { saleEndingAt } = require('./partner-club-sale-endings');
const { saleMessage, saleMessageHtml } = require('./partner-club-sale-format');

const FLAGS=['sales','first_sale','daily','weekly','milestones','new_points','tips','new_products','top_products_week','top_products_all'];
const DEFAULTS=Object.freeze({sales:true,first_sale:true,daily:true,weekly:true,milestones:true,new_points:true,tips:false,new_products:false,top_products_week:true,top_products_all:false,sales_mode:'all',hourly_limit:5,include_groomer_names:false,enabled:false,chat_id:null});
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
function recordPaidOrder(order,items,demo=false){
  if(demo||!order||order.status!=='paid'||order.refund_status==='refunded')return false;
  const point=order.point_id?db.prepare('SELECT id,name FROM points WHERE id=?').get(order.point_id):null;
  const product=(items||[]).map(i=>safeText(i.name)+(i.qty>1?' ×'+i.qty:'')).join(', ').slice(0,190)||'товар для питомца';
  const location='🏪 '+venueType(point||{id:order.point_id})+': «'+safeText(point?.name||order.pickup_point||'Точка')+'»';
  // First paid CUSTOMER order only. Other paid orders prevent retrospective greetings.
  // Permanent event key also prevents repeat milestones after restarts or order removal.
  if(point&&!order.is_partner_self_order&&settings().first_sale){
    const previous=db.prepare("SELECT 1 FROM orders WHERE point_id=? AND id<>? AND status='paid' AND COALESCE(is_partner_self_order,0)=0 LIMIT 1").get(point.id,order.id);
    if(!previous){
      const message=saleMessage('🎉 Первая продажа!',location,'🦴 '+product,
        '💚 '+money(order.total),
        '👏 Поздравляем команду с первым успехом! Отличный старт — дальше больше! 💪🐾');
      return queue('first-sale:point:'+String(point.id),'first_sale',message);
    }
  }
  const message=saleMessage('🐾 Новая покупка!',location,'🦴 '+product,
    '💚 '+money(order.total),nextSaleEnding());
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
  case 'sales':return saleMessage('🐾 Новая покупка!',
    '🏪 Партнёрская точка: «'+point+'»','🦴 '+item,'💚 '+money(amount),nextSaleEnding());
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
 router.post('/api/admin/partner-club/reviewer',(req,res,ctx)=>{const admin=requireSuperAdmin(req,res,ctx);if(!admin)return;const linked=db.prepare('SELECT telegram_chat_id FROM admins WHERE id=? AND role=?').get(admin.id,'super');if(!linked?.telegram_chat_id)return sendJson(res,409,{error:'Сначала подключите Telegram в кабинете супер-администратора'});const cfg={...settings(),reviewer_admin_id:admin.id};db.prepare('INSERT INTO partner_club_settings(id,config_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json').run(JSON.stringify(cfg));sendJson(res,200,{ok:true,message:'Черновики будут приходить в личный Telegram супер-администратора'});});
 router.get('/api/admin/partner-club/status',(req,res,ctx)=>{if(!auth(req,res,ctx))return;sendJson(res,200,clubStatus());});
 router.post('/api/admin/partner-club/start',(req,res,ctx)=>{if(!auth(req,res,ctx))return;const c=settings();if(!c.chat_id||!process.env.TG_TOKEN)return sendJson(res,409,{error:'Группа не настроена'});db.prepare('INSERT INTO partner_club_settings(id,config_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,updated_at=CURRENT_TIMESTAMP').run(JSON.stringify({...c,enabled:true,club_started_at:new Date().toISOString().slice(0,19).replace('T',' ')}));sendJson(res,200,{ok:true,...clubStatus()});});
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
   const sent=await require('./telegram').sendToChat(reviewer,preview,{reply_markup:reviewButtons(id)});
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
 router.post('/api/admin/partner-club/generate-report',(req,res,ctx)=>{if(!auth(req,res,ctx))return;const type=ctx.body?.type;if(!['daily','weekly','top_products_week','top_products_all'].includes(type))return sendJson(res,400,{error:'Неизвестный тип отчёта'});const result=type.startsWith('top_products_')?topProductsMessage(type==='top_products_week'?'week':'all'):report(type);const key='report:'+type+':'+(type==='daily'?new Date(Date.now()-86400000).toISOString().slice(0,10):new Date().toISOString().slice(0,10));const created=queue(key,type,result.message);sendJson(res,200,{created,message:result.message,stats:result.stats,delivered:false});});
}
db.exec("CREATE TABLE IF NOT EXISTS partner_club_delivery_log(event_id INTEGER PRIMARY KEY, delivered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
db.exec("CREATE TABLE IF NOT EXISTS partner_club_reviews(event_id INTEGER PRIMARY KEY, state TEXT NOT NULL DEFAULT 'pending', reviewer_chat_id TEXT, edited_message TEXT, requested_at TEXT, claimed_at TEXT)");
db.exec("CREATE TABLE IF NOT EXISTS partner_club_bot_inputs(chat_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('new','edit')), event_id INTEGER, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
db.exec("CREATE TABLE IF NOT EXISTS partner_club_message_formats(event_id INTEGER PRIMARY KEY REFERENCES partner_club_events(id) ON DELETE CASCADE,message_html TEXT,edited_html TEXT)");
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
 // Add line spacing and safe HTML <b> tags to automatic sale posts at delivery.
 // Older drafts get the same presentation without rewriting their DB records.
 if (event.event_type === 'sales' || event.event_type === 'first_sale')
   return saleMessageHtml(event.message);
 return safeMarkdownHtml(event.message);
}

function reviewerForClub(){
 const c=settings();
 if(!c.reviewer_admin_id)return null;
 const r=db.prepare("SELECT telegram_chat_id,role,active FROM admins WHERE id=?").get(c.reviewer_admin_id);
 return r&&r.role==='super'&&r.active&&r.telegram_chat_id?String(r.telegram_chat_id):null;
}
function isClubModerator(chatId){return !!chatId&&String(chatId)===reviewerForClub();}
function reviewButtons(id){return {inline_keyboard:[[{text:'✅ Отправить в группу',callback_data:'club:send:'+id},{text:'✏️ Скорректировать',callback_data:'club:edit:'+id}],[{text:'🚫 Отклонить',callback_data:'club:reject:'+id}]]};}
async function handleClubCallback(chatId,data){
 if(!/^club:(send|edit|reject):[0-9]+$/.test(data))return null;
 if(String(chatId)!==reviewerForClub())return {message:'Недостаточно прав',ok:false};
 const [,action,idText]=data.split(':');const id=Number(idText);
 const row=db.prepare("SELECT e.*,r.state,r.edited_message FROM partner_club_events e JOIN partner_club_reviews r ON r.event_id=e.id WHERE e.id=?").get(id);
 if(!row||row.state==='sent'||row.state==='rejected')return {message:'Этот черновик уже обработан',ok:false};
 if(row.state==='sending')return {message:'Публикация уже обрабатывается. Проверьте сообщения группы.',ok:false};
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
 if(row.event_type==='sales'&&c.sales_mode==='limit'){
   const count=db.prepare("SELECT COUNT(*) n FROM partner_club_delivery_log WHERE delivered_at>=datetime('now','-1 hour')").get().n;
   if(count>=5)return {ok:false,message:'Лимит 5 публикаций за час достигнут. Можно подтвердить позднее.'};
 }
 if(row.state==='editing')return {ok:false,message:'Сначала отправьте исправленный текст черновика.'};
 const claimed=db.prepare("UPDATE partner_club_reviews SET state='sending',claimed_at=CURRENT_TIMESTAMP WHERE event_id=? AND state='pending'").run(id);
 if(!claimed.changes)return {ok:false,message:'Черновик сейчас недоступен для отправки.'};
 const message=clubMessageHtml(row);
 let result;
 try{result=await require('./telegram').sendToChat(c.chat_id,message);}
 catch(error){db.prepare("UPDATE partner_club_reviews SET state='pending' WHERE event_id=? AND state='sending'").run(id);return {ok:false,message:'Ошибка отправки: '+error.message};}
 if(!result.ok||result.data?.ok===false){
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
 const entry=db.prepare("SELECT state FROM partner_club_reviews WHERE event_id=?").get(id);
 if(!entry||entry.state!=='editing')return {ok:false,message:'Черновик не находится на редактировании'};
 db.prepare("UPDATE partner_club_reviews SET edited_message=?,state='pending' WHERE event_id=?").run(body,id);
 saveClubFormat(id,formatted.html,true);
 cancelClubInput(chatId);
 return {ok:true,message:'📝 Обновлённый черновик:\n\n'+formatted.html,reply_markup:reviewButtons(id),parse_mode:'HTML'};
}
function setClubInput(chatId,mode,eventId=null){
 db.prepare("INSERT INTO partner_club_bot_inputs(chat_id,mode,event_id,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(chat_id) DO UPDATE SET mode=excluded.mode,event_id=excluded.event_id,updated_at=CURRENT_TIMESTAMP")
   .run(String(chatId),mode,eventId);
}
function cancelClubInput(chatId){
 return db.prepare('DELETE FROM partner_club_bot_inputs WHERE chat_id=?').run(String(chatId)).changes>0;
}
function startClubPost(chatId){
 if(!isClubModerator(chatId))return {ok:false,message:'Эта команда доступна только назначенному модератору Клуба партнёров.'};
 if(!settings().chat_id)return {ok:false,message:'Сначала подключите Telegram-группу в админке.'};
 const prev=db.prepare('SELECT mode,event_id FROM partner_club_bot_inputs WHERE chat_id=?').get(String(chatId));
 if(prev?.mode==='edit')db.prepare("UPDATE partner_club_reviews SET state='pending' WHERE event_id=? AND state='editing'").run(prev.event_id);
 setClubInput(chatId,'new');
 return {ok:true,message:'✍️ Новое сообщение для Клуба партнёров.\n\nОтправьте следующим сообщением текст публикации (до 3000 символов).\nЖирный шрифт и курсив, заданные в Telegram, сохраняются. Можно также использовать **две звёздочки** для жирного текста.\n\nБот покажет черновик и кнопки «Отправить», «Скорректировать» и «Отклонить».\n\n/cancel — отмена.'};
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
 if(pending.mode==='edit'){
   const id=pending.event_id;
   const changed=db.prepare("UPDATE partner_club_reviews SET edited_message=?,state='pending' WHERE event_id=? AND state='editing'").run(body,id);
   cancelClubInput(chatId);
   if(!changed.changes)return {ok:false,message:'Редактирование этого черновика уже завершено.'};
   saveClubFormat(id,formatted.html,true);
   return {ok:true,message:'📝 Исправленный текст черновика #'+id+':\n\n'+formatted.html,reply_markup:reviewButtons(id),parse_mode:'HTML'};
 }
 if(!settings().chat_id){cancelClubInput(chatId);return {ok:false,message:'Telegram-группа не подключена.'};}
 const key='manual:bot:'+require('node:crypto').randomUUID();
 const created=db.prepare("INSERT INTO partner_club_events(event_key,event_type,message,status) VALUES(?,'manual',?,'draft')").run(key,body);
 const id=Number(created.lastInsertRowid);
 saveClubFormat(id,formatted.html);
 const markup=reviewButtons(id);
 const preview='🐾 <b>Черновик для Клуба партнёров #'+id+'</b>\n\n'+formatted.html;
 const sent=await require('./telegram').sendToChat(chatId,preview,{reply_markup:markup});
 if(!sent.ok||sent.data?.ok===false){
   db.prepare('DELETE FROM partner_club_events WHERE id=?').run(id);
   return {ok:false,message:'Не удалось доставить предпросмотр. Текст не опубликован; отправьте его ещё раз.'};
 }
 db.prepare("INSERT INTO partner_club_reviews(event_id,state,reviewer_chat_id,requested_at) VALUES(?,'pending',?,CURRENT_TIMESTAMP)").run(id,String(chatId));
 cancelClubInput(chatId);
 return {ok:true,message:'✅ Черновик #'+id+' готов. Для публикации нажмите «Отправить в группу» под сообщением выше.'};
}
let workerBusy=false;
async function sendClubUpdates(){
 if(workerBusy)return;
 const cfg=settings();if(!cfg.enabled||!cfg.chat_id||!cfg.club_started_at)return;
 const reviewer=reviewerForClub();if(!reviewer)return;
 workerBusy=true;
 try{
  const events=db.prepare("SELECT e.* FROM partner_club_events e LEFT JOIN partner_club_reviews r ON r.event_id=e.id WHERE r.event_id IS NULL AND e.created_at>=? AND e.status='draft' ORDER BY e.id LIMIT 5").all(cfg.club_started_at);
  for(const ev of events){
   if(!settings().enabled)break;
   if(!settings()[ev.event_type])continue;
   const message='🐾 <b>Черновик для Клуба партнёров #'+ev.id+'</b>\n\n'+clubMessageHtml(ev);
   const result=await require('./telegram').sendToChat(reviewer,message,{reply_markup:reviewButtons(ev.id)});
   if(!result.ok)break;
   db.prepare("INSERT OR IGNORE INTO partner_club_reviews(event_id,state,reviewer_chat_id,requested_at) VALUES(?,'pending',?,CURRENT_TIMESTAMP)").run(ev.id,reviewer);
  }
 }catch(e){console.warn('Partner club moderation:',e.message)}finally{workerBusy=false}
}
function startPartnerClubWorker(){const timer=setInterval(()=>sendClubUpdates().catch(e=>console.warn('Partner club:',e.message)),30000);timer.unref?.()}
module.exports={registerPartnerClubRoutes,settings,preview,analytics,report,topProducts,topProductsMessage,recordPaidOrder,welcomeNewPoint,startPartnerClubWorker,handleClubCallback,handleClubEdit,isClubModerator,startClubPost,handleClubPostInput,cancelClubInput};
