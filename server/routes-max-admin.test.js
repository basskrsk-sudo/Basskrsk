'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-max-admin-'));
process.env.MAX_BOT_TOKEN='secret-token-must-not-be-exposed';
process.env.MAX_BOT_USERNAME='HvostMarketTest';
process.env.MAX_WEBHOOK_SECRET='secret-webhook-must-not-be-exposed';
const db=require('./db');
const {signToken}=require('./auth');
const {registerMaxAdminRoutes,collectMaxConnections,personalMaxChat,connectionStats}=require('./routes-max-admin');

function admin(login,role,phone,active=1){
  return Number(db.prepare(
    'INSERT INTO admins(login,password_hash,full_name,phone,role,active) VALUES(?,?,?,?,?,?)'
  ).run(login,'test',login,phone,role,active).lastInsertRowid);
}
const superId=admin('max-admin-super-test','super','79001117711');
const regularId=admin('max-admin-regular-test','admin','79001117722');
const disabledId=admin('max-admin-disabled-test','super','79001117733',0);
const tokenSuper=signToken({id:superId,role:'admin',adminRole:'super'});
const tokenRegular=signToken({id:regularId,role:'admin',adminRole:'admin'});
const tokenDisabled=signToken({id:disabledId,role:'admin',adminRole:'super'});

db.prepare(
  'INSERT INTO task_assignees(code,full_name,phone,max_chat_id) VALUES(?,?,?,?)'
).run('max-admin-super-assignee','Супер-администратор','9001117711','918001');
db.prepare(
  'INSERT INTO task_assignees(code,full_name,phone,max_chat_id) VALUES(?,?,?,?)'
).run('max-admin-regular-assignee','Администратор','9001117722','918002');
db.prepare(
  'INSERT INTO customers(phone,name,max_chat_id) VALUES(?,?,?)'
).run('79001116666','Покупатель MAX','918003');
const partnerId=Number(db.prepare(
  'INSERT INTO partners(partner_code,login,password_hash,full_name,phone,point_name,max_chat_id) VALUES(?,?,?,?,?,?,?)'
).run('MAX-ADMIN-PARTNER-1','max-admin-partner','test','Грумер MAX','79001114444','Салон один','918004').lastInsertRowid);
db.prepare(
  "INSERT INTO max_login_tokens(token,phone,role,account_id,chat_id,verified,expires_at) "+
  "VALUES(?,?,?,?,?,1,datetime('now','+1 day'))"
).run('max-admin-delete-token','79001114444','partner',partnerId,'918004');

let syncCalls=0;
const sent=[];
const bot={
  isConfigured:()=>true,
  MAX_BOT_COMMANDS:[
    {name:'start',description:'Начать'},
    {name:'help',description:'Все команды'},
    {name:'tasks',description:'Мои поручения'},
    {name:'stock',description:'Остатки'},
  ],
  configureMaxCommands:async()=>{syncCalls++;return {ok:true};},
  sendMaxMessage:async(chatId,text)=>{
    sent.push({chatId:String(chatId),text});
    return {ok:true};
  },
};
const routes={get:new Map(),post:new Map()};
registerMaxAdminRoutes({
  get:(route,fn)=>routes.get.set(route,fn),
  post:(route,fn)=>routes.post.set(route,fn),
},{database:db,bot});
async function call(method,route,{token='',query={},body={}}={}){
  const fn=routes[method].get(route);
  assert.equal(typeof fn,'function',route);
  const req={headers:{authorization:token?'Bearer '+token:''}};
  const res={
    status:0,payload:null,
    writeHead(code){this.status=code;},
    end(value){this.payload=value?JSON.parse(value):null;},
  };
  await fn(req,res,{query,body});
  return res;
}

test('MAX overview requires an active administrator and does not leak secrets or chats',async()=>{
  const anonymous=await call('get','/api/admin/max/overview');
  assert.equal(anonymous.status,401);
  const inactive=await call('get','/api/admin/max/overview',{token:tokenDisabled});
  assert.equal(inactive.status,401);
  const result=await call('get','/api/admin/max/overview',{token:tokenRegular});
  assert.equal(result.status,200);
  assert.equal(result.payload.configured,true);
  assert.equal(result.payload.token_configured,true);
  assert.equal(result.payload.webhook_secret_configured,true);
  assert.equal(result.payload.bot_url,'https://max.ru/HvostMarketTest');
  assert.deepEqual(result.payload.commands.map(item=>item.name),['start','help','tasks','stock']);
  assert.equal(result.payload.connections.people,4);
  assert.equal(result.payload.connections.accounts,4);
  const safe=JSON.stringify(result.payload);
  assert.equal(safe.includes('secret-token-must-not-be-exposed'),false);
  assert.equal(safe.includes('secret-webhook-must-not-be-exposed'),false);
  assert.equal(safe.includes('918004'),false);
});

test('MAX connections are role-filtered, paginated, masked and private',async()=>{
  const result=await call('get','/api/admin/max/connections',{
    token:tokenRegular,query:{role:'partner',search:'Грумер',page:'1'},
  });
  assert.equal(result.status,200);
  assert.equal(result.payload.total,1);
  assert.equal(result.payload.rows[0].account_id,partnerId);
  assert.equal(result.payload.rows[0].role,'partner');
  assert.equal(result.payload.rows[0].phone_masked.endsWith('44'),true);
  assert.equal(result.payload.rows[0].chat_masked,'••••8004');
  assert.equal(JSON.stringify(result.payload).includes('79001114444'),false);
  const malformed=await call('get','/api/admin/max/connections',{
    token:tokenRegular,query:{role:'not-a-role'},
  });
  assert.equal(malformed.status,400);
  const unauthorized=await call('get','/api/admin/max/connections');
  assert.equal(unauthorized.status,401);
});

test('only super-admin may synchronize the native bot commands; second request is throttled',async()=>{
  const denied=await call('post','/api/admin/max/commands/sync',{token:tokenRegular});
  assert.equal(denied.status,403);
  assert.equal(syncCalls,0);
  const approved=await call('post','/api/admin/max/commands/sync',{token:tokenSuper});
  assert.equal(approved.status,200);
  assert.equal(syncCalls,1);
  const duplicate=await call('post','/api/admin/max/commands/sync',{token:tokenSuper});
  assert.equal(duplicate.status,429);
  assert.equal(syncCalls,1);
});

test('test message is addressed to own linked MAX and is throttled',async()=>{
  assert.equal(personalMaxChat({phone:'79001117711'}),'918001');
  const result=await call('post','/api/admin/max/test',{
    token:tokenRegular,body:{chat_id:'99999999'}
  });
  assert.equal(result.status,200);
  assert.equal(sent.length,1);
  assert.equal(sent[0].chatId,'918002');
  assert.match(sent[0].text,/тестовое сообщение/);
  const tooSoon=await call('post','/api/admin/max/test',{token:tokenRegular});
  assert.equal(tooSoon.status,429);
  assert.equal(sent.length,1);
});

test('disconnection only by super-admin, removes target MAX role but not other data',async()=>{
  const denied=await call('post','/api/admin/max/connections/disconnect',{
    token:tokenRegular,body:{role:'partner',account_id:partnerId}
  });
  assert.equal(denied.status,403);
  assert.equal(db.prepare('SELECT max_chat_id FROM partners WHERE id=?').get(partnerId).max_chat_id,'918004');
  const invalid=await call('post','/api/admin/max/connections/disconnect',{
    token:tokenSuper,body:{role:'admins',account_id:superId}
  });
  assert.equal(invalid.status,400);
  const success=await call('post','/api/admin/max/connections/disconnect',{
    token:tokenSuper,body:{role:'partner',account_id:partnerId}
  });
  assert.equal(success.status,200);
  assert.equal(db.prepare('SELECT max_chat_id FROM partners WHERE id=?').get(partnerId).max_chat_id,null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM max_login_tokens WHERE token='max-admin-delete-token'").get().n,0);
  assert.equal(db.prepare("SELECT max_chat_id FROM customers WHERE phone='79001116666'").get().max_chat_id,'918003');
  const repeat=await call('post','/api/admin/max/connections/disconnect',{
    token:tokenSuper,body:{role:'partner',account_id:partnerId}
  });
  assert.equal(repeat.status,404);
});

test('operation history is available to authenticated admins and never includes tokens',async()=>{
  const res=await call('get','/api/admin/max/history',{token:tokenRegular});
  assert.equal(res.status,200);
  assert.ok(res.payload.rows.some(row=>row.action==='sync_commands'));
  assert.ok(res.payload.rows.some(row=>row.action==='test_message'));
  assert.ok(res.payload.rows.some(row=>row.action==='disconnect'));
  assert.equal(JSON.stringify(res.payload).includes('secret-token-must-not-be-exposed'),false);
  assert.ok(connectionStats().accounts>=3);
});

test('frontend MAX management is a separate menu section with gated actions',()=>{
  const root=path.join(__dirname,'..');
  const adminHtml=fs.readFileSync(path.join(root,'public','taiga-admin.html'),'utf8');
  const frontend=fs.readFileSync(path.join(root,'public','max-admin.js'),'utf8');
  const navigation=fs.readFileSync(path.join(root,'public','admin-navigation.js'),'utf8');
  assert.match(adminHtml,/data-group="system" onclick="showSection\('system-health'\)"/);
  assert.match(navigation,/max:'system'/);
  assert.match(navigation,/\['max','MAX'\]/);
  assert.match(adminHtml,/id="sec-max"/);
  assert.match(adminHtml,/src="max-admin\.js/);
  assert.match(navigation,/if \(id === 'max'\) await loadMaxAdmin\(\)/);
  assert.match(frontend,/currentAdminRole==='super'/);
  assert.match(frontend,/disconnectMaxAdminAccount/);
  assert.doesNotMatch(frontend,/MAX_BOT_TOKEN|MAX_WEBHOOK_SECRET/);
  // Check full-size admin inline script syntax, not just the standalone MAX module.
  const inlineScripts=[...adminHtml.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match=>match[1]);
  const mainScript=inlineScripts.sort((a,b)=>b.length-a.length)[0];
  assert.ok(mainScript && mainScript.length>50000);
  assert.doesNotThrow(()=>new Function(mainScript));
});
