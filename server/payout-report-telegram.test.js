'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const { initializeReports, buildReport, saveReport } = require('./payout-reports');
const { workReportTarget, deliveryStatus, sendWorkReport } = require('./payout-report-telegram');

function fixture() {
  const db = new DatabaseSync(':memory:');
  initializeReports(db);
  const report = saveReport(db,buildReport('partner',{id:1,full_name:'Тестовый грумер',code:'QA-1'},[
    {order_code:'QA-ORDER',created_at:'2026-10-08 07:08:13',total:250,commission_rate:0.15,commission_amount:38},
  ],{start:'2026-10-01',end:'2026-10-15'}),7);
  const target={configured:true,chatId:'-100000000001',key:'test-work-target',label:'Рабочий ТГ-бот'};
  const options={confirm:true,target_key:target.key};
  const dependencies={target:()=>target,renderPdf:async()=>Buffer.from('%PDF-1.4\nTEST'),sendDocument:async()=>({ok:true,data:{ok:true,result:{message_id:123}}})};
  return {db,report,target,options,dependencies};
}
test('sends a saved PDF and caption only to the configured work-bot sender, and records delivery', async()=>{
  const f=fixture();let filename;
  f.dependencies.sendDocument=async(file,caption)=>{
    filename=file;assert.ok(fs.readFileSync(file).toString().startsWith('%PDF-'));
    assert.match(caption,/Тестовый грумер/);assert.match(caption,/2026-10-01/);assert.match(caption,/38 ₽/);
    return {ok:true,data:{ok:true,result:{message_id:123}}};
  };
  const result=await sendWorkReport(f.db,f.report,{id:7,login:'qa-admin'},f.options,f.dependencies);
  assert.equal(result.already_sent,false);assert.ok(result.sent_at);
  assert.equal(fs.existsSync(filename),false);
  const row=f.db.prepare('SELECT * FROM payout_report_deliveries').get();
  assert.equal(row.status,'sent');assert.equal(row.target_chat_id,f.target.chatId);assert.equal(row.admin_login,'qa-admin');
  assert.equal(deliveryStatus(f.db,f.report.id,f.target).status,'sent');f.db.close();
});
test('repeat clicks do not send a saved report twice',async()=>{
  const f=fixture();let sent=0;f.dependencies.sendDocument=async()=>{sent++;return {ok:true,data:{ok:true,result:{message_id:123}}};};
  await sendWorkReport(f.db,f.report,{id:7},f.options,f.dependencies);
  const repeated=await sendWorkReport(f.db,f.report,{id:7},f.options,f.dependencies);
  assert.equal(repeated.already_sent,true);assert.equal(sent,1);f.db.close();
});
test('overlapping requests cannot duplicate the upload',async()=>{
  const f=fixture();let release;const pending=new Promise(resolve=>{release=resolve;});
  f.dependencies.renderPdf=async()=>{await pending;return Buffer.from('%PDF-test');};
  const first=sendWorkReport(f.db,f.report,{id:7},f.options,f.dependencies);
  await assert.rejects(sendWorkReport(f.db,f.report,{id:7},f.options,f.dependencies),e=>e.code==='DELIVERY_PENDING');
  release();await first;f.db.close();
});
test('requires confirmation, work-bot settings and an unchanged destination',async()=>{
  const f=fixture();
  await assert.rejects(sendWorkReport(f.db,f.report,{id:7},{...f.options,confirm:false},f.dependencies),/Подтвердите/);
  await assert.rejects(sendWorkReport(f.db,f.report,{id:7},{...f.options,target_key:'other-chat'},f.dependencies),e=>e.code==='TARGET_CHANGED');
  await assert.rejects(sendWorkReport(f.db,f.report,{id:7},f.options,{...f.dependencies,target:()=>({...f.target,configured:false})}),/не настроен/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM payout_report_deliveries').get().n,0);f.db.close();
});
test('uncertain network delivery is not retried without a second explicit confirmation',async()=>{
  const f=fixture();let sent=0;f.dependencies.sendDocument=async()=>{sent++;return {ok:false,error:'timeout'};};
  await assert.rejects(sendWorkReport(f.db,f.report,{id:7},f.options,f.dependencies),e=>e.code==='DELIVERY_UNCERTAIN');
  assert.equal(deliveryStatus(f.db,f.report.id,f.target).status,'unknown');
  await assert.rejects(sendWorkReport(f.db,f.report,{id:7},f.options,f.dependencies),e=>e.code==='DELIVERY_UNCERTAIN');
  assert.equal(sent,1);
  f.dependencies.sendDocument=async()=>{sent++;return {ok:true,data:{ok:true,result:{message_id:124}}};};
  await sendWorkReport(f.db,f.report,{id:7},{...f.options,force:true},f.dependencies);
  assert.equal(sent,2);f.db.close();
});
test('PDF failure or a provider rejection does not claim that the report was sent',async()=>{
  const f=fixture();let sent=0;
  f.dependencies.renderPdf=async()=>{throw new Error('test render failure');};
  f.dependencies.sendDocument=async()=>{sent++;return {ok:false,status:403,data:{ok:false,description:'Forbidden'}};};
  await assert.rejects(sendWorkReport(f.db,f.report,{id:7},f.options,f.dependencies),/test render failure/);
  assert.equal(sent,0);assert.equal(deliveryStatus(f.db,f.report.id,f.target).status,'failed');
  f.dependencies.renderPdf=async()=>Buffer.from('%PDF-test');
  await assert.rejects(sendWorkReport(f.db,f.report,{id:7},f.options,f.dependencies),e=>e.code==='DELIVERY_FAILED');
  assert.equal(sent,1);assert.equal(deliveryStatus(f.db,f.report.id,f.target).status,'failed');f.db.close();
});
test('client-supplied chat identifiers cannot select a personal chat',async()=>{
  const f=fixture();
  await sendWorkReport(f.db,f.report,{id:7},{...f.options,chat_id:'personal-chat',recipient_id:999},f.dependencies);
  assert.equal(f.db.prepare('SELECT target_chat_id FROM payout_report_deliveries').get().target_chat_id,f.target.chatId);
  const actual=workReportTarget();assert.ok(typeof actual.key==='string');f.db.close();
});
test('owner and manager reports go through the same work-bot sender with role-specific captions',async()=>{
  for(const [role,title] of [['owner','Отчёт владельца салона'],['manager','Отчёт менеджера']]) {
    const f=fixture();f.report.role=role;
    f.dependencies.sendDocument=async(file,caption)=>{assert.ok(caption.startsWith(title));return {ok:true,data:{ok:true,result:{message_id:123}}};};
    await sendWorkReport(f.db,f.report,{id:7},f.options,f.dependencies);
    assert.equal(f.db.prepare('SELECT target_chat_id FROM payout_report_deliveries').get().target_chat_id,f.target.chatId);
    f.db.close();
  }
});
