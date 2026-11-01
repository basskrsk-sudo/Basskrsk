'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const script=fs.readFileSync(path.join(__dirname,'../public/miniapp-tasks.js'),'utf8');
const work=fs.readFileSync(path.join(__dirname,'../public/miniapp-work.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../public/miniapp.html'),'utf8');
const css=fs.readFileSync(path.join(__dirname,'../public/miniapp-work.css'),'utf8');

function task(id,name,code='angelina',status='new'){
 return {id,title:name,description:'Описание задачи №'+id,
  due_date:'2026-12-10',priority:'high',status,assignee_code:code,
  assignee_name:code==='angelina'?'Ангелина Функ':'Соколов Виталий',overdue:false,
  recurrence_rule:null,latest_report:null};
}
function dataset(verifiedRole){
 const mine=verifiedRole==='manager'
  ? [task(41,'Проверить стойки и образцы')]
  : [task(11,'Согласовать план логистики','vitaly')];
 const team=verifiedRole==='founder'?{
  summary:{active:2,overdue:1,today:0,in_progress:1},
  members:['alexey','vitaly','nikolay','angelina'].map(code=>({
   code,name:({alexey:'Лакомых Алексей',vitaly:'Соколов Виталий',
     nikolay:'Кучкин Николай',angelina:'Ангелина Функ'})[code],
   summary:{active:1,overdue:0,in_progress:0},
  })),
  tasks:[task(11,'Согласовать план логистики','vitaly'),
    task(41,'Проверить стойки и образцы','angelina')],
 }:null;
 return {actor:{name:verifiedRole==='manager'?'Ангелина Функ':'Соколов Виталий',
   code:verifiedRole==='manager'?'angelina':'vitaly',role:verifiedRole},
   summary:{active:1,overdue:0,today:0,in_progress:0},today:'2026-11-02',
   my_tasks:mine,team,can_edit_team:false};
}
function createHarness(role,taskBody=dataset(role),overrides={}){
 const elements={},listeners={},requests=[],navigation=[],store={};
 const root={innerHTML:'',
  addEventListener(name,cb){listeners[name]=cb;},
 };
 const document={getElementById(id){
   if(id==='workPage')return root;
   if(!elements[id])elements[id]={value:'',innerHTML:'',textContent:'',disabled:false};
   return elements[id];
 }};
 const token=role==='founder'?'founder-jwt':'manager-jwt';
 const user=role==='founder'?{id:1,full_name:'Соколов Виталий',active:1}:
   {id:2,full_name:'Ангелина Функ',active:1,points:[]};
 const fixtures={
  [role==='founder'?'/api/business-founder/me':'/api/managers/me']:
   role==='founder'?{founder:user}:{manager:user},
  '/api/miniapp/tasks':taskBody?taskBody:{status:403,error:'No tasks'},
  ...(role==='manager'?{
   '/api/managers/me/orders?days=30&limit=200':{orders:[]},
   '/api/managers/me/stock':{points:[]},
  }:{
   '/api/business-founder/dashboard?period=30d':{},
  }),
  ...overrides,
 };
 const fetch=async(url,options={})=>{
   requests.push({url,options});
   let item=fixtures[url];
   if(typeof item==='function')item=item(options);
   if(!item)return{ok:false,status:404,json:async()=>({error:'missing '+url})};
   if(item.status>=400)return{ok:false,status:item.status,json:async()=>({error:item.error||'Denied'})};
   return{ok:true,status:200,json:async()=>item};
 };
 const identity={getStatus:()=>({
   loaded:true,verified:true,contactVerified:true,
   accounts:[{role}],ambiguousRoles:[],phoneMasked:'***',
 }),onChange(){},async session(){return{role,token};}};
 const window={HvostMiniAppIdentity:identity,
   HvostBusinessFounder:{getPeriod:()=> '30d',render:()=>'<p>Founder dashboard</p>'},
   location:{assign(url){navigation.push(url);}},
 };
 const localStorage={
  getItem(k){return store[k]||null;},
  setItem(k,v){store[k]=String(v);},
  removeItem(k){delete store[k];},
 };
 const sessionStorage={setItem(){}};
 const context=vm.createContext({document,window,localStorage,sessionStorage,fetch});
 vm.runInContext(script,context,{filename:'miniapp-tasks.js',timeout:3000});
 vm.runInContext(work,context,{filename:'miniapp-work.js',timeout:3000});
 function clickWork(action){
   listeners.click({target:{closest(selector){
     if(selector==='[data-mini-task-action]')return null;
     if(selector==='[data-founder-period]')return null;
     if(selector==='[data-work-action]')return{dataset:{workAction:action}};
     return null;
   }}});
 }
 function clickTask(action,id,value){
   listeners.click({target:{closest(selector){
     if(selector==='[data-mini-task-action]')return{
       dataset:{miniTaskAction:action,taskId:String(id||''),taskValue:value||''},
     };
     if(selector==='[data-founder-period]')return null;
     if(selector==='[data-work-action]')return null;
     return null;
   }}});
 }
 return{root,window,requests,store,elements,fixtures,clickWork,clickTask,role};
}
async function flush(){
 for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
}

test('work mini-app loads the task module before the dashboard code',()=>{
 assert.ok(html.indexOf('/miniapp-tasks.js')>=0);
 assert.ok(html.indexOf('/miniapp-tasks.js')<html.indexOf('/miniapp-work.js'));
 assert.match(css,/\.mt-task/);
 assert.match(css,/\.mt-nav/);
});
test('manager tasks appear in the same cabinet with a concise overview and filterable panel',async()=>{
 const h=createHarness('manager');
 await h.window.HvostMiniAppWork.chooseRole('manager');
 assert.match(h.root.innerHTML,/Мои поручения/);
 assert.match(h.root.innerHTML,/data-work-action="work-tasks"/);
 assert.ok(h.requests.some(r=>r.url==='/api/miniapp/tasks'&&
   r.options.headers.Authorization==='Bearer manager-jwt'));
 h.clickWork('work-tasks');
 assert.match(h.root.innerHTML,/Проверить стойки и образцы/);
 assert.match(h.root.innerHTML,/Активные/);
 assert.doesNotMatch(h.root.innerHTML,/Команда · 4/);
 h.clickTask('filter',null,'overdue');
 assert.match(h.root.innerHTML,/По выбранному фильтру поручений нет/);
 h.clickTask('filter',null,'active');
 h.clickTask('open',41);
 assert.match(h.root.innerHTML,/Отправить отчёт/);
 assert.match(h.root.innerHTML,/Сохранить/);
 h.clickWork('work-overview');
 assert.match(h.root.innerHTML,/Обзор/);
 assert.match(h.root.innerHTML,/Мои поручения/);
});
test('manager can change own task status, add report and edit due date by authenticated API',async()=>{
 const h=createHarness('manager',dataset('manager'),{
  '/api/miniapp/tasks/41': (options)=>({
   ok:true,message:'Изменения сохранены',status:200,
  }),
 });
 await h.window.HvostMiniAppWork.chooseRole('manager');
 h.clickWork('work-tasks');
 h.clickTask('open',41);
 h.clickTask('work',41);
 await flush();
 const change=h.requests.find(r=>r.url==='/api/miniapp/tasks/41');
 assert.equal(change.options.method,'POST');
 assert.equal(change.options.headers.Authorization,'Bearer manager-jwt');
 assert.equal(JSON.parse(change.options.body).status,'in_progress');
 assert.equal(JSON.parse(change.options.body).expected_status,'new');
 h.elements.mtTaskNote.value='Позвонила владельцу салона';
 h.clickTask('save-note',41);
 await flush();
 const note=h.requests.filter(r=>r.url==='/api/miniapp/tasks/41').at(-1);
 assert.equal(JSON.parse(note.options.body).comment,'Позвонила владельцу салона');
 h.elements.mtTaskDue.value='2026-12-31';
 h.clickTask('save-due',41);
 await flush();
 const due=h.requests.filter(r=>r.url==='/api/miniapp/tasks/41').at(-1);
 assert.equal(JSON.parse(due.options.body).due_date,'2026-12-31');
 h.clickTask('done',41);
 assert.match(h.root.innerHTML,/Подтвердить выполнение поручения/);
 h.clickTask('confirm-done',41);
 await flush();
 const closed=h.requests.filter(r=>r.url==='/api/miniapp/tasks/41').at(-1);
 assert.equal(JSON.parse(closed.options.body).status,'done');
});
test('founders have a read-only team panel with all four names',async()=>{
 const h=createHarness('founder');
 await h.window.HvostMiniAppWork.chooseRole('founder');
 h.clickWork('work-tasks');
 assert.match(h.root.innerHTML,/Мои поручения/);
 assert.match(h.root.innerHTML,/Команда · 4/);
 h.clickTask('scope',null,'team');
 for(const name of ['Лакомых Алексей','Соколов Виталий','Кучкин Николай','Ангелина Функ'])
   assert.ok(h.root.innerHTML.includes(name));
 h.clickTask('open',41);
 assert.match(h.root.innerHTML,/Просмотр без права изменения/);
 assert.doesNotMatch(h.root.innerHTML,/data-mini-task-action="confirm-done"/);
 const prior=h.requests.filter(r=>r.url.startsWith('/api/miniapp/tasks/')).length;
 h.clickTask('work',41);
 await flush();
 assert.equal(h.requests.filter(r=>r.url.startsWith('/api/miniapp/tasks/')).length,prior);
});
test('another manager cannot see task content if the server denies task mapping',async()=>{
 const h=createHarness('manager',null);
 await h.window.HvostMiniAppWork.chooseRole('manager');
 assert.doesNotMatch(h.root.innerHTML,/data-work-action="work-tasks"/);
 assert.doesNotMatch(h.root.innerHTML,/Описание задачи/);
 assert.ok(h.requests.some(r=>r.url==='/api/miniapp/tasks'));
});
test('task API values are always escaped before injecting HTML',async()=>{
 const data=dataset('manager');
 data.my_tasks=[{
   ...task(41,'<img src=x onerror=alert(1)>'),description:'<script>bad()</script>',
   latest_report:'"><svg/onload=alert(2)>',
 }];
 const h=createHarness('manager',data);
 await h.window.HvostMiniAppWork.chooseRole('manager');
 h.clickWork('work-tasks');
 h.clickTask('open',41);
 assert.doesNotMatch(h.root.innerHTML,/<script>bad/);
 assert.doesNotMatch(h.root.innerHTML,/<img src=x/);
 assert.match(h.root.innerHTML,/&lt;script&gt;/);
 assert.match(h.root.innerHTML,/&lt;img src=x/);
});
