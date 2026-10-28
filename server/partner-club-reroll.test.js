'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hvost-club-reroll-'));
process.env.DATA_DIR = temp;
const db = require('./db');
const club = require('./routes-partner-club');
const telegram = require('./telegram');
const { SALE_ENDINGS } = require('./partner-club-sale-endings');
const { withSaleEnding, saleMessageHtml } = require('./partner-club-sale-format');

const adminId = Number(db.prepare(
  'INSERT INTO admins(login,password_hash,full_name,telegram_chat_id,role) VALUES (?,?,?,?,?)'
).run('club-reroll-test-admin','hash','Модератор','100100','super').lastInsertRowid);
db.prepare('INSERT INTO partner_club_settings(id,config_json) VALUES(1,?)')
  .run(JSON.stringify({
    enabled:true,chat_id:'-100200',reviewer_admin_id:adminId,
    club_started_at:'2026-10-01 00:00:00',sales:true,first_sale:true,
  }));
const order = { id:70101,status:'paid',refund_status:'none',point_id:null,
  pickup_point:'Мистер Лапсик',total:360,is_partner_self_order:0 };
assert.equal(club.recordPaidOrder(order,[{name:'Сердце говяжье',qty:1}]),true);
const sale = db.prepare(
  "SELECT * FROM partner_club_events WHERE event_key='paid:70101'"
).get();
db.prepare(
  "INSERT INTO partner_club_reviews(event_id,state,reviewer_chat_id) VALUES (?,'pending',?)"
).run(sale.id,'100100');
const chosen = () => db.prepare(
  'SELECT ending_index FROM partner_club_sale_endings_override WHERE event_id=?'
).get(sale.id);
const review = () => db.prepare(
  'SELECT state,edited_message FROM partner_club_reviews WHERE event_id=?'
).get(sale.id);
const outbound = [];
const originalSender = telegram.sendToChat;
telegram.sendToChat = async (chat,text) => {
  outbound.push({ chat:String(chat), text });
  return {ok:true,data:{ok:true}};
};

test('20 successive taps change only congratulations, preserve HTML and draft metadata',async()=>{
  const first = sale.message.trim().split('\n').at(-1);
  const defaultIndex = SALE_ENDINGS.indexOf(first);
  assert.notEqual(defaultIndex,-1);
  const firstText = sale.message.slice(0,sale.message.lastIndexOf(first));
  for(let i=0;i<20;i++){
    const result = await club.handleClubCallback('100100','club:reroll:'+sale.id);
    const index = (defaultIndex+i+1)%20;
    assert.equal(result.ok,true);
    assert.equal(result.rerolled,true);
    assert.equal(chosen().ending_index,index);
    assert.ok(result.preview_html.endsWith(SALE_ENDINGS[index]));
    assert.ok(result.preview_html.includes('🏪 Партнёрская точка: <b>«Мистер Лапсик»</b>'));
    assert.ok(result.preview_html.includes('🦴 Сердце говяжье\n💚 360 ₽\n\n'));
    assert.equal(result.reply_markup.inline_keyboard[0][0].callback_data,
      'club:reroll:'+sale.id);
    assert.equal(review().state,'pending');
    assert.equal(db.prepare('SELECT message FROM partner_club_events WHERE id=?')
      .get(sale.id).message,sale.message); // never mutate purchase details
    assert.equal(firstText, sale.message.slice(0,sale.message.lastIndexOf(first)));
  }
  assert.equal(chosen().ending_index,defaultIndex);
  assert.equal(outbound.length,0); // reroll never publishes the message
});

test('selected congratulations survive a code reload and are published on approval',async()=>{
  const changed = await club.handleClubCallback('100100','club:reroll:'+sale.id);
  const selected = SALE_ENDINGS[chosen().ending_index];
  assert.ok(changed.preview_html.endsWith(selected));
  const modulePath = require.resolve('./routes-partner-club');
  delete require.cache[modulePath];
  const restarted = require('./routes-partner-club');
  const published = await restarted.handleClubCallback('100100','club:send:'+sale.id);
  assert.equal(published.ok,true);
  assert.equal(review().state,'sent');
  assert.equal(outbound.length,1);
  assert.equal(outbound[0].chat,'-100200');
  assert.equal(outbound[0].text,
    saleMessageHtml(withSaleEnding(sale.message, selected)));
  assert.equal(outbound[0].text.split('\n').at(-1),selected);
  assert.equal((await restarted.handleClubCallback('100100','club:reroll:'+sale.id)).ok,false);
  assert.equal(outbound.length,1);
});

test('unauthorized reviewer and edited/manual/first-sale drafts cannot be rotated',async()=>{
  const e = db.prepare(
    "INSERT INTO partner_club_events(event_key,event_type,message) VALUES (?,?,?)"
  );
  const insertReview = db.prepare(
    "INSERT INTO partner_club_reviews(event_id,state,reviewer_chat_id,edited_message) VALUES (?,'pending',?,?)"
  );
  for(const [i,type,message,edited] of [
    [1,'manual','Ручная публикация',null],
    [2,'first_sale','🎉 Первая продажа!',null],
    [3,'sales',sale.message,'Поздравление от модератора'],
  ]){
    const id=Number(e.run('reroll-guard-'+i,type,message).lastInsertRowid);
    insertReview.run(id,'100100',edited);
    const rejected = await club.handleClubCallback('100100','club:reroll:'+id);
    assert.equal(rejected.ok,false);
    assert.equal(db.prepare(
      'SELECT ending_index FROM partner_club_sale_endings_override WHERE event_id=?'
    ).get(id),undefined);
  }
  const other = db.prepare("SELECT id FROM partner_club_events WHERE event_key='reroll-guard-3'").get();
  assert.equal((await club.handleClubCallback('999999','club:reroll:'+other.id)).ok,false);
  assert.equal(outbound.length,1);
});

test('older drafts with generic endings can be replaced without changing the sale details',async()=>{
  const original=[
    '🐾 Новая покупка!',
    '🏪 Партнёрская точка: «Тестовая точка»',
    '🦴 Кроличьи лапки',
    '💚 290 ₽',
    'Спасибо за покупку!',
  ].join('\n');
  const id=Number(db.prepare(
    "INSERT INTO partner_club_events(event_key,event_type,message) VALUES (?,'sales',?)"
  ).run('reroll-historical-sale',original).lastInsertRowid);
  db.prepare(
    "INSERT INTO partner_club_reviews(event_id,state,reviewer_chat_id) VALUES (?,'pending',?)"
  ).run(id,'100100');
  const result=await club.handleClubCallback('100100','club:reroll:'+id);
  assert.equal(result.ok,true);
  assert.equal(db.prepare('SELECT ending_index FROM partner_club_sale_endings_override WHERE event_id=?').get(id).ending_index,0);
  assert.match(result.preview_html,/🏪 Партнёрская точка: <b>«Тестовая точка»<\/b>/);
  assert.match(result.preview_html,/🦴 Кроличьи лапки\n💚 290 ₽\n\n/);
  assert.ok(result.preview_html.endsWith(SALE_ENDINGS[0]));
  assert.equal(db.prepare('SELECT message FROM partner_club_events WHERE id=?').get(id).message,original);
});

test.after(()=>{
  telegram.sendToChat=originalSender;
  try{db.close();}catch(_){}
  fs.rmSync(temp,{recursive:true,force:true});
});
