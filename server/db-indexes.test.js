'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-db-indexes-'));
const db=require('./db');

test('point, paid-order and stock lookups have usable SQLite indexes',()=>{
  const cases=[
    ['idx_orders_status_created',"SELECT id FROM orders INDEXED BY idx_orders_status_created WHERE status='paid' AND created_at>='2026-11-01'"],
    ['idx_orders_point_status_created',"SELECT id FROM orders INDEXED BY idx_orders_point_status_created WHERE point_id='x' AND status='paid'"],
    ['idx_order_items_order','SELECT id FROM order_items INDEXED BY idx_order_items_order WHERE order_id=1'],
    ['idx_stock_point_variant',"SELECT qty FROM stock INDEXED BY idx_stock_point_variant WHERE point_id='x'"],
    ['idx_partner_lead_notes_lead_latest',
      'SELECT id,note FROM partner_lead_notes INDEXED BY idx_partner_lead_notes_lead_latest WHERE lead_id=1 ORDER BY id DESC LIMIT 1'],
  ];
  for(const [index,sql] of cases){
    const plan=db.prepare('EXPLAIN QUERY PLAN '+sql).all();
    assert.ok(plan.some(step=>String(step.detail).includes(index)),
      index+' must be available for targeted queries: '+JSON.stringify(plan));
  }
});

test('expired reservation cleanup reads bounded ID pages, without client data',()=>{
  const {listExpiredActiveReservationsBatch}=require('./reservations');
  const insert=db.prepare(
    'INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,subtotal,total,'+
    'payment_method,status,reservation_status,reservation_expires_at,yookassa_payment_id) '+
    'VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  for(let i=1;i<=25;i++)insert.run(
    'CLEANUP-TEST-'+i,'Тест','79000000000','Тестовая точка',250,250,
    'yookassa','pending','active','2000-01-01 00:00:00','payment-'+i
  );
  insert.run('CLEANUP-TEST-FUTURE','Тест','79000000000','Тестовая точка',250,250,
    'yookassa','pending','active','2999-01-01 00:00:00','payment-future');
  insert.run('CLEANUP-TEST-PAID','Тест','79000000000','Тестовая точка',250,250,
    'yookassa','paid','consumed','2000-01-01 00:00:00','payment-paid');

  const pages=[];
  let afterId=0;
  for(let i=0;i<4;i++){
    const page=listExpiredActiveReservationsBatch(afterId,8);
    pages.push(page);
    if(page.length)afterId=page.at(-1).id;
  }
  assert.deepEqual(pages.map(page=>page.length),[8,8,8,1]);
  assert.equal(listExpiredActiveReservationsBatch(afterId,8).length,0);
  assert.deepEqual(
    pages.flat().map(row=>row.order_code),
    Array.from({length:25},(_,i)=>'CLEANUP-TEST-'+(i+1))
  );
  assert.deepEqual(Object.keys(pages[0][0]).sort(),['id','order_code','yookassa_payment_id']);
  assert.equal(listExpiredActiveReservationsBatch(0,999).length,20,
    'SQL batch size is clamped to at most 20');
  const explain=db.prepare(
    "EXPLAIN QUERY PLAN SELECT id,order_code,yookassa_payment_id FROM orders "+
    "INDEXED BY idx_orders_pending_reservation_cleanup WHERE status='pending' "+
    "AND reservation_status='active' AND reservation_expires_at IS NOT NULL "+
    "AND reservation_expires_at <= datetime('now') AND id > ? ORDER BY id LIMIT ?"
  ).all(0,8);
  assert.ok(explain.some(step=>String(step.detail).includes('idx_orders_pending_reservation_cleanup')),
    'The paged cleanup must use the partial ID index');
});
