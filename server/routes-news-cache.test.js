'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createPublicNewsCache,PUBLIC_NEWS_TTL_MS}=require('./routes-news');
test('empty public news is cached without repeating a SQLite load',()=>{
  let now=0,queries=0;
  const cache=createPublicNewsCache(()=>{queries++;return [];},{clock:()=>now});
  assert.deepEqual(cache.get(),[]);
  assert.deepEqual(cache.get(),[]);
  assert.equal(queries,1);
  now=PUBLIC_NEWS_TTL_MS-1;
  cache.get();
  assert.equal(queries,1);
  now=PUBLIC_NEWS_TTL_MS;
  cache.get();
  assert.equal(queries,2,'cache eventually notices changes outside current process');
});
test('admin changes immediately invalidate cached public news',()=>{
  let queries=0;
  let rows=[];
  const cache=createPublicNewsCache(()=>{queries++;return rows;});
  assert.deepEqual(cache.get(),[]);
  rows=[{id:1,title:'Новая точка'}];
  assert.deepEqual(cache.get(),[],'old empty result remains cached until invalidation');
  cache.invalidate();
  assert.deepEqual(cache.get(),rows);
  assert.equal(queries,2);
});
test('news admin actions invalidate and public route only reads cached values',()=>{
  const source=fs.readFileSync(path.join(__dirname,'routes-news.js'),'utf8');
  assert.match(source,/sendJson\(res, 200, \{ news: publicNewsCache\.get\(\) \}\)/);
  const invalidations=(source.match(/publicNewsCache\.invalidate\(\)/g)||[]).length;
  assert.equal(invalidations,3,'create, edit and delete invalidate the cache');
});
