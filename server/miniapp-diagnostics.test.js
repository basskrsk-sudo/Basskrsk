'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hvost-miniapp-diagnostics-'));
process.env.TOKEN_SECRET='miniapp-diagnostic-tests-only-secret';
const db=require('./db');
const {signToken}=require('./auth');
const {registerMiniAppDiagnosticRoutes,validPayload}=require('./miniapp-diagnostics');

const routes=new Map(), router={};
router.get=(name,fn)=>routes.set('GET '+name,fn);
router.post=(name,fn)=>routes.set('POST '+name,fn);
registerMiniAppDiagnosticRoutes(router);
function execute(method,url,body={},token=''){
  const handler=routes.get(method+' '+url);
  assert.ok(handler);
  const response={
    status:0,body:null,
    writeHead(status){this.status=status;return this;},
    end(raw){this.body=JSON.parse(raw);}
  };
  handler({headers:token?{authorization:'Bearer '+token}:{}},response,{body,query:{},params:{}});
  return response;
}
const event={
  stage:'startup',result:'success',code:'ok',
  platform:'ios',build:'123abcdef456789abcd0',telegram_version:'8.1',duration_ms:1250
};
test('public diagnostics reject raw IDs, phone, URL, token and arbitrary messages',()=>{
  for(const key of ['phone','telegram_id','user_id','initData','token','url','message','stack','ip']){
    assert.equal(validPayload({...event,[key]:'secret'}),null,key);
    assert.equal(execute('POST','/api/miniapp/diagnostics',{...event,[key]:'secret'}).status,400);
  }
  assert.equal(validPayload({...event,build:'<script>blah</script>'}),null);
  assert.equal(validPayload({...event,duration_ms:-2}),null);
  assert.equal(validPayload({...event,platform:'some-phone'}),null);
  assert.equal(validPayload({...event,code:'DB_CONTAINS_TOKEN'}),null);
  assert.equal(execute('POST','/api/miniapp/diagnostics',{...event,telegram_version:'8.0'}).status,200);
});

test('aggregate counts by safe stage, platform and day without storing identifiers',()=>{
  const before=db.prepare('SELECT COUNT(*) n FROM miniapp_diagnostic_aggregate').get().n;
  assert.equal(execute('POST','/api/miniapp/diagnostics',event).status,200);
  assert.equal(execute('POST','/api/miniapp/diagnostics',event).status,200);
  const row=db.prepare("SELECT * FROM miniapp_diagnostic_aggregate WHERE telegram_version='8.1'").get();
  assert.equal(row.stage,'startup');
  assert.equal(row.platform,'ios');
  assert.equal(row.occurrences,2);
  assert.equal(row.duration_sum_ms,2500);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM miniapp_diagnostic_aggregate').get().n,before+1);
  for(const forbidden of ['phone','telegram_id','token','url','initData','ip']){
    assert.equal(Object.prototype.hasOwnProperty.call(row,forbidden),false,forbidden);
  }
});

test('only active admin tokens can read 7-day reliability dashboard',()=>{
  const f=db.prepare('INSERT INTO admins(id,login,password_hash,full_name,role,active) VALUES(?,?,?,?,?,?)');
  f.run(901,'active-miniapp-reliability','x','Администратор','admin',1);
  f.run(902,'disabled-miniapp-reliability','x','Администратор','admin',0);
  for(const token of ['',signToken({role:'manager',id:1}),signToken({role:'partner',id:1}),signToken({role:'admin',id:902})]){
    const r=execute('GET','/api/miniapp/diagnostics-summary',{},token);
    assert.equal(r.status,401);
    assert.equal(r.body.summary,undefined);
  }
  const active=execute('GET','/api/miniapp/diagnostics-summary',{},signToken({role:'admin',id:901}));
  assert.equal(active.status,200);
  assert.equal(active.body.range,'7d');
  assert.ok(active.body.summary.successful_launches>=2);
  assert.ok(Array.isArray(active.body.rows));
  assert.ok(active.body.rows.every(x=>!('phone' in x)&&!('user_id' in x)&&!('token' in x)));
});
