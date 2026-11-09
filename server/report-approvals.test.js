'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-report-approval-'));
delete process.env.TG_CHAT_ID;
const db=require('./db');
const approvals=require('./report-approvals');
function admin(login,chat,role='admin'){
  db.prepare('INSERT INTO admins(login,password_hash,telegram_chat_id,role,active) VALUES(?,?,?,?,1)')
    .run(login,'test',chat,role);
}
admin('report-admin-1','70001');
admin('report-super-1','70002','super');
const prompts=[];
const send=async(chat,text,options)=>{
  prompts.push({chat,text,buttons:options.reply_markup});
  return {ok:true,data:{ok:true}};
};
test('no PDF/CSV is generated until matching authenticated Telegram approval',async()=>{
  const approval=await approvals.requestReport('70001','salesweek',{},send);
  assert.equal(approval.ok,true);
  assert.equal(prompts.length,1);
  assert.equal(prompts[0].buttons.inline_keyboard[0][0].callback_data,'report:yes:'+approval.id);
  assert.equal(db.prepare('SELECT status FROM report_approval_requests WHERE id=?').get(approval.id).status,'pending');
  assert.equal(approvals.decideReport('70002','yes',approval.id).ok,false);
  const claimed=approvals.decideReport('70001','yes',approval.id);
  assert.equal(claimed.ok,true);
  assert.equal(claimed.request.type,'salesweek');
  assert.equal(approvals.decideReport('70001','yes',approval.id).ok,false);
  approvals.finishReport(approval.id,true);
  assert.equal(db.prepare('SELECT status FROM report_approval_requests WHERE id=?').get(approval.id).status,'done');
});
test('reject/expired/disabled accounts cannot start report generation',async()=>{
  assert.equal((await approvals.requestReport('73333','salesweek',{},send)).ok,false);
  assert.equal((await approvals.requestReport('70001','qrweek',{},send)).ok,false);
  const superQr=await approvals.requestReport('70002','qrweek',{},send);
  assert.equal(superQr.ok,true);
  assert.equal(approvals.decideReport('70002','no',superQr.id).cancelled,true);
  assert.equal(approvals.decideReport('70002','yes',superQr.id).ok,false);
  const expired=await approvals.requestReport('70001','payouts',{},send);
  db.prepare("UPDATE report_approval_requests SET expires_at=datetime('now','-1 minute') WHERE id=?")
    .run(expired.id);
  assert.equal(approvals.decideReport('70001','yes',expired.id).ok,false);
  const pending=await approvals.requestReport('70001','business',{},send);
  db.prepare('UPDATE admins SET active=0 WHERE telegram_chat_id=?').run('70001');
  assert.equal(approvals.decideReport('70001','yes',pending.id).ok,false);
});
test('unapproved work is cancelable, with per-chat isolation',async()=>{
  const one=await approvals.requestReport('70002','gdweek',{start:'2026-11-02',end:'2026-11-08'},send);
  assert.equal(one.ok,true);
  assert.equal(approvals.cancelPendingReports('77777'),false);
  assert.equal(approvals.cancelPendingReports('70002'),true);
  assert.equal(approvals.decideReport('70002','yes',one.id).ok,false);
});
