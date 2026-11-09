'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const code=fs.readFileSync(path.join(__dirname,'../public/miniapp-admin-product-create.js'),'utf8');
const work=fs.readFileSync(path.join(__dirname,'../public/miniapp-work.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../public/miniapp.html'),'utf8');
const productRoutes=fs.readFileSync(path.join(__dirname,'routes-products.js'),'utf8');

function harness() {
  const events={},elements={},calls=[];
  const root={innerHTML:'',addEventListener(name,handler){
    (events[name]||(events[name]=[])).push(handler);
  }};
  const document={getElementById(id){
    if (id==='workPage') return root;
    if (!elements[id]) elements[id]={
      id,value:'',checked:false,innerHTML:'',textContent:'',disabled:false,files:null,
    };
    return elements[id];
  }};
  let uploads=0;
  const fetch=async(url,options)=>{
    calls.push({url,options});
    if (url==='/api/products/upload-image') {
      uploads++;
      return {ok:true,status:201,json:async()=>({ok:true,path:'images/uploads/mock-product.webp'})};
    }
    if (url==='/api/products') return {
      ok:true,status:201,json:async()=>({ok:true,id:123}),
    };
    return {ok:false,status:404,json:async()=>({error:'Unknown URL'})};
  };
  const FileReader=function(){};
  FileReader.prototype.readAsDataURL=function(){
    this.result='data:image/png;base64,AAAA';
    this.onload();
  };
  const window={};
  vm.runInNewContext(code,{window,document,fetch,FileReader,Date,Math,console},
    {filename:'miniapp-admin-product-create.js'});
  const el=id=>document.getElementById(id);
  async function emit(name,target){
    for (const handler of events[name]||[]) await handler({target,preventDefault(){}});
  }
  return {api:window.HvostAdminProductCreate,root,calls,el,emit,uploads:()=>uploads};
}
function values(h) {
  h.el('hmNewProductName').value='Лапка кроличья';
  h.el('hmNewProductCategory').value='treats';
  h.el('hmNewProductWeight').value='5 шт.';
  h.el('hmNewProductPrice').value='90';
  h.el('hmNewProductDesc').value='Натуральное лакомство';
  h.el('hmNewProductComp').value='Кролик\nМясо';
  h.el('hmNewProductSuitability').value='Собаки';
  h.el('hmNewProductPurpose').value='Лакомство';
  h.el('hmNewProductRestrictions').value='Под присмотром';
}
test('admin can create new product using the canonical catalog endpoint',async()=>{
  const h=harness();
  h.api.open({token:'admin-token',isValid:()=>true,onBack:()=>{}});
  assert.match(h.root.innerHTML,/Создать карточку товара/);
  assert.match(h.root.innerHTML,/Лакомства/);
  assert.match(h.root.innerHTML,/Остатки на складе/);
  values(h);
  await h.emit('submit',{id:'hmNewProductForm'});
  const req=h.calls.find(x=>x.url==='/api/products');
  assert.ok(req,'POST /api/products must be used');
  assert.equal(req.options.headers.Authorization,'Bearer admin-token');
  const payload=JSON.parse(req.options.body);
  assert.equal(payload.name,'Лапка кроличья');
  assert.equal(payload.category,'treats');
  assert.equal(payload.desc,'Натуральное лакомство');
  assert.equal(payload.img,null);
  assert.equal(payload.icon,'🐾');
  assert.deepEqual(Array.from(payload.comp),['Кролик','Мясо']);
  assert.equal(payload.variants.length,1);
  assert.equal(payload.variants[0].weight,'5 шт.');
  assert.equal(payload.variants[0].price,90);
  assert.match(payload.slug,/^[a-z0-9-]+$/);
  assert.match(h.root.innerHTML,/Товар создан/);
  assert.match(h.root.innerHTML,/Начальные остатки/);
  assert.equal(h.calls.length,1);
});
test('invalid price and incomplete form never issue a creation request',async()=>{
  const h=harness();
  h.api.open({token:'t',isValid:()=>true,onBack:()=>{}});
  values(h);
  h.el('hmNewProductPrice').value='1.5';
  await h.emit('submit',{id:'hmNewProductForm'});
  assert.match(h.el('hmNewProductFeedback').innerHTML,/Цена должна быть целым/);
  assert.equal(h.calls.length,0);
  h.el('hmNewProductPrice').value='90';
  h.el('hmNewProductName').value='';
  await h.emit('submit',{id:'hmNewProductForm'});
  assert.equal(h.calls.length,0);
});
test('photo uses existing upload endpoint and saved path in product card',async()=>{
  const h=harness();
  h.api.open({token:'t',isValid:()=>true,onBack:()=>{}});
  values(h);
  h.el('hmNewProductPhoto').files=[{name:'product.png',type:'image/png',size:100}];
  await h.emit('submit',{id:'hmNewProductForm'});
  assert.equal(h.uploads(),1);
  assert.equal(h.calls[0].url,'/api/products/upload-image');
  assert.equal(JSON.parse(h.calls[0].options.body).data,'data:image/png;base64,AAAA');
  assert.equal(h.calls[1].url,'/api/products');
  assert.equal(JSON.parse(h.calls[1].options.body).img,'images/uploads/mock-product.webp');
});
test('product editor cannot open without valid administrator credentials',async()=>{
  const h=harness();
  h.api.open({token:'t',isValid:()=>false,onBack:()=>{}});
  assert.equal(h.api.isOpen(),false);
  h.api.open({token:'',isValid:()=>true,onBack:()=>{}});
  assert.equal(h.api.isOpen(),false);
  assert.equal(h.calls.length,0);
  h.api.open({token:'t',isValid:()=>true,onBack:()=>{}});
  let back=0;
  h.api.close(true);
  assert.equal(h.api.isOpen(),false);
  h.api.open({token:'t',isValid:()=>true,onBack:()=>{back++;}});
  await h.emit('click',{closest:selector=>selector==='[data-hm-product-action]'?
    {dataset:{hmProductAction:'back'}}:null});
  assert.equal(back,1);
});
test('Mini App integrates editor into administrator role, no duplicate stock API',()=>{
  assert.match(html,/src="\/miniapp-admin-product-create\.js"/);
  assert.match(work,/data-work-action="admin-product-create"/);
  assert.match(work,/action === 'admin-product-create' && activeRole === 'admin' && adminRegisterAuthorized\(\)/);
  assert.match(work,/HvostAdminProductCreate\.open/);
  assert.match(work,/HvostAdminProductCreate\.close\(true\)/);
  assert.match(productRoutes,/router\.post\('\/api\/products'/);
  assert.match(productRoutes,/requireAuth\(\['admin', 'warehouse'\]\)/);
  assert.doesNotMatch(code,/warehouse_stock|INSERT INTO stock|\/warehouse\/adjust/);
});
