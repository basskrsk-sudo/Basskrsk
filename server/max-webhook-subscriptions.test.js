'use strict';
// MAX subscription reconciliation is read-only when callbacks are already enabled,
// never removes subscriptions, and is a single-flight network task.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-max-webhook-sync-'));
process.env.MAX_BOT_TOKEN='max-subscriptions-fake-token';
process.env.MAX_BOT_USERNAME='hvost_fake_bot';
process.env.MAX_WEBHOOK_SECRET='max-subscriptions-fake-secret';
const bot=require('./max-bot');
const url='https://xn--80aesdf8b.xn--p1ai/api/max/webhook';

async function withMockSubscriptions(initial,fn) {
  let current=initial.map(item=>({...item}));
  const requests=[],original=global.fetch;
  global.fetch=async(pathname,options={})=>{
    const method=options.method||'GET';
    const body=options.body?JSON.parse(options.body):null;
    requests.push({path:String(pathname),method,body});
    if(method==='GET')return {ok:true,status:200,json:async()=>({subscriptions:current})};
    if(method==='POST') {
      const index=current.findIndex(x=>x.url===body.url);
      if(index<0)throw new Error('Unexpected new subscription');
      current[index]={...current[index],update_types:body.update_types};
      return {ok:true,status:200,json:async()=>({success:true})};
    }
    throw new Error('Unexpected MAX request '+method);
  };
  try{return await fn(requests,()=>current);}finally{global.fetch=original;}
}

test('adds message_callback to a single existing subscription without changing its URL or other types',async()=>{
  await withMockSubscriptions([
    {url,update_types:['message_created','bot_started','bot_stopped']},
  ],async(requests,getCurrent)=>{
    const [first,second]=await Promise.all([
      bot.ensureMaxWebhookUpdates(),bot.ensureMaxWebhookUpdates(),
    ]);
    assert.equal(first.ok,true);
    assert.equal(second.ok,true);
    const post=requests.filter(r=>r.method==='POST');
    assert.equal(post.length,1,'one POST even when two concurrent sync calls happen');
    assert.equal(post[0].body.url,url);
    assert.deepEqual(post[0].body.update_types,
      ['message_created','bot_started','bot_stopped','message_callback']);
    assert.equal(post[0].body.secret,process.env.MAX_WEBHOOK_SECRET);
    assert.equal(getCurrent()[0].url,url);
    assert.equal(bot.webhookStatus().status,'ready');
    assert.equal(bot.webhookStatus().callback_enabled,true);
  });
});

test('already complete subscription does not send a write to MAX',async()=>{
  await withMockSubscriptions([{url,update_types:['message_created','bot_started','message_callback']}],
    async(requests)=>{
      const result=await bot.ensureMaxWebhookUpdates();
      assert.equal(result.ok,true);
      assert.equal(requests.filter(r=>r.method==='POST').length,0);
      assert.equal(result.updated,false);
    });
});

test('ambiguous, unrelated and missing subscriptions are not mutated',async()=>{
  for(const subs of [
    [{url:'https://different.example.invalid/other-hook',update_types:['message_created']}],
    [{url,update_types:['message_created']},{url:'https://other.example/api/max/webhook',update_types:[]}],
    [],
  ]){
    await withMockSubscriptions(subs,async(requests)=>{
      const result=await bot.ensureMaxWebhookUpdates();
      assert.equal(result.ok,false);
      assert.equal(result.updated,false);
      assert.equal(requests.some(r=>r.method==='POST'),false);
    });
  }
});

test('MAX API failures report a redacted error without leaking tokens',async()=>{
  const original=global.fetch;
  global.fetch=async()=>({ok:false,status:401,json:async()=>({message:'Invalid token'})});
  try{
    const result=await bot.ensureMaxWebhookUpdates();
    assert.equal(result.ok,false);
    assert.equal(bot.webhookStatus().status,'error');
    const serialized=JSON.stringify(bot.webhookStatus());
    assert.equal(serialized.includes(process.env.MAX_BOT_TOKEN),false);
    assert.equal(serialized.includes(process.env.MAX_WEBHOOK_SECRET),false);
  }finally{global.fetch=original;}
});
