'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-max-bot-commands-'));
process.env.MAX_BOT_TOKEN='mock-max-help-token';
process.env.MAX_BOT_USERNAME='mock-max-help-bot';
process.env.MAX_WEBHOOK_SECRET='mock-max-help-webhook-secret';

const db=require('./db');
const pointStock=require('./max-point-stock');
const bot=require('./max-bot');
const managerId=Number(db.prepare(
  'INSERT INTO managers(mgr_code,login,password_hash,full_name,phone,max_chat_id) VALUES(?,?,?,?,?,?)'
).run('MAX-HELP-01','max-help-manager','test','Тестовый менеджер','79001119999','88001').lastInsertRowid);
db.prepare(
  "INSERT INTO points(id,name,addr,icon,manager_id) VALUES(?,?,?,?,?)"
).run('max-help-point','Тестовая точка','ул. Тестовая, 5','🐾',managerId);
db.prepare(
  "INSERT INTO task_assignees(code,full_name,phone,max_chat_id) VALUES(?,?,?,?)"
).run('max-help-person','Исполнитель','9001119999','88001');

async function recordMax(fn){
  const calls=[];
  const original=global.fetch;
  global.fetch=async(url,options={})=>{
    const body=options.body?JSON.parse(options.body):null;
    calls.push({url:String(url),method:options.method,headers:options.headers,body});
    return {ok:true,status:200,json:async()=>({ok:true,commands:body?.commands||[]})};
  };
  try{await fn(calls);return calls;}finally{global.fetch=original;}
}
function updateMessage(chatId,text){
  return {update_type:'message_created',message:{
    body:{text},recipient:{chat_id:String(chatId)}
  }};
}
function updateCallback(chatId,payload){
  return {update_type:'message_callback',chat_id:String(chatId),
    callback:{payload,callback_id:'menu-test-callback'}};
}
test('MAX official slash-command registration matches the 4 implemented entry points',async()=>{
  const calls=await recordMax(async list=>{
    const result=await bot.configureMaxCommands();
    assert.equal(result.ok,true);
    assert.equal(list.length,1);
  });
  const request=calls[0];
  assert.equal(request.url,'https://platform-api2.max.ru/me/commands');
  assert.equal(request.method,'PATCH');
  assert.equal(request.headers.Authorization,'mock-max-help-token');
  assert.deepEqual(request.body.commands.map(x=>x.name),['start','help','tasks','stock','app']);
  assert.ok(request.body.commands.every(x=>x.description.length<=128));
});
test('help command lists actual commands with buttons only for permitted roles',()=>{
  const allowed=bot.buildMaxHelp('88001');
  assert.match(allowed.text,/\/help/);
  assert.match(allowed.text,/\/tasks/);
  assert.match(allowed.text,/\/stock/);
  assert.deepEqual(allowed.attachments[0].payload.buttons.map(row=>row[0].payload),
    ['menu:tasks','menu:stock','pilot_catalog']);
  const appButton=allowed.attachments[0].payload.buttons[2][0];
  assert.equal(appButton.type,'open_app');
  assert.equal(appButton.web_app,'mock-max-help-bot');
  assert.equal(appButton.payload,'pilot_catalog');
  const guest=bot.buildMaxHelp('88002');
  assert.match(guest.text,/привязанный MAX-аккаунт/);
  assert.equal(guest.attachments[0].payload.buttons.length,1);
  assert.equal(guest.attachments[0].payload.buttons[0][0].type,'open_app');
});

test('/app sends an open_app button to any private MAX user, no staff role required',async()=>{
  const calls=await recordMax(async()=>{
    await bot.processUpdate(updateMessage('88002','/app'));
    await bot.processUpdate(updateMessage('88002','/shop'));
  });
  assert.equal(calls.length,2);
  for(const call of calls) {
    const btn=call.body.attachments?.[0]?.payload?.buttons?.[0]?.[0];
    assert.equal(btn?.type,'open_app');
    assert.equal(btn?.web_app,'mock-max-help-bot');
    assert.equal(btn?.payload,'pilot_catalog');
    assert.match(call.body.text,/тестовое мини-приложение/i);
  }
});
test('start without token, /help, /commands and /menu return usable help',async()=>{
  const calls=await recordMax(async()=>{
    for(const cmd of ['/start','/help','/commands','/menu','команды']){
      await bot.processUpdate(updateMessage('88001',cmd));
    }
  });
  const messages=calls.filter(x=>x.url.includes('/messages?'));
  assert.equal(messages.length,5);
  assert.ok(messages.every(m=>m.body.text.includes('ХвостМаркет · команды MAX')));
  assert.ok(messages.every(m=>m.body.attachments?.[0]?.type==='inline_keyboard'));
});
test('the menu buttons reuse existing /tasks and /stock flows with stock confirmation',async()=>{
  const calls=await recordMax(async()=>{
    await bot.processUpdate(updateCallback('88001','menu:tasks'));
    await bot.processUpdate(updateCallback('88001','menu:stock'));
  });
  const answered=calls.filter(x=>x.url.includes('/answers?'));
  const messages=calls.filter(x=>x.url.includes('/messages?'));
  assert.equal(answered.length,2);
  assert.ok(answered.every(call=>call.body.message?.text));
  assert.ok(messages.some(m=>m.body.text.includes('Активных поручений')||
    m.body.text.includes('нет активных поручений')||
    m.body.text.includes('Активные поручения')));
  const stockPrompt=messages.find(m=>m.body.text.includes('Сформировать отчёт'));
  assert.ok(stockPrompt);
  assert.match(stockPrompt.body.attachments[0].payload.buttons[0][0].payload,/^stk:yes:/);
  const pending=db.prepare(
    "SELECT status FROM max_point_stock_approvals WHERE chat_id=? ORDER BY id DESC LIMIT 1"
  ).get('88001');
  assert.equal(pending.status,'pending','menu must not run stock aggregation');
});
test('unlinked user cannot receive working stock or task buttons',async()=>{
  const calls=await recordMax(async()=>{
    await bot.processUpdate(updateMessage('88002','/help'));
    await bot.processUpdate(updateMessage('88002','/stock'));
  });
  assert.equal(calls.length,2);
  assert.equal(calls[0].body.attachments[0].payload.buttons[0][0].type,'open_app');
  assert.match(calls[1].body.text,/доступен только сотрудникам/);
});
