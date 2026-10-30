'use strict';
// Integration tests for the all-time highest paid check announcement.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hvost-record-check-'));
process.env.DATA_DIR = directory;
const db = require('./db');
const club = require('./routes-partner-club');
const telegram = require('./telegram');

const adminId = Number(db.prepare(
  'INSERT INTO admins(login,password_hash,full_name,telegram_chat_id,role) VALUES (?,?,?,?,?)'
).run('club-record-test-admin','hash','Модератор','100500','super').lastInsertRowid);
db.prepare('INSERT INTO partner_club_settings(id,config_json) VALUES(1,?)').run(JSON.stringify({
  enabled:true,chat_id:'-100200',reviewer_admin_id:adminId,
  club_started_at:'2026-10-01 00:00:00',
  sales:true,first_sale:true,record_check:true,
}));
db.prepare('INSERT INTO points(id,name,addr,icon,active) VALUES (?,?,?,?,1)')
  .run('record-point-1','Дог Стиль & Ко','ул. Тестовая, 1','🐾');
db.prepare('INSERT INTO points(id,name,addr,icon,active) VALUES (?,?,?,?,1)')
  .run('record-point-2','Новая точка','ул. Тестовая, 2','🐾');

let sequence=0;
function paid(amount,options={}){
  const number=++sequence;
  const info=db.prepare(
    'INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,'+
    'point_id,subtotal,total,payment_method,status,is_partner_self_order,'+
    'refund_status,fulfillment_type,yookassa_payment_id) '+
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    'RECORD-TEST-'+number,'Клиент','+79001111111',
    options.pickupPoint || 'Дог Стиль & Ко',
    options.pointId === undefined ? 'record-point-1' : options.pointId,
    amount,amount,'sbp','paid',options.selfOrder?1:0,
    options.refunded?'refunded':'none',
    options.delivery?'home_delivery':'pickup',
    options.demo?null:'payment-record-test-'+number
  );
  return db.prepare('SELECT * FROM orders WHERE id=?').get(info.lastInsertRowid);
}
const products=[{name:'Сердце говяжье',weight:'50 г',qty:1,price:400}];
function announcement(order){
  return db.prepare("SELECT * FROM partner_club_events WHERE event_key=?")
    .get('record-check:'+order.id);
}
function countRecords(){
  return db.prepare("SELECT COUNT(*) AS n FROM partner_club_events WHERE event_type='record_check'").get().n;
}

let recordToModerate;
test('only a strictly higher real customer payment creates an independent record draft',()=>{
  const first=paid(400);
  assert.equal(club.recordPaidOrder(first,products),true);
  assert.equal(announcement(first),undefined); // establishes baseline
  assert.ok(db.prepare("SELECT 1 FROM partner_club_events WHERE event_type='first_sale' AND event_key=?").get('first-sale:point:record-point-1'));

  const same=paid(400);
  club.recordPaidOrder(same,products);
  assert.equal(announcement(same),undefined);
  const lower=paid(250);
  club.recordPaidOrder(lower,products);
  assert.equal(countRecords(),0);

  recordToModerate=paid(750);
  assert.equal(club.recordPaidOrder(recordToModerate,products),true);
  assert.equal(countRecords(),1);
  const draft=announcement(recordToModerate);
  assert.match(draft.message,/Рекордный чек:\n750 ₽/);
  assert.doesNotMatch(draft.message,/Рекордный чек:[^\\n]*\\d+ ₽/);
  assert.match(draft.message,/^💚 Рекордный чек:\\n750 ₽$/m);
  assert.match(draft.message,/Предыдущий рекорд:\n400 ₽/);
  assert.match(draft.message,/Превышение:\n\+350 ₽/);
  assert.match(draft.message,/Дог Стиль/);
  assert.equal(club.recordPaidOrder(recordToModerate,products),false);
  assert.equal(countRecords(),1);

  const newPoint=paid(950,{pointId:'record-point-2',pickupPoint:'Новая точка'});
  assert.equal(club.recordPaidOrder(newPoint,products),true);
  assert.ok(announcement(newPoint));
  assert.ok(db.prepare("SELECT 1 FROM partner_club_events WHERE event_key=?")
    .get('first-sale:point:record-point-2')); // first-sale does not replace network record

  const selfOrder=paid(1500,{selfOrder:true});
  club.recordPaidOrder(selfOrder,products);
  assert.equal(announcement(selfOrder),undefined);
  const demo=paid(2500,{demo:true});
  club.recordPaidOrder(demo,products,true);
  assert.equal(announcement(demo),undefined);
  const refunded=paid(2000,{refunded:true});
  club.recordPaidOrder(refunded,products);
  assert.equal(announcement(refunded),undefined);

  const next=paid(1200);
  club.recordPaidOrder(next,products);
  assert.match(announcement(next).message,/Предыдущий рекорд:\n950 ₽/);
  assert.equal(countRecords(),3);

  const delivery=paid(1300,{pointId:null,delivery:true,pickupPoint:'Доставка на дом — ул. Секретная, 99'});
  club.recordPaidOrder(delivery,products);
  assert.ok(announcement(delivery));
  assert.doesNotMatch(announcement(delivery).message,/Секретная/);
});

test('record draft requires approval and is published with the salon in bold',async()=>{
  const messages=[];
  const originalSend=telegram.sendToChat;
  telegram.sendToChat=async(chat,text)=>{
    messages.push({chat:String(chat),text});
    return {ok:true,data:{ok:true}};
  };
  try{
    const draft=announcement(recordToModerate);
    db.prepare("INSERT INTO partner_club_reviews(event_id,state,reviewer_chat_id) VALUES (?,'pending',?)")
      .run(draft.id,'100500');
    assert.equal(messages.length,0);
    assert.equal((await club.handleClubCallback('888','club:send:'+draft.id)).ok,false);
    assert.equal(messages.length,0);
    const sent=await club.handleClubCallback('100500','club:send:'+draft.id);
    assert.equal(sent.ok,true);
    assert.equal(messages.length,1);
    assert.equal(messages[0].chat,'-100200');
    assert.match(messages[0].text,/<b>«Дог Стиль &amp; Ко»<\/b>/);
    assert.equal((await club.handleClubCallback('100500','club:send:'+draft.id)).ok,false);
    assert.equal(messages.length,1);
  }finally{telegram.sendToChat=originalSend;}
});

test('the record switch is independent of ordinary sales; refunds block approval',async()=>{
  const existingSettings=club.settings();
  db.prepare('UPDATE partner_club_settings SET config_json=? WHERE id=1')
    .run(JSON.stringify({...existingSettings,record_check:false}));
  const disabled=paid(3000);
  club.recordPaidOrder(disabled,products);
  assert.equal(announcement(disabled),undefined);
  assert.ok(db.prepare("SELECT 1 FROM partner_club_events WHERE event_key=?").get('paid:'+disabled.id));

  const previous=recordToModerate;
  const newer=paid(3200);
  db.prepare('UPDATE partner_club_settings SET config_json=? WHERE id=1')
    .run(JSON.stringify({...existingSettings,record_check:true}));
  club.recordPaidOrder(newer,products);
  const draft=announcement(newer);
  assert.ok(draft);

  db.prepare("INSERT INTO partner_club_reviews(event_id,state,reviewer_chat_id) VALUES (?,'pending',?)")
    .run(draft.id,'100500');
  db.prepare("UPDATE orders SET refund_status='refunded' WHERE id=?").run(newer.id);
  const result=await club.handleClubCallback('100500','club:send:'+draft.id);
  assert.equal(result.ok,false);
  assert.match(result.message,/возвращён/);
  assert.ok(previous); // test keeps the earlier network record unchanged
});

test.after(()=>{
  try{db.close();}catch(_){}
  fs.rmSync(directory,{recursive:true,force:true});
});
