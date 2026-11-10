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
  ];
  for(const [index,sql] of cases){
    const plan=db.prepare('EXPLAIN QUERY PLAN '+sql).all();
    assert.ok(plan.some(step=>String(step.detail).includes(index)),
      index+' must be available for targeted queries: '+JSON.stringify(plan));
  }
});
