'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-customer-order-history-batch-'));
process.env.DATA_DIR = temp;
process.env.TOKEN_SECRET = 'isolated-customer-history-batch-secret';
const db = require('./db');
const { signToken } = require('./auth');
const { registerCustomerRoutes } = require('./routes-customers');
const { ORDER_HISTORY_PHONE_KEY_SQL, PAID_PHONE_KEY_SQL } = require('./report-phone-key');

const routes = new Map();
registerCustomerRoutes(new Proxy({}, {
  get: (_, verb) => (route, handler) => routes.set(verb.toUpperCase() + ' ' + route, handler),
}));

const customerId = Number(db.prepare(
  'INSERT INTO customers(phone,name) VALUES(?,?)'
).run('79135550001','Наш покупатель').lastInsertRowid);
const otherId = Number(db.prepare(
  'INSERT INTO customers(phone,name) VALUES(?,?)'
).run('79135550002','Другой покупатель').lastInsertRowid);

const insertOrder = db.prepare(
  'INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,subtotal,total,payment_method,status) ' +
  'VALUES(?,?,?,?,?,?,?,?)'
);
const insertItem = db.prepare(
  'INSERT INTO order_items(order_id,name,weight,price,qty,is_custom) VALUES(?,?,?,?,?,?)'
);
function order(code, phone, items = []) {
  const id = Number(insertOrder.run(
    code,'Тестовый покупатель',phone,'Салон',250,250,'sbp','paid'
  ).lastInsertRowid);
  for (const [index,name] of items.entries()) {
    insertItem.run(id,name,'50 г',250,index+1,0);
  }
  return id;
}
function history(id) {
  const res = {
    statusCode:0, body:null,
    writeHead(status) { this.statusCode = status; return this; },
    end(raw) { this.body=JSON.parse(raw); },
  };
  const handler=routes.get('GET /api/customer/me/orders');
  assert.ok(handler);
  handler({ headers:{ authorization:'Bearer '+signToken({role:'customer',id}) } },
    res,{query:{},params:{}});
  return res;
}

test('empty history returns the usual shape and no customer records from others', () => {
  const own = history(customerId);
  assert.equal(own.statusCode,200);
  assert.deepEqual(own.body,{orders:[]});
});

test('history returns only matching customer orders in reverse order, retaining every item field',()=>{
  const first=order('HISTORY-BATCH-1','+7 (913) 555-00-01',['Лёгкое','Сердце']);
  const second=order('HISTORY-BATCH-2','79135550001',[]);
  order('HISTORY-OTHER-1','79135550002',['Чужая покупка']);
  const own=history(customerId);
  assert.equal(own.statusCode,200);
  assert.deepEqual(own.body.orders.map(o=>o.order_code),
    ['HISTORY-BATCH-2','HISTORY-BATCH-1']);
  assert.equal(own.body.orders[0].id,second);
  assert.equal(own.body.orders[1].id,first);
  assert.deepEqual(own.body.orders[0].items,[]);
  assert.deepEqual(own.body.orders[1].items.map(i=>i.name),['Лёгкое','Сердце']);
  assert.deepEqual(own.body.orders[1].items.map(i=>i.qty),[1,2]);
  assert.deepEqual(Object.keys(own.body.orders[1].items[0]).sort(),
    ['name','weight','price','qty','is_custom'].sort());
  assert.deepEqual(history(otherId).body.orders.map(o=>o.order_code),['HISTORY-OTHER-1']);
});

test('500 historical orders use one item batch and never leak another customer',()=>{
  db.exec('BEGIN IMMEDIATE');
  try {
    for(let i=0;i<510;i++){
      order('HISTORY-OWN-'+i,'8 913 555 00 01',
        i%4===0?['Лакомство '+i]:[]);
      order('HISTORY-NOT-OWN-'+i,'8 913 555 00 02',
        ['Чужой товар '+i]);
    }
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  const own=history(customerId);
  assert.equal(own.statusCode,200);
  assert.equal(own.body.orders.length,500);
  assert.equal(own.body.orders[0].order_code,'HISTORY-OWN-509');
  assert.equal(own.body.orders.at(-1).order_code,'HISTORY-OWN-10');
  assert.equal(own.body.orders[1].items[0].name,'Лакомство 508');
  assert.ok(own.body.orders.every(o=>!o.order_code.startsWith('HISTORY-NOT-OWN-')));
});

test('SQLite plan uses the existing order_items order index',()=>{
  const source=fs.readFileSync(path.join(__dirname,'routes-customers.js'),'utf8');
  const section=source.split("router.get('/api/customer/me/orders'")[1]
    .split("router.get('/api/referral/validate'")[0];
  assert.match(section,/WHERE order_id IN \(\$\{placeholders\}\)/);
  assert.doesNotMatch(section,/getItems\.all\(o\.id\)/);
  assert.match(section,/ORDER BY order_id, id/);
  const plan=db.prepare(
    'EXPLAIN QUERY PLAN SELECT order_id,name FROM order_items '+
    'WHERE order_id IN (?,?,?) ORDER BY order_id,id'
  ).all(1,2,3).map(row=>row.detail).join('\n');
  assert.match(plan,/idx_order_items_order/);
  assert.doesNotMatch(section,/JOIN customers ON/);
});


test('history lookup uses a dedicated indexed expression without scanning orders', () => {
  const sql='SELECT * FROM orders WHERE ' + ORDER_HISTORY_PHONE_KEY_SQL +
    ' = ? ORDER BY id DESC LIMIT 500';
  const plan=db.prepare('EXPLAIN QUERY PLAN ' + sql)
    .all('9135550001').map(row => String(row.detail)).join('\n');
  assert.match(plan,/idx_orders_history_phone_key_id/);
  assert.doesNotMatch(plan,/SCAN orders\b/);
  const index=db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name=?"
  ).get('idx_orders_history_phone_key_id');
  assert.equal(index.name,'idx_orders_history_phone_key_id');
  const route=fs.readFileSync(path.join(__dirname,'routes-customers.js'),'utf8');
  assert.match(route,/ORDER_HISTORY_PHONE_KEY_SQL/);
  assert.doesNotMatch(route,/const storedDigits =/);
  // Existing BSC phone matching remains untouched and paid-only.
  assert.notEqual(PAID_PHONE_KEY_SQL,ORDER_HISTORY_PHONE_KEY_SQL);
});

test('indexed history preserves legacy phone separators for all order statuses', () => {
  order('HISTORY-INDEX-PENDING','+7 (913)\t555-00-01',[]);
  order('HISTORY-INDEX-CANCELLED','8\n913 555.00.01',[]);
  order('HISTORY-INDEX-OTHER','8 913 555 00 02',[]);
  db.prepare("UPDATE orders SET status='pending' WHERE order_code='HISTORY-INDEX-PENDING'").run();
  db.prepare("UPDATE orders SET status='failed' WHERE order_code='HISTORY-INDEX-CANCELLED'").run();
  const own=history(customerId);
  assert.ok(own.body.orders.some(o=>o.order_code==='HISTORY-INDEX-PENDING'));
  assert.ok(own.body.orders.some(o=>o.order_code==='HISTORY-INDEX-CANCELLED'));
  assert.ok(!own.body.orders.some(o=>o.order_code==='HISTORY-INDEX-OTHER'));
  assert.equal(
    db.prepare('SELECT ' + ORDER_HISTORY_PHONE_KEY_SQL +
      ' AS k FROM orders WHERE order_code=?').get('HISTORY-INDEX-CANCELLED').k,
    '9135550001'
  );
});

test('order phone changes update the history expression index immediately', () => {
  const id=order('HISTORY-INDEX-CHANGE','79135550002',[]);
  assert.ok(!history(customerId).body.orders.some(o=>o.id===id));
  db.prepare('UPDATE orders SET customer_phone=? WHERE id=?')
    .run('8 (913) 555-00-01',id);
  assert.ok(history(customerId).body.orders.some(o=>o.id===id));
  assert.ok(!history(otherId).body.orders.some(o=>o.id===id));
});

test.after(()=>{
  try { db.close(); }catch(_){}
  fs.rmSync(temp,{recursive:true,force:true});
});
