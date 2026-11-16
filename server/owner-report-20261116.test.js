'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const os=require('node:os');
const fs=require('node:fs');
const path=require('node:path');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-owner-archive-test-'));
process.env.TG_TOKEN='test-telegram-owner-report-token';

const db=require('./db');
const report=require('./owner-report-20261116');
const poller=require('./telegram-login-poller');
let currentId=0;
function admin(chat,role='super',active=1){
  currentId++;
  db.prepare("INSERT INTO admins(login,password_hash,role,active,telegram_chat_id) VALUES(?,?,?,?,?)")
    .run('owner-pdf-admin-'+currentId,'test-hash',role,active,String(chat));
}

admin('9111101','super',1);
admin('9111102','admin',1);
admin('9111103','super',0);

test('historical snapshot is fixed to 16 Nov 2026 and has six pages of source-based figures',()=>{
  assert.equal(report.FILE_NAME,'HvostMarket_Otchet_Sobstvennikam_16-11-2026.pdf');
  assert.equal(report.REPORT_DATE,'16.11.2026');
  const pages=report.buildOwnerReportPages('/usr/share/fonts/dejavu/DejaVuSans.ttf');
  assert.equal(pages.length,6);
  for(const p of pages){
    assert.match(p,/push graphic-context/);
    assert.match(p,/pop graphic-context/);
    assert.doesNotMatch(p,/undefined|NaN/);
  }
  assert.match(pages[0],/11 500 ₽/);
  assert.match(pages[1],/Sir Barsik/);
  assert.match(pages[4],/100[\s\u00a0\u202f]000/);
  assert.match(pages[5],/30 дней/);
});

test('historical PDF never goes to group, customer, ordinary admin or mismatched sender',async()=>{
  for(const [chat,sender] of [
    ['9111104','9111104'],['9111102','9111102'],
    ['9111103','9111103'],['9111101','9111109'],
    ['-100120130','-100120130'],
    ['9111101',''],['','9111101']
  ]){
    assert.equal(report.mayReadOwnerReport(chat,sender),false);
    const result=await report.sendOwnerReport(chat,sender,{
      renderPdf:async()=>{throw Error('should not render');},
      uploadPdf:async()=>{throw Error('should not send');},
    });
    assert.equal(result.ok,false);
    assert.match(result.message,/только привязанному супер-администратору/);
  }
  assert.equal(report.mayReadOwnerReport('9111101','9111101'),true);
});

test('linked super-admin can receive a single PDF with correct filename in private Telegram',async()=>{
  const buffer=Buffer.from('%PDF-1.4\nTEST PDF\n');
  const sent=[];
  const result=await report.sendOwnerReport('9111101','9111101',{
    renderPdf:async()=>buffer,
    uploadPdf:async(chat,doc)=>{sent.push({chat,doc});return {message_id:991};},
  });
  assert.equal(result.ok,true);
  assert.equal(sent.length,1);
  assert.equal(sent[0].chat,'9111101');
  assert.deepEqual(sent[0].doc,buffer);
  assert.match(result.message,/отправлен в этот чат/);
});

test('failed upload does not falsely claim that the file was delivered',async()=>{
  const r=await report.sendOwnerReport('9111101','9111101',{
    renderPdf:async()=>Buffer.from('%PDF test'),
    uploadPdf:async()=>{throw new Error('Telegram API: no access');}
  });
  assert.equal(r.ok,false);
  assert.match(r.message,/Не удалось отправить/);
});

test('Telegram sendDocument uses a PDF attachment and a date-specific caption',async()=>{
  const calls=[];
  const result=await report.uploadPdf('9111101',Buffer.from('%PDF example'),async(url,opts)=>{
    calls.push({url,opts});
    return {ok:true,status:200,json:async()=>({ok:true,result:{message_id:992}})};
  },'mock-bot-token');
  assert.equal(result.message_id,992);
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://api.telegram.org/botmock-bot-token/sendDocument');
  assert.equal(calls[0].opts.method,'POST');
  const form=calls[0].opts.body;
  assert.equal(form.get('chat_id'),'9111101');
  assert.equal(form.get('document').type,'application/pdf');
  assert.equal(form.get('document').name,report.FILE_NAME);
  assert.match(form.get('caption'),/16\.11\.2026/);
});

test('visible /ownerpdf command is routed only in private Telegram',async()=>{
  assert.equal(poller.TELEGRAM_BOT_COMMANDS.some(x=>x.command==='ownerpdf'),true);
  const calls=[];
  const origFetch=global.fetch;
  const originalSend=report.sendOwnerReport;
  report.sendOwnerReport=async(chat,sender)=>{
    calls.push({chat,sender});
    return {ok:true,message:'PDF test delivered'};
  };
  global.fetch=async(url,options={})=>({ok:true,status:200,
    json:async()=>({ok:true,result:{message_id:902}})});
  try{
    await poller.processUpdate({message:{
      chat:{type:'private',id:9111101},from:{id:9111101},text:'/ownerpdf'
    }});
    assert.equal(calls.length,1);
    assert.equal(String(calls[0].chat),'9111101');
    assert.equal(String(calls[0].sender),'9111101');
    await poller.processUpdate({message:{
      chat:{type:'group',id:-100101},from:{id:9111101},text:'/ownerpdf'
    }});
    assert.equal(calls.length,1);
    await poller.processUpdate({callback_query:{
      id:'test-owner-callback-1',
      from:{id:9111101},
      message:{chat:{type:'private',id:9111101}},
      data:'ownerpdf:send',
    }});
    assert.equal(calls.length,2,'super-admin button invokes real report sender');
    await poller.processUpdate({callback_query:{
      id:'test-owner-callback-2',
      from:{id:9111102},
      message:{chat:{type:'private',id:9111102}},
      data:'ownerpdf:send',
    }});
    assert.equal(calls.length,2,'ordinary admin must not invoke report sender');
    await poller.processUpdate({callback_query:{
      id:'test-owner-callback-3',
      from:{id:9111101},
      message:{chat:{type:'group',id:-100101}},
      data:'ownerpdf:send',
    }});
    assert.equal(calls.length,2,'group callbacks must not invoke report sender');
  }finally{
    report.sendOwnerReport=originalSend;
    global.fetch=origFetch;
  }
});

test.after(()=>{
  try{db.close()}catch(_){}
  fs.rmSync(process.env.DATA_DIR,{recursive:true,force:true});
});
