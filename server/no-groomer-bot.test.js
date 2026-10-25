'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname,'telegram-login-poller.js'),'utf8');
const events=[];
let queriedDays=[];
class FakeForm {
  constructor(){this.entries=[];}
  append(key,value,filename){this.entries.push({key,filename});}
}
class FakeBlob {
  constructor(parts,options){this.type=options?.type;this.size=parts.reduce((s,v)=>s+String(v).length,0);}
}
class FakeController { constructor(){this.signal={};} abort(){} }
const fakeFetch=async(url,options)=>{
  const method=String(url).split('/').pop();
  const data=typeof options.body==='string'?JSON.parse(options.body):null;
  const fields=options.body instanceof FakeForm ? options.body.entries : [];
  events.push({method,data,fields});
  return {ok:true,status:200,json:async()=>({ok:true,result:{}})};
};
const mocks={
  './db':{},
  'node:crypto':{randomInt:()=>1234},
  './task-bot-actions':{},
  './task-bot-create':{},
  './expense-bot-create':{},
  './routes-partner-club':{handleClubPostInput:async()=>null,isClubModerator:()=>false},
  './sales-week-report':{adminCanReadSales:chatId=>String(chatId)==='777'},
  './payout-brief':{},
  './no-groomer-report':{
    collectNoGroomerReport:(days)=>{
      queriedDays.push(days);
      return {generated_at:'2026-10-25T12:00:00Z',orders:[{code:'T-1'}],
        period:{description:'За всё время'}};
    },
    formatNoGroomerReport:()=>'Заказы без грумера: 1',
    buildNoGroomerCsv:()=>'\uFEFFЗаказ;Причина\r\nT-1;Выбрал сам',
  },
};
const instance={exports:{}};
new Function('require','module','process','fetch','FormData','Blob',
  'AbortController','AbortSignal','setTimeout','clearTimeout','console',source)(
  key=>{if(!Object.hasOwn(mocks,key))throw Error('Unexpected dependency '+key);return mocks[key];},
  instance,{env:{TG_TOKEN:'test-token'}},fakeFetch,FakeForm,FakeBlob,FakeController,
  {timeout:()=>({})},()=>0,()=>{}, {warn(){},error(){}}
);

test('private admin command /nogroomer sends summary and CSV',async()=>{
  events.length=0;queriedDays=[];
  await instance.exports.processUpdate({message:{chat:{id:777,type:'private'},text:'/nogroomer'}});
  assert.deepEqual(queriedDays,[undefined]);
  assert.deepEqual(events.map(x=>x.method),['sendMessage','sendDocument']);
  assert.match(events[0].data.text,/Заказы без грумера: 1/);
  assert.match(events[1].fields.find(f=>f.key==='document').filename,/no_groomer-all.*\.csv$/);
});
test('seven day command passes the filter to live query',async()=>{
  events.length=0;queriedDays=[];
  await instance.exports.processUpdate({message:{chat:{id:777,type:'private'},text:'/nogroomer 7'}});
  assert.deepEqual(queriedDays,[7]);
  assert.equal(events.filter(e=>e.method==='sendDocument').length,1);
});
test('invalid period returns usage guidance without querying orders',async()=>{
  events.length=0;queriedDays=[];
  await instance.exports.processUpdate({message:{chat:{id:777,type:'private'},text:'/nogroomer 14'}});
  assert.equal(queriedDays.length,0);
  assert.equal(events.length,1);
  assert.match(events[0].data.text,/\/nogroomer 30/);
});
test('stranger or group cannot receive any private order report',async()=>{
  events.length=0;queriedDays=[];
  await instance.exports.processUpdate({message:{chat:{id:444,type:'private'},text:'/nogroomer'}});
  assert.equal(events.length,1);
  assert.match(events[0].data.text,/только администраторам/);
  await instance.exports.processUpdate({message:{chat:{id:-99,type:'supergroup'},text:'/nogroomer'}});
  assert.equal(events.length,1,'nothing is posted to a group');
  assert.equal(queriedDays.length,0);
});
test('button is only active for admins in private chats',async()=>{
  events.length=0;queriedDays=[];
  await instance.exports.processUpdate({callback_query:{
    id:'cb1',data:'sales:nogroomer',message:{chat:{id:777,type:'private'}}}});
  assert.equal(queriedDays.length,1);
  assert.equal(events.filter(e=>e.method==='sendDocument').length,1);
  events.length=0;queriedDays=[];
  await instance.exports.processUpdate({callback_query:{
    id:'cb2',data:'sales:nogroomer',message:{chat:{id:-99,type:'supergroup'}}}});
  assert.equal(queriedDays.length,0);
  assert.equal(events.length,1);
  assert.equal(events[0].method,'answerCallbackQuery');
  assert.equal(events[0].data.show_alert,true);
});
