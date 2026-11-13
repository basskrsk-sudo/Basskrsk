'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStaticCache } = require('./static-cache');

test('production async static cache keeps CSS, image, ETag and no-store behavior', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-static-async-'));
  const fonts = path.join(dir, 'fonts'), images = path.join(dir,'images');
  const html = path.join(dir,'index.html');
  const css = path.join(fonts,'site.css'), font = path.join(fonts,'site.woff2');
  try {
    fs.mkdirSync(fonts); fs.mkdirSync(images);
    fs.writeFileSync(html,'<link href="/fonts/site.css" rel="stylesheet"><img src="/images/a.webp">');
    fs.writeFileSync(css,"@font-face{src:url('/fonts/site.woff2')}");
    fs.writeFileSync(font, 'font original');
    fs.writeFileSync(path.join(images,'a.webp'),'original image');
    const cache = createStaticCache(dir);
    const req = { method:'GET',url:'/',headers:{} };

    const originalRead = fs.readFileSync, originalStat=fs.statSync;
    let first;
    // Requests must use the async filesystem API even on cold-cache misses.
    fs.readFileSync = () => { throw new Error('sync read during HTTP request'); };
    fs.statSync = () => { throw new Error('sync stat during HTTP request'); };
    try {
      first=await cache.responseAsync(html,req,'text/html');
      const again=await cache.responseAsync(html,req,'text/html');
      assert.equal(again.body,first.body,'warm HTML must reuse prepared Buffer');
      assert.equal(again.headers.ETag,first.headers.ETag);
      const cssVersion=first.body.toString().match(/href="([^"]+)"/)?.[1];
      const cssResult=await cache.responseAsync(css,{...req,url:cssVersion},'text/css');
      assert.match(cssResult.body.toString(),/site\.woff2\?v=[0-9a-f]{20}/);
      assert.equal(cssResult.headers['Cache-Control'],'public, max-age=31536000, immutable');
      assert.equal((await cache.responseAsync(html,{...req,headers:{'if-none-match':first.headers.ETag}},'text/html')).status,304);
      assert.equal((await cache.responseAsync(path.join(dir,'miniapp.html'),req,'text/html').catch(e=>e)).code,'ENOENT');
    } finally {
      fs.readFileSync=originalRead; fs.statSync=originalStat;
    }

    fs.writeFileSync(font,'font new and different');
    const newer=await cache.responseAsync(html,req,'text/html');
    assert.notEqual(newer.headers.ETag,first.headers.ETag,
      'nested font changes must invalidate CSS and parent HTML');
    assert.notEqual(newer.body.toString(),first.body.toString());

    fs.writeFileSync(path.join(dir,'miniapp.html'),'<h1>Login</h1>');
    const privatePage=await cache.responseAsync(path.join(dir,'miniapp.html'),
      {...req,url:'/miniapp.html',headers:{'if-none-match':'*'}},'text/html');
    assert.equal(privatePage.headers['Cache-Control'],'no-store');
    assert.equal(privatePage.status,200);
    assert.equal(privatePage.headers.ETag,undefined);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('async static cache streams large resources and avoids resident full-file buffers', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hm-static-async-large-'));
  try {
    const p=path.join(dir,'big.pdf');
    fs.writeFileSync(p,Buffer.alloc(700*1024,22));
    const cache=createStaticCache(dir,{maxAssetBytes:1024,maxCacheBytes:4096});
    const req={method:'GET',url:'/big.pdf',headers:{}};
    const first=await cache.responseAsync(p,req,'application/pdf');
    assert.equal(first.body,null);
    assert.equal(first.streamPath,p);
    assert.match(first.headers.ETag,/^W\//);
    assert.equal(cache.stats().resident_bytes,0);
    const second=await cache.responseAsync(p,{...req,headers:{'if-none-match':first.headers.ETag}},'application/pdf');
    assert.equal(second.status,304);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('HTTP static-file handler uses the asynchronous response path',()=>{
  const s=fs.readFileSync(path.join(__dirname,'server.js'),'utf8');
  assert.match(s,/fs\.stat\(filePath, async \(err, stat\) =>/);
  assert.match(s,/await staticCache\.responseAsync\(/);
  assert.doesNotMatch(s,/staticCache\.response\(/);
});
