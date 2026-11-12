'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStaticCache } = require('./static-cache');

test('HTML validates with ETag and changes when an image is replaced', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-cache-'));
  try {
    fs.mkdirSync(path.join(dir, 'images'));
    fs.writeFileSync(path.join(dir, 'images/a.webp'), 'first image');
    const html = path.join(dir, 'index.html');
    fs.writeFileSync(html, '<img src="images/a.webp?v=old"><img src="/images/uploads/a.jpg">');
    const cache = createStaticCache(dir);
    const request = { method: 'GET', url: '/', headers: {} };
    const first = cache.response(html, request, 'text/html');
    assert.equal(first.headers['Cache-Control'], 'no-cache');
    assert.match(first.body.toString(), /a\.webp\?v=[a-f0-9]{20}/);
    assert.match(first.body.toString(), /src="\/images\/uploads\/a.jpg"/);
    const same = cache.response(html, { ...request, headers: { 'if-none-match': 'W/' + first.headers.ETag } }, 'text/html');
    assert.equal(same.status, 304);
    fs.writeFileSync(path.join(dir, 'images/a.webp'), 'replacement image');
    const changed = cache.response(html, { ...request, headers: { 'if-none-match': first.headers.ETag } }, 'text/html');
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.ETag, first.headers.ETag);
    assert.notEqual(changed.body.toString(), first.body.toString());
    const versionedUrl = changed.body.toString().match(/src="([^"]+)"/)[1];
    const image = cache.response(path.join(dir, 'images/a.webp'), { ...request, url: '/' + versionedUrl }, 'image/webp');
    assert.match(image.headers['Cache-Control'], /immutable/);
    const unversioned = cache.response(path.join(dir, 'images/a.webp'), { ...request, url: '/images/a.webp?v=old' }, 'image/webp');
    assert.equal(unversioned.headers['Cache-Control'], 'no-cache');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('configuration and cabinet pages remain no-store even with a matching validator', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-private-'));
  try {
    const cache = createStaticCache(dir);
    for (const name of ['config.js', 'sw.js', 'taiga-admin.html', 'miniapp.html']) {
      fs.writeFileSync(path.join(dir, name), 'private settings');
      const response = cache.response(path.join(dir, name), { method: 'GET', url: '/' + name, headers: { 'if-none-match': '*' } }, 'text/plain');
      assert.equal(response.headers['Cache-Control'], 'no-store');
      assert.equal(response.status, 200);
      assert.equal(response.headers.ETag, undefined);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('font replacement updates stylesheet version and its parent HTML validator', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-font-'));
  try {
    fs.mkdirSync(path.join(dir, 'fonts'));
    fs.writeFileSync(path.join(dir, 'fonts/font.woff2'), 'font one');
    fs.writeFileSync(path.join(dir, 'fonts/site.css'), "@font-face{src:url('/fonts/font.woff2')}");
    fs.writeFileSync(path.join(dir, 'index.html'), '<link href="/fonts/site.css" rel="stylesheet">');
    const cache = createStaticCache(dir);
    const req = { method: 'GET', url: '/', headers: {} };
    const first = cache.response(path.join(dir, 'index.html'), req, 'text/html');
    fs.writeFileSync(path.join(dir, 'fonts/font.woff2'), 'updated font two');
    const next = cache.response(path.join(dir, 'index.html'), req, 'text/html');
    assert.notEqual(first.headers.ETag, next.headers.ETag);
    const stylesheetUrl = next.body.toString().match(/href="([^"]+)"/)[1];
    const css = cache.response(path.join(dir, 'fonts/site.css'), { ...req, url: stylesheetUrl }, 'text/css');
    assert.match(css.headers['Cache-Control'], /immutable/);
    assert.match(css.body.toString(), /font\.woff2\?v=[a-f0-9]{20}/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('warm HTML and CSS requests reuse prepared output without repetitive hashing', () => {
  const crypto = require('node:crypto');
  const originalHash = crypto.createHash;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hm-static-perf-'));
  try {
    fs.mkdirSync(path.join(dir,'fonts'));
    fs.writeFileSync(path.join(dir,'fonts/site.woff2'),'font-one');
    fs.writeFileSync(path.join(dir,'style.css'),"@font-face{src:url('/fonts/site.woff2')}");
    fs.writeFileSync(path.join(dir,'index.html'),'<link href="style.css" rel="stylesheet"><h1>Hi</h1>');
    const cache=createStaticCache(dir);
    const page=path.join(dir,'index.html'),req={method:'GET',url:'/',headers:{}};
    let hashCount=0;
    crypto.createHash=function(...args){hashCount++;return originalHash.apply(this,args);};
    const first=cache.response(page,req,'text/html');
    const hashAfterFirst=hashCount;
    assert.ok(hashAfterFirst>0,'cold request must prepare and hash representations');
    for(let i=0;i<40;i++){
      const cached=cache.response(page,req,'text/html');
      assert.equal(cached.body,first.body,'must reuse the same prepared Buffer');
      assert.equal(cached.headers.ETag,first.headers.ETag);
    }
    assert.equal(hashCount,hashAfterFirst,'warm HTML requests must not repeat SHA256');
    const css=path.join(dir,'style.css');
    const firstCss=cache.response(css,{...req,url:'/style.css'},'text/css');
    const hashesAfterCss=hashCount;
    for(let i=0;i<20;i++){
      const warm=cache.response(css,{...req,url:'/style.css'},'text/css');
      assert.equal(warm.body,firstCss.body);
    }
    assert.equal(hashCount,hashesAfterCss,'warm CSS requests must not repeat SHA256');
    fs.writeFileSync(path.join(dir,'fonts/site.woff2'),'font-two-with-new-content');
    const next=cache.response(page,req,'text/html');
    assert.notEqual(next.headers.ETag,first.headers.ETag,'changed nested font invalidates parent HTML');
    assert.notEqual(next.body,first.body);
    assert.ok(hashCount>hashesAfterCss,'dependency changes must trigger re-render');
  } finally {
    crypto.createHash=originalHash;
    fs.rmSync(dir,{recursive:true,force:true});
  }
});


test('large static files are streamed with stable ETags and no retained file bodies', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hm-static-stream-'));
  try {
    const pdf=path.join(dir,'guide.pdf');
    fs.writeFileSync(pdf,Buffer.alloc(1024,7));
    const cache=createStaticCache(dir,{maxCacheBytes:256,maxAssetBytes:128});
    const req={method:'GET',url:'/guide.pdf',headers:{}};
    const first=cache.response(pdf,req,'application/pdf');
    assert.equal(first.status,200);
    assert.equal(first.body,null);
    assert.equal(first.streamPath,pdf);
    assert.match(first.headers.ETag,/^W\//,'streamed assets must use weak metadata validators');
    assert.equal(cache.stats().resident_bytes,0);
    const check=cache.response(pdf,{...req,headers:{'if-none-match':first.headers.ETag}},'application/pdf');
    assert.equal(check.status,304);
    fs.writeFileSync(pdf,Buffer.alloc(1024,8));
    const changed=cache.response(pdf,req,'application/pdf');
    assert.notEqual(changed.headers.ETag,first.headers.ETag);
    assert.equal(cache.stats().resident_bytes,0);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('small assets are LRU-limited without losing their content on the next request', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hm-static-bounded-'));
  try {
    const cache=createStaticCache(dir,{maxCacheBytes:140,maxAssetBytes:120});
    const paths=['a.js','b.js','c.js'].map(name=>path.join(dir,name));
    paths.forEach((p,i)=>fs.writeFileSync(p,String(i).repeat(90)));
    const req={method:'GET',url:'/a.js',headers:{}};
    paths.forEach(p=>assert.equal(cache.response(p,req,'application/javascript').body.length,90));
    assert.ok(cache.stats().resident_bytes<=140);
    assert.equal(cache.response(paths[0],req,'application/javascript').body.toString(),'0'.repeat(90));
    assert.ok(cache.stats().resident_bytes<=140);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('large static assets never synchronously read every byte to generate ETags', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hm-static-nonblocking-'));
  const file=path.join(dir,'large-image.webp');
  fs.writeFileSync(file,Buffer.alloc(512*1024,1));
  const original=fs.readSync;
  try {
    fs.readSync=()=>{throw new Error('synchronous full-file read blocked the event loop');};
    const cache=createStaticCache(dir,{maxAssetBytes:1024});
    const response=cache.response(file,{method:'GET',url:'/large-image.webp',headers:{}},'image/webp');
    assert.equal(response.body,null);
    assert.equal(response.streamPath,file);
    assert.match(response.headers.ETag,/^W\//);
  } finally {
    fs.readSync=original;
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
