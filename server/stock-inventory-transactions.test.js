'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {approveStockMovement,receiveWarehouseStock}=require('./stock-inventory-transactions');

function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec(
    'PRAGMA foreign_keys=ON;'+
    'CREATE TABLE stock_movements(id INTEGER PRIMARY KEY,status TEXT NOT NULL DEFAULT \'pending\','+
      'point_id TEXT NOT NULL,city_id TEXT NOT NULL,reviewed_by TEXT,reviewed_at TEXT);'+
    'CREATE TABLE stock_movement_items(id INTEGER PRIMARY KEY,'+
      'movement_id INTEGER NOT NULL REFERENCES stock_movements(id),variant_id INTEGER NOT NULL,qty NUMERIC NOT NULL);'+
    'CREATE TABLE warehouse_stock(city_id TEXT NOT NULL,variant_id INTEGER NOT NULL,'+
      'qty INTEGER NOT NULL,PRIMARY KEY(city_id,variant_id));'+
    'CREATE TABLE stock(variant_id INTEGER NOT NULL,point_id TEXT NOT NULL,'+
      'qty INTEGER NOT NULL,PRIMARY KEY(variant_id,point_id));'+
    'CREATE TABLE warehouse_receipts(id INTEGER PRIMARY KEY,variant_id INTEGER NOT NULL,'+
      'qty INTEGER NOT NULL,supplier_note TEXT,keeper_id INTEGER,city_id TEXT NOT NULL);'+
    "INSERT INTO warehouse_stock(city_id,variant_id,qty) VALUES('krsk',1,12),('krsk',2,3),('spb',1,50);"+
    "INSERT INTO stock(variant_id,point_id,qty) VALUES (1,'salon',4);"+
    "INSERT INTO stock_movements(id,point_id,city_id) VALUES(1,'salon','krsk');"
  );
  return db;
}
function wh(db,variant,city='krsk'){
  return db.prepare('SELECT qty FROM warehouse_stock WHERE variant_id=? AND city_id=?').get(variant,city)?.qty??null;
}
function point(db,variant){
  return db.prepare("SELECT qty FROM stock WHERE variant_id=? AND point_id='salon'").get(variant)?.qty??null;
}

test('approval combines repeated variants and commits all stock movement lines only once',()=>{
  const db=fixture();
  try{
    db.exec("INSERT INTO stock_movement_items(movement_id,variant_id,qty) VALUES(1,1,3),(1,1,2),(1,2,2)");
    const result=approveStockMovement(db,1,'admin');
    assert.deepEqual(result,{ok:true,lines:2,quantity:7});
    assert.equal(wh(db,1),7);
    assert.equal(wh(db,2),1);
    assert.equal(wh(db,1,'spb'),50,'city boundary remains intact');
    assert.equal(point(db,1),9);
    assert.equal(point(db,2),2);
    const review=db.prepare('SELECT status,reviewed_by,reviewed_at FROM stock_movements WHERE id=1').get();
    assert.equal(review.status,'approved');
    assert.equal(review.reviewed_by,'admin');
    assert.ok(review.reviewed_at);
    const changesBefore=db.prepare('SELECT total_changes() AS value').get().value;
    const repeated=approveStockMovement(db,1,'admin');
    assert.equal(repeated.ok,false);
    assert.equal(repeated.code,'ALREADY_PROCESSED');
    assert.equal(wh(db,1),7);
    assert.equal(db.prepare('SELECT total_changes() AS value').get().value,changesBefore);
  }finally{db.close();}
});

test('insufficient inventory rolls back earlier successful SKU updates and leaves movement pending',()=>{
  const db=fixture();
  try{
    db.exec("INSERT INTO stock_movement_items(movement_id,variant_id,qty) VALUES(1,1,5),(1,2,4)");
    const result=approveStockMovement(db,1,'admin');
    assert.equal(result.ok,false);
    assert.equal(result.code,'STOCK_UNAVAILABLE');
    assert.equal(result.variantId,2);
    assert.equal(result.required,4);
    assert.equal(result.available,3);
    assert.equal(wh(db,1),12,'first SKU was rolled back');
    assert.equal(wh(db,2),3);
    assert.equal(point(db,1),4);
    assert.equal(point(db,2),null);
    assert.equal(db.prepare('SELECT status FROM stock_movements WHERE id=1').get().status,'pending');
  }finally{db.close();}
});

test('duplicated SKU cannot bypass aggregated stock check',()=>{
  const db=fixture();
  try{
    db.exec("INSERT INTO stock_movement_items(movement_id,variant_id,qty) VALUES(1,2,2),(1,2,2)");
    const result=approveStockMovement(db,1,'admin');
    assert.equal(result.code,'STOCK_UNAVAILABLE');
    assert.equal(result.required,4);
    assert.equal(wh(db,2),3);
    assert.equal(point(db,2),null);
  }finally{db.close();}
});

test('empty/invalid movement and downstream SQL failure never produce partial inventory',()=>{
  const db=fixture();
  try{
    assert.equal(approveStockMovement(db,1,'admin').code,'EMPTY_MOVEMENT');
    db.exec("INSERT INTO stock_movement_items(movement_id,variant_id,qty) VALUES(1,1,1.5)");
    assert.equal(approveStockMovement(db,1,'admin').code,'INVALID_QUANTITY');
    db.exec("DELETE FROM stock_movement_items WHERE movement_id=1");
    db.exec("INSERT INTO stock_movement_items(movement_id,variant_id,qty) VALUES(1,1,4)");
    db.exec("CREATE TRIGGER reject_stock_update BEFORE UPDATE ON stock BEGIN SELECT RAISE(ABORT,'test stock failure'); END;");
    assert.throws(()=>approveStockMovement(db,1,'admin'),/test stock failure/);
    assert.equal(wh(db,1),12);
    assert.equal(point(db,1),4);
    assert.equal(db.prepare('SELECT status FROM stock_movements WHERE id=1').get().status,'pending');
  }finally{db.close();}
});

test('receipt and inventory increase are one transaction with non-destructive UPSERT',()=>{
  const db=fixture();
  try{
    const first=receiveWarehouseStock(db,{variantId:1,quantity:3,supplierNote:'new batch',keeperId:5,cityId:'krsk'});
    assert.equal(first.new_qty,15);
    assert.equal(wh(db,1),15);
    assert.deepEqual(db.prepare('SELECT variant_id,qty,supplier_note,keeper_id,city_id FROM warehouse_receipts').all().map(row=>({...row})),
      [{variant_id:1,qty:3,supplier_note:'new batch',keeper_id:5,city_id:'krsk'}]);
    assert.equal(receiveWarehouseStock(db,{variantId:9,quantity:2,cityId:'krsk'}).new_qty,2);
    assert.equal(wh(db,9),2);
    assert.throws(()=>receiveWarehouseStock(db,{variantId:9,quantity:0,cityId:'krsk'}),/positive integer/);
    db.exec("CREATE TRIGGER reject_receipt_stock BEFORE UPDATE ON warehouse_stock BEGIN SELECT RAISE(ABORT,'stock failed'); END");
    const oldCount=db.prepare('SELECT COUNT(*) AS n FROM warehouse_receipts').get().n;
    assert.throws(()=>receiveWarehouseStock(db,{variantId:1,quantity:1,cityId:'krsk'}),/stock failed/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM warehouse_receipts').get().n,oldCount);
    assert.equal(wh(db,1),15);
  }finally{db.close();}
});

test('both stock APIs use atomic helper; payment creation reuses one order summary',()=>{
  const warehouse=fs.readFileSync(path.join(__dirname,'routes-warehouse.js'),'utf8');
  const alternate=fs.readFileSync(path.join(__dirname,'routes-stock-movements.js'),'utf8');
  const checkout=fs.readFileSync(path.join(__dirname,'routes-payment.js'),'utf8');
  assert.match(warehouse,/approveStockMovement\(db,ctx\.params\.id,payload\.login\)/);
  assert.match(alternate,/approveStockMovement\(db,ctx\.params\.id,payload\.login\)/);
  assert.match(warehouse,/receiveWarehouseStock\(db,/);
  assert.match(checkout,/SELECT display_number,reservation_expires_at FROM orders WHERE id=\?/);
  assert.doesNotMatch(checkout,/SELECT reservation_expires_at FROM orders WHERE id = \?/);
  const approval=warehouse.split("router.put('/api/stock-movements/:id/approve'")[1].split('router.put(\'/api/stock-movements/:id/reject\'')[0];
  assert.doesNotMatch(approval,/INSERT OR REPLACE INTO stock \(variant_id, point_id, qty\)/);
});
