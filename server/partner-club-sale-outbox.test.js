'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hm-club-outbox-'));
process.env.DATA_DIR=directory;
const db=require('./db');
let club=require('./routes-partner-club');
const outbox=require('./partner-club-sale-outbox');
const {withImmediateTransaction,consumeOrderReservation}=require('./reservations');
const telegram=require('./telegram');
const point='club-outbox-point';
const admin=Number(db.prepare("INSERT INTO admins(login,password_hash,role,telegram_chat_id,active) VALUES(?,?,?,?,1)")
  .run('outbox-admin','hash','super','991122').lastInsertRowid);
const base={enabled:true,chat_id:'-100200',reviewer_admin_id:admin,club_started_at:'2026-01-01 00:00:00',
  sales:true,first_sale:true,record_check:true,record_day:false,daily:false,weekly:false};
function configure(overrides={}){
  db.prepare('INSERT INTO partner_club_settings(id,config_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json')
    .run(JSON.stringify({...base,...overrides}));
}
configure();
db.prepare('INSERT INTO points(id,name,addr,icon,active) VALUES(?,?,?,?,1)').run(point,'Салон Тест','Тестовый адрес','🐾');
let seq=0;
function pending(total=250,options={}){
  const n=++seq;
  const id=Number(db.prepare(
    "INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,point_id,subtotal,total,payment_method,status,reservation_status,yookassa_payment_id,is_partner_self_order) "+
    "VALUES(?,?,?,?,?,?,?,'yookassa','pending','active',?,?)"
  ).run('OUTBOX-'+n,'Покупатель','79990000000','Салон Тест',options.pointId??point,total,total,'outbox-pay-'+n,options.self?1:0).lastInsertRowid);
  db.prepare("INSERT INTO order_items(order_id,name,weight,price,qty,is_custom) VALUES(?,?,'50 г',?,1,0)").run(id,'Лакомство',total);
  return id;
}
function pay(id,demo=false){return consumeOrderReservation(id,{onPaid:order=>outbox.enqueuePaidClubSale(order,demo)});}
const row=id=>db.prepare('SELECT status,reservation_status FROM orders WHERE id=?').get(id);
const jobs=()=>db.prepare('SELECT * FROM partner_club_sale_jobs ORDER BY id').all();
const event=key=>db.prepare('SELECT * FROM partner_club_events WHERE event_key=?').get(key);
test('payment and minimal Club job commit together; disabled and demo sales do not enqueue',()=>{
  const failed=pending();
  assert.throws(()=>consumeOrderReservation(failed,{onPaid:order=>{
    outbox.enqueuePaidClubSale(order);throw Error('rollback simulation');
  }}),/rollback simulation/);
  assert.equal(row(failed).status,'pending');
  assert.equal(jobs().length,0);
  const id=pending();
  configure({enabled:false});
  assert.equal(pay(id).afterPaid,false);assert.equal(row(id).status,'paid');
  configure();
  const demo=pending();
  assert.equal(pay(demo,true).afterPaid,false);
  assert.equal(jobs().length,0);
  const first=pending(400);
  assert.equal(pay(first).afterPaid,true);
  assert.equal(pay(first).consumed,false);
  assert.equal(jobs().length,1);
  assert.equal(jobs()[0].order_id,first);
  assert.equal(event('paid:'+first),undefined);
  assert.doesNotMatch(JSON.stringify(jobs()),/79990000000|Покупатель/);
  club.drainPaidClubSales();
  assert.equal(jobs().length,0);
  assert.ok(event('paid:'+first));
});
test('FIFO payment order preserves first-sale congratulations and sequential record comparisons',()=>{
  db.prepare('INSERT INTO points(id,name,addr,icon,active) VALUES(?,?,?,?,1)').run('club-outbox-new','Новая точка','Адрес','🐾');
  const second=pending(900,{pointId:'club-outbox-new'});
  const first=pending(700,{pointId:'club-outbox-new'});
  pay(first);pay(second);
  assert.deepEqual(jobs().map(j=>j.order_id),[first,second]);
  club.drainPaidClubSales();
  assert.equal(jobs().length,0);
  assert.ok(event('first-sale:point:club-outbox-new'));
  assert.match(event('first-sale:point:club-outbox-new').message,/700 ₽/);
  assert.ok(event('paid:'+second));
  assert.equal(event('paid:'+first),undefined);
  assert.match(event('record-check:'+first).message,/400 ₽/);
  assert.match(event('record-check:'+second).message,/700 ₽/);
  club.drainPaidClubSales();assert.equal(jobs().length,0);
  assert.equal(pay(first).consumed,false);
});
test('failed partial draft insert rolls back, actual SQLite lock retains jobs, restart recovers exactly once',async()=>{
  const id=pending(1100);pay(id);
  db.exec("CREATE TEMP TRIGGER reject_record_draft BEFORE INSERT ON partner_club_events "+
    "WHEN NEW.event_type='record_check' BEGIN SELECT RAISE(ABORT,'simulated draft write failure'); END");
  try{
    assert.throws(()=>club.drainPaidClubSales(),/simulated draft write failure/);
    assert.equal(event('paid:'+id),undefined,'partial ordinary sale must roll back');
    assert.equal(jobs().length,1);
  }finally{db.exec('DROP TRIGGER reject_record_draft');}
  const other=new DatabaseSync(db.DB_PATH);
  other.exec('BEGIN IMMEDIATE');
  try{
    assert.throws(()=>club.drainPaidClubSales(),/database is locked/i);
    assert.equal(row(id).status,'paid');
    assert.equal(jobs().length,1);
    assert.equal(event('paid:'+id),undefined);
  }finally{other.exec('ROLLBACK');other.close();}
  const delivered=[],timers=new Map();
  let next=0;
  const originalSend=telegram.sendToChat,originalSet=global.setTimeout,originalClear=global.clearTimeout;
  global.setTimeout=(fn,delay)=>{const timer={id:++next,fn,delay,unref(){}};timers.set(timer.id,timer);return timer;};
  global.clearTimeout=timer=>timers.delete(timer?.id);
  telegram.sendToChat=async(chat,message)=>{delivered.push({chat:String(chat),message});return {ok:true,data:{ok:true}};};
  async function tick(){
    const timer=[...timers.values()][0];assert.ok(timer);timers.delete(timer.id);
    timer.fn();for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
  }
  // Re-import Club as a new process would; committed jobs do not depend on RAM.
  delete require.cache[require.resolve('./routes-partner-club')];club=require('./routes-partner-club');
  try{
    club.startPartnerClubWorker();
    const lock=new DatabaseSync(db.DB_PATH);lock.exec('BEGIN IMMEDIATE');
    try{
      await tick();
      assert.equal([...timers.values()][0].delay,30000);
      assert.equal(jobs().length,1);
      assert.equal(delivered.length,0);
    }finally{lock.exec('ROLLBACK');lock.close();}
    await tick();
    assert.equal(jobs().length,0);
    const sale=event('paid:'+id),record=event('record-check:'+id);
    assert.ok(sale&&record);
    // Previous tests left drafts too. Bounded worker drains all via its normal wake.
    for(let i=0;i<10&&timers.size;i++)await tick();
    assert.equal(timers.size,0);
    assert.equal(delivered.filter(m=>m.message.includes('#'+sale.id+'</b>')).length,1);
    assert.equal(delivered.filter(m=>m.message.includes('#'+record.id+'</b>')).length,1);
    assert.ok(delivered.every(m=>m.chat==='991122'),'only moderator receives automatic drafts');
    assert.equal(pay(id).consumed,false);
    assert.equal(jobs().length,0);
  }finally{
    club.stopPartnerClubWorker();telegram.sendToChat=originalSend;
    global.setTimeout=originalSet;global.clearTimeout=originalClear;
  }
});
test('refunded/deleted jobs and previous activation do not resurrect obsolete sales',()=>{
  const refunded=pending(500),deleted=pending(600),old=pending(800);
  pay(refunded);pay(deleted);pay(old);
  db.prepare("UPDATE orders SET refund_status='refunded' WHERE id=?").run(refunded);
  db.prepare('DELETE FROM order_items WHERE order_id=?').run(deleted);
  db.prepare('DELETE FROM orders WHERE id=?').run(deleted);
  assert.equal(jobs().some(j=>j.order_id===deleted),false);
  configure({club_started_at:'2026-02-01 00:00:00'});
  club.drainPaidClubSales();
  assert.equal(jobs().length,0);
  for(const id of [refunded,deleted,old])assert.equal(event('paid:'+id),undefined);
});
test.after(()=>{club.stopPartnerClubWorker();db.close();fs.rmSync(directory,{recursive:true,force:true});});
