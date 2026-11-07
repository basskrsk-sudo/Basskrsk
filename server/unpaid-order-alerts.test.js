'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-unpaid-point-manager-'));
process.env.UNPAID_ORDER_ALERT_MINUTES = '3'; // Old Amvera override must not keep the former delay.
const db = require('./db');
const {
  ALERT_DELAY_MINUTES, POLL_INTERVAL_MS, responsibleManagerChat,
  pendingOrderIds, runUnpaidOrderAlertCheck, sendUnpaidOrderAlert,
  buildUnpaidOrderMessage,
} = require('./unpaid-order-alerts');

function manager(name, chat, active = 1) {
  const code = 'MGR-' + name.replace(/\W/g, '');
  return Number(db.prepare(
    'INSERT INTO managers (mgr_code,login,password_hash,full_name,phone,telegram_chat_id,active) ' +
    'VALUES (?,?,?,?,?,?,?)'
  ).run(code,code,'test-hash',name,'79130000001',chat,active).lastInsertRowid);
}
function point(id, managerId, active = 1) {
  db.prepare('INSERT INTO points (id,name,addr,icon,manager_id,active) VALUES (?,?,?,?,?,?)')
    .run(id, id, 'Красноярск', '🏪', managerId, active);
}
function order(code, pointId, age = '-2 minutes', status = 'pending', reserve = 'active') {
  const id = Number(db.prepare(
    "INSERT INTO orders (order_code,customer_name,customer_phone,pickup_point,point_id, " +
    "subtotal,total,payment_method,status,reservation_status,created_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now',?))"
  ).run(code,'Тестовый покупатель','+79131234567',pointId || 'Точка',
    pointId,250,250,'yookassa',status,reserve,age).lastInsertRowid);
  db.prepare('INSERT INTO order_items (order_id,name,weight,price,qty) VALUES (?,?,?,?,?)')
    .run(id,'Лёгкое говяжье','50 г',250,1);
  return id;
}
function sender() {
  const calls = [];
  return { calls, sendToChat: async (chat,message) => {
    calls.push({chat,message});
    return {ok:true};
  }};
}

test('one-minute rule ignores legacy three-minute env, polls every 15 seconds', () => {
  assert.equal(ALERT_DELAY_MINUTES,1);
  assert.equal(POLL_INTERVAL_MS,15000);
  assert.match(buildUnpaidOrderMessage({
    customer_name:'Клиент',order_code:'TG-SLA',customer_phone:'79131111111',
    pickup_point:'Zveryuga',payment_method:'sbp',total:250,
  },[], 'pending'),/Заказ не оплачен 1 минуту/);
});

test('pending orders alert only their active point manager, once', async () => {
  const a=manager('angelina-a','900000000001');
  const b=manager('manager-b','900000000002');
  point('zveryuga-unpaid',a);
  point('barklay-unpaid',b);
  const x=order('TG-UNPAID-ONE-MIN','zveryuga-unpaid','-2 minutes');
  const y=order('TG-UNPAID-OTHER','barklay-unpaid','-2 minutes');
  const fresh=order('TG-UNPAID-FRESH','zveryuga-unpaid','-30 seconds');
  assert.equal(responsibleManagerChat(db.prepare('SELECT * FROM orders WHERE id=?').get(x)),'900000000001');
  assert.ok(pendingOrderIds().includes(x));
  assert.ok(pendingOrderIds().includes(y));
  assert.ok(!pendingOrderIds().includes(fresh));

  const send=sender();
  const results=await runUnpaidOrderAlertCheck(send);
  assert.equal(results.filter(z=>z.ok).length,2);
  assert.deepEqual(send.calls.map(z=>z.chat).sort(),['900000000001','900000000002']);
  const z=send.calls.find(q=>q.chat==='900000000001');
  assert.match(z.message,/TG-UNPAID-ONE-MIN/);
  assert.match(z.message,/79131234567/);
  assert.doesNotMatch(z.message,/TG-UNPAID-OTHER/);
  assert.match(z.message,/Заказ не оплачен 1 минуту/);
  assert.equal((await runUnpaidOrderAlertCheck(send)).length,0);
  assert.equal(send.calls.length,2);
  assert.deepEqual(db.prepare("SELECT status FROM unpaid_order_alert_log WHERE alert_type='pending' ORDER BY order_id").all()
    .map(row=>row.status),['sent','sent']);
});

test('already paid, failed and released orders never receive pending alerts', async () => {
  const mgr=manager('manager-paid','900000000003');
  point('paid-unpaid',mgr);
  const paid=order('TG-PAID-TEST','paid-unpaid','-4 minutes','paid');
  const failed=order('TG-CANCEL-TEST','paid-unpaid','-4 minutes','failed');
  const released=order('TG-RELEASE-TEST','paid-unpaid','-4 minutes','pending','released');
  const send=sender();
  for(const id of [paid,failed,released]){
    assert.ok(!pendingOrderIds().includes(id));
    assert.equal((await sendUnpaidOrderAlert(id,'pending',null,send)).skipped,true);
  }
  assert.equal(send.calls.length,0);
});

test('unlinked and inactive managers never receive private numbers or reserve alert', async () => {
  const active=manager('awaiting-connect',null);
  const inactive=manager('manager-inactive','900000000004',0);
  point('missing-chat-unpaid',active);
  point('inactive-unpaid',inactive);
  const unlinked=order('TG-UNPAID-NO-CHAT','missing-chat-unpaid');
  const off=order('TG-UNPAID-INACTIVE','inactive-unpaid');
  const send=sender();
  assert.equal((await sendUnpaidOrderAlert(unlinked,'pending',null,send)).skipped,true);
  assert.equal((await sendUnpaidOrderAlert(off,'pending',null,send)).skipped,true);
  assert.equal(send.calls.length,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM unpaid_order_alert_log WHERE order_id=?').get(unlinked).n,0);
  db.prepare('UPDATE managers SET telegram_chat_id=? WHERE id=?').run('900000000005',active);
  assert.equal((await sendUnpaidOrderAlert(unlinked,'pending',null,send)).ok,true);
  assert.deepEqual(send.calls.map(z=>z.chat),['900000000005']);
});

test('inactive primary manager cannot fall back to a historical manager', async () => {
  const inactive=manager('inactive-primary','900000000006',0);
  const historical=manager('stale-referral','900000000007');
  point('old-points-unpaid',inactive);
  db.prepare('INSERT INTO manager_points(manager_id,point_id,point_name,point_type) VALUES (?,?,?,?)')
    .run(historical,'old-points-unpaid','История','Груминг');
  const id=order('TG-UNPAID-OLD-MANAGER','old-points-unpaid');
  const send=sender();
  assert.equal(responsibleManagerChat(db.prepare('SELECT * FROM orders WHERE id=?').get(id)),null);
  assert.equal((await sendUnpaidOrderAlert(id,'pending',null,send)).skipped,true);
  assert.equal(send.calls.length,0);
});

test('legacy point without primary manager allows only one active manager', async () => {
  const a=manager('legacy-a','900000000008');
  const b=manager('legacy-b','900000000009');
  point('legacy-point-unpaid',null);
  db.prepare('INSERT INTO manager_points(manager_id,point_id,point_name,point_type) VALUES (?,?,?,?)')
    .run(a,'legacy-point-unpaid','Точка','Груминг');
  const id=order('TG-UNPAID-LEGACY','legacy-point-unpaid');
  assert.equal(responsibleManagerChat(db.prepare('SELECT * FROM orders WHERE id=?').get(id)),'900000000008');
  db.prepare('INSERT INTO manager_points(manager_id,point_id,point_name,point_type) VALUES (?,?,?,?)')
    .run(b,'legacy-point-unpaid','Точка 2','Груминг');
  assert.equal(responsibleManagerChat(db.prepare('SELECT * FROM orders WHERE id=?').get(id)),null);
});

test('failed payment alerts point manager immediately, not the shared service chat', async () => {
  const mgr=manager('failed-manager','900000000010');
  point('failed-point-unpaid',mgr);
  const id=order('TG-FAILED-IN-POINT','failed-point-unpaid','-10 seconds','failed','released');
  const send=sender();
  assert.equal((await sendUnpaidOrderAlert(id,'failed','ЮKassa: отменён платеж',send)).ok,true);
  assert.deepEqual(send.calls.map(z=>z.chat),['900000000010']);
  assert.match(send.calls[0].message,/Платёж не состоялся/);
  assert.match(send.calls[0].message,/Причина:/);
  assert.equal((await sendUnpaidOrderAlert(id,'failed',null,send)).skipped,true);
  assert.equal(send.calls.length,1);
});


function admin(name, chat, active=1) {
  const login='unpaid-'+name;
  return Number(db.prepare(
    'INSERT INTO admins (login,password_hash,full_name,telegram_chat_id,active) VALUES (?,?,?,?,?)'
  ).run(login,'test-hash',name,chat,active).lastInsertRowid);
}
function isolateAdminAlerts() {
  db.prepare('DELETE FROM admins').run();
  // Prevent a new admin's enrollment in a test from picking up old pending
  // fixtures from unrelated tests. Paid orders are excluded by the scheduler.
  db.prepare("UPDATE orders SET status='paid' WHERE status='pending'").run();
}

test('manager and administrator get independent one-minute notices with manager name', async () => {
  isolateAdminAlerts();
  const m=manager('dual-manager','900000000021');
  point('dual-unpaid',m);
  const a=admin('admin-one','900000000022');
  const b=admin('admin-two','900000000023');
  const id=order('TG-UNPAID-ADMIN-ONE','dual-unpaid');
  const send=sender();
  const opts={...send,businessChatId:''};
  const summary=await runUnpaidOrderAlertCheck(opts);
  assert.equal(summary.length,1);
  assert.equal(summary[0].manager_sent,true);
  assert.equal(summary[0].admin_sent,true);
  assert.equal(summary[0].sent_count,3);
  assert.deepEqual(send.calls.map(x=>x.chat).sort(),[
    '900000000021','900000000022','900000000023']);
  const notice=send.calls.find(x=>x.chat==='900000000022').message;
  assert.match(notice,/Ответственный менеджер: dual-manager/);
  assert.match(notice,/TG-UNPAID-ADMIN-ONE/);
  assert.match(notice,/79131234567/);
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS n FROM unpaid_order_admin_alert_log WHERE order_id=? AND status=?'
  ).get(id,'sent').n,2);
  assert.equal((await runUnpaidOrderAlertCheck(opts)).length,0);
  assert.equal(send.calls.length,3);
  assert.equal(a>0&&b>0,true);
});

test('administrator still receives message when manager has no Telegram or is unassigned', async () => {
  isolateAdminAlerts();
  admin('admin-no-manager','900000000024');
  const inactive=manager('no-telegram-manager',null);
  point('admin-only-point',inactive);
  const id=order('TG-UNPAID-ADMIN-ONLY','admin-only-point');
  const unassigned=order('TG-UNPAID-UNASSIGNED','no-matching-point');
  const send=sender();
  const opts={...send,businessChatId:''};
  const first=await sendUnpaidOrderAlert(id,'pending',null,opts);
  assert.equal(first.ok,true);
  assert.equal(first.manager_sent,false);
  assert.equal(first.admin_sent,true);
  assert.deepEqual(send.calls.map(x=>x.chat),['900000000024']);
  const second=await sendUnpaidOrderAlert(unassigned,'pending',null,opts);
  assert.equal(second.admin_sent,true);
  assert.equal(second.manager_sent,false);
  assert.match(send.calls[1].message,/не назначен/);
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS n FROM unpaid_order_alert_log WHERE order_id=?'
  ).get(id).n,0,'manager ledger must not be falsely marked sent');
});

test('one chat having both manager and admin roles gets a single administrative message', async () => {
  isolateAdminAlerts();
  const m=manager('dual-role-manager','900000000025');
  point('dual-role-point',m);
  admin('also-admin','900000000025');
  admin('second-admin-same-chat','900000000025');
  const id=order('TG-UNPAID-DUAL-ROLE','dual-role-point');
  const send=sender();
  const opts={...send,businessChatId:'900000000025'};
  const result=await sendUnpaidOrderAlert(id,'pending',null,opts);
  assert.equal(result.sent_count,1);
  assert.deepEqual(send.calls.map(x=>x.chat),['900000000025']);
  assert.match(send.calls[0].message,/Ответственный менеджер: dual-role-manager/);
  assert.equal((await sendUnpaidOrderAlert(id,'pending',null,opts)).skipped,true);
  assert.equal(send.calls.length,1);
});

test('service admin chat receives one copy and inactive admins are excluded', async () => {
  isolateAdminAlerts();
  admin('inactive-admin','900000000026',0);
  admin('service-admin','900000000027');
  const id=order('TG-UNPAID-SERVICE','unassigned-service-point');
  const send=sender();
  const opts={...send,businessChatId:'-1009000000001'};
  const result=await sendUnpaidOrderAlert(id,'pending',null,opts);
  assert.equal(result.admin_sent,true);
  assert.deepEqual(send.calls.map(x=>x.chat).sort(),['-1009000000001','900000000027']);
  assert.ok(send.calls.every(x=>x.chat!=='900000000026'));
  assert.equal((await sendUnpaidOrderAlert(id,'pending',null,opts)).skipped,true);
});

test('an already paid order does not alert any manager or administrator', async () => {
  isolateAdminAlerts();
  const a=admin('paid-admin','900000000028');
  const m=manager('paid-manager-two','900000000029');
  point('paid-two-point',m);
  const id=order('TG-PAID-NO-ADMIN','paid-two-point','-2 minutes','paid');
  const send=sender();
  assert.equal((await sendUnpaidOrderAlert(id,'pending',null,{...send,businessChatId:''})).skipped,true);
  assert.equal(send.calls.length,0);
  assert.equal(a>0,true);
});

test('if admin send fails only that recipient may be retried, without resending others', async () => {
  isolateAdminAlerts();
  const m=manager('retry-manager','900000000030');
  point('retry-point',m);
  admin('retry-admin-a','900000000031');
  admin('retry-admin-b','900000000032');
  const id=order('TG-UNPAID-RETRY','retry-point');
  const calls=[];
  const opts={
    businessChatId:'',
    sendToChat:async(chat,text)=>{
      calls.push(chat);
      return chat==='900000000031' && calls.filter(x=>x===chat).length===1
        ? {ok:false,error:'Temporary Telegram failure'} : {ok:true};
    },
  };
  const first=await sendUnpaidOrderAlert(id,'pending',null,opts);
  assert.equal(first.sent_count,2);
  assert.equal(first.failed_count,1);
  assert.equal((await sendUnpaidOrderAlert(id,'pending',null,opts)).skipped,true);
  assert.equal(calls.length,3);
  // Make the retry due, without introducing actual waiting into the test.
  db.prepare(
    "UPDATE unpaid_order_admin_alert_log SET created_at=datetime('now','-31 seconds') " +
    "WHERE order_id=? AND target_chat_id=?"
  ).run(id,'900000000031');
  assert.ok(pendingOrderIds(opts).includes(id));
  const retry=await runUnpaidOrderAlertCheck(opts);
  assert.equal(retry.length,1);
  assert.equal(retry[0].sent_count,1);
  assert.deepEqual(calls,['900000000030','900000000031','900000000032','900000000031']);
  assert.equal((await runUnpaidOrderAlertCheck(opts)).length,0);
});

test('canceled payment reaches administrator immediately, only once per type', async () => {
  isolateAdminAlerts();
  admin('failed-payment-admin','900000000033');
  const id=order('TG-FAILED-ADMIN','unassigned-failed-point','-10 seconds','failed','released');
  const send=sender();
  const opts={...send,businessChatId:''};
  const result=await sendUnpaidOrderAlert(id,'failed','ЮKassa: отмена',opts);
  assert.equal(result.admin_sent,true);
  assert.match(send.calls[0].message,/Платёж не состоялся/);
  assert.match(send.calls[0].message,/Причина: ЮKassa: отмена/);
  assert.equal((await sendUnpaidOrderAlert(id,'failed','ЮKassa: отмена',opts)).skipped,true);
  assert.equal(send.calls.length,1);
});


test('pending-order polling uses a partial index instead of scanning paid order history',()=>{
  const row=db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_orders_pending_notification_scan'"
  ).get();
  assert.ok(row?.sql,'expected the partial index for the 15-second poller');
  assert.match(row.sql,/WHERE status='pending' AND reservation_status='active'/);
  // The indexed condition matches the actual scheduled query verbatim.
  assert.ok(!row.sql.includes("status='paid'"));
});
