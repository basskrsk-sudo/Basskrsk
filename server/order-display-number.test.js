'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hm-sequential-orders-'));
process.env.DATA_DIR=dir;

const db=require('./db');
const {numberForId,assignDisplayNumber,visibleOrderNumber}=require('./order-display-number');
const {buildCustomerMessage,buildPartnerMessage,buildManagerMessage}=require('./order-notifications');
const {buildOrderMessage}=require('./telegram');
const source=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

function insertOrder(code){
  return Number(db.prepare(
    "INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,"+
    "subtotal,total,payment_method,status) VALUES (?,'Покупатель','79990000000',"+
    "'Салон Лапочки',250,250,'sbp','pending')"
  ).run(code).lastInsertRowid);
}

test('short number uses monotonic SQLite order ID with a minimum five digits',()=>{
  assert.equal(numberForId(1),'ХМ-00001');
  assert.equal(numberForId(127),'ХМ-00127');
  assert.equal(numberForId(99999),'ХМ-99999');
  assert.equal(numberForId(100000),'ХМ-100000');
  for(const bad of [0,-1,1.5,'',null,'001',Number.MAX_SAFE_INTEGER+1,{}]){
    assert.throws(()=>numberForId(bad),RangeError);
  }
});

test('new orders have one unique public number, old technical code stays unchanged',()=>{
  const columns=db.prepare('PRAGMA table_info(orders)').all().map(c=>c.name);
  assert.ok(columns.includes('display_number'),'must auto-migrate existing databases');
  const index=db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_orders_display_number'").get();
  assert.ok(index,'database must enforce display number uniqueness');

  const legacy=insertOrder('TG-LEGACY-2026');
  const newer=insertOrder('TMA-TECH-CODE-2026');
  assert.equal(db.prepare('SELECT display_number FROM orders WHERE id=?').get(legacy).display_number,null);
  const display=assignDisplayNumber(db,newer);
  assert.equal(display,numberForId(newer));
  const row=db.prepare('SELECT * FROM orders WHERE id=?').get(newer);
  assert.equal(row.order_code,'TMA-TECH-CODE-2026');
  assert.equal(row.display_number,display);
  assert.equal(visibleOrderNumber(row),display);
  assert.equal(visibleOrderNumber(db.prepare('SELECT * FROM orders WHERE id=?').get(legacy)),'TG-LEGACY-2026');
  assert.throws(()=>assignDisplayNumber(db,newer),/not assigned/,'public numbers cannot be changed');
  assert.throws(()=>db.prepare('UPDATE orders SET display_number=? WHERE id=?').run(display,legacy),/UNIQUE/);

  db.prepare('DELETE FROM orders WHERE id=?').run(newer);
  const next=insertOrder('TG-NEXT-CODE-2026');
  assert.ok(next>newer,'AUTOINCREMENT must not reuse deleted numbers');
  assert.equal(assignDisplayNumber(db,next),numberForId(next));
  assert.equal(db.prepare('SELECT order_code FROM orders WHERE id=?').get(next).order_code,'TG-NEXT-CODE-2026');
});

test('display number is assigned within the existing checkout transaction before payment',()=>{
  const app=source('server/routes-payment.js');
  assert.match(app,/return withImmediateTransaction\(\(\) => \{/);
  assert.match(app,/assignDisplayNumber\(db, orderRowId\)/);
  assert.match(app,/const orderRowId = Number\(info\.lastInsertRowid\)/);
  assert.match(app,/orderCode: orderId/,'YooKassa metadata must keep the technical code');
  assert.match(app,/paymentReturnUrl\(req, orderId, returnPath\)/,'bank return URLs must not change');
  assert.match(app,/display_number: order\.display_number \|\| null/);
  assert.match(app,/display_number: db\.prepare\('SELECT display_number FROM orders WHERE id=\?'\)/);
  const recovery=source('server/order-recovery.js');
  assert.match(recovery,/assignDisplayNumber\(db,id\)/,'recovered orders receive one new public number too');
  assert.match(recovery,/metadata\.order_code !== code/,'historical payment code remains verified');
});

test('Telegram messages show public numbers, but buyer can still retrieve their technical code',()=>{
  const order={
    order_code:'TMA-SECRET-0001',display_number:'ХМ-00127',
    pickup_point:'Лапочки',fulfillment_type:'pickup',
    status:'paid',total:250,customer_name:'Тест',customer_phone:'79990000000',
    payment_method:'sbp',
  };
  const items=[{name:'Лёгкое говяжье',weight:'50 г',price:250,qty:1}];
  const personal=buildCustomerMessage(order,items);
  const partner=buildPartnerMessage(order,items,{point_name:'Лапочки'});
  const manager=buildManagerMessage(order,items,{full_name:'Менеджер'},{name:'Лапочки'},null,0.07);
  const service=buildOrderMessage(order,items);
  assert.match(personal,/📋 Заказ: ХМ-00127/);
  assert.match(personal,/Технический код для привязки заказа: TMA-SECRET-0001/);
  assert.match(partner,/📋 Заказ: ХМ-00127/);
  assert.doesNotMatch(partner,/TMA-SECRET/,'no technical code in partner sales notification');
  assert.match(manager,/📋 Заказ: ХМ-00127/);
  assert.doesNotMatch(manager,/TMA-SECRET/,'no technical code in manager notification');
  assert.match(service,/📋 Заказ: ХМ-00127/);
  assert.match(service,/Технический код: TMA-SECRET-0001/);
  const legacy={...order,order_code:'TG-OLD',display_number:null};
  assert.match(buildCustomerMessage(legacy,items),/📋 Заказ: TG-OLD/);
  assert.doesNotMatch(buildCustomerMessage(legacy,items),/Технический код для привязки/);
  assert.match(buildOrderMessage(legacy,items),/📋 Заказ: TG-OLD/);
});

test('all purchase pages show the short number while preserving private payment reconciliation',()=>{
  const site=source('public/index.html');
  const mini=source('public/miniapp.html');
  const qr=source('public/p.html');
  const admin=source('public/taiga-admin.html');
  assert.match(site,/escapeHtml\(lastPaidCheckoutDisplayNumber \|\| orderId\)/);
  assert.match(site,/escapeHtml\(data\.display_number \|\| orderCode\)/);
  assert.match(site,/o\.display_number \|\| o\.order_code/);
  assert.match(site,/Технический код заказа/);
  assert.match(mini,/state\.pendingPublicNumber=data\.display_number\|\|null/);
  assert.match(mini,/showResult\(d\.paid\?'paid':d\.status==='failed'\?'failed':'pending',code,d\.display_number\|\|null\)/);
  assert.match(qr,/QR_PUBLIC_NUMBER = data\.display_number \|\| ''/);
  assert.match(qr,/showSuccess\(result\.order_code \|\| orderCode,.*result\.display_number\)/);
  assert.match(admin,/escapeOrderCell\(o\.display_number \|\| o\.order_code\)/);
  const auth=source('server/routes-auth.js');
  assert.match(auth,/WHERE order_code = \? AND status = \?/,'account claim must use the harder-to-guess technical code');
  assert.doesNotMatch(auth,/WHERE display_number = \? AND status = \?/,'sequential public number must not authorize access');
});

test.after(()=>{
  try{db.close()}catch(_){}
  fs.rmSync(dir,{recursive:true,force:true});
});
