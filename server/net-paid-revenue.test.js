'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {netPaidRevenue,NET_PAID_REVENUE_SQL}=require('./net-paid-revenue');

test('partial refund status from actual payment endpoint leaves the net amount',()=>{
  assert.equal(netPaidRevenue({total:500,refund_status:'refunded',refunded_amount:100}),400);
  assert.equal(netPaidRevenue({total:500,refund_status:'refunded',refunded_amount:500}),0);
  assert.equal(netPaidRevenue({total:500,refund_status:'refunded',refunded_amount:null}),0,
    'legacy full refunds with unknown amount remain at zero');
  assert.equal(netPaidRevenue({total:500,refund_status:'partially_refunded',refunded_amount:100}),400);
  assert.equal(netPaidRevenue({total:500,refund_status:'none',refunded_amount:0}),500);
  assert.equal(netPaidRevenue({total:500,refund_status:'refunded',refunded_amount:700}),0);
});

test('shared SQL expression produces the same net revenue as JS for sale snapshots',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE orders(total REAL,refund_status TEXT,refunded_amount REAL)');
    const rows=[
      {total:500,refund_status:'refunded',refunded_amount:100},
      {total:500,refund_status:'refunded',refunded_amount:500},
      {total:250,refund_status:'refunded',refunded_amount:null},
      {total:250,refund_status:'none',refunded_amount:null},
      {total:600,refund_status:'partially_refunded',refunded_amount:200},
      {total:100,refund_status:'refunded',refunded_amount:150},
    ];
    const ins=db.prepare('INSERT INTO orders(total,refund_status,refunded_amount) VALUES(?,?,?)');
    rows.forEach(o=>ins.run(o.total,o.refund_status,o.refunded_amount));
    const fromSql=db.prepare('SELECT '+NET_PAID_REVENUE_SQL+' AS net FROM orders ORDER BY rowid')
      .all().map(r=>r.net);
    assert.deepEqual(fromSql,rows.map(netPaidRevenue));
    assert.equal(db.prepare('SELECT COALESCE(SUM('+NET_PAID_REVENUE_SQL+'),0) AS sum FROM orders').get().sum,1050);
  }finally{db.close();}
});
