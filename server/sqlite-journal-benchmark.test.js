'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {parseArgs,validateOfflineSource,runBenchmark}=require('../scripts/sqlite-journal-benchmark');

test('SQLite benchmark validates arguments and blocks live or persistent databases',()=>{
  assert.deepEqual(parseArgs([]),{source:null,transactions:80});
  assert.deepEqual(parseArgs(['--transactions','24']),{source:null,transactions:24});
  assert.throws(()=>parseArgs(['--transactions','1']),/Transactions/);
  assert.throws(()=>parseArgs(['--source']),/Usage/);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hm-bench-safety-'));
  try{
    const live=path.join(dir,'taiga.db');
    const backup=path.join(dir,'offline-backup.db');
    fs.writeFileSync(live,'SQLite format 3');
    fs.writeFileSync(backup,'SQLite format 3');
    assert.throws(()=>validateOfflineSource(live),/Refusing a live database/);
    assert.equal(validateOfflineSource(backup),backup);
    const previous=process.env.DATA_DIR;
    try{
      process.env.DATA_DIR=dir;
      assert.throws(()=>validateOfflineSource(backup),/under DATA_DIR/);
    }finally{
      if(previous===undefined)delete process.env.DATA_DIR;
      else process.env.DATA_DIR=previous;
    }
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('offline WAL/DELETE comparison runs on temporary copies without modifying a supplied backup',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hm-bench-offline-'));
  const source=path.join(dir,'offline-backup.db');
  const database=new DatabaseSync(source);
  try{
    database.exec('CREATE TABLE preserved(id INTEGER PRIMARY KEY, amount INTEGER); INSERT INTO preserved VALUES(1,250)');
  }finally{database.close();}
  const before=createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  try{
    const result=runBenchmark({source,transactions:10});
    assert.equal(result.source,'offline-backup');
    assert.deepEqual(result.trial_order,['wal','delete','delete','wal']);
    assert.equal(result.transactions_per_trial,10);
    assert.equal(result.trials.length,4);
    for(const row of result.trials){
      assert.equal(row.synchronous,2,'FULL durability is identical across modes');
      assert.ok(row.write_total_ms>=0);
      assert.ok(row.write_p95_ms>=0);
      assert.ok(row.read_p95_ms>=0);
      assert.ok(['written','blocked'].includes(row.write_with_open_reader));
      assert.ok(row.db_bytes>0);
      assert.ok(row.wal_bytes>=0);
    }
    assert.equal(createHash('sha256').update(fs.readFileSync(source)).digest('hex'),before);
    const readonly=new DatabaseSync(source,{readOnly:true});
    try{assert.equal(readonly.prepare('SELECT amount FROM preserved WHERE id=1').get().amount,250);}
    finally{readonly.close();}
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('synthetic benchmark does not require a production backup or credentials',()=>{
  const result=runBenchmark({transactions:10});
  assert.equal(result.source,'generated-fixture');
  assert.equal(result.trials.length,4);
  assert.match(result.warning,/Do not switch live WAL/);
});
