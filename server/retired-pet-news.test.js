'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('pet news pilot, worker, sources and cron code are removed',()=>{
  for(const file of [
    'server/pet-news-digest.js','server/pet-news-digest.test.js',
    'server/pet-news-worker.js','server/pet-news-worker-runner.js',
    'server/pet-news-worker.test.js','server/pet-news-sources.json',
    '.github/workflows/pet-news-existing-bot.yml'
  ])assert.equal(fs.existsSync(path.join(root,file)),false,file);
  const bot=read('server/telegram-login-poller.js');
  assert.doesNotMatch(bot,/createPetNewsService|petNewsService|pet-news-digest|command: 'news/);
  assert.match(bot,/Сборщик новостей зоовендинга временно отключён/);
  const monitor=read('server/site-health.js');
  assert.doesNotMatch(monitor,/newsCollectorSnapshot|news_collector|pet_news_meta/);
  const ci=read('.github/workflows/miniapp-checks.yml');
  assert.doesNotMatch(ci,/pet-news-digest|pet-news-worker/);
});
test('manually authored company news and customer payments still exist',()=>{
  const routes=read('server/routes-news.js'),server=read('server/server.js');
  assert.match(routes,/router\.get\('\/api\/news\/public'/);
  assert.match(routes,/router\.post\('\/api\/news'/);
  assert.match(server,/registerNewsRoutes\(router\)/);
  assert.match(server,/registerPaymentRoutes\(router\)/);
  assert.match(read('server/bones.js'),/function spendBones\(/);
  assert.match(read('server/db.js'),/CREATE TABLE IF NOT EXISTS news/);
});
test('full weekly and BSC report runtimes are measured',()=>{
  const code=read('server/weekly-report.js');
  assert.match(code,/weekly_report_build/);
  assert.match(code,/weekly_bsc_build/);
  assert.doesNotMatch(code.split('function buildDaily(current, previous, period) {')[1].split('function buildOperations(period) {')[0],/paidOrders\.filter\(/);
});
