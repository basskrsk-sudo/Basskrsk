'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createFounderPaidSalesReader,PAID_PAGE_SQL}=require('./founder-sales-batches');

test('keyset paging returns every paid sale exactly once with a hard 200-row cap',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec(`
      CREATE TABLE orders(
        id INTEGER PRIMARY KEY,point_id TEXT,partner_id INTEGER,total REAL,
        commission_rate REAL,refund_status TEXT,refunded_amount REAL,
        created_at TEXT,status TEXT);
      CREATE INDEX idx_orders_status_created ON orders(status,created_at,id);
    `);
    const insert=db.prepare(
      'INSERT INTO orders(id,point_id,partner_id,total,commission_rate,refund_status,refunded_amount,created_at,status) '+
      'VALUES(?,?,?,?,?,?,?,?,?)');
    for(let id=1;id<=523;id++){
      insert.run(id,id%2?'a':'b',null,100,id%4===0?null:0.15,
        id%9===0?'refunded':'none',id%9===0?20:null,
        // Many identical timestamps exercise the composite (date,id) cursor.
        '2026-11-01 10:'+String(Math.floor((id-1)/21)%60).padStart(2,'0')+':00',
        id%10===0?'failed':'paid');
    }
    const bounds={from:'2026-11-01 00:00:00',to:'2026-12-01 00:00:00'};
    const reader=createFounderPaidSalesReader(db,bounds);
    const pages=[...reader.pages()];
    assert.ok(pages.length>2);
    assert.ok(pages.every(p=>p.length>=1&&p.length<=200));
    const actual=pages.flat().map(r=>r.id);
    const expected=db.prepare(
      "SELECT id FROM orders WHERE status='paid' AND created_at>=? AND created_at<? "+
      "ORDER BY created_at,id").all(bounds.from,bounds.to).map(r=>r.id);
    assert.deepEqual(actual,expected);
    assert.equal(new Set(actual).size,actual.length);
    assert.deepEqual([...reader].map(r=>r.id),expected,
      'the same reader is safely re-iterable');
    const tiny=[...createFounderPaidSalesReader(db,bounds,{pageSize:7}).pages()];
    assert.deepEqual(tiny.flat().map(r=>r.id),expected);
    const plan=db.prepare('EXPLAIN QUERY PLAN '+PAID_PAGE_SQL)
      .all(bounds.from,bounds.to,bounds.from,-1,200).map(x=>x.detail).join('\n');
    assert.match(plan,/idx_orders_status_created/);
  }finally{db.close();}
});
test('page size and period are constrained',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    for(const pageSize of [0,-1,201,1.5,NaN])
      assert.throws(()=>createFounderPaidSalesReader(db,{from:'a',to:'b'},{pageSize}),/200/);
    assert.throws(()=>createFounderPaidSalesReader(db,{from:'b',to:'a'}),/period/);
  }finally{db.close();}
});
