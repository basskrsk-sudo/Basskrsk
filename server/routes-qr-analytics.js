'use strict';
const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireAuth } = require('./routes-auth');

function registerQrAnalyticsRoutes(router) {
  router.post('/api/qr-analytics/event',(req,res,ctx)=>{
    const {point_id,product_id,event_type,visit_id,order_code}=ctx.body||{};
    if(!['open','checkout','payment_created'].includes(event_type)
      || !/^[a-z0-9_-]{1,80}$/i.test(String(point_id||''))
      || !Number.isSafeInteger(Number(product_id)) || Number(product_id)<=0
      || !/^[a-z0-9_-]{12,100}$/i.test(String(visit_id||'')))return sendJson(res,400,{error:'Недопустимое событие'});
    if (!db.prepare('SELECT id FROM points WHERE id=? AND active=1').get(point_id)
      || !db.prepare('SELECT id FROM products WHERE id=? AND active=1').get(Number(product_id)))
      return sendJson(res,404,{error:'Точка или товар недоступны'});
    const value=event_type==='payment_created'&&typeof order_code==='string'&&/^TG-[A-Za-z0-9_-]{1,60}$/.test(order_code)?order_code:null;
    if(event_type==='payment_created'){
      if(!value)return sendJson(res,400,{error:'Не указан номер заказа'});
      const order=db.prepare(`SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id=o.id
        JOIN product_variants v ON v.id=oi.variant_id
        WHERE o.order_code=? AND o.point_id=? AND v.product_id=? LIMIT 1`).get(value,point_id,Number(product_id));
      if(!order)return sendJson(res,404,{error:'Заказ не найден'});
    }
    db.prepare('INSERT OR IGNORE INTO qr_funnel_events (point_id,product_id,event_type,visit_id,order_code) VALUES (?,?,?,?,?)')
      .run(point_id,Number(product_id),event_type,visit_id,value);
    sendJson(res,200,{ok:true});
  });

  router.get('/api/admin/qr-analytics',(req,res,ctx)=>{
    if(!requireAuth(['admin'])(req,res,ctx))return;
    const days=Number(ctx.query.days||30);
    if(![7,30,90].includes(days))return sendJson(res,400,{error:'Период 7, 30 или 90 дней'});
    const point=String(ctx.query.point||'');
    const conditions=["e.created_at>=datetime('now',?)"],params=['-'+days+' days'];
    if(point){conditions.push('e.point_id=?');params.push(point);}
    const totals=db.prepare(`SELECT e.point_id,p.name AS point_name,
      COUNT(CASE WHEN e.event_type='open' THEN 1 END) AS opens,
      COUNT(DISTINCT CASE WHEN e.event_type='open' THEN e.visit_id END) AS visits,
      COUNT(CASE WHEN e.event_type='checkout' THEN 1 END) AS checkouts,
      COUNT(CASE WHEN e.event_type='payment_created' THEN 1 END) AS payment_requests
      FROM qr_funnel_events e JOIN points p ON p.id=e.point_id
      WHERE ${conditions.join(' AND ')} GROUP BY e.point_id ORDER BY visits DESC`).all(...params);
    const sales=db.prepare(`SELECT o.point_id,COUNT(DISTINCT o.id) AS paid_orders,COALESCE(SUM(o.total),0) AS revenue
      FROM orders o WHERE o.status='paid' AND COALESCE(o.refund_status,'none')!='refunded'
      AND o.created_at>=datetime('now',?)
      AND EXISTS(SELECT 1 FROM qr_funnel_events e WHERE e.order_code=o.order_code AND e.event_type='payment_created')
      ${point?'AND o.point_id=?':''}
      GROUP BY o.point_id`).all(...params);
    const salesBy=new Map(sales.map(x=>[x.point_id,x]));
    const points=totals.map(x=>({...x,paid_orders:salesBy.get(x.point_id)?.paid_orders||0,
      revenue:salesBy.get(x.point_id)?.revenue||0}));
    sendJson(res,200,{days,points,totals:{
      opens:points.reduce((n,x)=>n+x.opens,0),visits:points.reduce((n,x)=>n+x.visits,0),
      checkouts:points.reduce((n,x)=>n+x.checkouts,0),paid_orders:points.reduce((n,x)=>n+x.paid_orders,0),
      revenue:points.reduce((n,x)=>n+x.revenue,0)
    }});
  });
}
module.exports={registerQrAnalyticsRoutes};
