'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hvost-payout-on-demand-'));
const { groupStatements, recipientKeyForAccounts }=require('./payout-brief');
const { payoutBriefMenu }=require('./telegram-login-poller');

function statement(role,total){
  return {role,role_label:role==='partner'?'Грумер':'Менеджер',commission:total,
    bonus:0,total,held_orders:0,held_order_ids:[],held_amount:0,sales:[],bonuses:[]};
}
test('merged roles use one opaque stable recipient key instead of a shifting list index',()=>{
  const a={id:12,role:'partner',full_name:'Иван Петров',phone:'79991234567',telegram_chat_id:'7111222'};
  const b={id:9,role:'manager',full_name:'Иван Петров',phone:'79991234567',telegram_chat_id:'7111222'};
  const grouped=groupStatements([
    {account:a,statement:statement('partner',100)},
    {account:b,statement:statement('manager',200)},
  ]);
  assert.equal(grouped.length,1);
  assert.equal(grouped[0].total,300);
  assert.equal(grouped[0].selection_key,recipientKeyForAccounts([a,b]));
  assert.equal(grouped[0].selection_key,recipientKeyForAccounts([b,a]));
  assert.match(grouped[0].selection_key,/^[0-9a-f]{16}$/);
  assert.notEqual(grouped[0].selection_key,recipientKeyForAccounts([{...b,id:11}]));
  assert.doesNotMatch(grouped[0].selection_key,/7999|7111/);
});

test('payout menu sends at most eight recipient buttons and stable pages',()=>{
  const report={people:Array.from({length:17},(_,i)=>({
    name:'Получатель номер '+(i+1),total:300+i*100,
    selection_key:String(i+1).padStart(16,'0'),
  }))};
  const first=payoutBriefMenu(report,0);
  const second=payoutBriefMenu(report,1);
  const last=payoutBriefMenu(report,99);
  assert.equal(first.reply_markup.inline_keyboard.length,9);
  assert.equal(second.reply_markup.inline_keyboard.length,9);
  assert.equal(last.reply_markup.inline_keyboard.length,2);
  assert.equal(first.reply_markup.inline_keyboard[0][0].callback_data,
    'payout:pick:0000000000000001');
  assert.equal(second.reply_markup.inline_keyboard[0][0].callback_data,
    'payout:pick:0000000000000009');
  assert.match(last.message,/3\/3/);
  for(const item of [first,second,last])
    for(const row of item.reply_markup.inline_keyboard)
      for(const button of row)assert.ok(button.callback_data.length<=64);
});

test('payout default request produces CSV and never batch-renders personal PDFs',()=>{
  const src=fs.readFileSync(path.join(__dirname,'telegram-login-poller.js'),'utf8');
  const standard=src.split('async function sendPayoutBriefs(chatId) {')[1]
    .split('async function sendIndividualPayoutPdf(')[0];
  assert.match(standard,/buildPayoutBriefCsv\(report\)/);
  assert.match(standard,/payoutBriefMenu\(report\)/);
  assert.doesNotMatch(standard,/renderPayoutBriefPdf\(/);
  assert.doesNotMatch(standard,/for \(const person of report\.people\)/);
  const personal=src.split('async function sendIndividualPayoutPdf(')[1]
    .split('function accountRoleText(')[0];
  assert.match(personal,/recipientKey/);
  assert.match(personal,/expectedTotal/);
  assert.match(personal,/collectPayoutBrief\(new Date\(\), \{recipientKey:params.recipientKey\}\)/);
  assert.match(personal,/renderPayoutBriefPdf\(report, \{ recipient: person \}\)/);
  assert.match(src,/if\(type==='payoutpdf'\)return sendIndividualPayoutPdf\(chatId,params\)/);
  assert.match(src,/show_alert:!allowed/,'only an authorized private admin may request a payee');
});

// Keep reporting imports out of the always-on HTTP and Telegram startup path.
test('large report engines load on demand rather than at server start',()=>{
  const bot=fs.readFileSync(path.join(__dirname,'telegram-login-poller.js'),'utf8');
  assert.match(bot,/const collectPayoutBrief = lazyReport\('\.\/payout-brief','collectPayoutBrief'\)/);
  assert.match(bot,/const collectBusinessYearReport = lazyReport\('\.\/business-year-report','collectBusinessYearReport'\)/);
  assert.match(bot,/const collectNoGroomerReport = lazyReport\('\.\/no-groomer-report','collectNoGroomerReport'\)/);
  assert.match(bot,/const collectSalesWeekReport = lazyReport\('\.\/sales-week-report','collectSalesWeekReport'\)/);
  assert.match(bot,/const collectWarehouseStockReport = lazyReport\('\.\/warehouse-telegram-report','collectWarehouseStockReport'\)/);
  const routes=fs.readFileSync(path.join(__dirname,'routes-weekly-reports.js'),'utf8');
  assert.match(routes,/const readComparison = \(\.\.\.args\) => require\('\.\/week-over-week'\)\.readComparison\(\.\.\.args\)/);
  assert.match(routes,/const listWeeklyReports = \(\.\.\.args\) => require\('\.\/weekly-report'\)\.listWeeklyReports\(\.\.\.args\)/);
  const approvals=fs.readFileSync(path.join(__dirname,'report-approvals.js'),'utf8');
  assert.match(approvals,/const adminCanReadSales = \(\.\.\.args\) => require\('\.\/sales-week-report'\)\.adminCanReadSales\(\.\.\.args\)/);
});

const db=require('./db');
const {collectPayoutBrief}=require('./payout-brief');
const confirmations=require('./payout-brief-confirmation');
const {processUpdate}=require('./telegram-login-poller');
const adminId=Number(db.prepare('INSERT INTO admins(login,password_hash,full_name,telegram_chat_id,role,active) VALUES(?,?,?,?,?,1)')
 .run('payout-tg','hash','Admin','777001','super').lastInsertRowid);
const otherAdminId=Number(db.prepare('INSERT INTO admins(login,password_hash,telegram_chat_id,active) VALUES(?,?,?,1)')
 .run('other-payout-tg','hash','777002').lastInsertRowid);
const name='Иван Петров',phone='79991234567';
const managerId=Number(db.prepare('INSERT INTO managers(mgr_code,login,password_hash,full_name,phone) VALUES(?,?,?,?,?)')
 .run('M-CONFIRM','manager-confirm','hash',name,phone).lastInsertRowid);
db.prepare('INSERT INTO points(id,name,addr,icon,manager_id) VALUES(?,?,?,?,?)').run('payout-point','Тестовый салон','Тестовая, 1','🐾',managerId);
const partnerId=Number(db.prepare('INSERT INTO partners(partner_code,login,password_hash,full_name,phone,point_id,point_name,commission_rate) VALUES(?,?,?,?,?,?,?,?)')
 .run('P-CONFIRM','partner-confirm','hash',name,phone,'payout-point','Тестовый салон',0.2).lastInsertRowid);
const ownerId=Number(db.prepare('INSERT INTO salon_owners(login,password_hash,full_name,phone,point_id,commission_rate) VALUES(?,?,?,?,?,?)')
 .run('owner-confirm','hash',name,phone,'payout-point',0.05).lastInsertRowid);
const bonusId=Number(db.prepare('INSERT INTO manager_points(manager_id,point_id,point_name,point_type,commission_rate,bonus_paid,bonus_manager_amount,bonus_accrued_at,referred_groomer_id,referred_groomer_amount,referred_owner_id,referred_owner_amount,referral_bonus_accrued_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
 .run(managerId,'payout-point','Тестовый салон','Груминг',0.07,1,2000,'2026-11-01 10:00:00',partnerId,1000,ownerId,1000,'2026-11-01 10:00:00').lastInsertRowid);
function sale(code,amount,refund=0){
 return Number(db.prepare('INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,point_id,partner_id,subtotal,total,payment_method,status,commission_rate,refund_status,refunded_amount) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
 .run(code,'Клиент','79001112233','Тестовый салон','payout-point',partnerId,amount,amount,'sbp','paid',0.2,refund?'partial':'none',refund).lastInsertRowid);
}
const tables=['partner_payouts','owner_payouts','manager_commission_payouts','manager_launch_bonus_payouts','referral_bonus_payouts','payout_reports'];
const counts=()=>tables.map(t=>db.prepare('SELECT COUNT(*) n FROM '+t).get().n);
function reportNow(){const report=collectPayoutBrief();const person=report.people.find(p=>p.roles.includes('partner')&&p.roles.includes('owner')&&p.roles.includes('manager'));assert.ok(person);return{report,person};}
function draft(){const {report,person}=reportNow();return{person,...confirmations.registerPayoutBrief('777001',person,report.generated_at)};}
const act=(id,action,chat='777001')=>confirmations.handlePayoutConfirmation(chat,'payout:'+action+':'+id);
test('PDF payout confirmation is bound to an active admin, and cancel never records money',()=>{
 const order=sale('CONFIRM-FIRST',3000);
 const {person,id,reply_markup}=draft();
 const held=sale('CONFIRM-REFUND',500,100);
 assert.equal(person.total,4960);
 assert.equal(reply_markup.inline_keyboard[0][0].text,'✅ Выплачено');
 assert.match(id,/^[0-9a-f]{32}$/);
 const before=counts();
 assert.equal(act(id,'confirm').ok,false,'must first click paid');
 assert.equal(act(id,'paid','777002').ok,false,'another admin cannot use this document');
 assert.equal(act(id,'paid','999999').ok,false);
 assert.equal(confirmations.registerPayoutBrief('999999',person,new Date().toISOString()),null);
 const prompt=act(id,'paid');
 assert.equal(prompt.ok,true);assert.match(prompt.message,/фактически переведены/);
 assert.equal(act(id,'cancel').ok,true);
 assert.equal(act(id,'confirm').ok,false);
 assert.deepEqual(counts(),before);
 const duplicate=draft();
 const later=sale('CONFIRM-LATER',500);
 assert.equal(act(id,'paid').ok,true);
 confirmations.rememberDocument('777001',id,1234);
 const result=act(id,'confirm');
 assert.equal(result.ok,true,result.message);
 assert.match(result.message,/Выплачено и зафиксировано/);
 assert.equal(result.documentMessageId,1234);
 assert.deepEqual(counts().map((n,i)=>n-before[i]),[1,1,1,1,2,6]);
 for(const [table,amount] of [['partner_payouts',600],['owner_payouts',150],['manager_commission_payouts',210],['manager_launch_bonus_payouts',2000]]){
  const row=db.prepare('SELECT amount,paid_by_admin_id,paid_by_admin_login FROM '+table+' ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.amount,amount);assert.equal(row.paid_by_admin_id,adminId);assert.equal(row.paid_by_admin_login,'payout-tg');
 }
 for(const table of ['partner_payout_items','owner_payout_items','manager_commission_payout_items']){
  assert.deepEqual(db.prepare('SELECT order_id FROM '+table).all().map(r=>r.order_id),[order]);
  assert.ok(!db.prepare('SELECT 1 FROM '+table+' WHERE order_id=?').get(later));
  assert.ok(!db.prepare('SELECT 1 FROM '+table+' WHERE order_id=?').get(held));
 }
 assert.equal(db.prepare('SELECT COUNT(*) n FROM referral_bonus_payouts WHERE manager_point_id=?').get(bonusId).n,2);
 const completed=counts();
 assert.match(act(id,'confirm').message,/уже зафиксирована/);
 assert.equal(act(duplicate.id,'paid').ok,true);
 assert.equal(act(duplicate.id,'confirm').ok,false);
 assert.deepEqual(counts(),completed);
 assert.equal(reportNow().person.total,288,'later order and net partial return remain payable');
});
test('a stale rate rolls back all roles even if a preceding role has already written',()=>{
 const {id}=draft();
 const before=counts();
 assert.equal(act(id,'paid').ok,true);
 db.prepare('UPDATE salon_owners SET commission_rate=0.06 WHERE id=?').run(ownerId);
 try{
  const result=act(id,'confirm');
  assert.equal(result.ok,false);
  assert.match(result.message,/изменились/);
  assert.deepEqual(counts(),before,'no partial payout or report survives');
 }finally{db.prepare('UPDATE salon_owners SET commission_rate=0.05 WHERE id=?').run(ownerId);}
});
test('refund after PDF or deactivation of admin blocks confirmation',()=>{
 const {id}=draft(),before=counts();
 assert.equal(act(id,'paid').ok,true);
 db.prepare("UPDATE admins SET active=0 WHERE id=?").run(adminId);
 try{assert.equal(act(id,'confirm').ok,false);}finally{db.prepare('UPDATE admins SET active=1 WHERE id=?').run(adminId);}
 db.prepare("UPDATE orders SET refunded_amount=1,refund_status='partial' WHERE order_code='CONFIRM-LATER'").run();
 try{assert.equal(act(id,'confirm').ok,false);assert.deepEqual(counts(),before);}
 finally{db.prepare("UPDATE orders SET refunded_amount=0,refund_status='none' WHERE order_code='CONFIRM-LATER'").run();}
});
test('PDF document has a real Telegram keyboard and payment callback is private, authorized, audited',async()=>{
 const {report,person}=reportNow();
 const params={recipientKey:person.selection_key,recipientName:person.name,expectedTotal:person.total};
 const reqId=Number(db.prepare("INSERT INTO report_approval_requests(chat_id,report_type,params_json) VALUES(?,'payoutpdf',?)").run('777001',JSON.stringify(params)).lastInsertRowid);
 const oldFetch=global.fetch,pdf=require('./payout-brief-pdf'),oldRender=pdf.renderPayoutBriefPdf;
 const calls=[];
 pdf.renderPayoutBriefPdf=async()=>Buffer.from('%PDF-1.4');
 global.fetch=async(url,opts)=>{
  const method=String(url).split('/').pop();
  const body=opts.body instanceof FormData?{markup:opts.body.get('reply_markup'),filename:opts.body.get('document')?.name}:JSON.parse(opts.body);
  calls.push({method,body});
  return {ok:true,status:200,json:async()=>({ok:true,result:{message_id:1001}})};
 };
 const callback=(data,chat='777001',type='private',from=chat)=>processUpdate({callback_query:{id:'cb-test',data,from:{id:Number(from)},message:{message_id:1001,chat:{id:Number(chat),type}}}});
 try{
  await callback('report:yes:'+reqId);
  const document=calls.find(c=>c.method==='sendDocument');
  assert.ok(document);
  assert.match(document.body.filename,/\.pdf$/);
  const button=JSON.parse(document.body.markup).inline_keyboard[0][0];
  assert.equal(button.text,'✅ Выплачено');
  const before=counts();
  await callback(button.callback_data,'777001','group');
  await callback(button.callback_data,'777002','private');
  assert.deepEqual(counts(),before);
  await callback(button.callback_data);
  const prompt=calls.filter(c=>c.method==='sendMessage').at(-1);
  const confirm=prompt.body.reply_markup.inline_keyboard[0][0].callback_data;
  assert.match(confirm,/^payout:confirm:/);
  assert.deepEqual(counts(),before);
  await callback(confirm);
  assert.match(calls.filter(c=>c.method==='sendMessage').at(-1).body.text,/Выплачено и зафиксировано/);
  assert.ok(calls.some(c=>c.method==='editMessageReplyMarkup'));
  const completed=counts();
  await callback(confirm);
  assert.deepEqual(counts(),completed);
 }finally{global.fetch=oldFetch;pdf.renderPayoutBriefPdf=oldRender;}
});
test.after(()=>{try{db.close();}catch(_){}fs.rmSync(process.env.DATA_DIR,{recursive:true,force:true});});
