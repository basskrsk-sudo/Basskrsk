'use strict';

// Customer demand for goods absent at a chosen point.
// Independent of actual stock movements: no reservations, charges or stock changes.
const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireAuth } = require('./routes-auth');
const { sendTelegram } = require('./telegram');

function initializeCustomerRestockRequests() {
  db.exec([
    'CREATE TABLE IF NOT EXISTS customer_restock_requests (',
    'id INTEGER PRIMARY KEY AUTOINCREMENT,',
    'point_id TEXT REFERENCES points(id) ON DELETE SET NULL,',
    'point_name TEXT NOT NULL,',
    'variant_id INTEGER REFERENCES product_variants(id) ON DELETE SET NULL,',
    'product_name TEXT NOT NULL, variant_weight TEXT NOT NULL,',
    'customer_name TEXT NOT NULL DEFAULT \'\',',
    'customer_phone TEXT NOT NULL,',
    'qty INTEGER NOT NULL CHECK(qty BETWEEN 1 AND 20),',
    'status TEXT NOT NULL DEFAULT \'new\' CHECK(status IN (\'new\',\'in_progress\',\'fulfilled\',\'cancelled\')),',
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\')),',
    'updated_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
    ');',
    'CREATE INDEX IF NOT EXISTS idx_customer_restock_status ON customer_restock_requests(status, created_at DESC);',
    'CREATE INDEX IF NOT EXISTS idx_customer_restock_point ON customer_restock_requests(point_id, created_at DESC);',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_restock_pending ON customer_restock_requests(customer_phone,point_id,variant_id) WHERE status IN (\'new\',\'in_progress\');',
  ].join('\n'));
}

function normalizePhone(value) {
  const digits=String(value || '').replace(/\D/g,'');
  if (digits.length < 10 || digits.length > 11) return null;
  if (digits.length === 11 && !['7','8'].includes(digits[0])) return null;
  const last10=digits.slice(-10);
  return last10[0] === '9' ? '7' + last10 : null;
}
function escapeTg(value) {
  return String(value || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function registerCustomerRestockRoutes(router) {
  initializeCustomerRestockRequests();
  router.post('/api/customer-restock-requests', (req,res,ctx) => {
    const b=ctx.body || {};
    const pointId=String(b.point_id || '').trim();
    const variantId=Number(b.variant_id);
    const qty=Number(b.qty);
    const phone=normalizePhone(b.phone);
    const name=String(b.name || '').trim().slice(0,100);
    if (!pointId || !Number.isSafeInteger(variantId) || variantId <= 0 ||
        !Number.isSafeInteger(qty) || qty < 1 || qty > 20 || !phone || !b.consent) {
      return sendJson(res,400,{error:'Выберите точку, товар, количество (1–20), укажите телефон и согласие на связь'});
    }
    const point=db.prepare('SELECT id,name,addr FROM points WHERE id=? AND active=1').get(pointId);
    if (!point) return sendJson(res,404,{error:'Выбранная точка недоступна'});
    const variant=db.prepare([
      'SELECT v.id,v.weight,p.name FROM product_variants v',
      'JOIN products p ON p.id=v.product_id',
      'WHERE v.id=? AND v.active=1 AND p.active=1',
    ].join(' ')).get(variantId);
    if (!variant) return sendJson(res,404,{error:'Товар недоступен в каталоге'});
    const stock=db.prepare('SELECT qty FROM stock WHERE point_id=? AND variant_id=?').get(pointId,variantId);
    if (Number(stock?.qty || 0) >= qty) return sendJson(res,409,{error:'Нужное количество уже есть на выбранной точке — можно оформить покупку'});
    const recent=db.prepare([
      'SELECT COUNT(*) AS n FROM customer_restock_requests',
      "WHERE customer_phone=? AND created_at >= datetime('now','-24 hours')",
    ].join(' ')).get(phone);
    if (Number(recent.n) >= 5) return sendJson(res,429,{error:'Слишком много заявок за сутки. Попробуйте позже'});
    try {
      const info=db.prepare([
        'INSERT INTO customer_restock_requests',
        '(point_id,point_name,variant_id,product_name,variant_weight,customer_name,customer_phone,qty)',
        'VALUES (?,?,?,?,?,?,?,?)',
      ].join(' ')).run(point.id,point.name,variant.id,variant.name,variant.weight,name,phone,qty);
      const id=Number(info.lastInsertRowid);
      sendJson(res,201,{ok:true,id,message:'Заявка принята. Мы свяжемся с вами по указанному телефону после рассмотрения.'});
      // Failures in chat notifications must not roll back the saved request.
      void sendTelegram('📦 <b>Новая заявка на довоз №'+id+'</b>\n📍 '+escapeTg(point.name)+'\n🦴 '+escapeTg(variant.name)+' ('+escapeTg(variant.weight)+') — '+qty+' шт.\nОткройте «Заявки клиентов» в админке.').catch(e=>console.warn('[customer-restock] telegram:',e.message));
    } catch(e) {
      if (String(e.message).includes('UNIQUE constraint failed')) return sendJson(res,409,{error:'Заявка на этот товар и точку уже оставлена с указанного телефона'});
      console.error('[customer-restock]',e);
      return sendJson(res,500,{error:'Не удалось сохранить заявку, попробуйте позже'});
    }
  });

  router.get('/api/customer-restock-requests',(req,res,ctx)=>{
    const user=requireAuth(['admin','manager'])(req,res,ctx);
    if(!user)return;
    const statuses=['new','in_progress','fulfilled','cancelled'];
    const status=String(ctx.query?.status || '');
    if(status && !statuses.includes(status))return sendJson(res,400,{error:'Некорректный статус'});
    const where=[];
    const args=[];
    if(user.role==='manager'){where.push('p.manager_id=?');args.push(user.id);}
    if(status){where.push('r.status=?');args.push(status);}
    const rows=db.prepare([
      'SELECT r.*,p.name AS current_point_name,p.manager_id',
      'FROM customer_restock_requests r LEFT JOIN points p ON p.id=r.point_id',
      'WHERE '+(where.length?where.join(' AND '):'1=1'),
      'ORDER BY CASE r.status WHEN \'new\' THEN 0 WHEN \'in_progress\' THEN 1 ELSE 2 END, r.id DESC LIMIT 300',
    ].join(' ')).all(...args);
    sendJson(res,200,{requests:rows});
  });

  router.put('/api/customer-restock-requests/:id',(req,res,ctx)=>{
    const user=requireAuth(['admin','manager'])(req,res,ctx);
    if(!user)return;
    const id=Number(ctx.params.id);
    const status=String(ctx.body?.status || '');
    if(!Number.isSafeInteger(id) || id<=0 || !['in_progress','fulfilled','cancelled'].includes(status))
      return sendJson(res,400,{error:'Некорректная заявка или статус'});
    const row=db.prepare([
      'SELECT r.*,p.manager_id FROM customer_restock_requests r',
      'LEFT JOIN points p ON p.id=r.point_id WHERE r.id=?',
    ].join(' ')).get(id);
    if(!row)return sendJson(res,404,{error:'Заявка не найдена'});
    if(user.role==='manager' && Number(row.manager_id)!==Number(user.id))
      return sendJson(res,403,{error:'Это не ваша точка'});
    if(['fulfilled','cancelled'].includes(row.status))
      return sendJson(res,409,{error:'Заявка уже закрыта'});
    if(status==='fulfilled') {
      const stock=db.prepare('SELECT qty FROM stock WHERE point_id=? AND variant_id=?').get(row.point_id,row.variant_id);
      if(Number(stock?.qty || 0)<row.qty) return sendJson(res,409,{error:'На точке ещё нет запрошенного количества — сначала подтвердите перемещение товара'});
    }
    db.prepare("UPDATE customer_restock_requests SET status=?,updated_at=datetime('now') WHERE id=?").run(status,id);
    sendJson(res,200,{ok:true,id,status});
  });
}
module.exports={registerCustomerRestockRoutes,initializeCustomerRestockRequests,normalizePhone};
