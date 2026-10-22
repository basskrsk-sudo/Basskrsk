// Partner Club: configuration and message previews only. No bot connection or sending.
'use strict';
const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireSuperAdmin } = require('./routes-auth');
const DEFAULTS = Object.freeze({
  sales: true, daily: true, weekly: true, milestones: true,
  new_points: true, tips: false, new_products: false,
  sales_mode: 'all', hourly_limit: 5, include_groomer_names: false,
  enabled: false, chat_id: null
});
db.exec(`CREATE TABLE IF NOT EXISTS partner_club_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  config_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS partner_club_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status='draft')
);`);
function getSettings() {
  const row = db.prepare('SELECT config_json FROM partner_club_settings WHERE id=1').get();
  let saved = {};
  try { saved = row ? JSON.parse(row.config_json) : {}; } catch (_) {}
  return { ...DEFAULTS, ...saved, enabled: false, chat_id: null };
}
function preview(type, data={}) {
  const point = String(data.point || 'БаркЛай').slice(0,80);
  const item = String(data.product || 'Лёгкое говяжье, 50 г').slice(0,100);
  const count = Number.isFinite(+data.count) ? Math.max(0,Math.floor(+data.count)) : 18;
  const amount = Number.isFinite(+data.amount) ? Math.max(0,+data.amount) : 4500;
  const money = new Intl.NumberFormat('ru-RU').format(amount);
  switch(type) {
    case 'sales': return '🐾 Новая покупка!\n🏪 '+point+'\n🦴 '+item+'\n💚 '+money+' ₽\nСпасибо за рекомендацию!';
    case 'daily': return '☀️ Итоги вчерашнего дня\n🐾 Продаж: '+count+'\n💚 Выручка: '+money+' ₽\nСпасибо всем партнёрам!';
    case 'weekly': return '🏆 Итоги недели\nПродаж по сети: '+count+'\nОтмечаем достижения и личные рекорды, без публикации неудач.';
    case 'milestones': return '🎉 Новый рекорд!\nСеть достигла '+count+' продаж!';
    case 'new_points': return '🎉 К ХвостМаркету присоединился минимаркет «'+point+'»!';
    case 'tips': return '💡 Совет недели: предложите клиенту лакомство после груминга.';
    case 'new_products': return '🦴 Новинка в минимаркетах: '+item+'!';
    default: return null;
  }
}
function registerPartnerClubRoutes(router) {
  router.get('/api/admin/partner-club', (req,res,ctx)=>{
    if(!requireSuperAdmin(req,res,ctx)) return;
    sendJson(res,200,{settings:getSettings(),connected:false,delivery_enabled:false});
  });
  router.put('/api/admin/partner-club', (req,res,ctx)=>{
    if(!requireSuperAdmin(req,res,ctx)) return;
    const body=ctx.body || {};
    const previous=getSettings(), next={...previous};
    for(const key of ['sales','daily','weekly','milestones','new_points','tips','new_products','include_groomer_names']){
      if(Object.prototype.hasOwnProperty.call(body,key)){
        if(typeof body[key]!=='boolean') return sendJson(res,400,{error:'Некорректное поле: '+key});
        next[key]=body[key];
      }
    }
    if(Object.prototype.hasOwnProperty.call(body,'sales_mode')){
      if(!['all','limit','digest'].includes(body.sales_mode)) return sendJson(res,400,{error:'Некорректная частота'});
      next.sales_mode=body.sales_mode;
    }
    // Activation/chat binding intentionally impossible in this release.
    next.enabled=false; next.chat_id=null; next.include_groomer_names=false;
    db.prepare(`INSERT INTO partner_club_settings(id,config_json,updated_at)
      VALUES(1,?,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE
      SET config_json=excluded.config_json,updated_at=CURRENT_TIMESTAMP`).run(JSON.stringify(next));
    sendJson(res,200,{ok:true,settings:next,connected:false,delivery_enabled:false});
  });
  router.post('/api/admin/partner-club/preview',(req,res,ctx)=>{
    if(!requireSuperAdmin(req,res,ctx)) return;
    const type=String(ctx.body?.type || 'sales');
    const message=preview(type,ctx.body?.data);
    if(!message) return sendJson(res,400,{error:'Неизвестный тип сообщения'});
    sendJson(res,200,{message,preview_only:true,delivered:false});
  });
}
module.exports={registerPartnerClubRoutes,getSettings,preview};
