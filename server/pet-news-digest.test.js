'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const digest=require('./pet-news-digest');
const tg={name:'PRO Зообизнес',kind:'telegram',handle:'zoobusiness',url:'https://t.me/s/zoobusiness'};
const market={name:'GlobalPETS',kind:'website',url:'https://globalpetindustry.com/'};
const articleTitle='Pet vending machine for dog treats opens in shopping malls';
const tgHtml=`<div class="tgme_widget_message" data-post="zoobusiness/1234"><div class="tgme_widget_message_text js-message_text">Сеть зоомагазинов открывает новые вендинг автоматы для лакомств собак &amp; кошек.</div><time datetime="2026-11-12T08:00:00Z"></time></div>`;
const otherHtml=`<article><h2><a href="/latest/pet-vending-machine-in-grooming-salons">${articleTitle}</a></h2><p>Pet shops are testing dog treat vending machines in grooming salons.</p><time datetime="2026-11-12T09:00:00Z"></time></article>`;
const fixed=Date.parse('2026-11-12T12:00:00Z');
function fixture(sources=[tg,market]){
  const db=new DatabaseSync(':memory:');const sent=[];
  let t=fixed;let count=0;
  const mockFetch=async(url)=>{
    count++;
    return {ok:true,headers:{get:()=>null},text:async()=>url.includes('t.me')?tgHtml:otherHtml};
  };
  const service=digest.createPetNewsService({db,send:async(id,text)=>{sent.push({id:String(id),text});return {ok:true};},fetchFn:mockFetch,clock:()=>t,isAuthorized:id=>String(id)==='101',sources});
  return {db,sent,service,mockFetch,get fetches(){return count},advance:n=>{t+=n},close:()=>{service.stop();db.close()}};
}
test('Telegram public preview is extracted, linked to source and filtered',()=>{
  const posts=digest.parseTelegram(tgHtml,tg);
  assert.equal(posts.length,1);
  assert.equal(posts[0].url,'https://t.me/zoobusiness/1234');
  assert.match(posts[0].snippet,/лакомств/);
  assert.ok(digest.scoreItem(posts[0]).score>=35);
});
test('source link allowlist prevents external and non-article links',()=>{
  const website=`<article><h2><a href="https://phishing.example/unsafe">${articleTitle}</a></h2></article><article><h2><a href="/news/zoovending">${articleTitle}</a></h2></article>`;
  const posts=digest.parseWebsite(website,market);
  assert.deepEqual(posts.map(x=>x.url),['https://globalpetindustry.com/news/zoovending']);
  assert.equal(digest.safeUrl('http://insecure.example','https://globalpetindustry.com/',market.name),'');
});
test('spam is rejected and similar cross-source headlines deduplicate',()=>{
  assert.equal(digest.scoreItem({title:'Casino betting pet vending',snippet:'online casino'}),null);
  assert.equal(digest.duplicate({url:'a',title:'New pet vending machines open in grooming salons'},{url:'b',title:'New pet vending machines open in grooming salons'}),true);
});
test('unauthorized private user cannot subscribe or fetch sources',async()=>{
  const f=fixture();
  assert.equal(await f.service.processCommand('bad','/news_on'),true);
  assert.equal(f.sent.length,1);
  assert.match(f.sent[0].text,/только привязанным администраторам/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM pet_news_subscribers').get().n,0);
  assert.equal(f.fetches,0);f.close();
});
test('manual refresh collects public sources and presents original links',async()=>{
  const f=fixture();
  const result=await f.service.refresh({minInterval:0});
  assert.equal(result.healthy,2);
  assert.equal(result.updated,2);
  await f.service.processCommand('101','/news');
  assert.match(f.sent[0].text,/https:\/\/t.me\/zoobusiness\/1234/);
  assert.match(f.sent[0].text,/Для ХвостМаркета/);
  assert.ok(f.sent[0].text.length<4096);f.close();
});
test('daily digest is opt-in and delivered once, without re-sending old articles',async()=>{
  const f=fixture();
  await f.service.dailyTick();assert.equal(f.fetches,0);
  await f.service.processCommand('101','/news_on');
  await f.service.dailyTick();
  const count=f.sent.length;
  assert.ok(count>=2);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM pet_news_delivery').get().n,2);
  await f.service.dailyTick();assert.equal(f.sent.length,count);
  f.advance(24*60*60_000);
  await f.service.dailyTick();
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM pet_news_delivery').get().n,2);
  assert.match(f.sent.at(-1).text,/нет новых подходящих/i);
  f.close();
});
test('topics can be switched off for one admin',async()=>{
  const f=fixture();await f.service.refresh({minInterval:0});
  await f.service.processCommand('101','/news_topic vending off');
  await f.service.processCommand('101','/news_topics');
  assert.match(f.sent.at(-1).text,/◻️ vending/);
  assert.equal(f.service.listCandidates('101').some(x=>x.topic==='vending'),false);
  f.close();
});
test('refresh cooldown avoids redundant network access',async()=>{
  const f=fixture();
  await f.service.refresh({minInterval:0});
  const before=f.fetches;
  const res=await f.service.refresh();
  assert.equal(res.skipped,true);
  assert.equal(f.fetches,before);
  f.close();
});
test('source errors are isolated; report exposes unavailable feed',async()=>{
  const db=new DatabaseSync(':memory:');const msgs=[];
  const src=[tg,market];
  const service=digest.createPetNewsService({db,send:async(_id,txt)=>{msgs.push(txt);return {ok:true};},fetchFn:async(url)=>{if(url.includes('t.me'))throw Error('HTTP 403');return {ok:true,headers:{get:()=>null},text:async()=>otherHtml};},clock:()=>fixed,isAuthorized:()=>true,sources:src});
  const result=await service.refresh({minInterval:0});
  assert.equal(result.healthy,1);
  assert.equal(result.updated,1);
  await service.processCommand('101','/news_status');
  assert.match(msgs[0],/HTTP 403/);
  db.close();
});
