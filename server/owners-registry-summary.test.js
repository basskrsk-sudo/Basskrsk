'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {readOwnersRegistry,OWNERS_REGISTRY_SQL}=require('./owners-registry-summary');

function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE points(id TEXT PRIMARY KEY,name TEXT);
    CREATE TABLE partners(id INTEGER PRIMARY KEY,full_name TEXT);
    CREATE TABLE salon_owners(
      id INTEGER PRIMARY KEY,login TEXT,password_hash TEXT,
      point_id TEXT,groomer_partner_id INTEGER,commission_rate REAL,
      full_name TEXT,active INTEGER,telegram_chat_id TEXT);
    CREATE TABLE orders(
      id INTEGER PRIMARY KEY,point_id TEXT,status TEXT,total REAL,created_at TEXT);
    CREATE INDEX idx_orders_point_status_created ON orders(point_id,status,created_at);
    CREATE TABLE owner_payout_items(
      id INTEGER PRIMARY KEY,order_id INTEGER UNIQUE,commission_amount INTEGER,payout_id INTEGER,order_code TEXT);
    CREATE TABLE owner_payouts(id INTEGER PRIMARY KEY,owner_id INTEGER);
    CREATE TABLE payout_reports(role TEXT,payout_id INTEGER,snapshot_json TEXT);
    INSERT INTO points VALUES ('a','Первый салон'),('b','Второй салон');
    INSERT INTO partners VALUES (1,'Грумер 1');
    INSERT INTO salon_owners VALUES
      (1,'o1','secret','a',1,0.05,'Владелец А',1,'777777'),
      (2,'o2','secret','b',NULL,0.075,'Владелец Б',1,NULL),
      (3,'o3','secret',NULL,NULL,0.05,'Без точки',1,NULL),
      (4,'o4','secret','a',NULL,0.10,'Второй владелец А',0,NULL);
    INSERT INTO orders VALUES
      (1,'a','paid',250,datetime('now','-1 day')),
      (2,'a','paid',360,datetime('now','-2 days')),
      (3,'a','paid',101,datetime('now','-70 days')),
      (4,'a','failed',500,datetime('now','-2 days')),
      (5,'a','pending',999,datetime('now','-3 days')),
      (6,'b','paid',201,datetime('now','-2 days')),
      (7,'b','paid',249,datetime('now','-70 days')),
      (8,'a','paid',0,datetime('now','-2 days'));
    INSERT INTO owner_payout_items(order_id,commission_amount) VALUES(2,18),(6,15);
  `);
  db.exec("ALTER TABLE orders ADD COLUMN refund_status TEXT DEFAULT 'none'; ALTER TABLE orders ADD COLUMN refunded_amount REAL;");
  require('./commission-refunds').initializeRefundOffsets(db);
  return db;
}
function originalRegistry(database){
  const rows=database.prepare(`
    SELECT so.*,p.name AS point_name,gp.full_name AS groomer_partner_name,
      COUNT(o.id) AS paid_orders_count,COALESCE(SUM(o.total),0) AS paid_revenue,
      COALESCE(SUM(CASE WHEN o.created_at>=datetime('now','start of month')
        THEN o.total ELSE 0 END),0) AS month_paid_revenue
    FROM salon_owners so LEFT JOIN points p ON p.id=so.point_id
    LEFT JOIN partners gp ON gp.id=so.groomer_partner_id
    LEFT JOIN orders o ON o.point_id=so.point_id AND o.status='paid'
    GROUP BY so.id ORDER BY so.id DESC
  `).all();
  return rows.map(row=>{
    const paid=database.prepare(`
      SELECT o.total,so.commission_rate FROM salon_owners so
      JOIN orders o ON o.point_id=so.point_id
      LEFT JOIN owner_payout_items pi ON pi.order_id=o.id
      WHERE so.id=? AND o.status='paid' AND pi.id IS NULL
    `).all(row.id);
    const rate=Number(row.commission_rate||0);
    return {...row,paid_orders_count:Number(row.paid_orders_count||0),
      paid_revenue:Number(row.paid_revenue||0),
      accrued_earnings:Math.round(Number(row.paid_revenue||0)*rate),
      month_earnings:Math.round(Number(row.month_paid_revenue||0)*rate),
      current_earnings:paid.reduce((s,o)=>s+Math.round(Number(o.total||0)*Number(o.commission_rate||0)),0),
      unpaid_orders_count:paid.length};
  });
}
test('registry matches original per-owner payout summaries for all owners',()=>{
  const db=fixture();
  try{
    assert.deepEqual(readOwnersRegistry(db),originalRegistry(db));
    const a=readOwnersRegistry(db).find(o=>o.id===1);
    assert.equal(a.current_earnings,18,'first and historical paid orders, individually rounded');
    assert.equal(a.unpaid_orders_count,3,'paid order with zero gross total still counts');
    assert.equal(a.paid_orders_count,4);
    assert.equal(a.paid_revenue,711);
    const b=readOwnersRegistry(db).find(o=>o.id===2);
    assert.equal(b.current_earnings,19);
    const empty=readOwnersRegistry(db).find(o=>o.id===3);
    assert.equal(empty.paid_orders_count,0);
    assert.equal(empty.current_earnings,0);
    assert.equal(empty.unpaid_orders_count,0);
    assert.equal(readOwnersRegistry(db)[0].id,4,'keep original reverse ID ordering');
  }finally{db.close();}
});
test('index used for paid orders, one read without JavaScript N+1 payouts',()=>{
  const db=fixture();
  try{
    const plan=db.prepare('EXPLAIN QUERY PLAN '+OWNERS_REGISTRY_SQL).all()
      .map(row=>String(row.detail||'')).join('\n');
    assert.match(plan,/idx_orders_point_status_created/,plan);
    const fs=require('node:fs'),path=require('node:path');
    const source=fs.readFileSync(path.join(__dirname,'routes-owners.js'),'utf8');
    const handler=source.split("router.get('/api/salon-owners'")[1]
      .split("router.get('/api/owner-payouts'")[0];
    assert.match(handler,/readOwnersRegistry\(db\)/);
    assert.doesNotMatch(handler,/getOwnerUnpaidSummary|rows\.map\(/);
  }finally{db.close();}
});
