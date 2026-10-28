'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'hvost-club-endings-'));
process.env.DATA_DIR = tmp;
const db = require('./db');
const club = require('./routes-partner-club');
const { SALE_ENDINGS, saleEndingAt } = require('./partner-club-sale-endings');
const event = key => db.prepare(
  'SELECT event_type,message FROM partner_club_events WHERE event_key=?'
).get(key);
const count = () => db.prepare(
  "SELECT COUNT(*) AS n FROM partner_club_events WHERE event_type='sales'"
).get().n;
const order = id => ({
  id, status:'paid', refund_status:'none', point_id:null,
  pickup_point:'Мистер Лапсик', total:360, is_partner_self_order:0,
});
const items = [{ name:'Сердце говяжье', qty:1 }];

test('twenty endings are different, positive, and rotate through the entire set',()=>{
  assert.equal(SALE_ENDINGS.length,20);
  assert.equal(new Set(SALE_ENDINGS).size,10);
  for(const text of SALE_ENDINGS){
    assert.ok(text.length>=20 && text.length<=110);
    assert.ok(!text.includes('Спасибо за покупку!'));
  }
  assert.equal(saleEndingAt(0),SALE_ENDINGS[0]);
  assert.equal(saleEndingAt(9),SALE_ENDINGS[9]);
  assert.equal(saleEndingAt(10),SALE_ENDINGS[10]);
  assert.equal(saleEndingAt(20),SALE_ENDINGS[0]);
  assert.equal(saleEndingAt(21),SALE_ENDINGS[1]);
  assert.throws(()=>saleEndingAt(-1),RangeError);
  assert.throws(()=>saleEndingAt(1.5),RangeError);
});

test('every confirmed sale receives a new ending, draft format and order idempotence are preserved',()=>{
  for(let i=0;i<23;i++){
    const id=i+1000;
    assert.equal(club.recordPaidOrder(order(id),items),true);
    const current=event('paid:'+id);
    assert.equal(current.event_type,'sales');
    const lines=current.message.split('\n');
    assert.match(current.message,/🐾 Новая покупка!\n\n🏪 /);
    assert.match(current.message,/»\n\n🦴 Сердце говяжье\n💚 360 ₽\n\n/);
    assert.match(current.message,/Партнёрская точка: «Мистер Лапсик»/);
    assert.match(current.message,/🦴 Сердце говяжье/);
    assert.match(current.message,/💚 360 ₽/);
    assert.equal(lines.at(-1),SALE_ENDINGS[i%20]);
    if(i>0)assert.notEqual(lines.at(-1),event('paid:'+(id-1)).message.split('\n').at(-1));
    assert.equal(club.recordPaidOrder(order(id),items),false);
    assert.equal(count(),i+1);
  }
});

test('preview shows the upcoming ending and does not consume the rotation',()=>{
  const upcoming=SALE_ENDINGS[23%20];
  const preview=club.preview('sales',{
    point:'Мистер Лапсик',product:'Сердце говяжье',amount:360,
  });
  assert.match(preview,/Новая покупка!\n\n🏪 /);
  assert.match(preview,/»\n\n🦴 Сердце говяжье\n💚 360 ₽\n\n/);
  assert.ok(preview.endsWith(upcoming));
  assert.equal(count(),23);
  assert.equal(club.recordPaidOrder(order(1234),items),true);
  assert.ok(event('paid:1234').message.endsWith(upcoming));
  assert.equal(count(),24);
});

test('reloading the club code keeps rotation using the persistent database',()=>{
  const previous=count();
  const modulePath=require.resolve('./routes-partner-club');
  delete require.cache[modulePath];
  const restarted=require('./routes-partner-club');
  assert.equal(restarted.recordPaidOrder(order(1235),items),true);
  assert.equal(count(),previous+1);
  assert.ok(event('paid:1235').message.endsWith(SALE_ENDINGS[previous%20]));
});

test('first-sale congratulations and unpaid/refunded order filtering stay unchanged',()=>{
  assert.equal(club.recordPaidOrder({...order(3000),status:'pending'},items),false);
  assert.equal(club.recordPaidOrder({...order(3001),refund_status:'refunded'},items),false);
  assert.equal(club.recordPaidOrder(order(3002),items,true),false);
  const previous=count();
  const firstPreview=club.preview('first_sale',{point:'Мистер Лапсик',amount:360});
  assert.match(firstPreview,/Поздравляем команду с первым успехом/);
  assert.equal(count(),previous);
  // A point's first sale uses its separate historical greeting, not the normal cycle.
  db.prepare(
    'INSERT INTO points(id,name,addr,icon,active) VALUES (?,?,?,?,1)'
  ).run('club-first-sale-point','Тестовый салон','Тестовый адрес','🐾');
  const first={...order(4000),point_id:'club-first-sale-point'};
  assert.equal(club.recordPaidOrder(first,items),true);
  assert.equal(event('first-sale:point:club-first-sale-point').event_type,'first_sale');
  assert.match(event('first-sale:point:club-first-sale-point').message,/Поздравляем команду/);
  assert.match(event('first-sale:point:club-first-sale-point').message,
    /🎉 Первая продажа!\n\n🏪 /);
  assert.equal(count(),previous);
});

test.after(()=>{
  try{db.close();}catch(_){}
  fs.rmSync(tmp,{recursive:true,force:true});
});
