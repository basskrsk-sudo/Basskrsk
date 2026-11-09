// "Стрижка со вкусом": one-use QR gifts, completely separate from paid orders.
'use strict';
const crypto = require('node:crypto');
const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireActiveAdmin } = require('./routes-auth');
const { normalizeRussianPhone } = require('./miniapp-phone-identity');

const CAMPAIGN = 1;
const SLUG = 'strizhka-so-vkusom-gift-lung-30g';
function todayKrasnoyarsk() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Krasnoyarsk', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const p = k => parts.find(x => x.type === k).value;
  return p('year') + '-' + p('month') + '-' + p('day');
}
function dayNumber(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return NaN;
  const n = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === s ? n : NaN;
}
const hash = token => crypto.createHash('sha256').update(token).digest('hex');
const validToken = token => typeof token === 'string' && /^[\w-]{24}$/.test(token);
function ensureGiftSetup() {
  db.exec([
    'CREATE TABLE IF NOT EXISTS gift_campaigns (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, variant_id INTEGER NOT NULL REFERENCES product_variants(id), active INTEGER NOT NULL DEFAULT 0);',
    'CREATE TABLE IF NOT EXISTS gift_batches (id TEXT PRIMARY KEY, campaign_id INTEGER NOT NULL REFERENCES gift_campaigns(id), point_id TEXT NOT NULL REFERENCES points(id), starts_on TEXT NOT NULL, ends_on TEXT NOT NULL, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')));',
    'CREATE TABLE IF NOT EXISTS gift_codes (code_hash TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES gift_batches(id), redeemed_phone TEXT, redeemed_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')));',
    'CREATE INDEX IF NOT EXISTS idx_gift_batch ON gift_codes(batch_id);',
    'CREATE TABLE IF NOT EXISTS gift_admin_events (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER NOT NULL, action TEXT NOT NULL, details TEXT, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')));',
    'CREATE TABLE IF NOT EXISTS gift_stock_transfers (id INTEGER PRIMARY KEY AUTOINCREMENT, city_id TEXT NOT NULL REFERENCES cities(id), point_id TEXT NOT NULL REFERENCES points(id), variant_id INTEGER NOT NULL REFERENCES product_variants(id), qty INTEGER NOT NULL, admin_id INTEGER NOT NULL, note TEXT NOT NULL, delivered_at TEXT NOT NULL DEFAULT (datetime(\'now\')));'
  ].join('\n'));
  let product = db.prepare('SELECT id FROM products WHERE slug = ?').get(SLUG);
  if (!product) {
    const info = db.prepare('INSERT INTO products(slug,name,category,icon,badge,desc,comp,pet_suitability,purpose,restrictions,active) VALUES (?,?,?,?,?,?,?,?,?,?,0)')
      .run(SLUG, 'Лёгкое говяжье — подарок за стрижку', 'treats', '🎁', 'Стрижка со вкусом',
        'Сушёное говяжье лёгкое, 30 г. Только для бесплатной выдачи после стрижки.',
        JSON.stringify(['Говяжье лёгкое сушёное']), 'Собаки', 'Подарок по акции',
        'Уточняйте пищевые ограничения питомца.');
    product = { id: Number(info.lastInsertRowid) };
  }
  let variant = db.prepare("SELECT id FROM product_variants WHERE product_id = ? AND weight = '30 г'").get(product.id);
  if (!variant) {
    const info = db.prepare("INSERT INTO product_variants(product_id, weight, price, active) VALUES (?, '30 г', 0, 0)").run(product.id);
    variant = { id: Number(info.lastInsertRowid) };
  }
  db.prepare('INSERT OR IGNORE INTO gift_campaigns(id,slug,title,variant_id,active) VALUES (?,?,?,?,0)')
    .run(CAMPAIGN, 'strizhka-so-vkusom', 'Стрижка со вкусом', variant.id);
  const stmt = db.prepare('INSERT OR IGNORE INTO stock(variant_id,point_id,qty) VALUES (?,?,0)');
  for (const point of db.prepare('SELECT id FROM points').all()) stmt.run(variant.id, point.id);
}
function getGift(token) {
  return db.prepare(
    'SELECT gc.code_hash,gc.redeemed_at,gc.revoked_at,b.point_id,b.starts_on,b.ends_on,c.title,c.active AS campaign_active,c.variant_id,' +
    'p.name AS point_name,p.addr AS point_addr,p.active AS point_active,COALESCE(s.qty,0) AS stock_qty ' +
    'FROM gift_codes gc JOIN gift_batches b ON b.id=gc.batch_id ' +
    'JOIN gift_campaigns c ON c.id=b.campaign_id JOIN points p ON p.id=b.point_id ' +
    'LEFT JOIN stock s ON s.point_id=b.point_id AND s.variant_id=c.variant_id WHERE gc.code_hash=?'
  ).get(hash(token));
}
function checkGift(g, date = todayKrasnoyarsk()) {
  if (!g) return [404, 'Карточка подарка не найдена'];
  if (g.redeemed_at) return [410, 'Подарок по этой карточке уже получен'];
  if (g.revoked_at) return [410, 'Карточка отменена'];
  if (!g.campaign_active) return [409, 'Акция пока не запущена'];
  if (!g.point_active) return [409, 'Точка сейчас недоступна'];
  if (date < g.starts_on) return [409, 'Акция в салоне ещё не началась'];
  if (date > g.ends_on) return [410, 'Срок получения подарка истёк'];
  if (g.stock_qty <= 0) return [409, 'Подарки закончились. Обратитесь к грумеру'];
  return null;
}
function adminLog(id, action, value) {
  db.prepare('INSERT INTO gift_admin_events(admin_id,action,details) VALUES (?,?,?)').run(id, action, JSON.stringify(value));
}
function registerGiftRoutes(router) {
  ensureGiftSetup();
  router.get('/api/gifts/admin', (req, res, ctx) => {
    const admin = requireActiveAdmin(req,res,ctx); if (!admin) return;
    const campaign = db.prepare('SELECT c.*,p.name AS product_name,v.weight FROM gift_campaigns c JOIN product_variants v ON v.id=c.variant_id JOIN products p ON p.id=v.product_id WHERE c.id=?').get(CAMPAIGN);
    const points = db.prepare('SELECT p.id,p.name,p.addr,p.city_id,p.active,COALESCE(s.qty,0) AS gift_stock FROM points p LEFT JOIN stock s ON s.point_id=p.id AND s.variant_id=? ORDER BY p.name').all(campaign.variant_id);
    const cities = db.prepare('SELECT c.id,c.name,COALESCE(w.qty,0) AS gift_warehouse_stock FROM cities c LEFT JOIN warehouse_stock w ON w.city_id=c.id AND w.variant_id=? WHERE c.active=1 ORDER BY c.name').all(campaign.variant_id);
    const batches = db.prepare(
      'SELECT b.id,b.point_id,p.name AS point_name,b.starts_on,b.ends_on,b.created_at,' +
      'COUNT(gc.code_hash) AS issued,' +
      'SUM(CASE WHEN gc.redeemed_at IS NOT NULL THEN 1 ELSE 0 END) AS redeemed,' +
      'SUM(CASE WHEN gc.revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked,' +
      'COUNT(DISTINCT CASE WHEN gc.redeemed_at IS NOT NULL THEN gc.redeemed_phone END) AS unique_phones ' +
      'FROM gift_batches b JOIN points p ON p.id=b.point_id LEFT JOIN gift_codes gc ON gc.batch_id=b.id ' +
      'WHERE b.campaign_id=? GROUP BY b.id ORDER BY b.created_at DESC,b.id DESC LIMIT 200'
    ).all(CAMPAIGN);
    res.setHeader('Cache-Control','no-store');
    sendJson(res,200,{campaign,points,cities,batches});
  });
  router.put('/api/gifts/admin/active', (req, res, ctx) => {
    const admin = requireActiveAdmin(req,res,ctx); if (!admin) return;
    const active = ctx.body && ctx.body.active;
    if (typeof active !== 'boolean') return sendJson(res,400,{error:'Укажите active: true или false'});
    if (active) {
      const ready = db.prepare(
        'SELECT 1 FROM gift_batches b JOIN gift_campaigns c ON c.id=b.campaign_id ' +
        'JOIN points p ON p.id=b.point_id AND p.active=1 ' +
        'JOIN stock s ON s.point_id=b.point_id AND s.variant_id=c.variant_id AND s.qty>0 ' +
        'WHERE c.id=? AND b.ends_on>=? LIMIT 1'
      ).get(CAMPAIGN,todayKrasnoyarsk());
      if (!ready) return sendJson(res,409,{error:'Сначала подготовьте QR-карточки и пополните остаток подарков хотя бы в одном салоне'});
    }
    db.prepare('UPDATE gift_campaigns SET active=? WHERE id=?').run(active?1:0,CAMPAIGN);
    adminLog(admin.id,active?'activate':'deactivate',{campaign_id:CAMPAIGN});
    sendJson(res,200,{ok:true,active});
  });
  // Gift-specific physical receiving: auditable receipt into the city's central warehouse.
  router.post('/api/gifts/admin/intake', (req,res,ctx) => {
    const admin=requireActiveAdmin(req,res,ctx); if(!admin)return;
    const {city_id,qty,supplier_note,physical_received}=ctx.body||{};
    if(typeof city_id!=='string' || city_id.length>100 ||
       !Number.isSafeInteger(qty) || qty<1 || qty>20000 ||
       typeof supplier_note!=='string' || supplier_note.trim().length<6 || supplier_note.trim().length>500 ||
       physical_received!==true){
      return sendJson(res,400,{error:'Укажите город, количество, накладную/основание и подтвердите фактическую приёмку товара'});
    }
    const city=db.prepare('SELECT id FROM cities WHERE id=? AND active=1').get(city_id);
    if(!city)return sendJson(res,404,{error:'Город не найден'});
    const variant=db.prepare('SELECT variant_id FROM gift_campaigns WHERE id=?').get(CAMPAIGN).variant_id;
    let transaction=false;
    try {
      db.exec('BEGIN IMMEDIATE');transaction=true;
      db.prepare('INSERT INTO warehouse_receipts(variant_id,qty,supplier_note,keeper_id,city_id) VALUES (?,?,?,NULL,?)')
        .run(variant,qty,'Акция Стрижка со вкусом · '+supplier_note.trim(),city_id);
      db.prepare('INSERT INTO warehouse_stock(city_id,variant_id,qty) VALUES (?,?,?) ON CONFLICT(city_id,variant_id) DO UPDATE SET qty=qty+excluded.qty')
        .run(city_id,variant,qty);
      adminLog(admin.id,'gift_intake',{city_id,qty,supplier_note:supplier_note.trim()});
      db.exec('COMMIT');transaction=false;
      sendJson(res,201,{ok:true,city_id,qty});
    }catch(e){
      if(transaction){try{db.exec('ROLLBACK')}catch(_){}}
      console.error('[gifts] intake:',e);
      sendJson(res,500,{error:'Не удалось провести приход подарков'});
    }
  });

  // Admin confirms actual delivery. This moves ONLY real city warehouse stock,
  // never creates phantom gifts and never updates paid order or commission tables.
  router.post('/api/gifts/admin/transfer', (req,res,ctx) => {
    const admin=requireActiveAdmin(req,res,ctx);if(!admin)return;
    const {point_id,qty,note,physical_delivered}=ctx.body||{};
    if(typeof point_id!=='string'||point_id.length>150 ||
       !Number.isSafeInteger(qty)||qty<1||qty>20000 ||
       typeof note!=='string'||note.trim().length<8||note.trim().length>500 ||
       physical_delivered!==true){
      return sendJson(res,400,{error:'Укажите салон, количество, примечание и подтвердите фактическую передачу подарков в салон'});
    }
    const point=db.prepare('SELECT id,city_id FROM points WHERE id=? AND active=1').get(point_id);
    if(!point)return sendJson(res,404,{error:'Салон не найден'});
    const variant=db.prepare('SELECT variant_id FROM gift_campaigns WHERE id=?').get(CAMPAIGN).variant_id;
    let transaction=false;
    try {
      db.exec('BEGIN IMMEDIATE');transaction=true;
      const reduced=db.prepare('UPDATE warehouse_stock SET qty=qty-? WHERE city_id=? AND variant_id=? AND qty>=?')
        .run(qty,point.city_id,variant,qty);
      if(reduced.changes!==1){const e=new Error('На городском складе недостаточно подарков');e.status=409;throw e}
      db.prepare('INSERT INTO stock(point_id,variant_id,qty) VALUES (?,?,?) ON CONFLICT(variant_id,point_id) DO UPDATE SET qty=qty+excluded.qty')
        .run(point_id,variant,qty);
      db.prepare('INSERT INTO gift_stock_transfers(city_id,point_id,variant_id,qty,admin_id,note) VALUES (?,?,?,?,?,?)')
        .run(point.city_id,point_id,variant,qty,admin.id,note.trim());
      adminLog(admin.id,'gift_transfer',{point_id,city_id:point.city_id,qty,note:note.trim()});
      db.exec('COMMIT');transaction=false;
      sendJson(res,201,{ok:true,point_id,qty});
    }catch(e){
      if(transaction){try{db.exec('ROLLBACK')}catch(_){}}
      if(!e.status)console.error('[gifts] transfer:',e);
      sendJson(res,e.status||500,{error:e.status?e.message:'Не удалось передать подарки в салон'});
    }
  });

  router.post('/api/gifts/admin/batches', (req, res, ctx) => {
    const admin = requireActiveAdmin(req,res,ctx); if (!admin) return;
    const {point_id,starts_on,ends_on,count} = ctx.body || {};
    const a=dayNumber(starts_on),b=dayNumber(ends_on);
    if (!Number.isSafeInteger(count) || count<1 || count>200 ||
        typeof point_id!=='string' || point_id.length>150 ||
        !Number.isFinite(a) || !Number.isFinite(b) || a>b ||
        b-a>6*86400000 || b<dayNumber(todayKrasnoyarsk())) {
      return sendJson(res,400,{error:'Укажите салон, количество 1–200 и корректные даты акции до семи дней'});
    }
    const point=db.prepare('SELECT id FROM points WHERE id=? AND active=1').get(point_id);
    if (!point) return sendJson(res,404,{error:'Салон не найден или отключён'});
    const batchId=crypto.randomUUID(),cards=[];
    let transaction=false;
    try {
      db.exec('BEGIN IMMEDIATE'); transaction=true;
      db.prepare('INSERT INTO gift_batches(id,campaign_id,point_id,starts_on,ends_on,created_by) VALUES (?,?,?,?,?,?)')
        .run(batchId,CAMPAIGN,point_id,starts_on,ends_on,admin.id);
      const stmt=db.prepare('INSERT INTO gift_codes(code_hash,batch_id) VALUES (?,?)');
      for (let i=0;i<count;i++) {
        const token=crypto.randomBytes(18).toString('base64url');
        stmt.run(hash(token),batchId);
        cards.push('/gift/'+token);
      }
      adminLog(admin.id,'create_batch',{batch_id:batchId,point_id,count,starts_on,ends_on});
      db.exec('COMMIT'); transaction=false;
      res.setHeader('Cache-Control','no-store');
      sendJson(res,201,{ok:true,batch_id:batchId,cards});
    } catch (e) {
      if (transaction) { try { db.exec('ROLLBACK'); } catch (_) {} }
      console.error('[gifts] batch:',e);
      sendJson(res,500,{error:'Не удалось сформировать тираж'});
    }
  });
  router.post('/api/gifts/admin/batches/:id/revoke', (req,res,ctx) => {
    const admin=requireActiveAdmin(req,res,ctx); if (!admin) return;
    if (!db.prepare('SELECT id FROM gift_batches WHERE id=? AND campaign_id=?').get(ctx.params.id,CAMPAIGN)) return sendJson(res,404,{error:'Тираж не найден'});
    const result=db.prepare("UPDATE gift_codes SET revoked_at=datetime('now') WHERE batch_id=? AND redeemed_at IS NULL AND revoked_at IS NULL").run(ctx.params.id);
    adminLog(admin.id,'revoke_batch',{batch_id:ctx.params.id,revoked:result.changes});
    sendJson(res,200,{ok:true,revoked:result.changes});
  });
  router.get('/api/gifts/:token', (req,res,ctx) => {
    res.setHeader('Cache-Control','no-store');
    if (!validToken(ctx.params.token)) return sendJson(res,404,{error:'Подарок не найден'});
    const gift=getGift(ctx.params.token),err=checkGift(gift);
    if (err) return sendJson(res,err[0],{error:err[1]});
    sendJson(res,200,{title:gift.title,product:'Говяжье лёгкое',weight:'30 г',price:0,point_name:gift.point_name,point_addr:gift.point_addr,ends_on:gift.ends_on});
  });
  router.post('/api/gifts/:token/redeem', (req,res,ctx) => {
    res.setHeader('Cache-Control','no-store');
    if (!validToken(ctx.params.token)) return sendJson(res,404,{error:'Карточка не найдена'});
    const body=ctx.body || {},phone=normalizeRussianPhone(body.phone);
    if (!phone || !/^79\d{9}$/.test(phone)) return sendJson(res,400,{error:'Укажите мобильный номер РФ'});
    if (body.guide_seen!==true || body.privacy_acknowledged!==true) return sendJson(res,400,{error:'Прочитайте инструкцию и подтвердите условия получения'});
    let transaction=false;
    try {
      db.exec('BEGIN IMMEDIATE'); transaction=true;
      const gift=getGift(ctx.params.token),err=checkGift(gift);
      if (err) { const e=new Error(err[1]);e.status=err[0];throw e; }
      const stock=db.prepare('UPDATE stock SET qty=qty-1 WHERE point_id=? AND variant_id=? AND qty>0').run(gift.point_id,gift.variant_id);
      if (stock.changes!==1) {const e=new Error('Подарки закончились');e.status=409;throw e;}
      const used=db.prepare("UPDATE gift_codes SET redeemed_phone=?,redeemed_at=datetime('now') WHERE code_hash=? AND redeemed_at IS NULL AND revoked_at IS NULL").run(phone,gift.code_hash);
      if (used.changes!==1) {const e=new Error('Карточка уже использована');e.status=410;throw e;}
      db.exec('COMMIT');transaction=false;
      // No order, payment, commission, referral credit, cashback, or mailing.
      sendJson(res,200,{ok:true,product:'Говяжье лёгкое',weight:'30 г',point_name:gift.point_name,message:'Подарок оформлен. Заберите упаковку 30 г с полки ХвостМаркета.'});
    } catch(e) {
      if(transaction) {try {db.exec('ROLLBACK');}catch(_){}}
      if(!e.status)console.error('[gifts] redeem:',e);
      sendJson(res,e.status||500,{error:e.status?e.message:'Не удалось выдать подарок'});
    }
  });
}
module.exports={registerGiftRoutes,ensureGiftSetup,todayKrasnoyarsk,dayNumber,checkGift,SLUG};
