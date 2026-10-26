'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hvost-telegram-stock-'));
process.env.DATA_DIR = temp;
const db = require('./db');
const {
  collectWarehouseStockReport,
  formatWarehouseStockMessages,
  formatWarehouseStockSummary,
  buildWarehouseStockCsv,
} = require('./warehouse-telegram-report');

const now = new Date('2026-10-26T00:00:00.000Z');
const addProduct = (suffix, active = 1) => Number(db.prepare(
  'INSERT INTO products(slug,name,category,icon,desc,comp,active) VALUES (?,?,?,?,?,?,?)'
).run('stock-report-' + suffix, suffix, 'treats', '🐾', 'Test product', '[]', active).lastInsertRowid);
const addVariant = (productId, weight, active = 1) => Number(db.prepare(
  'INSERT INTO product_variants(product_id,weight,price,active) VALUES (?,?,?,?)'
).run(productId,weight,250,active).lastInsertRowid);

const normal = addProduct('Лёгкое говяжье');
const v50 = addVariant(normal,'50 г');
const v100 = addVariant(normal,'100 г');
const vExtra = addVariant(addProduct('Кроличьи лапки'),'5 шт.');
const archived = addVariant(addProduct('Архивная позиция',0),'1 шт.',0);
const archivedMissing = addVariant(addProduct('Архив без остатка',0),'1 шт.',0);
db.prepare('INSERT INTO cities(id,name,active) VALUES (?,?,?)').run('old-city','Исторический город',0);
db.prepare('INSERT INTO cities(id,name,active) VALUES (?,?,?)').run('inactive-empty','Неактивный пустой',0);

function setStock(cityId, variantId, qty) {
  db.prepare(
    'INSERT INTO warehouse_stock(city_id,variant_id,qty) VALUES (?,?,?) ' +
    'ON CONFLICT(city_id,variant_id) DO UPDATE SET qty=excluded.qty'
  ).run(cityId,variantId,qty);
}
setStock('krsk',v50,12);
setStock('krsk',archived,2);
setStock('spb',v100,5);
setStock('old-city',v50,3);

test('reports fresh warehouse balances from all active cities and inactive cities with stock', () => {
  const result = collectWarehouseStockReport('', now);
  assert.deepEqual(result.cities.map(c=>c.id),['old-city','krsk','spb']);
  assert.equal(result.total_qty,22);
  assert.equal(result.city_count,3);
  assert.equal(result.local_time.includes('07:00'),true); // UTC+7
  const krsk = result.cities.find(c=>c.id==='krsk');
  assert.equal(krsk.total_qty,14);
  assert.equal(krsk.positions_in_stock,2);
  assert.equal(krsk.zero_positions,2);
  assert.equal(krsk.items.find(i=>i.variant_id===v50).qty,12);
  assert.equal(krsk.items.find(i=>i.variant_id===v100).qty,0);
  assert.equal(krsk.items.find(i=>i.variant_id===vExtra).qty,0);
  assert.equal(krsk.items.find(i=>i.variant_id===archived).archived,true);
  assert.equal(krsk.items.some(i=>i.variant_id===archivedMissing),false);
  assert.equal(result.cities.some(c=>c.id==='inactive-empty'),false);
  assert.equal(result.cities.find(c=>c.id==='old-city').active,false);
});

test('filters by city code or case-insensitive full city name', () => {
  const byId = collectWarehouseStockReport('krsk',now);
  const byName = collectWarehouseStockReport('КрАсНоЯрСк',now);
  assert.deepEqual(byId.cities,byName.cities);
  assert.equal(byId.total_qty,14);
  assert.equal(collectWarehouseStockReport('spb',now).total_qty,5);
  assert.equal(collectWarehouseStockReport('all',now).city_count,3);
  assert.throws(()=>collectWarehouseStockReport('неправильный',now),
    err=>err.code==='UNKNOWN_WAREHOUSE_CITY' && err.cities.some(c=>c.id==='krsk'));
});

test('each command collects a new snapshot rather than using stale cached stock', () => {
  const previous = collectWarehouseStockReport('krsk',now).total_qty;
  setStock('krsk',v50,19);
  try {
    assert.equal(collectWarehouseStockReport('krsk',now).total_qty,previous+7);
    const last=collectWarehouseStockReport('krsk',now);
    assert.match(formatWarehouseStockMessages(last).join('\n'),/19 шт/);
  } finally {
    setStock('krsk',v50,12);
  }
});

test('Russian Telegram text includes every product size, zeros, archives and totals', () => {
  const report = collectWarehouseStockReport('krsk',now);
  const pages = formatWarehouseStockMessages(report);
  const text = pages.join('\n');
  assert.match(text,/центральный склад/);
  assert.match(text,/Красноярск/);
  assert.match(text,/Лёгкое говяжье \(50 г\) — 12 шт/);
  assert.match(text,/Лёгкое говяжье \(100 г\) — 0 шт/);
  assert.match(text,/Кроличьи лапки \(5 шт\.\) — 0 шт/);
  assert.match(text,/Архивная позиция.*\[архив\]/);
  assert.match(text,/ИТОГО: 14 шт/);
  assert.match(text,/без остатков в салонах/);
  assert.equal(pages.every(page=>page.length<4000),true);
});

test('all-city summary is separate from a detailed Excel-friendly CSV', () => {
  const result = collectWarehouseStockReport('',now);
  const summary = formatWarehouseStockSummary(result);
  assert.match(summary,/Всего по выбранным складам: 22 шт/);
  const csv=buildWarehouseStockCsv(result);
  assert.equal(csv.charCodeAt(0),0xFEFF);
  const lines=csv.trim().split('\r\n');
  assert.ok(lines.length>=10);
  assert.ok(lines.some(line=>line.includes('Архивный')));
  assert.ok(lines.some(line=>line.includes('"0"')));
  assert.match(lines[0],/Остаток, шт/);
});

test('long reports are split into Telegram-safe pages with no items lost', () => {
  const many = {
    local_time:'26.10.2026, 07:00',
    cities:[{
      id:'krsk',name:'Красноярск',active:true,
      items:Array.from({length:200},(_,i)=>({
        name:'Тестовое лакомство '+i+' '+('длинный текст ').repeat(4),
        weight:'50 г',qty:i,archived:false,
      })),
      total_qty:19900,positions_in_stock:199,zero_positions:1,negative_positions:0,
    }],
  };
  const pages=formatWarehouseStockMessages(many);
  assert.ok(pages.length>1);
  assert.equal(pages.every(page=>page.length<4000),true);
  assert.equal(pages.join('\n').match(/Тестовое лакомство /g).length,200);
  assert.match(pages[pages.length-1],/ИТОГО/);
});

test.after(()=>{
  try { db.close(); } catch (_) {}
  fs.rmSync(temp,{recursive:true,force:true});
});
