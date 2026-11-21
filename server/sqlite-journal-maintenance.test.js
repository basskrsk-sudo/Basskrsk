'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {DatabaseSync}=require('node:sqlite');
const {maybeMigrateJournalAtBoot,CONFIRM}=require('./sqlite-journal-maintenance');
// Test-only dummy hash; not an operator's backup proof.
const HASH='0'.repeat(64);
function fixture(mode='wal'){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hm-journal-maint-'));
  const file=path.join(dir,'taiga.db');
  const db=new DatabaseSync(file);
  db.exec('PRAGMA journal_mode='+mode.toUpperCase());
  db.exec('CREATE TABLE admins(id INTEGER PRIMARY KEY);'+
    'CREATE TABLE products(id INTEGER PRIMARY KEY);'+
    'CREATE TABLE orders(id INTEGER PRIMARY KEY,total INTEGER);'+
    'CREATE TABLE order_items(id INTEGER PRIMARY KEY);'+
    'CREATE TABLE stock(id INTEGER PRIMARY KEY);'+
    'CREATE TABLE customers(id INTEGER PRIMARY KEY);'+
    'INSERT INTO orders VALUES(1,250); INSERT INTO orders VALUES(2,360);');
  db.close();
  return {dir,file};
}
function run(dir,target){
  return maybeMigrateJournalAtBoot({dataDir:dir,target,confirmation:CONFIRM,backupProof:HASH});
}
function read(file) {
  const db=new DatabaseSync(file,{readOnly:true});
  try {
    return {mode:db.prepare('PRAGMA journal_mode').get().journal_mode,
      orders:db.prepare('SELECT COUNT(*) AS n FROM orders').get().n,
      total:db.prepare('SELECT SUM(total) AS n FROM orders').get().n,
      integrity:db.prepare('PRAGMA integrity_check').get().integrity_check};
  }finally{db.close();}
}
test('disabled mode performs no disk operations',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hm-journal-off-'));
  try{
    assert.deepEqual(maybeMigrateJournalAtBoot({dataDir:dir,target:''}),{skipped:true});
    assert.deepEqual(fs.readdirSync(dir),[]);
  }finally{fs.rmSync(dir,{force:true,recursive:true});}
});
test('missing explicit confirmation blocks journal migration',()=>{
  const {dir,file}=fixture();
  try{
    assert.throws(()=>maybeMigrateJournalAtBoot({dataDir:dir,target:'delete'}),/refused/);
    assert.throws(()=>maybeMigrateJournalAtBoot({dataDir:dir,target:'delete',
      confirmation:CONFIRM,backupProof:'not-a-hash'}),/refused/);
    assert.throws(()=>maybeMigrateJournalAtBoot({dataDir:dir,target:'off',
      confirmation:CONFIRM,backupProof:HASH}),/refused/);
    assert.equal(read(file).mode,'wal');
  }finally{fs.rmSync(dir,{force:true,recursive:true});}
});
test('offline WAL to DELETE preserves data, creates verified backup, and is idempotent',()=>{
  const {dir,file}=fixture();
  try{
    const result=run(dir,'delete');
    assert.equal(result.switched,true);
    assert.equal(result.from,'wal');
    assert.equal(result.to,'delete');
    assert.deepEqual(read(file),{mode:'delete',orders:2,total:610,integrity:'ok'});
    const backup=path.join(result.backupDir,result.safetyBackup);
    assert.equal(read(backup).orders,2);
    assert.equal(read(backup).integrity,'ok');
    assert.equal(run(dir,'delete').alreadyConfigured,true);
    assert.equal(fs.readdirSync(result.backupDir).length,1);
  }finally{fs.rmSync(dir,{force:true,recursive:true});}
});
test('separate confirmed maintenance can revert DELETE to WAL without restoring orders',()=>{
  const {dir,file}=fixture('delete');
  try{
    const result=run(dir,'wal');
    assert.equal(result.switched,true);
    assert.equal(result.from,'delete');
    assert.equal(read(file).mode,'wal');
    assert.equal(read(file).total,610);
  }finally{fs.rmSync(dir,{force:true,recursive:true});}
});
test('active WAL reader prevents change; existing database remains WAL',()=>{
  const {dir,file}=fixture();
  const reader=new DatabaseSync(file,{readOnly:true});
  try{
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) FROM orders').get();
    assert.throws(()=>run(dir,'delete'),/busy|locked|checkpoint|reader/i);
    assert.equal(read(file).mode,'wal');
  }finally{
    reader.exec('ROLLBACK');reader.close();
    fs.rmSync(dir,{force:true,recursive:true});
  }
});
test('no current DB never causes a new empty database to be created',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hm-journal-missing-'));
  try{
    assert.throws(()=>run(dir,'delete'),/existing taiga.db not found/);
    assert.deepEqual(fs.readdirSync(dir),[]);
  }finally{fs.rmSync(dir,{force:true,recursive:true});}
});
test('migration is invoked only before application startup opens db.js',()=>{
  const source=fs.readFileSync(path.join(__dirname,'server.js'),'utf8');
  const restore=source.indexOf("require('./database-restore').applyPendingDatabaseRestore()");
  const journal=source.indexOf("require('./sqlite-journal-maintenance').maybeMigrateJournalAtBoot()");
  const server=source.indexOf("const http = require('node:http')");
  assert.ok(restore>=0 && restore<journal && journal<server);
});
