'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {
  probe,scan,run,telegram,INCIDENT_TITLE,confirmedFailures,renderIssueBody,
}=require('./site-uptime-monitor');

function fakeFetch(state) {
  return async(url,options)=>{
    const route=new URL(url).pathname;
    const text=route==='/'?'<html><title>ХвостМаркет — магазин</title></html>':
      route==='/api/health'?JSON.stringify({status:'ok',checks:{database:'ok',storage:'ok'}}):
      route==='/api/points'?JSON.stringify({points:[]}):
      route==='/miniapp.html'?'<html><script src="/miniapp-work.js"></script></html>':'';
    const status=state.statuses?.[route]||200;
    return {ok:status>=200&&status<300,status,
      text:async()=>state.invalid===route?'{"status":"bad"}':text};
  };
}
function issuesApi(){
  let next=1;
  const issues=[];
  const actions=[];
  async function api(method,payload,body){
    actions.push({method,payload,body});
    if(method==='GET'&&payload.startsWith('/issues?')){
      return issues.filter(x=>x.state==='open');
    }
    if(method==='POST'&&payload==='/issues'){
      const value={...body,number:next++,state:'open',
        created_at:'2026-11-04T08:00:00Z',html_url:'https://github.com/test/repo/issues/1'};
      issues.push(value);
      return value;
    }
    if(method==='POST'&&/\/issues\/\d+\/comments/.test(payload))return {id:1};
    if(method==='PATCH'&&/\/issues\/\d+$/.test(payload)){
      const item=issues.find(x=>String(x.number)===payload.split('/').pop());
      Object.assign(item,body);
      return item;
    }
    throw Error('Unknown API '+method+' '+payload);
  }
  return {api,issues,actions};
}
const immediate=async()=>{};
const log={log(){},warn(){}};
test('four external endpoints validate actual HTML, SQLite, API and Mini App content',async()=>{
  const s={};
  const results=await scan({fetchImpl:fakeFetch(s)});
  assert.equal(results.length,4);
  assert.ok(results.every(x=>x.ok));
  assert.ok(results.every(x=>!x.path.includes('token')));
  const broken=await scan({fetchImpl:fakeFetch({invalid:'/api/health'})});
  assert.equal(broken.find(x=>x.path==='/api/health').code,'invalid_content');
  assert.equal(broken.filter(x=>!x.ok).length,1);
});
test('two confirmed failures create ONE GitHub incident and ONE Telegram alert',async()=>{
  const state={statuses:{'/api/health':503,'/miniapp.html':502}};
  const github=issuesApi(),messages=[];
  const notify=async text=>{messages.push(text);return {sent:true}};
  const opts={fetchImpl:fakeFetch(state),api:github.api,notify,wait:immediate,logger:log,
    now:()=>new Date('2026-11-04T12:00:00Z')};
  const first=await run(opts);
  assert.equal(first.status,'down');
  assert.equal(first.failures.length,2);
  assert.equal(github.issues.length,1);
  assert.equal(github.issues[0].title,INCIDENT_TITLE);
  assert.equal(messages.length,1);
  assert.match(messages[0],/🔴/);
  assert.match(messages[0],/SQLite/);
  const still=await run(opts);
  assert.equal(still.status,'still_down');
  assert.equal(github.issues.length,1);
  assert.equal(messages.length,1,'never flood Telegram on repeated scheduled runs');
  state.statuses={};
  const recovery=await run(opts);
  assert.equal(recovery.status,'recovered');
  assert.equal(github.issues[0].state,'closed');
  assert.equal(messages.length,2);
  assert.match(messages[1],/🟢/);
  const stable=await run(opts);
  assert.equal(stable.status,'healthy');
  assert.equal(messages.length,2);
});
test('one-off failure in a single 20-second scan does not create an incident',async()=>{
  let errors=0;
  const fetchImpl=async(url,opts)=>{
    const path=new URL(url).pathname;
    if(path==='/api/health'&&errors++===0)return {ok:false,status:504,text:async()=>''};
    return fakeFetch({})(url,opts);
  };
  const gh=issuesApi(),messages=[];
  const result=await run({fetchImpl,api:gh.api,
    notify:async msg=>{messages.push(msg);return {sent:true}},wait:immediate,logger:log});
  assert.equal(result.status,'transient');
  assert.equal(gh.issues.length,0);
  assert.equal(messages.length,0);
});
test('an already open incident is not closed after only one successful scan',async()=>{
  const gh=issuesApi();
  await gh.api('POST','/issues',{title:INCIDENT_TITLE,body:'old'});
  let scanN=0;
  const fetchImpl=async(url,options)=>{
    const path=new URL(url).pathname;
    if(path==='/'){
      scanN++;
      if(scanN===2)return {status:503,ok:false,text:async()=>''};
    }
    return fakeFetch({})(url,options);
  };
  const messages=[];
  const result=await run({fetchImpl,api:gh.api,
    notify:async x=>{messages.push(x);return {sent:true}},wait:immediate,logger:log});
  assert.equal(result.status,'uncertain');
  assert.equal(gh.issues[0].state,'open');
  assert.equal(messages.length,0);
});
test('probe surfaces request timeouts without leaking stack trace or URLs',async()=>{
  const entry={name:'SQLite и хранилище',path:'/api/health',verify:()=>true};
  const outcome=await probe(entry,{fetchImpl:async()=>{const e=Error('secret');
    e.name='TimeoutError';throw e;}});
  assert.equal(outcome.ok,false);
  assert.equal(outcome.code,'timeout');
  assert.equal(JSON.stringify(outcome).includes('secret'),false);
  const issue=renderIssueBody([outcome],'2026-11-04T12:00:00Z');
  assert.match(issue,/timeout/);
  assert.doesNotMatch(issue,/secret/);
});
test('Telegram notifier is optional and never sends on missing secrets',async()=>{
  const sent=await telegram('test',{fetchImpl:async()=>{throw Error('unreachable')}});
  assert.deepEqual(sent,{sent:false,configured:false});
});
test('GitHub workflow schedules checks every five minutes and limits permissions',()=>{
  const text=fs.readFileSync(path.join(__dirname,'../.github/workflows/site-uptime.yml'),'utf8');
  assert.match(text,/cron: '\*\/5 \* \* \* \*'/);
  assert.match(text,/issues: write/);
  assert.match(text,/cancel-in-progress: false/);
  assert.match(text,/HM_MONITOR_TELEGRAM_TOKEN/);
  assert.match(text,/HM_MONITOR_CHAT_ID/);
  assert.doesNotMatch(text,/bot\d{6,}:/);
});

test('Telegram delivery can resume after the secrets are added without duplicating incidents',async()=>{
  const gh=issuesApi(),state={statuses:{'/api/health':503}};
  let enabled=false;
  const messages=[];
  const opts={
    api:gh.api,wait:immediate,logger:log,fetchImpl:fakeFetch(state),
    notify:async text=>{
      if(!enabled)return {sent:false,configured:false};
      messages.push(text);return {sent:true};
    },
  };
  const first=await run(opts);
  assert.equal(first.status,'down');
  assert.equal(first.notified,false);
  assert.equal(gh.issues.length,1);
  assert.match(gh.issues[0].body,/hm-telegram-alert:pending/);
  enabled=true;
  const second=await run(opts);
  assert.equal(second.status,'still_down');
  assert.equal(messages.length,1);
  assert.match(gh.issues[0].body,/hm-telegram-alert:sent/);
  assert.equal(gh.issues.length,1);
  await run(opts);
  assert.equal(messages.length,1,'must not send a repeated down alert once acknowledged');
  state.statuses={};
  const recovered=await run(opts);
  assert.equal(recovered.status,'recovered');
  assert.equal(messages.length,2);
  assert.match(messages[1],/восстановлен/);
});
