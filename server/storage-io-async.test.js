'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hm-salon-snapshot-async-'));
process.env.DATA_DIR=dir;
const db=require('./db');
const {SNAPSHOT_PATH,writeSalonPagesSnapshot}=require('./salon-page-storage');
const code=fs.readFileSync(path.join(__dirname,'routes-products.js'),'utf8');

function setSalon(text){
  db.prepare('UPDATE points SET salon_description=?,salon_page_updated_at=? WHERE id=?')
    .run(text,new Date().toISOString(),'snapshot-async-point');
}
db.prepare("INSERT INTO points(id,name,addr,icon,active,is_hub,salon_tagline,salon_description) VALUES(?,?,?,?,?,0,?,?)")
  .run('snapshot-async-point','Snapshot test salon','Красноярск, тест 1','🐾',1,'Салон','Изначально');

test('insurance snapshots serialize concurrent writes and never block the Node event loop',async()=>{
  const original=fs.promises.writeFile;
  let running=0,peak=0,entered;
  const firstStarted=new Promise(resolve=>entered=resolve);
  fs.promises.writeFile=async function(file,...rest){
    if(String(file).startsWith(SNAPSHOT_PATH)){
      running++;peak=Math.max(peak,running);
      if(running===1)entered();
      await new Promise(resolve=>setTimeout(resolve,30));
      try{return await original.call(this,file,...rest)}
      finally{running--;}
    }
    return original.call(this,file,...rest);
  };
  try {
    setSalon('Версия 1');
    const first=writeSalonPagesSnapshot();
    await firstStarted;
    setSalon('Версия 2');
    const second=writeSalonPagesSnapshot();
    let timerRan=false;
    await new Promise(resolve=>setTimeout(()=>{timerRan=true;resolve();},0));
    assert.equal(timerRan,true,'other requests must keep processing while snapshot is written');
    assert.equal(await first,1);
    assert.equal(await second,1);
    assert.equal(peak,1,'concurrent updates must never write snapshot files simultaneously');
    const json=JSON.parse(await fs.promises.readFile(SNAPSHOT_PATH,'utf8'));
    assert.equal(json.salons.find(s=>s.id==='snapshot-async-point').salon_description,'Версия 2',
      'slow earlier write must not overwrite a newer snapshot');
  }finally {fs.promises.writeFile=original;}
});

test('a failed insurance snapshot does not poison subsequent writes or change SQLite',async()=>{
  const original=fs.promises.writeFile;
  let failOnce=true;
  fs.promises.writeFile=async function(file,...rest){
    if(failOnce && String(file).startsWith(SNAPSHOT_PATH)){
      failOnce=false;throw new Error('Simulated persistent storage hiccup');
    }
    return original.call(this,file,...rest);
  };
  try {
    setSalon('После сбоя');
    await assert.rejects(writeSalonPagesSnapshot(),/Simulated persistent storage hiccup/);
    await writeSalonPagesSnapshot();
    const json=JSON.parse(await fs.promises.readFile(SNAPSHOT_PATH,'utf8'));
    assert.equal(json.salons[0].salon_description,'После сбоя');
    assert.equal(db.prepare('SELECT salon_description FROM points WHERE id=?')
      .get('snapshot-async-point').salon_description,'После сбоя');
  }finally {fs.promises.writeFile=original;}
});

test('upload and salon mutation endpoints contain no blocking filesystem calls',()=>{
  assert.doesNotMatch(code,/fs\.(?:writeFile|readFile|unlink|rename|mkdir|stat|exists)Sync\(/);
  assert.match(code,/router\.put\('\/api\/points\/:id\/salon-page', async/);
  assert.match(code,/await writeSalonPagesSnapshot\(\)/);
  assert.match(code,/await fs\.promises\.rename\(tempPath, fallbackPath\)/);
  assert.match(code,/await fs\.promises\.writeFile\(tempPath, buffer\)/);
  assert.match(code,/The authoritative DB write succeeded/);
});
