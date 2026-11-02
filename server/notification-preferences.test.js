'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-notification-prefs-'));
process.env.TOKEN_SECRET='isolated-notification-preferences-test-secret';

const db=require('./db');
require('./business-founders');
const {signToken}=require('./auth');
const {preference,describe,savePreferences}=require('./notification-preferences');
const {registerNotificationPreferenceRoutes}=require('./routes-notification-preferences');

function invoke(method,token,body) {
  const routes={};
  registerNotificationPreferenceRoutes({
    get(path,handler){routes['GET '+path]=handler;},
    put(path,handler){routes['PUT '+path]=handler;},
  });
  const res={status:0,writeHead(status){this.status=status;},end(raw){this.result=JSON.parse(raw);}};
  const req={headers:{authorization:token?'Bearer '+token:''}};
  routes[method+' /api/me/notifications'](req,res,{body});
  return res;
}
db.prepare("INSERT INTO points(id,name,addr,icon,active) VALUES ('test-salon','Тестовый салон','Мира 1','🐾',1)").run();
const c=Number(db.prepare('INSERT INTO customers(phone,name,telegram_chat_id) VALUES (?,?,?)')
  .run('79135550001','Покупатель','11001').lastInsertRowid);
const p=Number(db.prepare(
  'INSERT INTO partners(partner_code,login,password_hash,full_name,phone,point_name,point_id,telegram_chat_id,active) VALUES (?,?,?,?,?,?,?,?,1)'
).run('GR-notify-1','groomer-notify-1','hash','Грумер','79135550002','Тестовый салон','test-salon','11002').lastInsertRowid);
const o=Number(db.prepare(
  'INSERT INTO salon_owners(login,password_hash,full_name,phone,point_id,telegram_chat_id,active) VALUES (?,?,?,?,?,?,1)'
).run('owner-notify-1','hash','Владелец','79135550002','test-salon','11002').lastInsertRowid);
const m=Number(db.prepare(
  'INSERT INTO managers(mgr_code,login,password_hash,full_name,phone,telegram_chat_id,active) VALUES (?,?,?,?,?,?,1)'
).run('M-notify-1','manager-notify-1','hash','Менеджер','79135550003','11003').lastInsertRowid);
const a=Number(db.prepare(
  'INSERT INTO admins(login,password_hash,full_name,telegram_chat_id,role,active) VALUES (?,?,?,?,?,1)'
).run('admin-notify-1','hash','Администратор','11004','super').lastInsertRowid);
const f=db.prepare('SELECT id FROM business_founders WHERE full_name=?').get('Лакомых Алексей').id;
db.prepare('UPDATE business_founders SET active=1,telegram_chat_id=? WHERE id=?').run('11005',f);

test('per-role defaults retain existing personal notices, restrict new broadcasts and marketing',()=>{
  assert.equal(preference('customer',c,'purchase'),true);
  assert.equal(preference('customer',c,'offers'),false);
  assert.equal(preference('partner',p,'sales'),true);
  assert.equal(preference('partner',p,'payouts'),true);
  assert.equal(preference('owner',o,'sales'),false);
  assert.equal(preference('owner',o,'payouts'),true);
  assert.equal(preference('manager',m,'sales'),true);
  assert.equal(preference('manager',m,'messages'),true);
  assert.equal(preference('owner',o,'messages'),true);
  assert.equal(preference('partner',p,'messages'),true);
  assert.equal(preference('admin',a,'sales'),false);
  assert.equal(preference('founder',f,'sales'),false);
  assert.equal(preference('owner',o,'unrecognized-topic'),false);
});

test('settings route belongs to signed active account and cannot alter another role',()=>{
  const partner=signToken({role:'partner',id:p});
  const owner=signToken({role:'owner',id:o});
  const start=invoke('GET',partner);
  assert.equal(start.status,200);
  assert.equal(start.result.role,'partner');
  assert.deepEqual(start.result.settings.map(x=>x.key),['sales','payouts','new_products','messages']);

  const saved=invoke('PUT',partner,{settings:{sales:false}});
  assert.equal(saved.status,200);
  assert.equal(preference('partner',p,'sales'),false);
  assert.equal(preference('owner',o,'sales'),false);
  assert.equal(preference('partner',p,'payouts'),true);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM notification_preferences').get().count,1);

  const own=invoke('PUT',owner,{settings:{sales:true,payouts:false}});
  assert.equal(own.status,200);
  assert.equal(preference('owner',o,'sales'),true);
  assert.equal(preference('owner',o,'payouts'),false);
  assert.equal(preference('partner',p,'sales'),false);

  assert.equal(invoke('GET','').status,401);
  assert.equal(invoke('PUT',partner,{settings:{sales:'false'}}).status,400);
  assert.equal(invoke('PUT',partner,{settings:{admin_sales:true}}).status,400);
  assert.equal(invoke('PUT',partner,{settings:{sales:false,unknown:true}}).status,400);
  assert.equal(invoke('PUT',partner,{settings:{}}).status,400);
  assert.equal(invoke('PUT',partner,{settings:null}).status,400);
  db.prepare('UPDATE partners SET active=0 WHERE id=?').run(p);
  assert.equal(invoke('GET',partner).status,403);
  assert.equal(invoke('PUT',partner,{settings:{sales:true}}).status,403);
  db.prepare('UPDATE partners SET active=1 WHERE id=?').run(p);
});

test('transactional purchase receipt cannot be switched off, while offers require opt-in',()=>{
  const token=signToken({role:'customer',id:c});
  assert.equal(invoke('PUT',token,{settings:{purchase:false}}).status,400);
  assert.equal(invoke('PUT',token,{settings:{offers:true}}).status,200);
  assert.equal(preference('customer',c,'offers'),true);
  assert.equal(invoke('PUT',token,{settings:{offers:false}}).status,200);
  assert.equal(preference('customer',c,'offers'),false);
  db.prepare("INSERT OR REPLACE INTO notification_preferences(recipient_role,recipient_id,notification_key,enabled) VALUES ('customer',?,'purchase',0)").run(c);
  assert.equal(preference('customer',c,'purchase'),true,'mandatory receipts ignore malformed stored preferences');
  assert.equal(describe('customer',c).find(x=>x.key==='purchase').locked,true);
});

test('private paid sale notices actually respect settings; owner/admin/founder only opt-in',async()=>{
  // Reset explicitly so this regression never depends on earlier test order.
  assert.equal(savePreferences('partner',p,{sales:false}).ok,true);
  assert.equal(savePreferences('owner',o,{sales:false}).ok,true);
  const telegram=require('./telegram');
  const real=telegram.sendToChat;
  const deliveries=[];
  telegram.sendToChat=async (chatId,body)=>{
    deliveries.push({chatId:String(chatId),body});
    return {ok:true};
  };
  try {
    const path=require.resolve('./order-notifications');
    delete require.cache[path];
    const {sendPaidOrderNotifications}=require('./order-notifications');
    const order={
      customer_phone:'79135550001',customer_name:'Покупатель',customer_lname:'',
      point_id:'test-salon',partner_id:p,pickup_point:'Тестовый салон',
      order_code:'QR-test-101',commission_rate:.15,total:200,
    };
    const items=[{name:'Сердце говяжье',weight:'50 г',qty:1,price:200}];
    let sent=await sendPaidOrderNotifications(order,items);
    assert.deepEqual(sent.attempted,['customer'],'groomer opted out and only purchase receipt is mandatory');
    assert.deepEqual(deliveries.map(x=>x.chatId),['11001']);
    assert.match(deliveries[0].body,/Заказ оплачен/);
    deliveries.length=0;

    assert.equal(savePreferences('owner',o,{sales:true}).ok,true);
    assert.equal(savePreferences('admin',a,{sales:true}).ok,true);
    assert.equal(savePreferences('founder',f,{sales:true}).ok,true);
    sent=await sendPaidOrderNotifications(order,items);
    assert.deepEqual(sent.attempted,['customer','owner','admin','founder']);
    assert.deepEqual(deliveries.map(x=>x.chatId),['11001','11002','11004','11005']);
    for(const row of deliveries.slice(1)) {
      assert.doesNotMatch(row.body,/Покупатель|79135550001/,
        'private optional reports should not disclose a customer phone/name');
    }
    deliveries.length=0;
    savePreferences('partner',p,{sales:true});
    savePreferences('owner',o,{sales:false});
    sent=await sendPaidOrderNotifications(order,items);
    assert.deepEqual(sent.attempted,['customer','partner','admin','founder']);
    assert.deepEqual(deliveries.map(x=>x.chatId),['11001','11002','11004','11005']);
  } finally {
    telegram.sendToChat=real;
    delete require.cache[require.resolve('./order-notifications')];
  }
});

test('customer winback messages and gift candidates honor explicit customer consent',()=>{
  db.prepare("UPDATE customers SET last_order_at=datetime('now','-40 days'),winback_sent_at=NULL WHERE id=?").run(c);
  const {findWinbackCandidates}=require('./winback');
  assert.equal(findWinbackCandidates().some(x=>x.id===c),false);
  savePreferences('customer',c,{offers:true});
  assert.equal(findWinbackCandidates().some(x=>x.id===c),true);
  savePreferences('customer',c,{offers:false});
  assert.equal(findWinbackCandidates().some(x=>x.id===c),false);
});


test('recorded payout notices obey independent partner/owner/manager toggles without reserving suppressed deliveries',async()=>{
  const telegram=require('./telegram');
  const old=telegram.sendToChat;
  const chats=[];
  telegram.sendToChat=async(chat,message)=>{chats.push({chat:String(chat),message});return {ok:true};};
  const file=require.resolve('./payout-reminders');
  delete require.cache[file];
  try {
    const payouts=require('./payout-reminders');
    savePreferences('partner',p,{payouts:false});
    savePreferences('owner',o,{payouts:false});
    savePreferences('manager',m,{payouts:false});
    const partnerPayout={id:90001,paid_at:'2026-11-01 11:00:00'};
    const ownerPayout={id:90002,paid_at:'2026-11-01 11:00:00'};
    assert.equal((await payouts.sendPartnerPayoutNotification(p,partnerPayout,'Оплачено'))[0].disabled,true);
    assert.equal((await payouts.sendOwnerPayoutNotification(o,ownerPayout,'Оплачено'))[0].disabled,true);
    assert.equal((await payouts.sendManagerPayoutNotification(m,{id:90003},'Оплачено','launch_bonus'))[0].disabled,true);
    assert.deepEqual(chats,[]);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM payout_notification_log').get().n,0,
      'suppressed payouts should not occupy a delivery reservation');
    savePreferences('partner',p,{payouts:true});
    savePreferences('owner',o,{payouts:true});
    savePreferences('manager',m,{payouts:true});
    assert.equal((await payouts.sendPartnerPayoutNotification(p,partnerPayout,'Оплачено'))[0].ok,true);
    assert.equal((await payouts.sendOwnerPayoutNotification(o,ownerPayout,'Оплачено'))[0].ok,true);
    assert.equal((await payouts.sendManagerPayoutNotification(m,{id:90003},'Оплачено','launch_bonus'))[0].ok,true);
    assert.deepEqual(chats.map(x=>x.chat),['11002','11002','11003']);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM payout_notification_log WHERE status='sent'").get().n,3);
  } finally {
    telegram.sendToChat=old;
    delete require.cache[file];
  }
});
