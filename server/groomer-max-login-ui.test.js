'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const page=fs.readFileSync(path.join(__dirname,'..','public/taiga-groomer.html'),'utf8');
const source=fs.readFileSync(path.join(__dirname,'..','public/groomer-max-login.js'),'utf8');

test('groomer keeps Telegram and password alongside a distinct MAX website entry',()=>{
  assert.match(page,/href="https:\/\/t\.me\/HvostMarketRusBot\?start=app"/);
  assert.match(page,/onclick="doLogin\(\)"/);
  assert.match(page,/id="tg-login-block"/);
  assert.match(page,/id="max-login-block"/);
  assert.match(page,/id="max-login-phone"/);
  assert.match(page,/src="\/groomer-max-login\.js\?v=1"/);
  assert.match(page,/onSuccess:onPartnerLoginSuccess/);
  assert.doesNotMatch(source,/\/api\/sms|sendSms|sms\.ru/i);
});
function setup(data={status:200}) {
  const nodes=new Map();
  function element(id){
    if(!nodes.has(id))nodes.set(id,{
      style:{display:id==='max-login-block'?'none':id==='max-login-step-waiting'?'none':'block'},
      attributes:{},value:id==='max-login-phone'?'+7 (913) 555-34-01':'',
      textContent:'',href:'',disabled:false,
      setAttribute(k,v){this.attributes[k]=v;},
    });
    return nodes.get(id);
  }
  let pollOptions;
  const sent=[];
  const host={
    getComputedStyle(node){return {display:node.style.display};},
    HvostTelegramLoginPolling:{
      start(options){pollOptions=options;return {stop(){sent.push({stop:true})}};},
    },
  };
  const fetch=async(url,options={})=>{
    sent.push({url,options});
    if(url==='/api/partners/max/start')return {ok:true,json:async()=>({
      token:'a'.repeat(64),deep_link:'https://max.ru/HvostMaxTestBot?start='+'a'.repeat(64),
    })};
    if(url==='/api/partners/max/check')return {
      status:data.status||200,ok:(data.status||200)===200,
      json:async()=>data.status===403?{error:'Другой аккаунт MAX'}:
        {verified:true,token:'signed-token',user:{id:1,full_name:'Грумер'}},
    };
    throw Error('unexpected URL '+url);
  };
  vm.runInNewContext(source,{
    window:host,document:{getElementById:element},fetch,console,
    Promise,URLSearchParams,
  });
  return {app:host.HvostGroomerMaxLogin,element,sent,getPoll:()=>pollOptions};
}
test('MAX website flow opens its own bot and hands the verified session to the existing groomer UI',async()=>{
  const ctx=setup(),login=[];
  assert.equal(ctx.app.normalizedPhone('8 (913) 555-34-01'),'79135553401');
  assert.equal(ctx.app.normalizedPhone('1234'),null);
  ctx.app.toggle();
  assert.equal(ctx.element('max-login-block').style.display,'block');
  assert.equal(ctx.element('max-login-toggle').attributes['aria-expanded'],'true');
  await ctx.app.start({onSuccess:async result=>login.push(result)});
  assert.equal(ctx.sent[0].url,'/api/partners/max/start');
  assert.equal(JSON.parse(ctx.sent[0].options.body).phone,'79135553401');
  assert.equal(ctx.element('max-login-step-waiting').style.display,'block');
  assert.match(ctx.element('max-login-link').href,/^https:\/\/max\.ru\//);
  const verified=await ctx.getPoll().check();
  assert.equal(verified.done,true);
  await ctx.getPoll().onSuccess(verified.data);
  assert.equal(login[0].token,'signed-token');
  assert.equal(login[0].user.id,1);
  ctx.app.stop();
});
test('foreign MAX account is not signed in and shows an error',async()=>{
  const ctx=setup({status:403}),login=[];
  await ctx.app.start({onSuccess:async result=>login.push(result)});
  const denied=await ctx.getPoll().check();
  assert.equal(denied.expired,true);
  ctx.getPoll().onExpired();
  assert.equal(login.length,0);
  assert.match(ctx.element('max-login-error').textContent,/Другой аккаунт/);
});
