'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {loadOwnerDashboardSales,TOTALS_SQL,GROOMERS_SQL,RECENT_SQL,UNPAID_SQL}=
  require('./owner-dashboard-aggregate');

const MONTH='2026-11-01 00:00:00';
function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE orders(id INTEGER PRIMARY KEY,point_id TEXT,status TEXT,
      refund_status TEXT,refunded_amount REAL,total REAL,partner_id INTEGER,
      commission_rate REAL,is_partner_self_order INTEGER,payment_method TEXT,
      created_at TEXT);
    CREATE INDEX idx_orders_point_status_created ON orders(point_id,status,created_at);
    CREATE TABLE partners(id INTEGER PRIMARY KEY,point_id TEXT,full_name TEXT,commission_rate REAL,active INTEGER);
    CREATE TABLE salon_owners(id INTEGER PRIMARY KEY,point_id TEXT,commission_rate REAL);
    CREATE TABLE owner_payout_items(id INTEGER PRIMARY KEY,order_id INTEGER,commission_amount INTEGER,payout_id INTEGER,order_code TEXT);
    CREATE TABLE owner_payouts(id INTEGER PRIMARY KEY,owner_id INTEGER);
    CREATE TABLE payout_reports(role TEXT,payout_id INTEGER,snapshot_json TEXT);
    INSERT INTO partners VALUES
      (1,'a','Анна',0.15,1),(2,'a','Борис',0.20,0),(3,'b','Чужой грумер',0.10,1),
      (4,'a','Новый грумер',0.15,1);
    INSERT INTO salon_owners VALUES(1,'a',0.05),(2,'b',0.05);
    INSERT INTO orders VALUES
      (1,'a','paid','none',NULL,250,1,0.15,0,'sbp','2026-11-03 12:00:00'),
      (2,'a','paid','none',NULL,360,1,0.20,0,'bank_card','2026-11-04 12:00:00'),
      (3,'a','paid','refunded',50,200,1,0.15,0,'sbp','2026-11-05 12:00:00'),
      (4,'a','paid','refunded',100,100,2,NULL,0,'sbp','2026-11-06 12:00:00'),
      (5,'a','failed','none',NULL,100,1,0.15,0,'sbp','2026-11-07 12:00:00'),
      (6,'a','paid','none',NULL,100,NULL,0,0,'sbp','2026-11-08 12:00:00'),
      (7,'a','paid','none',NULL,450,2,NULL,1,'sbp','2026-11-09 12:00:00'),
      (8,'b','paid','none',NULL,999,3,0.1,0,'sbp','2026-11-10 12:00:00'),
      (9,'a','paid','refunded',NULL,50,2,NULL,0,'sbp','2026-11-11 12:00:00'),
      (10,'a','paid','none',NULL,150,0,0,0,'sbp','2026-11-12 12:00:00'),
      (11,'a','paid','none',NULL,120,1,0.15,0,'sbp','2026-10-23 12:00:00');
    INSERT INTO owner_payout_items(order_id,commission_amount) VALUES(1,13),(8,50);
  `);
  require('./commission-refunds').initializeRefundOffsets(db);
  return db;
}
function legacyDashboard(db,pointId,ownerId,monthStart){
  const orders=db.prepare(`
    SELECT id,
      CASE WHEN refund_status = 'refunded' AND refunded_amount IS NULL THEN 0
        ELSE MAX(0,total - COALESCE(refunded_amount,0)) END AS total,
      partner_id,commission_rate,is_partner_self_order,payment_method,created_at
    FROM orders WHERE point_id=? AND status='paid'
      AND CASE WHEN refund_status='refunded' AND refunded_amount IS NULL THEN 0
        ELSE MAX(0,total-COALESCE(refunded_amount,0)) END>0
    ORDER BY created_at DESC
  `).all(pointId);
  const revenue=orders.reduce((s,o)=>s+o.total,0);
  const inMonth=orders.filter(o=>o.created_at>=monthStart);
  const partners=db.prepare('SELECT id,full_name,commission_rate,active FROM partners WHERE point_id=?')
    .all(pointId);
  const groomers=partners.map(p=>{
    const assigned=orders.filter(o=>o.partner_id===p.id);
    return {
      id:p.id,full_name:p.full_name,active:!!p.active,
      tier_percent:Math.round(p.commission_rate*100),
      orders_count:assigned.length,
      revenue:assigned.reduce((s,o)=>s+o.total,0),
      commission_earned:Math.round(assigned.reduce((s,o)=>
        s+o.total*(o.commission_rate??p.commission_rate),0)),
    };
  }).sort((a,b)=>b.revenue-a.revenue);
  const owner=db.prepare('SELECT commission_rate FROM salon_owners WHERE id=?').get(ownerId);
  const unpaid=db.prepare(`
    SELECT CASE WHEN o.refund_status='refunded' AND COALESCE(o.refunded_amount,0)<=0 THEN 0 ELSE MAX(0,o.total-COALESCE(o.refunded_amount,0)) END AS total FROM orders o LEFT JOIN owner_payout_items pi ON pi.order_id=o.id
    WHERE o.point_id=? AND o.status='paid' AND pi.order_id IS NULL
      AND (o.refund_status<>'refunded' OR (o.refunded_amount>0 AND o.refunded_amount<o.total))
  `).all(pointId);
  return {
    totals:{revenue,orders:orders.length,
      avg_order:orders.length?Math.round(revenue/orders.length):0,
      this_month_revenue:inMonth.reduce((s,o)=>s+o.total,0),
      this_month_orders:inMonth.length},
    groomers,
    unassigned_orders_count:orders.filter(o=>!o.partner_id).length,
    recent_orders:orders.slice(0,20).map(o=>({
      id:o.id,total:o.total,payment_method:o.payment_method,created_at:o.created_at,
      is_self_order:!!o.is_partner_self_order})),
    unpaid:{amount:unpaid.reduce((s,o)=>s+Math.round(o.total*owner.commission_rate),0),
      orders_count:unpaid.length},
  };
}
test('owner dashboard SQL exactly matches historical dashboard behavior',()=>{
  const db=fixture();
  try {
    const actual=loadOwnerDashboardSales(db,'a',1,MONTH);
    const expected=legacyDashboard(db,'a',1,MONTH);
    assert.deepEqual(actual,expected);
    assert.equal(actual.totals.revenue,1580);
    assert.equal(actual.totals.this_month_revenue,1460);
    assert.equal(actual.totals.orders,7);
    assert.equal(actual.unassigned_orders_count,2);
    assert.equal(actual.groomers[0].commission_earned,150);
    assert.equal(actual.groomers.find(x=>x.id===2).revenue,450);
    assert.equal(actual.groomers.find(x=>x.id===4).orders_count,0);
    assert.equal(actual.unpaid.amount,68,'round each remaining paid amount separately');
    assert.equal(actual.unpaid.orders_count,6,'full returns excluded, partial included');
  } finally {db.close();}
});
test('owner and groomer data cannot leak across salons',()=>{
  const db=fixture();
  try {
    const actual=loadOwnerDashboardSales(db,'b',2,MONTH);
    assert.deepEqual(actual,legacyDashboard(db,'b',2,MONTH));
    assert.equal(actual.totals.orders,1);
    assert.equal(actual.totals.revenue,999);
    assert.deepEqual(actual.groomers.map(x=>x.id),[3]);
  } finally {db.close();}
});
test('recent owner orders are hard-limited to 20 even with long paid history',()=>{
  const db=fixture();
  try {
    const insert=db.prepare(
      'INSERT INTO orders(id,point_id,status,refund_status,refunded_amount,total,partner_id,'+
      'commission_rate,is_partner_self_order,payment_method,created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for(let i=100;i<160;i++)insert.run(i,'a','paid','none',null,100,1,0.15,0,
      'sbp','2026-12-'+String(1+Math.floor((i-100)/24)).padStart(2,'0')+' 13:'+String(i%60).padStart(2,'0')+':00');
    const actual=loadOwnerDashboardSales(db,'a',1,MONTH);
    assert.equal(actual.recent_orders.length,20);
    assert.equal(actual.totals.orders,67);
    const plan=db.prepare('EXPLAIN QUERY PLAN '+RECENT_SQL).all('a')
      .map(row=>row.detail).join('\n');
    assert.match(plan,/idx_orders_point_status_created/);
  } finally {db.close();}
});
test('owner aggregates use targeted SQL without selecting historic order rows',()=>{
  const db=fixture();
  try{
    for(const [sql,params] of [
      [TOTALS_SQL,['a',MONTH,MONTH]],
      [GROOMERS_SQL,['a','a']],
      [RECENT_SQL,['a']],
      [UNPAID_SQL,[1]],
    ]) assert.doesNotThrow(()=>db.prepare('EXPLAIN QUERY PLAN '+sql).all(...params));
    const fs=require('node:fs'),path=require('node:path');
    const route=fs.readFileSync(path.join(__dirname,'routes-owners.js'),'utf8');
    const portion=route.split("router.get('/api/owner/dashboard'")[1]
      .split("router.delete('/api/salon-owners/:id'")[0];
    assert.match(portion,/owner_dashboard_aggregate/);
    assert.doesNotMatch(portion,/orders\.filter\(|getOwnerUnpaidSummary\(/);
  }finally{db.close();}
});
