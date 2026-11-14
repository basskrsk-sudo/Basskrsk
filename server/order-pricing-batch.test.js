'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-checkout-pricing-batch-'));
process.env.DATA_DIR = directory;
const db = require('./db');
const { priceCatalogCart, buildReceiptItems } = require('./order-pricing');

const product = Number(db.prepare(
  "INSERT INTO products(slug,name,category,icon,desc,comp,active) VALUES(?,?,?,?,?,?,1)"
).run('checkout-batch-treat', 'Лёгкое говяжье', 'treats', '🐾', 'Лакомство', '[]').lastInsertRowid);
const variant = db.prepare(
  'INSERT INTO product_variants(product_id,weight,price,active,sort_order) VALUES(?,?,?,?,?)'
);
const ids = [];
for (let i = 0; i < 50; i++) {
  ids.push(Number(variant.run(product, (i + 1) + ' г', 250 + i, 1, i).lastInsertRowid));
}
const inactive = Number(variant.run(product,'51 г',400,0,51).lastInsertRowid);
const badPrice = Number(variant.run(product,'52 г',0,1,52).lastInsertRowid);

function recorded(cart) {
  const statements = [];
  const database = {
    prepare(sql) {
      statements.push(sql);
      return db.prepare(sql);
    },
  };
  const result = priceCatalogCart(cart, database);
  return { result, statements };
}

function expectPricingError(cart, code, statusCode) {
  assert.throws(() => priceCatalogCart(cart), (error) => {
    assert.equal(error.code, code);
    if (statusCode) assert.equal(error.statusCode, statusCode);
    return true;
  });
}

test('50 different variants require one indexed SQLite lookup, not 50', () => {
  const cart = ids.map((id, index) => ({
    variantId: id,
    qty: 1,
    // An untrusted browser must never set current price, product name or weight.
    price: 1,
    name: 'Fake product ' + index,
    weight: 'fake',
  }));
  const { result, statements } = recorded(cart);
  assert.equal(result.items.length, 50);
  assert.deepEqual(result.items.map(item => item.variantId), ids);
  assert.equal(result.subtotal, ids.reduce((sum, _, index) => sum + 250 + index, 0));
  assert.equal(result.items[0].name, 'Лёгкое говяжье');
  assert.equal(result.items[0].price, 250);
  assert.equal(statements.length, 1, 'one authoritative price read for the whole cart');
  assert.match(statements[0], /WHERE v\.id IN \(/);
  const queryPlan = db.prepare(
    'EXPLAIN QUERY PLAN ' + statements[0]
  ).all(...ids).map(row => String(row.detail)).join('\n');
  assert.match(queryPlan, /SEARCH v USING INTEGER PRIMARY KEY/);
  const discounted = result.subtotal - 47;
  const receipt = buildReceiptItems(result.items, discounted, 0);
  assert.equal(receipt.reduce(
    (sum, row) => sum + Math.round(Number(row.amount.value) * 100) * Number(row.quantity),
    0
  ), discounted * 100);
});

test('duplicate variant IDs are loaded once, while quantities merge as before', () => {
  const { result, statements } = recorded([
    { variantId: ids[0], qty: 2 },
    { variant_id: ids[0], qty: 3, price: 2 },
    { variantId: ids[1], qty: 1 },
  ]);
  assert.equal(statements.length, 1);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].qty, 5);
  assert.equal(result.subtotal, 5 * 250 + 251);
});

test('legacy name and weight fallback remains authoritative and detects ambiguity', () => {
  const { result, statements } = recorded([
    { name: 'Лёгкое говяжье', weight: '1 г', qty: 2, price: 1 },
    { variantId: ids[1], qty: 1 },
  ]);
  assert.equal(result.subtotal, 2 * 250 + 251);
  assert.equal(statements.length, 2, 'one batch query and one legacy lookup');

  const duplicateProduct = Number(db.prepare(
    'INSERT INTO products(slug,name,category,icon,desc,comp,active) VALUES(?,?,?,?,?,?,1)'
  ).run('checkout-batch-duplicate', 'Лёгкое говяжье', 'treats', '🐾', 'Other', '[]').lastInsertRowid);
  variant.run(duplicateProduct, '1 г', 240, 1, 0);
  expectPricingError([{name:'Лёгкое говяжье',weight:'1 г',qty:1}], 'AMBIGUOUS_VARIANT', 409);
});

test('unknown ID does not fall back to a matching name, and inactive catalog is still rejected', () => {
  expectPricingError([
    {variantId:99999999, name:'Лёгкое говяжье', weight:'2 г', qty:1},
  ], 'VARIANT_NOT_FOUND', 409);
  expectPricingError([{variantId:inactive,qty:1}], 'VARIANT_INACTIVE', 409);
  expectPricingError([{variantId:badPrice,qty:1}], 'INVALID_CATALOG_PRICE', 409);
  expectPricingError([{variantId:ids[0],qty:0}], 'INVALID_QUANTITY');
  expectPricingError([{variantId:ids[0],qty:100}], 'INVALID_QUANTITY');
  expectPricingError([{variantId:ids[0],qty:99},{variantId:ids[0],qty:1}], 'INVALID_QUANTITY');
  expectPricingError([{variantId:ids[0],qty:1,isCustom:true}], 'CUSTOM_ITEM_NOT_ALLOWED');
});

test('empty and >50-line carts are rejected before querying the database', () => {
  assert.throws(() => priceCatalogCart([]), e => e.code === 'EMPTY_CART');
  let calls = 0;
  const instrumented = { prepare(sql) { calls++; return db.prepare(sql); } };
  assert.throws(
    () => priceCatalogCart(Array.from({length:51}, () => ({variantId:ids[0],qty:1})), instrumented),
    e => e.code === 'TOO_MANY_LINES'
  );
  assert.equal(calls,0);
});

test.after(() => {
  try { db.close(); } catch (_) {}
  fs.rmSync(directory,{recursive:true,force:true});
});
