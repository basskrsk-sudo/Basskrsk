'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-catalog-perf-'));
process.env.TOKEN_SECRET='catalog-perf-test-secret';
const db=require('./db');
const {buildCatalog}=require('./product-catalog');
const {registerProductRoutes}=require('./routes-products');
const {Router}=require('./http-utils');
const {signToken}=require('./auth');

const productId=Number(db.prepare(
  "INSERT INTO products(slug,name,category,icon,desc,comp,active) VALUES(?,?,?,?,?,?,1)"
).run('perf-test-active','Test Liver','treats','🐶','Unit test',JSON.stringify(['liver'])).lastInsertRowid);
const hiddenId=Number(db.prepare(
  "INSERT INTO products(slug,name,category,icon,desc,comp,active) VALUES(?,?,?,?,?,?,0)"
).run('perf-test-hidden','Hidden Product','treats','🐕','Hidden test','[]').lastInsertRowid);
const variantId=Number(db.prepare(
  "INSERT INTO product_variants(product_id,weight,price,cost_price,active,sort_order) VALUES(?,?,?,?,1,1)"
).run(productId,'50 г',250,90).lastInsertRowid);
const inactiveVariantId=Number(db.prepare(
  "INSERT INTO product_variants(product_id,weight,price,cost_price,active,sort_order) VALUES(?,?,?,?,0,2)"
).run(productId,'100 г',420,140).lastInsertRowid);
db.prepare("INSERT INTO points(id,name,addr,icon,city_id) VALUES(?,?,?,?,?)")
  .run('perf-stock-point','Test Point','Test Street','🏪','krsk');
db.prepare("INSERT INTO stock(variant_id,point_id,qty) VALUES(?,?,?)")
  .run(variantId,'perf-stock-point',8);
db.prepare("INSERT INTO stock(variant_id,point_id,qty) VALUES(?,?,?)")
  .run(inactiveVariantId,'perf-stock-point',3);
db.prepare(
  "INSERT INTO guest_product_reviews(product_id,author_name,rating,text,visitor_hash,status) VALUES(?,?,?,?,?,'approved')"
).run(productId,'Guest A',5,'Great liver snacks','perf-visitor-1');
db.prepare(
  "INSERT INTO guest_product_reviews(product_id,author_name,rating,text,visitor_hash,status) VALUES(?,?,?,?,?,'approved')"
).run(productId,'Guest B',2,'Another evaluation','perf-visitor-2');
db.prepare(
  "INSERT INTO guest_product_reviews(product_id,author_name,rating,text,visitor_hash,status) VALUES(?,?,?,?,?,'pending')"
).run(productId,'Guest C',1,'Pending must stay private','perf-visitor-3');
const router=new Router();registerProductRoutes(router);
function query(all,token){
  const matched=router.match('GET','/api/products');
  assert.ok(matched);
  const res={
    status:null,body:null,
    writeHead(status){this.status=status;},
    end(raw){this.body=JSON.parse(raw);}
  };
  matched.handler({headers:token?{authorization:'Bearer '+token}:{}},res,
    {query:all?{all:'1'}:{}});
  assert.equal(res.status,200);
  return res.body.products;
}
test('public catalog remains live, hides cost and inactive variants, and aggregates approved reviews',()=>{
  const products=query(false);
  const p=products.find(p=>p.id===productId);
  assert.ok(p);
  assert.deepEqual(p.comp,['liver']);
  assert.deepEqual(p.variants.map(v=>v.weight),['50 г']);
  assert.equal(p.variants[0].price,250);
  assert.deepEqual(p.variants[0].stock,{'perf-stock-point':8});
  assert.equal(Object.hasOwn(p.variants[0],'cost_price'),false);
  assert.equal(p.review_count,2);
  assert.equal(p.review_avg,3.5);
  assert.equal(p.sales_count,0);
  assert.equal(products.some(item=>item.id===hiddenId),false);
  db.prepare('UPDATE stock SET qty=? WHERE variant_id=? AND point_id=?').run(6,variantId,'perf-stock-point');
  assert.equal(query(false).find(p=>p.id===productId).variants[0].stock['perf-stock-point'],6,
    'inventory must never be stale when buyers reload the catalog');
});
test('authenticated admin catalog retains inactive variants and purchase prices',()=>{
  const token=signToken({role:'admin',id:98765,adminRole:'super'});
  const products=query(true,token),p=products.find(p=>p.id===productId);
  assert.ok(p);
  assert.equal(p.variants.length,2);
  assert.equal(p.variants[0].cost_price,90);
  assert.equal(p.variants[1].active,false);
  assert.equal(p.variants[1].cost_price,140);
  assert.equal(products.some(item=>item.id===hiddenId),true);
});
test('SQL read count is constant regardless of number of products',()=>{
  let prepares=0;
  const connection={prepare(sql){prepares++;return db.prepare(sql);}};
  const rows=db.prepare("SELECT * FROM products WHERE id IN (?,?)").all(productId,hiddenId);
  const result=buildCatalog(rows,true,true,new Map([[productId,4]]),connection);
  assert.equal(prepares,3,'one read each for variants, stock, and review summaries');
  assert.equal(result.find(p=>p.id===productId).sales_count,4);
  assert.equal(result.length,2);
});

test('product popularity is cached for one minute while new stock remains live',()=>{
  const {createSalesCountCache}=require('./product-sales-cache');
  let now=1000, queries=0, sales=4;
  const cache=createSalesCountCache(()=>{queries++;return [{product_id:productId,sales_count:sales}];},
    {ttlMs:60000,clock:()=>now});
  assert.equal(cache.get().get(productId),4);
  sales=5;
  now+=30000;
  assert.equal(cache.get().get(productId),4);
  assert.equal(queries,1,'repeated requests must not re-aggregate paid history');
  now+=30001;
  assert.equal(cache.get().get(productId),5);
  assert.equal(queries,2);
  cache.invalidate();
  assert.equal(cache.get().get(productId),5);
  assert.equal(queries,3);
});
