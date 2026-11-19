'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const site=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
const admin=fs.readFileSync(path.join(root,'public/admin-point.js'),'utf8');
const adminHtml=fs.readFileSync(path.join(root,'public/taiga-admin.html'),'utf8');
const sourceBetween=(file,a,b)=>{
  const start=file.indexOf(a),end=file.indexOf(b,start+a.length);
  assert.ok(start>=0&&end>start,'extract '+a);
  return file.slice(start,end);
};

test('public salon navigation jumps directly to top, rather than animating from the previous list',()=>{
  const go=sourceBetween(site,'function showPage(id) {','function ');
  assert.match(go,/window\.scrollTo\(\{ top: 0, behavior: id === 'salon' \? 'instant' : 'smooth' \}\)/);
});

test('salon details reset scroll both on opening and after asynchronous render',async()=>{
  const code=sourceBetween(site,'async function showSalonPage(code) {','let currentSalonGalleryPhotos');
  const scrolls=[],frames=[],elements={};
  let rendered=0,opened=0;
  const document={getElementById(id){
    if(!elements[id])elements[id]={style:{display:'none'},classList:{contains:()=>true}};
    return elements[id];
  }};
  const ctx={document,window:{scrollTo:(x)=>scrolls.push({...x})},
    requestAnimationFrame:fn=>frames.push(fn),
    currentSalonPointId:null,
    showPage:()=>opened++,
    renderSalonPage:()=>rendered++,
    fetch:async()=>({ok:true,json:async()=>({salon:{name:'Sir Barsik'}})}),
    encodeURIComponent, String,
  };
  vm.runInNewContext(code,ctx);
  await vm.runInNewContext("showSalonPage('sir-barsik')",ctx);
  assert.equal(opened,1);
  assert.equal(rendered,1);
  assert.equal(scrolls.length,1);
  assert.equal(scrolls[0].top,0);
  assert.equal(scrolls[0].behavior,'instant');
  assert.equal(frames.length,1);
  frames[0]();
  assert.equal(scrolls.length,2);
  assert.equal(scrolls[1].top,0);
  assert.equal(scrolls[1].behavior,'instant');
});

test('old salon load cannot snap another page back to the top',async()=>{
  const code=sourceBetween(site,'async function showSalonPage(code) {','let currentSalonGalleryPhotos');
  const frames=[],scrolls=[];
  const ctx={currentSalonPointId:null,window:{scrollTo:x=>scrolls.push(x)},
    showPage(){},requestAnimationFrame:fn=>frames.push(fn),
    document:{getElementById:id=>({style:{},classList:{contains:()=>id!=='page-salon'}})},
    fetch:async()=>({ok:true,json:async()=>({salon:{name:'Old'}})}),
    renderSalonPage:()=>{throw Error('must not render stale page')},
    encodeURIComponent, String,
  };
  vm.runInNewContext(code,ctx);
  await vm.runInNewContext("showSalonPage('old')",ctx);
  assert.equal(scrolls.length,1,'initial navigation resets scroll');
  assert.equal(frames.length,0,'stale result never schedules a late scroll');
});

test('admin point card resets both desktop inner scroller and mobile window immediately',()=>{
  const func=sourceBetween(admin,'function resetPointCardScroll() {','async function showPoint(idx) {');
  const main={scrollTop:685};
  const scrolls=[];
  const context={document:{querySelector:()=>main},window:{scrollTo:x=>scrolls.push(x)}};
  vm.runInNewContext(func,context);
  vm.runInNewContext('resetPointCardScroll()',context);
  assert.equal(main.scrollTop,0);
  assert.equal(scrolls.length,1);
  assert.equal(scrolls[0].behavior,'instant');
  const showPoint=sourceBetween(admin,'async function showPoint(idx) {','async function renderPointStockForCurrent()');
  assert.match(showPoint,/resetPointCardScroll\(\)/);
});

test('salon editor modal opens at its own scroll top; not its previous gallery position',()=>{
  const modal=sourceBetween(adminHtml,'async function openSalonPageModal(pointId, pointName) {','function closeSalonPageModal() {');
  assert.match(modal,/modal\.style\.display = 'flex';/);
  assert.match(modal,/modal\.firstElementChild\.scrollTop = 0/);
  assert.match(adminHtml,/admin-point\.js\?v=2/);
});
