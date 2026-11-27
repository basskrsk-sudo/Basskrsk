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
  assert.match(personal,/collectPayoutBrief\(new Date\(\), \{recipientKey:params.recipientKey,monthly:true\}\)/);
  assert.match(personal,/renderPayoutBriefPdf\(report, \{ recipient: person \}\)/);
  assert.match(src,/if\(type==='payoutpdf'\)return sendIndividualPayoutPdf\(chatId,params\)/);
  assert.match(src,/show_alert:!allowed/,'only an authorized private admin may request a payee');
});

test('all-time debts are an approved, read-only report without monthly PDF selection',()=>{
  const src=fs.readFileSync(path.join(__dirname,'telegram-login-poller.js'),'utf8');
  const debts=src.split('async function sendAllTimeDebtReport(chatId) {')[1]
    .split('async function sendIndividualPayoutPdf(')[0];
  assert.ok(debts.includes('adminCanReadSales(chatId)'));
  assert.ok(debts.includes('collectPayoutBrief(new Date(),{monthly:false})'));
  assert.ok(debts.includes('buildPayoutBriefCsv(report)'));
  assert.ok(debts.includes('includePersonalPdf:false'));
  assert.ok(!debts.includes('payoutBriefMenu('));
  assert.ok(!debts.includes('registerPayoutBrief('));
  assert.ok(src.includes("if(type==='debts')return sendAllTimeDebtReport(chatId)"));
  assert.ok(src.includes("requestBotReport(msg.chat.id,'debts')"));
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
const testCycle=require('./payout-brief').monthlyPayoutPeriod(new Date());
const bonusDate=testCycle.start.slice(0,19).replace('T',' ');
const bonusId=Number(db.prepare('INSERT INTO manager_points(manager_id,point_id,point_name,point_type,commission_rate,bonus_paid,bonus_manager_amount,bonus_accrued_at,referred_groomer_id,referred_groomer_amount,referred_owner_id,referred_owner_amount,referral_bonus_accrued_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
 .run(managerId,'payout-point','Тестовый салон','Груминг',0.07,1,2000,bonusDate,partnerId,1000,ownerId,1000,bonusDate).lastInsertRowid);
function sale(code,amount,refund=0){
 const id=Number(db.prepare('INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,point_id,partner_id,subtotal,total,payment_method,status,commission_rate,refund_status,refunded_amount) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(code,'Клиент','79001112233','Тестовый салон','payout-point',partnerId,amount,amount,'sbp','paid',0.2,refund?'partial':'none',refund).lastInsertRowid);
 const cycle=require('./payout-brief').monthlyPayoutPeriod(new Date());
 db.prepare('UPDATE orders SET created_at=? WHERE id=?').run(cycle.start.slice(0,19).replace('T',' '),id);
 return id;
}
const tables=['partner_payouts','owner_payouts','manager_commission_payouts','manager_launch_bonus_payouts','referral_bonus_payouts','payout_reports'];
const counts=()=>tables.map(t=>db.prepare('SELECT COUNT(*) n FROM '+t).get().n);
function reportNow(){const report=collectPayoutBrief(new Date(),{monthly:true});const person=report.people.find(p=>p.roles.includes('partner')&&p.roles.includes('owner')&&p.roles.includes('manager'));assert.ok(person);return{report,person};}
function draft(){const {report,person}=reportNow();return{person,...confirmations.registerPayoutBrief('777001',person,report.generated_at)};}
const act=(id,action,chat='777001')=>confirmations.handlePayoutConfirmation(chat,'payout:'+action+':'+id);
test('PDF payout confirmation is bound to an active admin, and cancel never records money',()=>{
 db.prepare("UPDATE partners SET payout_method='sbp' WHERE id=?").run(partnerId);
 db.prepare("UPDATE salon_owners SET payout_method='bank_account' WHERE id=?").run(ownerId);
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
 assert.match(prompt.message,/СБП на номер телефона/);assert.match(prompt.message,/Безналичный расчёт по договору/);
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
 assert.equal(db.prepare('SELECT payout_method FROM partner_payouts ORDER BY id DESC LIMIT 1').get().payout_method,'sbp');
 assert.equal(db.prepare('SELECT payout_method FROM owner_payouts ORDER BY id DESC LIMIT 1').get().payout_method,'bank_account');
 assert.deepEqual(db.prepare('SELECT payout_method FROM referral_bonus_payouts WHERE manager_point_id=? ORDER BY role').all(bonusId).map(r=>r.payout_method),['bank_account','sbp']);
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
  assert.match(prompt.body.reply_markup.inline_keyboard[0][0].callback_data,/^payout:confirm:/);
  const mobile=prompt.body.reply_markup.inline_keyboard.flat().find(b=>b.callback_data.startsWith('payout:confirm-mobile_balance:'));
  assert.ok(mobile,'mobile balance must be available in the actual Telegram keyboard');
  assert.match(mobile.text,/Пополнение баланса мобильного телефона/);
  assert.ok(Buffer.byteLength(mobile.callback_data)<=64);
  const confirm=mobile.callback_data;
  assert.deepEqual(counts(),before);
  await callback(confirm);
  assert.match(calls.filter(c=>c.method==='sendMessage').at(-1).body.text,/Выплачено и зафиксировано/);
  for(const table of ['partner_payouts','owner_payouts','manager_commission_payouts'])assert.equal(db.prepare('SELECT payout_method FROM '+table+' ORDER BY id DESC LIMIT 1').get().payout_method,'mobile_balance');
  assert.ok(calls.some(c=>c.method==='editMessageReplyMarkup'));
  const completed=counts();
  await callback(confirm);
  assert.deepEqual(counts(),completed);
 }finally{global.fetch=oldFetch;pdf.renderPayoutBriefPdf=oldRender;}
});
test('refund of previously paid order is offset once in the next confirmed combined PDF',()=>{
 const old=db.prepare("SELECT id FROM orders WHERE order_code='CONFIRM-FIRST'").get().id;
 db.prepare("UPDATE orders SET refund_status='refunded',refunded_amount=1000 WHERE id=?").run(old);
 sale('CONFIRM-NEXT-REFUND',2000);
 const {person,id}=draft();
 assert.equal(person.total,320);
 assert.equal(person.statements.reduce((n,s)=>n+(s.refund_adjustments||[]).reduce((m,x)=>m+x.amount,0),0),320);
 const before=db.prepare('SELECT COUNT(*) n FROM commission_refund_offsets').get().n;
 assert.equal(act(id,'paid').ok,true);
 const result=act(id,'confirm');
 assert.equal(result.ok,true,result.message);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM commission_refund_offsets').get().n,before+3);
 assert.match(act(id,'confirm').message,/уже зафиксирована/);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM commission_refund_offsets').get().n,before+3);
 sale('CONFIRM-AFTER-OFFSET',1000);
 assert.equal(reportNow().person.total,320,'recovered commission never deducted again');
});
test('administrator can explicitly confirm a different actual method for a combined payment',()=>{
 const {id,person}=draft();
 assert.ok(person.total>0);
 assert.equal(act(id,'paid').ok,true);
 assert.equal(act(id,'confirm-cash','777002').ok,false);
 const result=act(id,'confirm-cash');
 assert.equal(result.ok,true,result.message);
 for(const table of ['partner_payouts','owner_payouts','manager_commission_payouts'])assert.equal(db.prepare('SELECT payout_method FROM '+table+' ORDER BY id DESC LIMIT 1').get().payout_method,'cash');
 assert.equal(db.prepare('SELECT payout_method FROM partners WHERE id=?').get(partnerId).payout_method,'sbp');
 assert.equal(db.prepare('SELECT payout_method FROM salon_owners WHERE id=?').get(ownerId).payout_method,'bank_account');
 const count=counts();assert.match(act(id,'confirm-sbp').message,/уже зафиксирована/);assert.deepEqual(counts(),count);
});
test.after(()=>{try{db.close();}catch(_){}fs.rmSync(process.env.DATA_DIR,{recursive:true,force:true});});


// Reference implementation frozen from the former report grouping. Compare
// full group contents and warning order, not merely the totals.
function legacyGroups(entries){
  const {sameRecipient,clean}=require('./payout-brief');
  const people=[];
  for(const entry of entries){
    const matches=people.filter(person=>person.accounts.some(other=>sameRecipient(other,entry.account)));
    if(!matches.length){
      people.push({name:clean(entry.account.full_name),accounts:[entry.account],statements:[entry.statement]});
      continue;
    }
    const primary=matches[0];
    primary.accounts.push(entry.account);primary.statements.push(entry.statement);
    for(const extra of matches.slice(1)){
      primary.accounts.push(...extra.accounts);primary.statements.push(...extra.statements);
      people.splice(people.indexOf(extra),1);
    }
  }
  return people;
}
function legacyWarnings(entries){
  const {sameRecipient,clean}=require('./payout-brief');
  const norm=value=>clean(value,200).toLowerCase().replace(/ё/g,'е')
    .replace(/[^\p{L}\p{N} ]/gu,'').split(/\s+/).filter(Boolean).sort().join('|');
  const labels=[];
  for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++){
    const a=entries[i].account,b=entries[j].account;
    if(a.role===b.role)continue;
    if(norm(a.full_name)===norm(b.full_name)&&!sameRecipient(a,b)){
      const label=clean(a.full_name,60);
      if(!labels.includes(label))labels.push(label);
    }
  }
  return labels;
}
test('indexed identity candidates preserve exact legacy grouping, bridging and warning order',()=>{
  const {groupRecipientEntries,identitiesToVerify}=require('./payout-brief');
  const roles=['partner','owner','manager'];
  function make(id,role,full_name,phone,telegram_chat_id,inn){
    return {account:{id,role,full_name,phone,telegram_chat_id,inn},statement:{...statement(role,id+1),account_id:id}};
  }
  const bridge=[
    make(1,'partner','Иван Иванов','+7 (999) 111-22-33',null,null),
    make(2,'owner','Другое имя',null,'7771234',null),
    make(3,'manager','Иванов Иван','89991112233','7771234',null),
    make(4,'owner','Иван Иванов','79990000001',null,null),
    make(5,'partner','Другое имя','79990000001',null,null),
    make(6,'manager','Иван Иванов',null,null,'123456789012'),
    make(7,'owner','Иванов Иван Петрович',null,null,'123456789012'),
    make(8,'partner','',null,null,null),
    make(9,'owner','',null,null,null),
    make(10,'manager','Иван Иванов',null,'invalid','invalid'),
  ];
  const groups=groupRecipientEntries(bridge);
  assert.deepEqual(groups,legacyGroups(bridge));
  assert.deepEqual(groups[0].accounts.map(a=>a.id),[1,3,2]);
  assert.deepEqual(identitiesToVerify(bridge),legacyWarnings(bridge));
  let seed=113;
  function next(n){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;}
  const names=['Иван Иванов','Иванов Иван','Иван','Иван Иван','Иван Иванов Петрович','Пётр Сидоров','Петр Сидоров','','Анна Петрова'];
  for(let run=0;run<20;run++){
    const entries=Array.from({length:90},(_,i)=>make(i+1,roles[next(3)],names[next(names.length)],
      [null,'+7 999 111 22 33','89991112233','79990000001','x'][next(5)],
      [null,'7771234','7771235','bad'][next(4)],
      [null,'123456789012','1234567890','bad'][next(4)]));
    assert.deepEqual(groupRecipientEntries(entries),legacyGroups(entries));
    assert.deepEqual(identitiesToVerify(entries),legacyWarnings(entries));
  }
});
test('large recipient directory avoids all-pairs matching without changing report identity',()=>{
  const {groupRecipientEntries,identitiesToVerify}=require('./payout-brief');
  const {performance}=require('node:perf_hooks');
  const entries=Array.from({length:1000},(_,i)=>{
    const role=['partner','owner','manager'][i%3];
    return {account:{id:i+1,role,full_name:'Получатель '+i,phone:String(79000000000+i)},
      statement:{...statement(role,100),account_id:i+1}};
  });
  let t=performance.now();
  const before=legacyGroups(entries),warnings=legacyWarnings(entries);
  const previous=performance.now()-t;
  t=performance.now();
  const after=groupRecipientEntries(entries),nextWarnings=identitiesToVerify(entries);
  const current=performance.now()-t;
  assert.deepEqual(after,before);assert.deepEqual(nextWarnings,warnings);
  assert.equal(after.length,1000);
  console.log('[payout-identities] 1000 recipients: old='+previous.toFixed(2)+'ms indexed='+current.toFixed(2)+'ms');
});
test('very long all-time periods do not spread timestamps into function arguments',()=>{
  const {personPeriod}=require('./payout-brief');
  const sales=Array(150000).fill({created_at:'2026-10-01 07:00:00'});
  sales.push({created_at:'2026-11-26 07:00:00'});
  const period=personPeriod([{sales,bonuses:[{accrued_at:'2026-09-01 07:00:00'}]}]);
  assert.equal(period.label,'01.09.2026 — 26.11.2026');
});
