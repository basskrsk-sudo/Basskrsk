'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const work=fs.mkdtempSync(path.join(os.tmpdir(),'hm-ops-last-sale-'));
process.env.DATA_DIR=work;
const db=require('./db');
const {SILENT_POINTS_SQL,registerOperationsRoutes}=require('./routes-operations');
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
test.after(()=>{try{db.close();}catch(_){}fs.rmSync(work,{recursive:true,force:true});});
