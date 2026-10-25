'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const source=fs.readFileSync(path.join(__dirname,'telegram-login-poller.js'),'utf8');
const requests=[];
const payees=[
  {index:1,name:'Анна Иванова',roles:['partner','manager'],roles_label:'Грумер + Менеджер',
    total:750,period:{label:'01.10.2026 — 20.10.2026'}},
  {index:2,name:'Пётр Соколов',roles:['owner'],roles_label:'Владелец салона',
    total:250,period:{label:'05.10.2026 — 22.10.2026'}},
];
const report={generated_at:'2026-10-25T11:00:00.000Z',people:payees};
const mockModules={
  './db':{},
  'node:crypto':{randomInt:()=>2345},
  './task-bot-actions':{},
  './task-bot-create':{},
  './expense-bot-create':{},
  './routes-partner-club':{isClubModerator:()=>false,handleClubPostInput:()=>null},
  './sales-week-report':{adminCanReadSales:id=>String(id)==='777'},
  './payout-brief':{
    collectPayoutBrief:()=>report,
    formatPayoutBriefMessage:()=>'Общая сводка',
    formatRecipientPayoutMessage:p=>'Справка для '+p.name+' ('+p.roles_label+')',
    buildPayoutBriefCsv:()=>'\uFEFFПолучатель;Комиссия',
  },
  './payout-brief-pdf':{renderPayoutBriefPdf:async(r,{recipient})=>{
    requests.push({method:'render',recipient:recipient.name});
    return Buffer.from('%PDF-1.4','utf8');
  }},
};
function fakeFetch(url,options){
  const method=String(url).split('/').pop();
  const message=typeof options.body==='string'?JSON.parse(options.body):null;
  const document=options.body instanceof FormData ? options.body.get('document') : null;
  requests.push({method,message,document_name:document?.name||null});
  return Promise.resolve({ok:true,status:200,json:async()=>({ok:true,result:{}})});
}
const mod={exports:{}};
new Function('require','module','process','fetch','FormData','Blob',
  'AbortController','AbortSignal','setTimeout','clearTimeout','console',source)(
    key=>{if(!Object.hasOwn(mockModules,key))throw new Error('Unexpected import '+key);return mockModules[key];},
    mod,{env:{TG_TOKEN:'test-token'}},fakeFetch,FormData,Blob,AbortController,AbortSignal,
    ()=>0,()=>{}, {error(){},warn(){}}
  );
test('admin receives summary, separate message and PDF for each person, then CSV',async()=>{
  requests.length=0;
  await mod.exports.processUpdate({message:{chat:{id:777,type:'private'},text:'/payouts'}});
  const texts=requests.filter(x=>x.method==='sendMessage').map(x=>x.message.text);
  assert.deepEqual(texts,['Общая сводка',
    'Справка для Анна Иванова (Грумер + Менеджер)',
    'Справка для Пётр Соколов (Владелец салона)']);
  const pdfs=requests.filter(x=>x.document_name?.endsWith('.pdf'));
  assert.equal(pdfs.length,2);
  assert.deepEqual(requests.filter(x=>x.method==='render').map(x=>x.recipient),
    ['Анна Иванова','Пётр Соколов']);
  assert.equal(requests.filter(x=>x.document_name?.endsWith('.csv')).length,1);
});
test('outsiders cannot request recipient financial documents',async()=>{
  requests.length=0;
  await mod.exports.processUpdate({message:{chat:{id:999,type:'private'},text:'/payouts'}});
  assert.equal(requests.length,1);
  assert.equal(requests[0].method,'sendMessage');
  assert.match(requests[0].message.text,/только администраторам/);
});
