'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-expense-telegram-files-'));
process.env.TG_TOKEN='test-telegram-token';
const db=require('./db');
const flow=require('./expense-bot-create');
const {handleExpenseAttachmentMessage,processPendingExpenseAttachments,readTelegramFile}=require('./expense-bot-files');
const {DOCUMENT_DIR,MAX_FILE_BYTES}=require('./expense-documents');

const chat='640010002';
db.prepare('INSERT INTO task_assignees(code,full_name,telegram_chat_id,active) VALUES(?,?,?,1)')
  .run('HM-EXPENSE-TEST','Тестовый сотрудник',chat);
const fileId='AgACAgIAAxkBAAIBdummyTelegramFileId0001';
const jpg=Buffer.from([0xff,0xd8,0xff,0xe0,10,9,8,7,6]);
const pdf=Buffer.from('%PDF-1.7\n1 0 obj<<>>\n%%EOF','utf8');

function createExpense() {
  assert.equal(flow.startExpenseCreation('telegram',chat).ok,true);
  assert.equal(flow.handleExpenseMessage('telegram',chat,'04.11.2026').ok,true);
  assert.equal(flow.handleExpenseCallback('telegram',chat,'expense:investor:vitaly').ok,true);
  assert.equal(flow.handleExpenseMessage('telegram',chat,'495').ok,true);
  assert.equal(flow.handleExpenseMessage('telegram',chat,'Доставка лакомств от 02.11.26').ok,true);
  return flow.handleExpenseCallback('telegram',chat,'expense:confirm');
}
function telegramFetcher(binary,filepath='photos/file_0.jpg',options={}) {
  const calls=[];
  async function request(url) {
    calls.push(String(url));
    if(String(url).endsWith('/getFile')){
      if(options.onGetFile)options.onGetFile();
      return {ok:true,json:async()=>({ok:true,result:{file_path:filepath,file_size:binary.length}})};
    }
    if(String(url).includes('/file/bot')){
      if(options.onDownload)options.onDownload();
      return {ok:true,headers:{get:()=>String(binary.length)},
        body:null,arrayBuffer:async()=>binary};
    }
    throw Error('Unexpected mock Telegram endpoint: '+url);
  }
  return {request,calls};
}
function photoMessage(id=1001){return {
  chat:{id:Number(chat),type:'private'},message_id:id,
  photo:[{file_id:fileId,file_size:jpg.length,width:640,height:480}],
};}
function docMessage(name='Доставка.pdf'){return {
  chat:{id:Number(chat),type:'private'},message_id:1020,
  document:{file_id:fileId,file_name:name,file_size:pdf.length},
};}
test('bot records expense only once and opens a private receipt upload phase',()=>{
  const saved=createExpense();
  assert.equal(saved.ok,true);
  assert.equal(saved.created,true);
  assert.match(saved.message,/Трата записана/);
  assert.match(saved.message,/скрепку/);
  assert.match(JSON.stringify(saved.replyMarkup),/expense:attach:done:/);
  const row=db.prepare('SELECT * FROM expenses WHERE id=?').get(saved.expenseId);
  assert.equal(row.amount,495);
  assert.equal(row.investor_name,'Соколов Виталий');
  assert.equal(row.category,'Доставка лакомств от 02.11.26');
  const draft=db.prepare('SELECT * FROM expense_bot_drafts WHERE chat_id=?').get(chat);
  assert.equal(draft.step,'attach');
  assert.equal(draft.expense_id,saved.expenseId);
  const duplicate=flow.handleExpenseCallback('telegram',chat,'expense:confirm');
  assert.equal(duplicate.created,false,'replayed confirm must not create another expense');
  assert.equal(duplicate.expenseId,saved.expenseId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM expenses WHERE amount=495').get().n,1);
});
test('private Telegram photos and PDF documents attach to the saved expense and deduplicate',async()=>{
  const expenseId=db.prepare('SELECT expense_id FROM expense_bot_drafts WHERE chat_id=?').get(chat).expense_id;
  const f=telegramFetcher(jpg);
  const first=await handleExpenseAttachmentMessage('telegram',chat,photoMessage(),f.request);
  assert.equal(first.ok,true,first.message);
  assert.equal(first.attached,true);
  assert.match(first.message,/Чек-фото-1001\.jpg/);
  const duplicate=await handleExpenseAttachmentMessage('telegram',chat,photoMessage(),f.request);
  assert.equal(duplicate.ok,true);
  assert.match(duplicate.message,/уже прикреплён/);
  const p=telegramFetcher(pdf,'documents/file_7.pdf');
  const second=await handleExpenseAttachmentMessage('telegram',chat,docMessage(),p.request);
  assert.equal(second.ok,true,second.message);
  assert.equal(flow.attachmentCount(expenseId),2);
  const files=db.prepare('SELECT * FROM expense_documents WHERE expense_id=? ORDER BY id').all(expenseId);
  assert.equal(files[0].uploaded_by_role,'task_assignee');
  assert.ok(files[0].storage_name!==files[0].filename);
  assert.equal(files[1].filename,'Доставка.pdf');
  for(const row of files){
    assert.ok(fs.existsSync(path.join(DOCUMENT_DIR,row.storage_name)));
    assert.ok(row.sha256.length===64);
  }
  assert.equal(path.resolve(DOCUMENT_DIR).startsWith(path.resolve(__dirname,'../public')),false);
  assert.equal(p.calls.length,2);
});
test('the expense session is isolated to its original verified chat',async()=>{
  const fetcher=telegramFetcher(jpg);
  const other=await handleExpenseAttachmentMessage('telegram','998874',photoMessage(2002),fetcher.request);
  assert.equal(other,null);
  assert.equal(fetcher.calls.length,0,'must not download a file from another chat');
  assert.equal(flow.handleExpenseCallback('telegram','998874','expense:attach:done:1').ok,false);
  const before=flow.attachmentCount(db.prepare('SELECT expense_id FROM expense_bot_drafts WHERE chat_id=?').get(chat).expense_id);
  const malicious=await handleExpenseAttachmentMessage('telegram',chat,docMessage('payload.exe'),
    telegramFetcher(pdf,'documents/file_9.exe').request);
  assert.equal(malicious.ok,false);
  assert.match(malicious.message,/Формат|соответствует/);
  assert.equal(flow.attachmentCount(db.prepare('SELECT expense_id FROM expense_bot_drafts WHERE chat_id=?').get(chat).expense_id),before);
});
test('oversized attachment is rejected before calling Telegram Bot API',async()=>{
  const fetcher=telegramFetcher(jpg);
  const big={...photoMessage(),photo:[{file_id:fileId,file_size:MAX_FILE_BYTES+1}]};
  const result=await handleExpenseAttachmentMessage('telegram',chat,big,fetcher.request);
  assert.equal(result.ok,false);
  assert.match(result.message,/10 МБ/);
  assert.equal(fetcher.calls.length,0);
});
test('Telegram file path traversal is rejected and no remote download attempted',async()=>{
  const f=telegramFetcher(pdf,'../data/secrets.txt');
  await assert.rejects(readTelegramFile(fileId,'Доставка.pdf',pdf.length,f.request),/путь/);
  assert.equal(f.calls.length,1);
});
test('if access is revoked during download, receipt is not stored',async()=>{
  const expenseId=db.prepare('SELECT expense_id FROM expense_bot_drafts WHERE chat_id=?').get(chat).expense_id;
  const before=flow.attachmentCount(expenseId);
  const get=telegramFetcher(jpg,'photos/file_8.jpg',{
    onDownload(){db.prepare('UPDATE task_assignees SET active=0 WHERE telegram_chat_id=?').run(chat);}
  });
  const result=await handleExpenseAttachmentMessage('telegram',chat,photoMessage(1002),get.request);
  assert.equal(result.ok,false);
  assert.match(result.message,/Сессия/);
  assert.equal(flow.attachmentCount(expenseId),before);
  db.prepare('UPDATE task_assignees SET active=1 WHERE telegram_chat_id=?').run(chat);
});
test('finished upload mode is closed; receipt photos do not create a new expense',async()=>{
  const id=db.prepare('SELECT expense_id FROM expense_bot_drafts WHERE chat_id=?').get(chat).expense_id;
  const help=flow.handleExpenseCallback('telegram',chat,'expense:attach:help:'+id);
  assert.equal(help.ok,true);
  assert.match(help.message,/скрепку/);
  const done=flow.handleExpenseCallback('telegram',chat,'expense:attach:done:'+id);
  assert.equal(done.ok,true);
  assert.match(done.message,/Подтверждающих документов: 2/);
  const after=await handleExpenseAttachmentMessage('telegram',chat,photoMessage(3333),telegramFetcher(jpg).request);
  assert.equal(after,null);
  assert.equal(flow.handleExpenseCallback('telegram',chat,'expense:attach:done:'+id).ok,false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM expenses WHERE amount=495').get().n,1);
});
test('Telegram polling routes a photo to expense storage and replies in the private chat',async()=>{
  // A fresh expense session proves integration with the actual Telegram
  // getUpdates message dispatcher rather than only the isolated upload helper.
  const saved=createExpense();
  const {processUpdate}=require('./telegram-login-poller');
  const originalFetch=global.fetch;
  const calls=[];
  global.fetch=async(url,opts)=>{
    calls.push(String(url));
    if(String(url).endsWith('/getFile'))return {
      ok:true,json:async()=>({ok:true,result:{file_path:'photos/file_13.jpg',file_size:jpg.length}})};
    if(String(url).includes('/file/bot'))return {
      ok:true,headers:{get:()=>String(jpg.length)},arrayBuffer:async()=>jpg,body:null};
    if(String(url).endsWith('/sendMessage'))return {ok:true,json:async()=>({ok:true,result:{}})};
    throw Error('Unexpected poller API call: '+url);
  };
  try {
    await processUpdate({message:photoMessage(1123)});
  }finally{global.fetch=originalFetch;}
  assert.equal(flow.attachmentCount(saved.expenseId),1);
  assert.ok(calls.some(url=>url.endsWith('/sendMessage')));
  assert.ok(calls.some(url=>url.endsWith('/getFile')));
  flow.handleExpenseCallback('telegram',chat,'expense:attach:done:'+saved.expenseId);
});


test('a receipt sent on the confirmation screen is queued and saved to the same expense',async()=>{
  assert.equal(flow.startExpenseCreation('telegram',chat).ok,true);
  flow.handleExpenseMessage('telegram',chat,'04.11.2026');
  flow.handleExpenseCallback('telegram',chat,'expense:investor:vitaly');
  flow.handleExpenseMessage('telegram',chat,'16850');
  const preview=flow.handleExpenseMessage('telegram',chat,'Закуп лакомств у Хвостика от 02.11.26');
  assert.match(preview.message,/16850|16 850/);
  const remote=telegramFetcher(jpg);
  const staged=await handleExpenseAttachmentMessage('telegram',chat,photoMessage(5060),remote.request);
  assert.equal(staged.ok,true,staged.message);
  assert.equal(staged.queued,true);
  assert.match(staged.message,/Файл принят/);
  assert.equal(remote.calls.length,0,'do not download anything before expense confirmation');
  const draft=db.prepare('SELECT * FROM expense_bot_drafts WHERE chat_id=?').get(chat);
  assert.equal(draft.step,'confirm');
  assert.equal(JSON.parse(draft.pending_attachments).length,1);
  const repeated=await handleExpenseAttachmentMessage('telegram',chat,photoMessage(5060),remote.request);
  assert.match(repeated.message,/уже ожидает/);
  assert.equal(JSON.parse(db.prepare('SELECT pending_attachments FROM expense_bot_drafts WHERE chat_id=?').get(chat).pending_attachments).length,1);
  const before=db.prepare('SELECT COUNT(*) AS count FROM expenses').get().count;
  const saved=flow.handleExpenseCallback('telegram',chat,'expense:confirm');
  assert.equal(saved.created,true);
  assert.match(saved.message,/Ожидают автоматического прикрепления: 1/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM expenses').get().count,before+1);
  const imported=await processPendingExpenseAttachments('telegram',chat,remote.request);
  assert.equal(imported.attached,1,imported.message);
  assert.equal(imported.failed,0);
  assert.equal(flow.attachmentCount(saved.expenseId),1);
  assert.equal(JSON.parse(db.prepare('SELECT pending_attachments FROM expense_bot_drafts WHERE chat_id=?').get(chat).pending_attachments).length,0);
  assert.equal(await processPendingExpenseAttachments('telegram',chat,remote.request),null);
  assert.equal(flow.handleExpenseCallback('telegram',chat,'expense:confirm').created,false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM expenses').get().count,before+1);
  const done=flow.handleExpenseCallback('telegram',chat,'expense:attach:done:'+saved.expenseId);
  assert.equal(done.ok,true);
});

test('a failed staged receipt is preserved and can be retried without a second expense',async()=>{
  assert.equal(flow.startExpenseCreation('telegram',chat).ok,true);
  flow.handleExpenseMessage('telegram',chat,'04.11.2026');
  flow.handleExpenseCallback('telegram',chat,'expense:investor:vitaly');
  flow.handleExpenseMessage('telegram',chat,'100');
  flow.handleExpenseMessage('telegram',chat,'Тестовая трата с подтверждением');
  const staged=await handleExpenseAttachmentMessage('telegram',chat,docMessage('Счет.pdf'),telegramFetcher(pdf).request);
  assert.equal(staged.queued,true);
  const saved=flow.handleExpenseCallback('telegram',chat,'expense:confirm');
  const broken=await processPendingExpenseAttachments('telegram',chat,async()=>{throw Error('Сеть недоступна')});
  assert.equal(broken.failed,1);
  assert.match(broken.message,/Повторить ожидающие файлы/);
  assert.equal(flow.attachmentCount(saved.expenseId),0);
  assert.equal(flow.handleExpenseCallback('telegram',chat,'expense:attach:done:'+saved.expenseId).ok,false);
  const retry=flow.handleExpenseCallback('telegram',chat,'expense:attach:retry:'+saved.expenseId);
  assert.equal(retry.retryPending,true);
  const good=await processPendingExpenseAttachments('telegram',chat,telegramFetcher(pdf,'documents/file_7.pdf').request);
  assert.equal(good.attached,1,good.message);
  assert.equal(flow.attachmentCount(saved.expenseId),1);
  assert.equal(flow.handleExpenseCallback('telegram',chat,'expense:attach:done:'+saved.expenseId).ok,true);
});

test('actual Telegram poller accepts pre-confirm photo and uploads it after confirmation',async()=>{
  assert.equal(flow.startExpenseCreation('telegram',chat).ok,true);
  flow.handleExpenseMessage('telegram',chat,'04.11.2026');
  flow.handleExpenseCallback('telegram',chat,'expense:investor:vitaly');
  flow.handleExpenseMessage('telegram',chat,'300');
  flow.handleExpenseMessage('telegram',chat,'Загрузка чека до сохранения');
  const {processUpdate}=require('./telegram-login-poller');
  const originalFetch=global.fetch;
  const called=[];
  global.fetch=async url=>{
    const name=String(url);
    called.push(name);
    if(name.endsWith('/getFile'))return {
      ok:true,json:async()=>({ok:true,result:{file_path:'photos/file_31.jpg',file_size:jpg.length}})};
    if(name.includes('/file/bot'))return {
      ok:true,headers:{get:()=>String(jpg.length)},arrayBuffer:async()=>jpg,body:null};
    if(name.endsWith('/sendMessage') || name.endsWith('/answerCallbackQuery'))
      return {ok:true,json:async()=>({ok:true,result:{}})};
    throw Error('Unexpected Telegram call: '+name);
  };
  try {
    await processUpdate({message:photoMessage(8831)});
    assert.equal(called.some(x=>x.endsWith('/getFile')),false);
    await processUpdate({callback_query:{
      id:'confirm-pre-upload',data:'expense:confirm',
      message:{chat:{id:Number(chat),type:'private'}},from:{id:Number(chat)},
    }});
  } finally {global.fetch=originalFetch;}
  const expense=db.prepare("SELECT id FROM expenses WHERE category='Загрузка чека до сохранения' ORDER BY id DESC LIMIT 1").get();
  assert.ok(expense);
  assert.equal(flow.attachmentCount(expense.id),1,'receipt should be automatically saved');
  assert.ok(called.some(x=>x.endsWith('/getFile')));
  assert.ok(called.some(x=>x.endsWith('/sendMessage')));
  flow.handleExpenseCallback('telegram',chat,'expense:attach:done:'+expense.id);
});
