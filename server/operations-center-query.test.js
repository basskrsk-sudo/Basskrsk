'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const work=fs.mkdtempSync(path.join(os.tmpdir(),'hm-ops-last-sale-'));
process.env.DATA_DIR=work;
const db=require('./db');
const {SILENT_POINTS_SQL,STOCK_ALERTS_SQL,registerOperationsRoutes}=require('./routes-operations');
const {signToken}=require('./auth');
const {snapshotOperations}=require('./runtime-diagnostics');
function point(id,active=1){
  db.prepare('INSERT INTO points(id,name,addr,icon,active) VALUES(?,?,?,?,?)').run(id,id,'Красноярск','🐾',active);
}
function order(pointId,status,age,id){
  db.prepare("INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,point_id,subtotal,total,payment_method,status,created_at) "+
    "VALUES(?,?,?,?,?,?,?,?,?,datetime('now',?))")
    .run('ops-test-'+id,'Клиент','79991231212',pointId,pointId,200,200,'sbp',status,age);
}
test('silent point query honors 7-day window and ignores unpaid orders and inactive points',()=>{
  point('ops-never');
  point('ops-old');
  point('ops-recent');
  point('ops-pending');
  point('ops-inactive',0);
  order('ops-old','paid','-15 days',1);
  order('ops-old','failed','-2 hours',2);
  order('ops-recent','paid','-2 days',3);
  order('ops-pending','pending','-1 day',4);
  order('ops-inactive','paid','-20 days',5);
  const rows=db.prepare(SILENT_POINTS_SQL).all();
  assert.deepEqual(rows.map(row=>row.id).sort(),['ops-never','ops-old','ops-pending']);
  assert.equal(rows.find(row=>row.id==='ops-never').last_sale,null);
  assert.match(rows.find(row=>row.id==='ops-old').last_sale,/^\d{4}-\d{2}-\d{2}/);
  assert.equal(rows.find(row=>row.id==='ops-pending').last_sale,null);
});
test('last-sale lookup uses existing point, status, date index',()=>{
  const plan=db.prepare('EXPLAIN QUERY PLAN '+SILENT_POINTS_SQL).all();
  const details=plan.map(row=>String(row.detail||'')).join('\n');
  assert.match(details,/idx_orders_point_status_created/);
  assert.doesNotMatch(SILENT_POINTS_SQL,/LEFT JOIN orders|GROUP BY p\.id/);
});
test('admin-only route retains structured output and records runtime',()=>{
  const routes=new Map();
  registerOperationsRoutes({get:(route,handler)=>routes.set(route,handler)});
  const res={status:null,body:null,
    writeHead(code){this.status=code;return this;},
    end(raw){this.body=JSON.parse(raw);}};
  routes.get('/api/operations-center')({
    headers:{authorization:'Bearer '+signToken({role:'admin',id:1,login:'ops-test',adminRole:'super'})}
  },res,{query:{},params:{}});
  assert.equal(res.status,200);
  assert.ok(Array.isArray(res.body.issues));
  const silent=res.body.issues.find(row=>row.key==='silent_points');
  assert.ok(silent);
  assert.equal(silent.count,3);
  assert.ok(snapshotOperations().some(row=>row.name==='operations_center_build'));
});

function makeVariant(tag, active=1, productActive=1){
  const prod=Number(db.prepare(
    'INSERT INTO products(slug,name,category,icon,desc,comp,active) VALUES(?,?,?,?,?,?,?)'
  ).run('ops-product-'+tag,'Ops product '+tag,'treats','🐾','Test','[]',productActive).lastInsertRowid);
  return Number(db.prepare(
    'INSERT INTO product_variants(product_id,weight,price,active) VALUES(?,?,?,?)'
  ).run(prod,tag+' г',250,active).lastInsertRowid);
}
function stock(id,variant,qty){
  db.prepare('INSERT INTO stock(point_id,variant_id,qty) VALUES(?,?,?)').run(id,variant,qty);
}
function purchaseWithItem(id,variant,age,status,number){
  const orderId=db.prepare(
    'INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,point_id,'+
    'subtotal,total,payment_method,status,created_at) '+
    "VALUES(?,?,?,?,?,?,?,?,?,datetime('now',?))"
  ).run('ops-stock-'+number,'Покупатель','79991112233','Point',id,250,250,'sbp',status,age).lastInsertRowid;
  db.prepare('INSERT INTO order_items(order_id,variant_id,name,weight,price,qty) VALUES(?,?,?,?,?,?)')
    .run(orderId,variant,'Ops product','50 г',250,1);
}

test('batch stock alerts preserve former 30-day rule and do not multiply repeated sales',()=>{
  const v=makeVariant('active'),low=makeVariant('low'),
    old=makeVariant('old'),inactiveVariant=makeVariant('hidden-variant',0),
    inactiveProduct=makeVariant('hidden-product',1,0);
  stock('ops-old',v,0);
  stock('ops-recent',v,0);
  stock('ops-never',v,0);
  stock('ops-pending',v,0);
  stock('ops-inactive',v,0);
  stock('ops-never',low,2);
  stock('ops-old',old,0);
  stock('ops-old',inactiveVariant,1);
  stock('ops-old',inactiveProduct,1);
  purchaseWithItem('ops-old',v,'-15 days','paid',10);
  purchaseWithItem('ops-old',v,'-14 days','paid',11);
  purchaseWithItem('ops-recent',v,'-2 days','paid',12);
  purchaseWithItem('ops-pending',v,'-1 days','failed',13);
  purchaseWithItem('ops-inactive',v,'-1 days','paid',14);
  purchaseWithItem('ops-old',old,'-40 days','paid',15);
  const oldSQL=[
    'SELECT s.point_id, pt.name AS point_name, pr.name AS product_name,',
    'pv.weight, s.qty, CASE WHEN s.qty <= 0 THEN 1 ELSE 0 END AS is_out',
    'FROM stock s',
    'JOIN points pt ON pt.id=s.point_id AND pt.active=1',
    'JOIN product_variants pv ON pv.id=s.variant_id AND pv.active=1',
    'JOIN products pr ON pr.id=pv.product_id AND pr.active=1',
    'WHERE s.qty BETWEEN 1 AND 2 OR (s.qty<=0 AND EXISTS (',
    'SELECT 1 FROM order_items oi JOIN orders o ON o.id=oi.order_id',
    "WHERE oi.variant_id=s.variant_id AND o.point_id=s.point_id AND o.status='paid'",
    "AND o.created_at>=datetime('now','-30 days')))",
    'ORDER BY is_out DESC,s.qty,pt.name,pr.name',
  ].join(' ');
  const previous=db.prepare(oldSQL).all();
  const updated=db.prepare(STOCK_ALERTS_SQL).all();
  const key=row=>JSON.stringify([
    row.point_id,row.point_name,row.product_name,row.weight,row.qty,row.is_out
  ]);
  assert.deepEqual(updated.map(key).sort(),previous.map(key).sort());
  assert.equal(updated.length,3,'only two sold-out positions and one low-stock position');
  assert.deepEqual(updated.filter(r=>r.is_out).map(r=>r.point_id).sort(),['ops-old','ops-recent']);
  assert.equal(updated.filter(r=>r.point_id==='ops-old').length,1,'repeat sales must not duplicate alerts');
  assert.equal(updated.find(r=>r.point_id==='ops-never').qty,2);
});
test('paid orders and order items are read once via existing indexes',()=>{
  const plan=db.prepare('EXPLAIN QUERY PLAN '+STOCK_ALERTS_SQL).all()
    .map(row=>String(row.detail||'')).join('\n');
  assert.match(plan,/idx_orders_status_created/,plan);
  assert.match(plan,/idx_order_items_order/,plan);
  assert.match(STOCK_ALERTS_SQL,/SELECT DISTINCT o.point_id, oi.variant_id/);
  assert.doesNotMatch(STOCK_ALERTS_SQL,/EXISTS\s*\(/);
  const source=fs.readFileSync(path.join(__dirname,'routes-operations.js'),'utf8');
  assert.match(source,/trackSync\('operations_stock_alerts'/);
});

test.after(()=>{try{db.close();}catch(_){}fs.rmSync(work,{recursive:true,force:true});});
