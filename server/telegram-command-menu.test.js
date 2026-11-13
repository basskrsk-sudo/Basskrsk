'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hvost-telegram-command-menu-'));
process.env.TG_TOKEN = 'fake-token-for-menu-checks';
const db = require('./db');
const poller = require('./telegram-login-poller');

const scopes = [
  { scope: { type: 'default' } },
  { scope: { type: 'all_private_chats' } },
  { scope: { type: 'all_private_chats' }, language_code: 'ru' },
];
const menuKey = body => JSON.stringify([body.scope || {type:'default'}, body.language_code || '']);
const stored = new Map();
const requests = [];
let brokenScope = '';
const originalFetch = global.fetch;

global.fetch = async (url, init = {}) => {
  const method = String(url).split('/').pop();
  const body = init.body ? JSON.parse(init.body) : {};
  requests.push({method,body});
  if (method === 'setMyCommands') {
    stored.set(menuKey(body), body.commands);
  }
  const result = method === 'getMyCommands'
    ? (menuKey(body) === brokenScope ? [{command:'2gis',description:'Old cached menu'}] :
        stored.get(menuKey(body)) || [])
    : true;
  return {ok:true,status:200,json:async()=>({ok:true,result})};
};

test('command menu is published and verified for default, all private, and Russian private scopes',async()=>{
  assert.ok(poller.TELEGRAM_BOT_COMMANDS.some(c=>c.command==='contact'));
  assert.ok(poller.TELEGRAM_BOT_COMMANDS.some(c=>c.command==='edit'));
  assert.ok(poller.TELEGRAM_BOT_COMMANDS.some(c=>c.command==='2gis'));
  assert.equal(poller.TELEGRAM_BOT_COMMANDS.some(c=>c.command==='syncmenu'),false,
    'the admin-only diagnostic command should remain hidden');
  const result=await poller.configureBotProfile();
  assert.equal(result.ok,true,JSON.stringify(result));
  const sets=requests.filter(x=>x.method==='setMyCommands');
  const gets=requests.filter(x=>x.method==='getMyCommands');
  assert.equal(sets.length,3);
  assert.equal(gets.length,3);
  for(const spec of scopes) {
    const key=menuKey(spec);
    const posted=sets.find(x=>menuKey(x.body)===key);
    const verified=gets.find(x=>menuKey(x.body)===key);
    assert.ok(posted,'missing setMyCommands '+key);
    assert.ok(verified,'missing getMyCommands '+key);
    const names=posted.body.commands.map(c=>c.command);
    assert.ok(names.includes('contact'),key);
    assert.equal(names.indexOf('contact'),names.indexOf('2gis')+1);
    assert.deepEqual(stored.get(key),poller.TELEGRAM_BOT_COMMANDS);
  }
});

test('a stale Russian-private menu is reported rather than silently marked as updated',async()=>{
  brokenScope=menuKey(scopes[2]);
  const result=await poller.syncTelegramBotCommands();
  assert.equal(result.ok,false);
  assert.deepEqual(result.failed,['private_ru']);
  brokenScope='';
  const fixed=await poller.syncTelegramBotCommands();
  assert.equal(fixed.ok,true);
});

test('linked administrator can use hidden /syncmenu and receives verified result',async()=>{
  db.prepare("INSERT INTO admins (login,password_hash,role,active,telegram_chat_id) VALUES (?,?,?,?,?)")
    .run('telegram-menu-admin','hash','super',1,'9188801');
  const countBefore=requests.filter(x=>x.method==='setMyCommands').length;
  await poller.processUpdate({message:{
    chat:{type:'private',id:9188801},
    from:{id:9188801},
    text:'/syncmenu',
  }});
  assert.equal(requests.filter(x=>x.method==='setMyCommands').length-countBefore,3);
  const reply=requests.findLast(x=>x.method==='sendMessage');
  assert.match(reply.body.text,/Меню команд Telegram обновлено/);
  assert.match(reply.body.text,/\/contact/);
});

test('unknown account and spoofed sender cannot resync Telegram menu',async()=>{
  for(const info of [
    {chat:9188811,from:9188811},
    {chat:9188801,from:9188811},
  ]) {
    const before=requests.filter(x=>x.method==='setMyCommands').length;
    await poller.processUpdate({message:{
      chat:{type:'private',id:info.chat},from:{id:info.from},text:'/syncmenu',
    }});
    const reply=requests.findLast(x=>x.method==='sendMessage');
    assert.match(reply.body.text,/только привязанный администратор/);
    assert.equal(requests.filter(x=>x.method==='setMyCommands').length,before);
  }
});

test.after(()=>{global.fetch=originalFetch});
