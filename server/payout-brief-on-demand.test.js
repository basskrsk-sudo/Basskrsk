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
  assert.match(personal,/renderPayoutBriefPdf\(report, \{ recipient: person \}\)/);
  assert.match(src,/if\(type==='payoutpdf'\)return sendIndividualPayoutPdf\(chatId,params\)/);
  assert.match(src,/show_alert:!allowed/,'only an authorized private admin may request a payee');
});
