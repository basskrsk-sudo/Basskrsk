'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hvost-point-economics-'));
process.env.DATA_DIR=dir;
const db=require('./db');
const {signToken}=require('./auth');
const {registerPointEquipmentRoutes}=require('./routes-point-equipment');
const {registerEconomicsRoutes}=require('./routes-economics');
const {registerBusinessFounderRoutes}=require('./routes-business-founders');
const {registerOwnerRoutes}=require('./routes-owners');
const {getUnitEconomicsSettings,calculateUnitEconomics}=require('./unit-economics');
const {
  normalizePointEquipment,getPointEquipment,savePointEquipment,
  buildPointEquipmentEconomics,
}=require('./point-equipment');

const router={},routes=new Map();
for(const method of ['get','put','post','delete']){
  router[method]=(url,handler)=>routes.set(method.toUpperCase()+' '+url,handler);
}
registerPointEquipmentRoutes(router);
registerEconomicsRoutes(router);
registerBusinessFounderRoutes(router);
registerOwnerRoutes(router);
async function request(method,route,actor=null,body={},params={},query={}){
  const handler=routes.get(method+' '+route);
  assert.ok(handler,'Route exists: '+method+' '+route);
  const res={status:null,headers:{},body:null,
    setHeader(k,v){this.headers[k]=v;},
    writeHead(status){this.status=status;return this;},
    end(body){this.body=JSON.parse(body);},
  };
  const token=actor?signToken(actor):'';
  await handler({headers:{authorization:token?'Bearer '+token:''}},res,
    {body,params,query});
  return res;
}
const superId=Number(db.prepare(
  'INSERT INTO admins(login,password_hash,full_name,role,active) VALUES(?,?,?,?,1)'
).run('point-econ-super','hash','Test Super','super').lastInsertRowid);
const normalId=Number(db.prepare(
  'INSERT INTO admins(login,password_hash,full_name,role,active) VALUES(?,?,?,?,1)'
).run('point-econ-admin','hash','Test Admin','admin').lastInsertRowid);
const superActor={id:superId,role:'admin',adminRole:'super',login:'point-econ-super'};
const normalActor={id:normalId,role:'admin',adminRole:'admin',login:'point-econ-admin'};
function newPoint(id){
  db.prepare(
    'INSERT INTO points(id,name,addr,icon,city_id,active,is_hub) VALUES(?,?,?,?,?,1,0)'
  ).run(id,'Точка '+id,'Красноярск, тестовый адрес 1','🐾','krsk');
}
for(const id of ['econ-none','econ-large','econ-small','econ-shelf','econ-unknown'])newPoint(id);
function paidOrder(code,pointId,total,{refund=null,status='paid'}={}){
  db.prepare(`INSERT INTO orders(
    order_code,customer_name,customer_phone,pickup_point,point_id,
    subtotal,total,payment_method,status,refund_status,refunded_amount
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(code,'Покупатель','79139000001',
    'Тестовая точка',pointId,total,total,'sbp',status,
    refund===null?'none':refund===total?'refunded':'partially_refunded',
    refund);
}

test('launch equipment validator keeps fixed stand prices, zero cost and custom shelf cost',()=>{
  assert.deepEqual(normalizePointEquipment({type:'none'}).cost,0);
  assert.equal(normalizePointEquipment({type:'large_stand'}).cost,5000);
  assert.equal(normalizePointEquipment({type:'small_stand'}).cost,2500);
  assert.equal(normalizePointEquipment({type:'shelf',shelf_cost:700}).cost,700);
  assert.equal(normalizePointEquipment({type:'shelf',shelf_cost:0}).cost,0);
  for(const input of [{type:'large_stand',shelf_cost:10},{type:'shelf'},
    {type:'shelf',shelf_cost:-1},{type:'shelf',shelf_cost:3.5},
    {type:'unknown'},{type:''},{type:'none',shelf_cost:100}])
    assert.throws(()=>normalizePointEquipment(input),/стоимост|оснащен|полки|вид/i);
});

test('historical points stay unknown, saving change logs and skips duplicate no-op',()=>{
  assert.equal(getPointEquipment(db,'econ-unknown').type,null);
  const actor={id:superId,login:'point-econ-super'};
  for(const [point,type,shelf_cost] of [
    ['econ-none','none',undefined],
    ['econ-large','large_stand',undefined],
    ['econ-small','small_stand',undefined],
    ['econ-shelf','shelf',700],
  ]){
    const changed=savePointEquipment(db,point,{type,shelf_cost},actor);
    assert.equal(changed.changed,true);
  }
  assert.equal(savePointEquipment(db,'econ-small',{type:'small_stand'},actor).changed,false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM point_launch_equipment_log").get().n,4);
  const changed=savePointEquipment(db,'econ-small',{type:'none'},actor);
  assert.equal(changed.cost,0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM point_launch_equipment_log").get().n,5);
  assert.equal(db.prepare("SELECT previous_type,new_type FROM point_launch_equipment_log ORDER BY id DESC LIMIT 1").get().previous_type,'small_stand');
  assert.throws(()=>savePointEquipment(db,'nonexistent',{type:'none'},actor),/Точка не найдена/);
});

test('admin may set equipment; salon owner and manager cannot access internal investment data',async()=>{
  const base='/api/points/:id/launch-equipment',p={id:'econ-unknown'};
  assert.equal((await request('GET',base,null,{},p)).status,401);
  assert.equal((await request('GET',base,{role:'owner',id:77}, {},p)).status,401);
  assert.equal((await request('GET','/api/points/launch-equipment',{role:'manager',id:99})).status,401);
  assert.equal((await request('PUT',base,normalActor,{equipment:{type:'large_stand',shelf_cost:19}},p)).status,400);
  assert.equal((await request('PUT',base,normalActor,{equipment:{type:'none'}},p)).status,200);
  const info=await request('GET',base,normalActor,{},p);
  assert.equal(info.status,200);
  assert.equal(info.body.equipment.cost,0);
  // Even a superadmin must not have a point-economics endpoint. Only the
  // authenticated business-founder dashboard is allowed to return the model.
  assert.equal(routes.has('GET /api/economics/point-launch'),false);
});

test('per-point economics matches equipment cost and avoids double-booking actual expenses',()=>{
  const a=getUnitEconomicsSettings().assumptions;
  const unit=calculateUnitEconomics(a);
  paidOrder('ECO-SALE-A','econ-none',1000);
  paidOrder('ECO-SALE-B','econ-none',250,{refund:50});
  paidOrder('ECO-SALE-C','econ-small',750);
  paidOrder('ECO-SALE-FULL','econ-small',500,{refund:500});
  const orders=db.prepare(
    "SELECT point_id,total,refund_status,refunded_amount FROM orders WHERE status='paid'"
  ).all();
  const data=buildPointEquipmentEconomics(db,a,unit,orders);
  const byId=Object.fromEntries(data.points.map(x=>[x.point_id,x]));
  assert.equal(byId['econ-none'].estimated_launch_cost,null,
    'a salon without equipment or tracked starting stock must not inherit fictional overhead');
  assert.equal(byId['econ-large'].estimated_launch_cost,20000);
  assert.equal(byId['econ-small'].estimated_launch_cost,15000);
  assert.equal(byId['econ-shelf'].estimated_launch_cost,15700);
  assert.equal(byId['econ-none'].estimated_investment,null);
  assert.equal(byId['econ-large'].estimated_investment,22000);
  assert.equal(byId['econ-unknown'].estimated_investment,null,
    'a point configured to none with no start deliveries has an unknown budget');
  assert.equal(byId['econ-none'].period_revenue,1200);
  assert.equal(byId['econ-small'].period_revenue,750);
  assert.equal(byId['econ-small'].period_orders,1);
  assert.ok(data.profit_disclaimer.includes('НЕ фактическая прибыль'));
  const expensesBefore=db.prepare('SELECT COUNT(*) AS n FROM expenses').get().n;
  savePointEquipment(db,'econ-large',{type:'none'},{id:superId,login:'point-econ-super'});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM expenses').get().n,expensesBefore);
  assert.equal(db.prepare('SELECT SUM(cost) AS total FROM point_launch_equipment').get().total,700);
});

test('no-stand launch counts only approved initial goods and bonus, excluding future restocks',()=>{
  const id=Number(db.prepare(
    "INSERT INTO managers(mgr_code,login,password_hash,full_name,phone,active) VALUES(?,?,?,?,?,1)"
  ).run('MGR-ECON-START','manager-econ-start','hash','Менеджер','79130000031').lastInsertRowid);
  const productId=Number(db.prepare(
    'INSERT INTO products(slug,name,category,icon,desc,comp) VALUES(?,?,?,?,?,?)'
  ).run('point-launch-initial-items','Первый товар','treats','🐾','Тест','[]').lastInsertRowid);
  const insertVariant=db.prepare(
    'INSERT INTO product_variants(product_id,weight,price,cost_price) VALUES(?,?,?,?)'
  );
  const known=Number(insertVariant.run(productId,'50 г',300,120).lastInsertRowid);
  const other=Number(insertVariant.run(productId,'100 г',360,170).lastInsertRowid);
  const missing=Number(insertVariant.run(productId,'1 шт',200,null).lastInsertRowid);
  const shipment=(when,items,status='approved')=>{
    const movementId=Number(db.prepare(
      'INSERT INTO stock_movements(manager_id,point_id,city_id,status,reported_at) VALUES(?,?,?,?,?)'
    ).run(id,'econ-none','krsk',status,when).lastInsertRowid);
    for(const [variant,qty] of items) db.prepare(
      'INSERT INTO stock_movement_items(movement_id,variant_id,qty) VALUES(?,?,?)'
    ).run(movementId,variant,qty);
  };
  shipment('2026-09-01 09:00:00',[[known,4],[missing,2]]);
  shipment('2026-09-15 09:00:00',[[other,2]]);
  shipment('2099-01-01 09:00:00',[[known,100]]);
  shipment('2026-08-01 09:00:00',[[known,100]],'rejected');

  const assumptions=getUnitEconomicsSettings().assumptions;
  const unit=calculateUnitEconomics(assumptions);
  const data=buildPointEquipmentEconomics(db,assumptions,unit);
  const point=data.points.find(row=>row.point_id==='econ-none');
  assert.equal(point.initial_goods_known_value,820);
  assert.equal(point.initial_goods_missing_cost_qty,2);
  assert.equal(point.initial_goods_missing_cost_variants,1);
  assert.equal(point.estimated_launch_cost,820);
  assert.equal(point.estimated_investment,2820,
    'must include only initial goods plus 2,000 RUB manager bonus, never 15,000 RUB overhead');
  assert.equal(point.estimated_investment_incomplete,true);
  assert.equal(point.payback_months_at_current_pace,null,
    'unknown initial prices must not imply precise payback');
  assert.ok(data.assumption.includes('15 000 ₽'));
});

test('point stock value uses positive physical qty and current variant purchase cost',()=>{
  const id=Number(db.prepare('INSERT INTO products(slug,name,category,icon,desc,comp) VALUES(?,?,?,?,?,?)')
    .run('point-economics-stock','Товар для теста','treats','🐾','Тест','[]').lastInsertRowid);
  function variant(weight,cost){
    return Number(db.prepare('INSERT INTO product_variants(product_id,weight,price,cost_price) VALUES(?,?,?,?)')
      .run(id,weight,500,cost).lastInsertRowid);
  }
  const priced=variant('50 г',120.5),free=variant('1 шт',0),
    missing=variant('100 г',null),extra=variant('2 шт',80);
  function setStock(pointId,variantId,qty){
    db.prepare('INSERT INTO stock(point_id,variant_id,qty) VALUES(?,?,?)')
      .run(pointId,variantId,qty);
  }
  setStock('econ-none',priced,3);
  setStock('econ-none',free,4);
  setStock('econ-none',missing,2);
  setStock('econ-large',extra,1);
  setStock('econ-shelf',extra,-5); // Invalid historical corrections must not count.
  const assumptions=getUnitEconomicsSettings().assumptions;
  const unit=calculateUnitEconomics(assumptions);
  const result=buildPointEquipmentEconomics(db,assumptions,unit);
  const rows=Object.fromEntries(result.points.map(p=>[p.point_id,p]));
  assert.equal(rows['econ-none'].inventory_qty,9);
  assert.equal(rows['econ-none'].inventory_known_value,361.5);
  assert.equal(rows['econ-none'].inventory_valuation,null);
  assert.equal(rows['econ-none'].inventory_missing_cost_qty,2);
  assert.equal(rows['econ-none'].inventory_missing_cost_variants,1);
  assert.equal(rows['econ-large'].inventory_valuation,80);
  assert.equal(rows['econ-shelf'].inventory_qty,0);
  assert.equal(rows['econ-shelf'].inventory_valuation,0);
  assert.ok(result.summary.inventory_qty>=10);
  assert.ok(result.summary.inventory_known_value>=441.5);
  assert.equal(result.summary.inventory_valuation,null);
  assert.match(result.inventory_disclaimer,/консигнации/);
  const expenses=db.prepare('SELECT COUNT(*) AS n FROM expenses').get().n;
  buildPointEquipmentEconomics(db,assumptions,unit);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM expenses').get().n,expenses);
});
test('founder-only boardroom receives all point economics, owners see no cost basis',async()=>{
  const id=Number(db.prepare('SELECT id FROM business_founders ORDER BY id LIMIT 1').get().id);
  db.prepare(
    "UPDATE business_founders SET login='econ-founder',phone='79131000001',password_hash='hash',active=1 WHERE id=?"
  ).run(id);
  const actor={id,role:'founder',login:'econ-founder'};
  const privateResult=await request('GET','/api/business-founder/dashboard',actor,{}, {}, {period:'30d'});
  assert.equal(privateResult.status,200,JSON.stringify(privateResult.body).slice(0,200));
  const info=privateResult.body.point_economics;
  assert.ok(info?.points?.length>=5);
  assert.ok(info.points.some(p=>p.point_id==='econ-none'));
  assert.ok(Number.isFinite(info.summary.estimated_period_contribution));
   assert.equal(info.points.find(p=>p.point_id==='econ-none').inventory_known_value,361.5);
   assert.equal(info.points.find(p=>p.point_id==='econ-none').inventory_valuation,null);
   assert.equal(info.summary.inventory_valuation,null);
  assert.equal((await request('GET','/api/business-founder/dashboard',normalActor)).status,401);
  const ownerId=Number(db.prepare(
    'INSERT INTO salon_owners(login,password_hash,full_name,phone,point_id) VALUES(?,?,?,?,?)'
  ).run('salon-owner-econ','hash','Владелец','79131000002','econ-none').lastInsertRowid);
  const ownerActor={id:ownerId,role:'owner',login:'salon-owner-econ'};
  const ownerRes=await request('GET','/api/owner/dashboard',ownerActor);
  assert.equal(ownerRes.status,200,ownerRes.body?.error);
  assert.equal(ownerRes.body.point.id,'econ-none');
  assert.equal(ownerRes.body.totals.revenue,1200);
  const json=JSON.stringify(ownerRes.body);
  for(const field of ['estimated_investment','estimated_period_contribution',
    'equipment_prices','point_launch_equipment','model_contribution_margin_percent',
     'inventory_valuation','inventory_known_value','inventory_missing_cost_qty'])
    assert.equal(json.includes(field),false,'owner cannot see internal cost: '+field);
});
test('point economics UI exists only in the company founder dashboard',()=>{
  const founder=fs.readFileSync(path.join(__dirname,'../public/miniapp-founder.js'),'utf8');
  const admin=fs.readFileSync(path.join(__dirname,'../public/taiga-admin.html'),'utf8');
  const salon=fs.readFileSync(path.join(__dirname,'../public/taiga-owner.html'),'utf8');
  const editor=fs.readFileSync(path.join(__dirname,'../public/admin-point-equipment.js'),'utf8');
  assert.match(founder,/Экономика каждой точки/);
  assert.match(founder,/Товар по закупке/);
  assert.match(founder,/estimated_investment_incomplete/);
  assert.match(founder,/initial_goods_known_value/);
  assert.match(founder,/Без закупочной цены/);
  assert.doesNotMatch(admin,/point-economics-card|point-economics-body|\/api\/economics\/point-launch/);
  assert.doesNotMatch(editor,/renderEconomics|\/api\/economics\/point-launch/);
  assert.doesNotMatch(salon,/point_economics|estimated_investment/);
});
test.after(()=>{try{db.close();}catch(_){}fs.rmSync(dir,{recursive:true,force:true});});
