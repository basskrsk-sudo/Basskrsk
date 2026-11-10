'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-max-point-stock-'));
process.env.MAX_BOT_TOKEN='max-stock-test-token';
const db=require('./db');
const stock=require('./max-point-stock');

const mgr1=Number(db.prepare(
  'INSERT INTO managers(mgr_code,login,password_hash,full_name,phone,max_chat_id) VALUES(?,?,?,?,?,?)'
).run('MAX-STOCK-1','max-stock-mgr1','test','Менеджер Один','79001110001','700001').lastInsertRowid);
const mgr2=Number(db.prepare(
  'INSERT INTO managers(mgr_code,login,password_hash,full_name,phone,max_chat_id) VALUES(?,?,?,?,?,?)'
).run('MAX-STOCK-2','max-stock-mgr2','test','Менеджер Два','79001110002','700002').lastInsertRowid);
function point(id,name,managerId,active=1){
  db.prepare('INSERT INTO points(id,name,addr,icon,manager_id,active) VALUES(?,?,?,?,?,?)')
    .run(id,name,'ул. Тестовая, 1','🐾',managerId,active);
}
point('max-stock-a','Барсик',mgr1);
point('max-stock-b','Собачий стиль',mgr1);
point('max-stock-c','Чужой салон',mgr2);
point('max-stock-closed','Закрытый салон',mgr1,0);
db.prepare(
  'INSERT INTO partners(partner_code,login,password_hash,full_name,phone,point_name,point_id,max_chat_id) '+
  'VALUES(?,?,?,?,?,?,?,?)'
).run('MAX-STOCK-GR','max-stock-partner','test','Грумер','79001110003','Барсик','max-stock-a','700003');
db.prepare(
  'INSERT INTO salon_owners(login,password_hash,full_name,phone,point_id,max_chat_id) VALUES(?,?,?,?,?,?)'
).run('max-stock-owner','test','Владелец','79001110004','max-stock-b','700004');

db.prepare('INSERT INTO admins(login,password_hash,phone,role) VALUES(?,?,?,?)')
  .run('max-stock-admin','test','79001110005','admin');
db.prepare('INSERT INTO task_assignees(code,full_name,phone,max_chat_id) VALUES(?,?,?,?)')
  .run('max-stock-assignee-admin','Ответственный администратор','9001110005','700005');
db.prepare('INSERT INTO task_assignees(code,full_name,phone,max_chat_id) VALUES(?,?,?,?)')
  .run('max-stock-assignee-unprivileged','Другой сотрудник','9001110016','700006');

const productId=Number(db.prepare(
  'INSERT INTO products(slug,name,category,icon,desc,comp) VALUES(?,?,?,?,?,?)'
).run('max-stock-beef','Лёгкое говяжье','treats','🐾','Описание','[]').lastInsertRowid);
const active=Number(db.prepare(
  'INSERT INTO product_variants(product_id,weight,price) VALUES(?,?,?)'
).run(productId,'50 г',250).lastInsertRowid);
const empty=Number(db.prepare(
  'INSERT INTO product_variants(product_id,weight,price) VALUES(?,?,?)'
).run(productId,'100 г',400).lastInsertRowid);
const archiveProd=Number(db.prepare(
  'INSERT INTO products(slug,name,category,icon,desc,comp,active) VALUES(?,?,?,?,?,?,0)'
).run('max-stock-old','Старое лакомство','treats','🐾','Описание','[]').lastInsertRowid);
const archived=Number(db.prepare(
  'INSERT INTO product_variants(product_id,weight,price,active) VALUES(?,?,?,0)'
).run(archiveProd,'1 шт.',100).lastInsertRowid);
function qty(pointId,variantId,number){
  db.prepare('INSERT INTO stock(point_id,variant_id,qty) VALUES(?,?,?)')
    .run(pointId,variantId,number);
}
qty('max-stock-a',active,10);
qty('max-stock-a',archived,2);
qty('max-stock-b',active,3);
qty('max-stock-c',active,9);
qty('max-stock-closed',active,99);
db.prepare(
  'INSERT INTO warehouse_stock(city_id,variant_id,qty) VALUES(?,?,?)'
).run('krsk',active,800);

test('parse /stock, pages and point codes without allowing arbitrary arguments',()=>{
  assert.deepEqual(stock.parseStockCommand('/stock'),{kind:'summary',page:1});
  assert.deepEqual(stock.parseStockCommand('/stock 2'),{kind:'summary',page:2});
  assert.deepEqual(stock.parseStockCommand('/stock max-stock-a'),{kind:'detail',pointId:'max-stock-a'});
  assert.equal(stock.parseStockCommand('Привет'),null);
  assert.match(stock.parseStockCommand('/stock 0').error,/страниц/i);
  assert.ok(stock.parseStockCommand('/stock ../../etc/passwd').error);
});

test('scopes match a linked MAX identity, not a task-only connection',()=>{
  const admin=stock.resolveMaxStockAccess('700005');
  assert.equal(admin.all,true);
  const manager=stock.resolveMaxStockAccess('700001');
  assert.equal(manager.all,false);
  const view=stock.stockSummary(manager);
  assert.deepEqual(view.points.map(p=>p.id),['max-stock-a','max-stock-b']);
  assert.equal(view.count,2);
  assert.deepEqual(stock.stockSummary(stock.resolveMaxStockAccess('700002')).points.map(p=>p.id),['max-stock-c']);
  assert.deepEqual(stock.stockSummary(stock.resolveMaxStockAccess('700003')).points.map(p=>p.id),['max-stock-a']);
  assert.deepEqual(stock.stockSummary(stock.resolveMaxStockAccess('700004')).points.map(p=>p.id),['max-stock-b']);
  assert.equal(stock.resolveMaxStockAccess('700006'),null);
  assert.equal(stock.resolveMaxStockAccess('unknown'),null);
  assert.equal(stock.stockSummary(admin).count,3);
});

test('live stock excludes central warehouse, hidden points, includes zeros and historic nonzero items',()=>{
  const manager=stock.resolveMaxStockAccess('700001');
  const report=stock.stockSummary(manager,1,new Date('2026-11-10T03:00:00Z'));
  const alpha=report.points.find(p=>p.id==='max-stock-a');
  assert.equal(alpha.total_qty,12);
  assert.equal(alpha.in_stock_positions,2);
  assert.equal(report.points.some(p=>p.id==='max-stock-closed'),false);
  assert.match(stock.formatSummary(report),/\/stock max-stock-a/);
  const detail=stock.stockDetail(manager,'max-stock-a');
  assert.equal(detail.totalQty,12);
  assert.equal(detail.items.find(x=>x.weight==='50 г').qty,10);
  assert.equal(detail.items.find(x=>x.weight==='100 г').qty,0);
  assert.equal(detail.items.find(x=>x.weight==='1 шт.').qty,2);
  assert.match(stock.formatDetail(detail).join('\n'),/архив/);
  assert.throws(()=>stock.stockDetail(manager,'max-stock-c'),/доступ/);
  assert.throws(()=>stock.stockDetail(manager,'max-stock-closed'),/доступ/);
});

test('approval is required, expires after 20 minutes, cannot be reused or confirmed from another chat',()=>{
  assert.equal(stock.requestStockApproval('700006',{kind:'summary',page:1}).ok,false);
  const pending=stock.requestStockApproval('700001',{kind:'summary',page:1});
  assert.equal(pending.ok,true);
  assert.match(pending.attachments[0].payload.buttons[0][0].payload,/^stk:yes:/);
  assert.equal(db.prepare('SELECT status FROM max_point_stock_approvals WHERE id=?').get(pending.id).status,'pending');
  assert.equal(stock.decideStockApproval('700002','yes',pending.id).ok,false);
  const confirmed=stock.decideStockApproval('700001','yes',pending.id);
  assert.equal(confirmed.ok,true);
  assert.equal(stock.decideStockApproval('700001','yes',pending.id).ok,false);
  stock.finishStockApproval(pending.id,true);
  assert.equal(db.prepare('SELECT status FROM max_point_stock_approvals WHERE id=?').get(pending.id).status,'done');
  const cancelled=stock.requestStockApproval('700001',{kind:'detail',pointId:'max-stock-a'});
  assert.equal(stock.decideStockApproval('700001','no',cancelled.id).cancelled,true);
  assert.equal(stock.decideStockApproval('700001','yes',cancelled.id).ok,false);
  const expired=stock.requestStockApproval('700001',{kind:'summary',page:2});
  db.prepare("UPDATE max_point_stock_approvals SET expires_at=datetime('now','-1 minute') WHERE id=?").run(expired.id);
  assert.equal(stock.decideStockApproval('700001','yes',expired.id).ok,false);
});

test('new requests supersede old ones; disabled account loses access before confirm',()=>{
  const first=stock.requestStockApproval('700004',{kind:'summary',page:1});
  const next=stock.requestStockApproval('700004',{kind:'detail',pointId:'max-stock-b'});
  assert.equal(stock.decideStockApproval('700004','yes',first.id).ok,false);
  db.prepare('UPDATE salon_owners SET active=0 WHERE max_chat_id=?').run('700004');
  assert.equal(stock.decideStockApproval('700004','yes',next.id).ok,false);
});

test('long detailed stock is split into MAX-safe messages',()=>{
  const items=Array.from({length:100},(_,index)=>({
    product_name:'Длинное название лакомства '+index+' хрустящие полоски для собак',
    weight:'50 г',qty:index%3,product_active:1,variant_active:1,
  }));
  const messages=stock.formatDetail({
    point:{name:'Большой салон',addr:'ул. Ленина 1'},items,
    truncated:false,totalQty:99,generatedAt:'10.11.2026, 11:00',
  });
  assert.ok(messages.length>2);
  assert.ok(messages.every(text=>text.length<=2700));
  assert.match(messages.at(-1),/Всего на точке/);
});

test('MAX webhook consumes /stock then sends report only after callback confirmation',async()=>{
  const sent=[];
  const original=global.fetch;
  global.fetch=async(url,options={})=>{
    const payload=options.body?JSON.parse(options.body):{};
    if(String(url).includes('/messages?')) sent.push(payload);
    return {ok:true,status:200,json:async()=>({message:{ok:true}})};
  };
  try{
    const bot=require('./max-bot');
    await bot.processUpdate({
      update_type:'message_created',
      message:{body:{text:'/stock'},recipient:{chat_id:'700001'}},
    });
    assert.equal(sent.length,1);
    assert.match(sent[0].text,/Сформировать отчёт/);
    assert.equal(sent[0].attachments[0].type,'inline_keyboard');
    assert.doesNotMatch(sent[0].text,/Барсик/);
    const pending=db.prepare("SELECT id FROM max_point_stock_approvals WHERE chat_id=? AND status='pending' ORDER BY id DESC LIMIT 1").get('700001');
    assert.ok(pending);
    await bot.processUpdate({
      update_type:'message_callback',chat_id:'700001',
      callback:{payload:'stk:yes:'+pending.id,callback_id:'stock-confirm-test'},
    });
    assert.ok(sent.length>=2);
    const output=sent.at(-1).text;
    assert.match(output,/Барсик/);
    assert.match(output,/Собачий стиль/);
    assert.doesNotMatch(output,/Чужой салон/);
    assert.equal(db.prepare('SELECT status FROM max_point_stock_approvals WHERE id=?').get(pending.id).status,'done');
  } finally{global.fetch=original}
});
