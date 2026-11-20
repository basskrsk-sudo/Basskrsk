'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {loadPointPayoutProfit}=require('./point-period-finance');

function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE partners(id INTEGER PRIMARY KEY,commission_rate REAL);
    CREATE TABLE salon_owners(id INTEGER PRIMARY KEY,point_id TEXT,commission_rate REAL,active INTEGER);
    CREATE TABLE orders(id INTEGER PRIMARY KEY,point_id TEXT,partner_id INTEGER,commission_rate REAL,total REAL,
      status TEXT,created_at TEXT,refund_status TEXT,refunded_amount REAL);
    CREATE TABLE partner_payout_items(order_id INTEGER,commission_amount REAL);
    CREATE TABLE owner_payout_items(order_id INTEGER,commission_amount REAL);
    CREATE TABLE product_variants(id INTEGER PRIMARY KEY,price REAL,cost_price REAL);
    CREATE TABLE order_items(order_id INTEGER,variant_id INTEGER,qty INTEGER,price REAL);
    INSERT INTO partners VALUES(1,0.15);
    INSERT INTO salon_owners VALUES(2,'a',0.2,1);
    INSERT INTO product_variants VALUES(1,250,100),(2,300,120),(3,250,NULL);
    INSERT INTO orders VALUES
      (1,'a',1,0.10,250,'paid','2026-11-01 00:00:00','none',NULL),
      (2,'a',1,0.10,250,'paid','2026-11-02 00:00:00','none',NULL),
      (3,'a',1,0.10,300,'paid','2026-11-03 00:00:00','partially_refunded',100),
      (4,'a',1,0.10,300,'paid','2026-11-04 00:00:00','refunded',300),
      (5,'a',1,0.10,250,'paid','2026-10-01 00:00:00','none',NULL);
    INSERT INTO order_items VALUES(1,1,1,250),(2,1,1,250),(3,2,1,300),(4,2,1,300),(5,3,1,250);
    INSERT INTO partner_payout_items VALUES(1,25),(4,30),(5,80);
    INSERT INTO owner_payout_items VALUES(1,50),(5,60);
  `);
  return db;
}
function orders(db){
  return db.prepare("SELECT id,point_id,partner_id,commission_rate,total,refund_status,refunded_amount "+
    "FROM orders WHERE status='paid' AND created_at>='2026-11-01 00:00:00' AND created_at<'2026-12-01 00:00:00'").all();
}
const period={from:'2026-11-01 00:00:00',to:'2026-12-01 00:00:00'};
const assumptions={manager_commission_percent:7,acquiring_percent:2.7,
  logistics_percent:5,writeoffs_percent:1.5,bonuses_it_percent:1.5};

test('recorded transfers and pending commissions are separated without double counting',()=>{
  const db=fixture();
  try{
    const p=loadPointPayoutProfit(db,orders(db),assumptions,period).get('a');
    assert.equal(p.partner_paid,55,'includes already paid commission on a fully refunded order');
    assert.equal(p.partner_pending,25);
    assert.equal(p.partner_refund_hold,20);
    assert.equal(p.partner_accrued,100);
    assert.equal(p.owner_paid,50);
    assert.equal(p.owner_pending,50);
    assert.equal(p.owner_refund_hold,40);
    assert.equal(p.owner_accrued,140);
    assert.equal(p.commission_refund_review_orders,1);
  }finally{db.close()}
});
test('founder period profit deducts product costs, manager costs, tax and full partner liabilities once',()=>{
  const db=fixture();
  try{
    const p=loadPointPayoutProfit(db,orders(db),assumptions,period).get('a');
    assert.equal(p.profit_revenue,700);
    assert.equal(p.profit_cogs,280,'only the net share of partially refunded products is counted');
    assert.equal(p.profit_tax,49);
    assert.equal(p.profit_manager_est,49);
    assert.equal(p.profit_other_costs_est,74.9);
    assert.equal(p.founder_profit_est,7.1);
    assert.equal(p.profit_missing_item_orders,0);
  }finally{db.close()}
});
test('selected sales period excludes historical payout and records, even if transferred later',()=>{
  const db=fixture();
  try{
    db.exec("INSERT INTO partner_payout_items VALUES(2,25)");
    let result=loadPointPayoutProfit(db,orders(db),assumptions,period).get('a');
    assert.equal(result.partner_paid,80);
    assert.equal(result.partner_pending,0);
    assert.equal(result.founder_profit_est,7.1,
      'moving accrued commission from pending to paid must never change company earnings');
    db.exec("INSERT INTO orders VALUES(6,'b',NULL,NULL,100,'paid','2026-11-05 00:00:00','none',NULL)");
    const all=orders(db);
    result=loadPointPayoutProfit(db,all,assumptions,period).get('b');
    assert.equal(result.profit_missing_item_orders,1);
    assert.equal(result.profit_cogs,50,'missing historic order items use 50% net revenue fallback');
    assert.equal(result.partner_accrued,0);
    assert.equal(result.owner_accrued,0);
  }finally{db.close()}
});
test('current catalog cost overrides fallback and no owner means no assumed owner commission',()=>{
  const db=fixture();
  try{
    db.exec("INSERT INTO orders VALUES(7,'b',1,NULL,250,'paid','2026-11-05 01:00:00','none',NULL)");
    db.exec("INSERT INTO order_items VALUES(7,3,1,250)");
    const row=loadPointPayoutProfit(db,orders(db),assumptions,period).get('b');
    assert.equal(row.profit_cogs,125);
    assert.equal(row.profit_fallback_item_qty,1);
    assert.equal(row.partner_pending,38,'frozen rate missing: use current partner rate');
    assert.equal(row.owner_pending,0);
  }finally{db.close()}
});
