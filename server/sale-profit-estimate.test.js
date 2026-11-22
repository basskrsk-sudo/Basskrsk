'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {loadSaleProfitEstimate}=require('./sale-profit-estimate');
const {sendSuperadminSaleProfit,formatSuperadminSaleProfit}=require('./superadmin-sale-profit');
const assumptions={manager_commission_percent:7,acquiring_percent:2.7,logistics_percent:5};
function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE product_variants(id INTEGER PRIMARY KEY,price REAL,cost_price REAL);'+
    'CREATE TABLE order_items(id INTEGER PRIMARY KEY,order_id INTEGER,name TEXT,weight TEXT,qty INTEGER,price REAL,is_custom INTEGER,variant_id INTEGER);'+
    'CREATE TABLE partners(id INTEGER PRIMARY KEY,commission_rate REAL);'+
    'CREATE TABLE salon_owners(id INTEGER PRIMARY KEY,point_id TEXT,active INTEGER,commission_rate REAL);'+
    'CREATE TABLE partner_payout_items(order_id INTEGER,commission_amount REAL);'+
    'CREATE TABLE owner_payout_items(order_id INTEGER,commission_amount REAL);'+
    'CREATE TABLE business_founders(id INTEGER PRIMARY KEY,full_name TEXT,share_percent REAL);'+
    'CREATE TABLE admins(id INTEGER PRIMARY KEY,role TEXT,active INTEGER,telegram_chat_id TEXT);'+
    'INSERT INTO product_variants VALUES(1,250,100),(2,300,NULL);'+
    "INSERT INTO order_items VALUES(1,1,'Лёгкое','50 г',1,250,0,1);"+
    "INSERT INTO partners VALUES(3,0.15);"+
    "INSERT INTO salon_owners VALUES(1,'point1',1,0.05);"+
    "INSERT INTO business_founders VALUES"+
      "(1,'Лакомых Алексей',45),(2,'Соколов Виталий',35),(3,'Кучкин Николай',20);"+
    "INSERT INTO admins VALUES"+
      "(1,'super',1,'111222333'),(2,'admin',1,'555666777'),"+
      "(3,'super',0,'777888999'),(4,'super',1,'111222333'),"+
      "(5,'super',1,NULL);"
  );
  return db;
}
function order(){
  return {id:1,order_code:'legacy-1',display_number:'ХМ-00001',
    status:'paid',total:250,point_id:'point1',partner_id:3,
    partner_name:'Грумер',pickup_point:'БаркЛай',created_at:'2026-11-21 07:00:00',
    commission_rate:0.15,refund_status:'none',refunded_amount:0};
}
test('one real paid order gives costs and 45/35/20 private shares to a cent',()=>{
 const db=fixture();
 try{
  const result=loadSaleProfitEstimate(db,order(),assumptions);
  assert.equal(result.revenue,250);
  assert.equal(result.cogs_est,100);
  assert.equal(result.partner_commission,38);
  assert.equal(result.salon_commission,13);
  assert.equal(result.tax_est,17.5);
  assert.equal(result.manager_est,17.5);
  assert.equal(result.acquiring_est,6.75);
  assert.equal(result.logistics_est,12.5);
  assert.equal(result.founder_profit_est,44.75);
  assert.deepEqual(result.founder_shares.map(x=>[x.share_percent,x.profit_est]),
    [[45,20.14],[35,15.66],[20,8.95]]);
  assert.equal(result.founder_shares.reduce((s,x)=>s+x.profit_est,0),44.75);
  assert.equal(result.founder_split_available,true);
  assert.equal(result.items[0].cost_estimated,false);
 }finally{db.close();}
});
test('fallback cost is clearly labeled; refund updates profit and allocations',()=>{
 const db=fixture();
 try{
  db.exec("INSERT INTO order_items VALUES(2,1,'Игрушка','1 шт',1,300,0,2)");
  const s=loadSaleProfitEstimate(db,{...order(),total:550,refunded_amount:100,
    refund_status:'refunded'},assumptions);
  assert.equal(s.refund_amount,100);
  assert.equal(s.revenue,450);
  assert.equal(s.fallback_item_qty,1);
  assert.equal(s.items[1].cost_estimated,true);
  assert.equal(s.cogs_est,Math.round((100+150)*450/550*100)/100);
  const refunded=loadSaleProfitEstimate(db,{...order(),
    refund_status:'refunded',refunded_amount:250},assumptions);
  assert.equal(refunded.revenue,0);
  assert.equal(refunded.founder_profit_est,0);
  const legacy=loadSaleProfitEstimate(db,{...order(),refund_status:'refunded',
    refunded_amount:null},assumptions);
  assert.equal(legacy.revenue,0,'legacy refunded orders with unknown amount stay at zero');
 }finally{db.close();}
});
test('already paid partner and salon commission used once, not accrued twice',()=>{
 const db=fixture();
 try{
  db.exec('INSERT INTO partner_payout_items VALUES(1,20);'+
    'INSERT INTO owner_payout_items VALUES(1,12)');
  const result=loadSaleProfitEstimate(db,order(),assumptions);
  assert.equal(result.partner_commission,20);
  assert.equal(result.salon_commission,12);
  assert.equal(result.founder_profit_est,63.75);
 }finally{db.close();}
});
test('only active linked superadmins receive one private Telegram message',async()=>{
 const db=fixture();
 try{
  const sent=[];
  const send=async(chat,text)=>{sent.push({chat,text});return {ok:true}};
  const status=await sendSuperadminSaleProfit(db,order(),{assumptions,send});
  assert.deepEqual(status,{attempted:1,delivered:1});
  assert.equal(sent[0].chat,'111222333');
  assert.match(sent[0].text,/ХМ-00001/);
  assert.match(sent[0].text,/<b>Расчётная прибыль ХвостМаркет: 44,75 ₽<\/b>/);
  assert.doesNotMatch(sent[0].text,/Доли собственников|Лакомых|Соколов|Кучкин/);
  assert.doesNotMatch(sent[0].text,/45%|35%|20%/);
  const skipped=await sendSuperadminSaleProfit(db,{...order(),status:'pending'},
    {assumptions,send});
  assert.equal(skipped.attempted,0);
  assert.equal(sent.length,1);
 }finally{db.close();}
});
test('untrusted product and salon names are HTML-escaped in Telegram',()=>{
 const db=fixture();
 try{
  db.exec("UPDATE order_items SET name='<b>gift & steal</b>' WHERE id=1");
  const result=loadSaleProfitEstimate(db,{...order(),pickup_point:'Салон <script>'},assumptions);
  const text=formatSuperadminSaleProfit(result,{demo:true});
  assert.match(text,/&lt;b&gt;gift &amp; steal&lt;\/b&gt;/);
  assert.match(text,/Салон &lt;script&gt;/);
  assert.match(text,/ДЕМО/);
  assert.doesNotMatch(text,/<script>|<b>gift/);
 }finally{db.close();}
});
test('no founder allocations are fabricated when shares are inconsistent',()=>{
 const db=fixture();
 try{
  db.exec('UPDATE business_founders SET share_percent=40 WHERE id=1');
  const result=loadSaleProfitEstimate(db,order(),assumptions);
  assert.equal(result.founder_split_available,false);
  assert.deepEqual(result.founder_shares,[]);
  const message=formatSuperadminSaleProfit(result);
  assert.match(message,/Расчётная прибыль ХвостМаркет/);
  assert.doesNotMatch(message,/не дают 100%|Доли собственников|Лакомых|Соколов|Кучкин/);
 }finally{db.close();}
});
