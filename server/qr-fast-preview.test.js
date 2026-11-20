'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadQrPreview } = require('./qr-fast-preview');
test('compact QR route uses one product and live stock', () => {
  const calls = [];
  const database = { prepare(sql) { return {
    get(...args) { calls.push(sql); if(sql.includes('FROM points'))return {id:'salon',name:'Dog Style'}; if(sql.includes('FROM products'))return {id:11,slug:'lung',name:'Лёгкое'}; throw Error(sql); },
    all(...args) { calls.push(sql); if(sql.includes('FROM product_variants'))return [{id:5,weight:'50 г',price:250,qty:3}]; if(sql.includes('FROM partners'))return [{id:1,full_name:'Грумер'}]; throw Error(sql); },
  }; } };
  const data = loadQrPreview(database,'salon','lung',()=>({partner:{id:1},source:'auto_single'}));
  assert.equal(data.point.name, 'Dog Style');
  assert.equal(data.product.variants[0].qty,3);
  assert.equal(data.default_partner_id,1);
  assert.equal(calls.length,4);
  assert.ok(calls.every(sql=>!sql.includes('product_reviews')&&!sql.includes('order_items')));
});
test('inactive salon never proceeds to catalog',()=>{
  assert.equal(loadQrPreview({prepare(){return{get(){return null}}}},'closed','lung',()=>{}),null);
});

test('SQL fast lookup works with a real SQLite database', () => {
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('CREATE TABLE points(id TEXT,name TEXT,addr TEXT,city_id TEXT,active INTEGER);' +
      'CREATE TABLE products(id INTEGER,slug TEXT,name TEXT,category TEXT,icon TEXT,badge TEXT,img TEXT,"desc" TEXT,comp TEXT,active INTEGER,archived_at TEXT);' +
      'CREATE TABLE product_variants(id INTEGER,product_id INTEGER,weight TEXT,price INTEGER,active INTEGER,sort_order INTEGER);' +
      'CREATE TABLE stock(variant_id INTEGER,point_id TEXT,qty INTEGER);' +
      'CREATE TABLE partners(id INTEGER,point_id TEXT,full_name TEXT,active INTEGER);');
    database.exec("INSERT INTO points VALUES('salon','Dog Style','Красноярск','krsk',1);" +
      "INSERT INTO products VALUES(11,'lung','Лёгкое','treats',NULL,NULL,NULL,'Натуральное','[]',1,NULL);" +
      "INSERT INTO product_variants VALUES(5,11,'50 г',250,1,1);" +
      "INSERT INTO stock VALUES(5,'salon',3);" +
      "INSERT INTO partners VALUES(1,'salon','Грумер',1);");
    const preview = loadQrPreview(database, 'salon', 'lung', () => ({ partner:{ id:1 },source:'auto_single' }));
    assert.equal(preview.product.name, 'Лёгкое');
    assert.equal(preview.product.variants[0].stock.salon, 3);
    assert.equal(preview.partners.length, 1);
  } finally { database.close(); }
});
