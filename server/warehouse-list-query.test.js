'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {BATCH_SIZE,hydrateRestockRequests,hydrateStockMovements}=require('./warehouse-list-query');

function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE products(id INTEGER PRIMARY KEY,name TEXT);'+
    'CREATE TABLE product_variants(id INTEGER PRIMARY KEY,product_id INTEGER,weight TEXT);'+
    'CREATE TABLE restock_request_items('+
      'id INTEGER PRIMARY KEY,request_id INTEGER,variant_id INTEGER,qty_requested INTEGER,qty_allocated INTEGER);'+
    'CREATE TABLE restock_deliveries('+
      'id INTEGER PRIMARY KEY,request_id INTEGER,point_id TEXT,variant_id INTEGER,qty INTEGER,delivered_at TEXT);'+
    'CREATE TABLE stock_movement_items('+
      'id INTEGER PRIMARY KEY,movement_id INTEGER,variant_id INTEGER,qty INTEGER);'+
    "INSERT INTO products VALUES(1,'Говяжье лёгкое');"+
    "INSERT INTO product_variants VALUES(10,1,'50 г');"
  );
  return db;
}
function counted(database){
  let statements=0;
  return {
    get count(){return statements;},
    prepare(sql){statements++;return database.prepare(sql);}
  };
}

test('empty warehouse lists do not issue any related SQL statements',()=>{
  const database=fixture(),stub=counted(database);
  try{
    assert.deepEqual(hydrateRestockRequests(stub,[]),[]);
    assert.deepEqual(hydrateStockMovements(stub,[]),[]);
    assert.equal(stub.count,0);
  }finally{database.close();}
});

test('restock requests preserve order and child properties, isolated to supplied parent IDs',()=>{
  const database=fixture();
  try{
    database.exec(
      "INSERT INTO restock_request_items VALUES"+
      "(1,101,10,5,3),(2,101,10,2,0),(3,102,10,7,6),(4,900,10,99,99);"+
      "INSERT INTO restock_deliveries VALUES"+
      "(1,101,'point-a',10,3,'2026-11-14 00:00:00'),"+
      "(2,102,'point-b',10,6,'2026-11-14 00:00:01'),"+
      "(3,900,'secret-point',10,99,'2026-11-14 00:00:02');"
    );
    const stub=counted(database);
    const result=hydrateRestockRequests(stub,[{id:102,status:'pending'},{id:101,status:'done'},{id:103,status:'pending'}]);
    assert.equal(stub.count,2,'one items query and one deliveries query');
    assert.deepEqual(result.map(x=>x.id),[102,101,103]);
    assert.deepEqual(result.map(x=>x.items.length),[1,2,0]);
    assert.deepEqual(result.map(x=>x.deliveries.length),[1,1,0]);
    assert.equal(result[1].items[0].product_name,'Говяжье лёгкое');
    assert.equal(result[1].items[0].weight,'50 г');
    assert.equal(result[1].items[0].qty_allocated,3);
    assert.equal(result[1].deliveries[0].point_id,'point-a');
    assert.ok(!JSON.stringify(result).includes('secret-point'),
      'items from a different manager/city must never leak');
  }finally{database.close();}
});

test('stock movement list reads hundreds of reports with a bounded number of SQL statements',()=>{
  const database=fixture();
  try{
    const ins=database.prepare('INSERT INTO stock_movement_items(id,movement_id,variant_id,qty) VALUES(?,?,10,?)');
    const movements=[];
    for(let n=1;n<=BATCH_SIZE+1;n++){
      ins.run(n,n,n%7+1);
      movements.push({id:n,status:n%2?'approved':'pending',point_name:'Point '+n});
    }
    const stub=counted(database);
    const result=hydrateStockMovements(stub,movements);
    assert.equal(stub.count,2,'at most 2 SQL queries for 401 reports, not 401');
    assert.equal(result.length,BATCH_SIZE+1);
    assert.deepEqual(result.map(x=>x.items.length),Array(BATCH_SIZE+1).fill(1));
    assert.equal(result[0].items[0].product_name,'Говяжье лёгкое');
    assert.equal(result[0].items[0].qty,2);
    assert.equal(result[0].point_name,'Point 1');
  }finally{database.close();}
});

test('real API handlers keep city/manager authorization and delegate read-only hydration',()=>{
  const source=fs.readFileSync(path.join(__dirname,'routes-warehouse.js'),'utf8');
  const restock=source.split("router.get('/api/restock-requests'")[1]
    .split("router.put('/api/restock-requests/:id/fulfill'")[0];
  assert.match(restock,/WHERE manager_id = \?/);
  assert.match(restock,/WHERE city_id = \?/);
  assert.match(restock,/hydrateRestockRequests\(db, requests\)/);
  assert.doesNotMatch(restock,/getItems\.all\(r\.id\)/);
  const movement=source.split("router.get('/api/stock-movements'")[1]
    .split("router.put('/api/stock-movements/:id/approve'")[0];
  assert.match(movement,/sm\.manager_id = \?/);
  assert.match(movement,/sm\.city_id = \?/);
  assert.match(movement,/hydrateStockMovements\(db, rows\)/);
  assert.doesNotMatch(movement,/getItems\.all\(r\.id\)/);
  assert.match(source,/warehouse_restock_list/);
  assert.match(source,/warehouse_movement_list/);
  const dbSource=fs.readFileSync(path.join(__dirname,'db.js'),'utf8');
  assert.match(dbSource,/idx_stock_movement_items_movement/);
  assert.match(dbSource,/idx_restock_request_items_request/);
  assert.match(dbSource,/idx_restock_deliveries_request/);
});
