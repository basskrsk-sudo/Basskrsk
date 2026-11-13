'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {collectPetNewsSources,createPetNewsService}=require('./pet-news-digest');
const {runPetNewsWorker}=require('./pet-news-worker-runner');

const day=Date.parse('2026-11-13T07:00:00Z');
const sources=Array.from({length:5},(_,i)=>({
  name:'News source '+i,kind:'website',url:'https://pet-vending-'+i+'.example/',
}));
const html=Array.from({length:70},(_,i)=>(
  '<article><h2><a href="/news/pet-vending-dog-treats-'+i+'">'+
  'Pet vending machine dog treats test article number '+i+
  '</a></h2><p>Automated pet retail in grooming shops.</p></article>'
)).join('');

function tracedDatabase() {
  const real=new DatabaseSync(':memory:');
  const seen=[];
  const db=new Proxy(real,{
    get(target,prop){
      if(prop==='prepare')return sql=>{seen.push({method:'prepare',sql});return target.prepare(sql);};
      if(prop==='exec')return sql=>{seen.push({method:'exec',sql});return target.exec(sql);};
      const value=Reflect.get(target,prop,target);
      return typeof value==='function'?value.bind(target):value;
    },
  });
  return {db,real,seen};
}

test('sequential source parsing is bounded and fairly samples all sources',async()=>{
  const result=await collectPetNewsSources(sources,async()=>({
    ok:true,headers:{get:()=>null},text:async()=>html,
  }));
  assert.equal(result.healthy,5);
  assert.equal(result.total,5);
  assert.equal(result.candidates,180);
  assert.equal(result.articles.length,180);
  assert.equal(new Set(result.articles.map(x=>x.url)).size,180);
  assert.ok(result.articles.some(x=>x.url.includes('pet-vending-4.example')));
  assert.equal(result.sources.length,5);
  assert.ok(result.sources.every(x=>x.count===50));
});

test('database updates use one short transaction and at most 8 batched article INSERTs',async()=>{
  const {db,real,seen}=tracedDatabase();
  const messages=[];
  const service=createPetNewsService({db,
    send:async(id,message)=>{messages.push(message);return {ok:true}},
    fetchFn:async()=>({ok:true,headers:{get:()=>null},text:async()=>html}),
    isAuthorized:()=>true,clock:()=>day,sources,
  });
  try{
    const result=await service.refresh({minInterval:0});
    assert.equal(result.updated,180);
    assert.equal(result.candidates,180);
    assert.ok(result.db_ms>=0);
    assert.ok(result.duration_ms>=0);
    assert.equal(real.prepare('SELECT COUNT(*) AS n FROM pet_news_articles').get().n,180);
    const inserts=seen.filter(x=>x.method==='prepare'&&
      x.sql.startsWith('INSERT OR IGNORE INTO pet_news_articles '));
    assert.equal(inserts.length,8,'180 articles should take 8 prepared multi-row inserts');
    assert.equal(seen.filter(x=>x.method==='exec'&&x.sql==='BEGIN').length,1);
    assert.equal(seen.filter(x=>x.method==='exec'&&x.sql==='COMMIT').length,1);
    assert.equal(real.prepare("SELECT value FROM pet_news_meta WHERE key='last_added'").get().value,'180');
    await service.processCommand('123','/news_status');
    assert.match(messages.at(-1),/Длительность:/);
    assert.match(messages.at(-1),/SQLite:/);
    assert.match(messages.at(-1),/Отобрано: 180/);
    assert.match(fs.readFileSync(path.join(__dirname,'site-health.js'),'utf8'),
      /news_collector:newsCollectorSnapshot\(\)/);
    await service.processCommand('123','/news_on');
    await service.dailyTick();
    const previous=seen.length;
    service.listCandidates('123',true);
    const selections=seen.slice(previous);
    assert.ok(selections.some(x=>x.method==='prepare'&&x.sql.includes('NOT EXISTS')),
      'daily delivery exclusion should be one SQL anti-join');
    assert.equal(selections.filter(x=>x.method==='prepare' && x.sql.trim().startsWith('SELECT 1 FROM pet_news_delivery')).length,0,
      'no per-article delivered check');
  } finally {service.stop();real.close();}
});

test('worker process is bounded, isolated and shares one in-flight refresh',async()=>{
  const first=runPetNewsWorker([]);
  const second=runPetNewsWorker([]);
  assert.strictEqual(first,second,'at most one worker may run concurrently');
  const result=await first;
  assert.deepEqual(result.articles,[]);
  assert.equal(result.healthy,0);
  assert.equal(result.total,0);
  assert.ok(result.workerMs>=0);
  await assert.rejects(runPetNewsWorker(Array.from({length:13},()=>({}))),/Too many news sources/);
  const worker=fs.readFileSync(path.join(__dirname,'pet-news-worker.js'),'utf8');
  assert.doesNotMatch(worker,/require\(['"]\.\/db['"]\)/);
  assert.doesNotMatch(worker,/OPENAI_API_KEY|TG_TOKEN|customer_phone/);
});

test('a failed source is isolated and does not rollback valid source articles',async()=>{
  const {db,real}=tracedDatabase();
  const sourceSet=[sources[0],sources[1]];
  const service=createPetNewsService({db,send:async()=>({ok:true}),clock:()=>day,
    isAuthorized:()=>true,sources:sourceSet,fetchFn:async url=>{
      if(url===sources[0].url)throw Error('HTTP 403');
      return {ok:true,headers:{get:()=>null},text:async()=>html};
    }});
  try{
    const result=await service.refresh({minInterval:0});
    assert.equal(result.healthy,1);
    assert.equal(result.updated,50);
    assert.equal(real.prepare('SELECT COUNT(*) AS n FROM pet_news_articles').get().n,50);
    assert.match(real.prepare('SELECT error FROM pet_news_sources WHERE source=?')
      .get(sources[0].name).error,/HTTP 403/);
  }finally{service.stop();real.close();}
});
