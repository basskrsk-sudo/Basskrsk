'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const code=fs.readFileSync(path.join(__dirname,'../public/miniapp-admin-warehouse.js'),'utf8');
const work=fs.readFileSync(path.join(__dirname,'../public/miniapp-work.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../public/miniapp.html'),'utf8');
function harness(){
  const events={},elements={},calls=[];
  const root={
    innerHTML:'',
    addEventListener(name,fn){(events[name]||(events[name]=[])).push(fn);},
  };
  const document={
    getElementById(id){
      if(id==='workPage')return root;
      if(!elements[id])elements[id]={id,value:'',checked:false,innerHTML:'',textContent:'',disabled:false,hidden:false};
      return elements[id];
    },
  };
  let changed=0;
  const fetch=async(url,opts)=>{
    calls.push({url,opts});
    if(url.startsWith('/api/miniapp/admin/warehouse?') || url==='/api/miniapp/admin/warehouse'){
      return {ok:true,status:200,json:async()=>({
        city_id:'krsk',cities:[{id:'krsk',name:'Красноярск'},{id:'spb',name:'СПб'}],
        items:[
          {variant_id:77,product_name:'Сердце говяжье',weight:'50 г',qty:10+changed,has_stock:1,can_add:1},
          {variant_id:78,product_name:'Лёгкое архивное',weight:'100 г',qty:0,has_stock:0,can_add:0},
        ],
      })};
    }
    if(url==='/api/miniapp/admin/warehouse/adjust'){
      const body=JSON.parse(opts.body);
      if(body.action==='add')changed+=body.qty;
      return {ok:true,status:200,json:async()=>({
        ok:true,old_qty:body.expected_qty,new_qty:body.action==='delete'?null:10+changed,
      })};
    }
    return {ok:false,status:404,json:async()=>({error:'Not mocked: '+url})};
  };
  const window={};
  vm.runInNewContext(code,{window,document,fetch,console},{filename:'miniapp-admin-warehouse.js'});
  const api=window.HvostAdminWarehouse;
  async function emit(name,target){
    for(const handler of events[name]||[]){
      await handler({target,preventDefault(){}});
    }
  }
  return {api,root,document,calls,emit,elements};
}
test('admin Mini App loads warehouse stock in selected city with active token',async()=>{
  const h=harness();
  let closed=0;
  await h.api.open({token:'administrator-token',isValid:()=>true,onBack:()=>{closed++;}});
  assert.match(h.root.innerHTML,/Центральный склад/);
  assert.match(h.root.innerHTML,/Сердце говяжье/);
  assert.match(h.root.innerHTML,/Красноярск/);
  assert.match(h.root.innerHTML,/Удалить позицию со склада/);
  assert.equal(h.calls[0].opts.headers.Authorization,'Bearer administrator-token');
  assert.equal(h.document.getElementById('hmWarehouseItem').value,'77');
  await h.emit('click',{closest:(s)=>s==='[data-hm-wh-action]'?
    {dataset:{hmWhAction:'back'}}:null});
  assert.equal(closed,1);
  assert.equal(h.api.isOpen(),false);
});
test('admin can add and remove quantity only with correct variant, city and reason',async()=>{
  const h=harness();
  await h.api.open({token:'t',isValid:()=>true,onBack:()=>{}});
  const el=id=>h.document.getElementById(id);
  el('hmWarehouseItem').value='77';
  el('hmWarehouseAction').value='add';
  el('hmWarehouseAmount').value='3';
  el('hmWarehouseReason').value='Накладная от поставщика №1';
  await h.emit('submit',{id:'hmWarehouseForm'});
  const post=h.calls.find(x=>x.url==='/api/miniapp/admin/warehouse/adjust');
  assert.ok(post);
  assert.equal(post.opts.headers.Authorization,'Bearer t');
  assert.deepEqual(JSON.parse(post.opts.body),{
    city_id:'krsk',variant_id:77,expected_qty:10,action:'add',qty:3,
    reason:'Накладная от поставщика №1',confirmed:false,
  });
  assert.match(h.root.innerHTML,/Изменение сохранено/);
  assert.match(h.root.innerHTML,/13 шт/);

  // The next action uses refreshed stock, never the stale original 10.
  el('hmWarehouseAction').value='decrease';
  el('hmWarehouseAmount').value='2';
  el('hmWarehouseReason').value='Списание по акту от 3 ноября';
  await h.emit('submit',{id:'hmWarehouseForm'});
  const changed=h.calls.filter(x=>x.url==='/api/miniapp/admin/warehouse/adjust');
  assert.equal(changed.length,2);
  const second=JSON.parse(changed[1].opts.body);
  assert.equal(second.action,'decrease');
  assert.equal(second.expected_qty,13);
  assert.equal(second.qty,2);
});
test('delete requires confirmation and never targets the central catalog',async()=>{
  const h=harness();
  await h.api.open({token:'t',isValid:()=>true,onBack:()=>{}});
  const el=id=>h.document.getElementById(id);
  el('hmWarehouseItem').value='77';
  el('hmWarehouseAction').value='delete';
  el('hmWarehouseReason').value='Удаление позиции с центрального склада';
  await h.emit('submit',{id:'hmWarehouseForm'});
  assert.equal(h.calls.filter(x=>x.url.includes('/adjust')).length,0);
  assert.match(el('hmWarehouseFeedback').innerHTML,/Подтвердите удаление/);
  el('hmWarehouseDeleteConfirm').checked=true;
  await h.emit('submit',{id:'hmWarehouseForm'});
  const post=h.calls.find(x=>x.url.endsWith('/adjust'));
  assert.equal(JSON.parse(post.opts.body).action,'delete');
  assert.equal(JSON.parse(post.opts.body).confirmed,true);
  assert.ok(!h.calls.some(x=>x.url.includes('/api/products')));
});
test('warehouse UI never opens without an authorized active-admin session',async()=>{
  const h=harness();
  await h.api.open({token:'t',isValid:()=>false,onBack:()=>{}});
  assert.equal(h.calls.length,0);
  assert.equal(h.api.isOpen(),false);
  await h.api.open({token:'',isValid:()=>true,onBack:()=>{}});
  assert.equal(h.calls.length,0);
});
test('Mini App links warehouse panel only from administrator role',()=>{
  assert.match(html,/src="\/miniapp-admin-warehouse\.js"/);
  assert.match(work,/data-work-action="admin-wh-open"/);
  assert.match(work,/activeRole === 'admin' && adminRegisterAuthorized\(\)/);
  assert.match(work,/HvostAdminWarehouse\.open/);
  assert.match(work,/HvostAdminWarehouse\.close\(true\)/);
});
