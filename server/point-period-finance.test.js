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
    CREATE TABLE order_items(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,variant_id INTEGER,qty INTEGER,price REAL,
      name TEXT DEFAULT 'Товар',weight TEXT DEFAULT '1 шт',is_custom INTEGER DEFAULT 0
    );
    INSERT INTO partners VALUES(1,0.15);
    INSERT INTO salon_owners VALUES(2,'a',0.2,1);
    INSERT INTO product_variants VALUES(1,250,100),(2,300,120),(3,250,NULL);
    INSERT INTO orders VALUES
      (1,'a',1,0.10,250,'paid','2026-11-01 00:00:00','none',NULL),
      (2,'a',1,0.10,250,'paid','2026-11-02 00:00:00','none',NULL),
      (3,'a',1,0.10,300,'paid','2026-11-03 00:00:00','refunded',100),
      (4,'a',1,0.10,300,'paid','2026-11-04 00:00:00','refunded',300),
      (5,'a',1,0.10,250,'paid','2026-10-01 00:00:00','none',NULL);
    INSERT INTO order_items(order_id,variant_id,qty,price) VALUES(1,1,1,250),(2,1,1,250),(3,2,1,300),(4,2,1,300),(5,3,1,250);
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
// The nonzero legacy percentages are intentional regression inputs. Both reserves
// must remain off until explicitly reintroduced in a later approved change.

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
    assert.equal(p.profit_other_costs_est,53.9,
      'only acquiring and logistics remain; no 3% reserve for writeoffs/IT');
    assert.equal(p.founder_profit_est,28.1);
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
    assert.equal(result.founder_profit_est,28.1,
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
    db.exec("INSERT INTO order_items(order_id,variant_id,qty,price) VALUES(7,3,1,250)");
    const row=loadPointPayoutProfit(db,orders(db),assumptions,period).get('b');
    assert.equal(row.profit_cogs,125);
    assert.equal(row.profit_fallback_item_qty,1);
    assert.equal(row.partner_pending,38,'frozen rate missing: use current partner rate');
    assert.equal(row.owner_pending,0);
  }finally{db.close()}
});

test('order-level distribution reconciles with point profit and shows real paid versus pending',()=>{
  const db=fixture();
  try{
    const selected=orders(db).map(o=>({...o,
      order_code:'ORDER-'+o.id,
      created_at:'2026-11-0'+o.id+' 10:00:00',
      partner_name:'Test groomer'
    }));
    const all=loadPointPayoutProfit(db,selected,assumptions,period).get('a');
    const detail=loadPointPayoutProfit(db,selected,assumptions,period,
      {includeOrderDetails:true}).get('a');
    assert.equal(detail.order_details.length,4);
    assert.deepEqual(detail.order_details.map(x=>x.founder_profit_est),[20.75,20.75,16.6,-30]);
    assert.ok(Math.abs(detail.order_details.reduce((sum,x)=>sum+x.founder_profit_est,0)-28.1)<0.001);
    assert.equal(detail.founder_profit_est,all.founder_profit_est,
      'the drilldown and summary must use identical calculations');
    const first=detail.order_details[0];
    assert.equal(first.revenue,250);
    assert.equal(first.cogs_est,100);
    assert.equal(first.tax_est,17.5);
    assert.equal(first.partner_paid,25);
    assert.equal(first.partner_pending,0);
    assert.equal(first.owner_paid,50);
    assert.equal(first.owner_pending,0);
    assert.equal(first.manager_est,17.5);
    assert.equal(first.acquiring_est,6.75);
    assert.equal(first.logistics_est,12.5);
    assert.equal(first.writeoffs_est,0,'writeoff reserve is disabled');
    assert.equal(first.it_est,0,'IT and miscellaneous bonus reserve is disabled');
    assert.equal(first.items.length,1);
    assert.equal(first.items[0].qty,1);
    assert.equal(first.items[0].unit_cost,100);
    assert.equal(first.items[0].net_cost,100);
    assert.equal(first.items[0].cost_estimated,false);
    assert.equal(Object.hasOwn(first,'customer_phone'),false);
    const partial=detail.order_details.find(x=>x.id===3);
    assert.equal(partial.refund_amount,100);
    assert.equal(partial.revenue,200);
    assert.equal(partial.cogs_est,80);
    assert.equal(partial.partner_refund_hold,20);
    assert.equal(partial.owner_refund_hold,40);
    const full=detail.order_details.find(x=>x.id===4);
    assert.equal(full.revenue,0);
    assert.equal(full.partner_paid,30);
    assert.equal(full.founder_profit_est,-30);
  }finally{db.close()}
});

test('drilldown restricts payout, items and calculation to selected order IDs',()=>{
  const db=fixture();
  try{
    const all=orders(db);
    const one=loadPointPayoutProfit(db,[all[1]],assumptions,period,
      {includeOrderDetails:true}).get('a');
    assert.equal(one.order_details.length,1);
    assert.equal(one.order_details[0].id,2);
    assert.equal(one.order_details[0].partner_paid,0);
    assert.equal(one.order_details[0].partner_pending,25);
    assert.equal(one.order_details[0].owner_pending,50);
    assert.equal(one.founder_profit_est,20.75);
    assert.equal(loadPointPayoutProfit(db,[],assumptions,period,
      {includeOrderDetails:true}).size,0);
  }finally{db.close()}
});
