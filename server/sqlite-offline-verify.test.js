'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {parseArgs,sha256,verifyOfflineBackup}=require('../scripts/sqlite-offline-verify');
function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hm-verify-fixture-'));
  const file=path.join(dir,'taiga-backup-test.db');
  const db=new DatabaseSync(file);
  db.exec('CREATE TABLE admins(id INTEGER PRIMARY KEY);'+
    'CREATE TABLE products(id INTEGER PRIMARY KEY);'+
    'CREATE TABLE orders(id INTEGER PRIMARY KEY, product_id INTEGER REFERENCES products(id));'+
    'INSERT INTO products VALUES(1); INSERT INTO orders VALUES(1,1)');
  db.close();
  return {dir,file};
}
test('verification requires an explicitly named offline SQLite backup',()=>{
  assert.deepEqual(parseArgs(['--source','offline-copy.db']),{source:'offline-copy.db'});
  assert.throws(()=>parseArgs([]),/Usage/);
  assert.throws(()=>parseArgs(['--source','taiga.db','--json']),/Usage/);
});
test('checks a private copy and leaves source backup byte-identical',async()=>{
  const {dir,file}=fixture();
  try{
    const oldSha=await sha256(file);
    const result=await verifyOfflineBackup(file);
    assert.equal(result.result,'pass');
    assert.equal(result.integrity_check,'ok');
    assert.equal(result.foreign_key_violations,0);
    assert.equal(result.journal_mode,'delete');
    assert.equal(result.required_tables_present,true);
    assert.equal(result.source_unchanged,true);
    assert.equal(result.source_sha256,oldSha);
    assert.equal(await sha256(file),oldSha,'original source cannot be altered');
    assert.ok(!fs.existsSync(file+'-wal'),'verification may not create WAL files beside source');
    assert.ok(!fs.existsSync(file+'-shm'),'verification may not create SHM files beside source');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('rejects a copy with inconsistent foreign keys without disclosing rows',async()=>{
  const {dir,file}=fixture();
  try{
    const db=new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys=OFF; INSERT INTO orders VALUES(2,999)');
    db.close();
    const original=await sha256(file);
    await assert.rejects(verifyOfflineBackup(file),/Foreign key integrity failed/);
    assert.equal(await sha256(file),original);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('rejects malformed or incomplete backup and WAL/SHM sidecars',async()=>{
  const {dir,file}=fixture();
  try{
    fs.writeFileSync(file+'-wal','not a valid snapshot');
    await assert.rejects(verifyOfflineBackup(file),/Sidecar WAL\/SHM/);
    fs.rmSync(file+'-wal');
    fs.writeFileSync(file,'not sqlite data');
    await assert.rejects(verifyOfflineBackup(file),/Invalid SQLite header/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('preserves existing WAL mode on a self-contained offline backup',async()=>{
  const {dir,file}=fixture();
  try{
    const db=new DatabaseSync(file);
    db.exec('PRAGMA journal_mode=WAL;');
    db.close();
    const result=await verifyOfflineBackup(file);
    assert.equal(result.result,'pass');
    assert.equal(result.journal_mode,'wal');
    assert.equal(result.source_unchanged,true);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('rejects live filename even when all SQLite content is valid',async()=>{
  const {dir,file}=fixture();
  try{
    const live=path.join(dir,'taiga.db');
    fs.copyFileSync(file,live);
    await assert.rejects(verifyOfflineBackup(live),/Refusing a live database/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
