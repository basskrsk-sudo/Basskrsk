'use strict';
// Opt-in SQLite maintenance at process boot BEFORE db.js/HTTP are loaded.
// Normal startup does no filesystem or database work in this module.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const CONFIRM = 'OFFSITE_BACKUP_VERIFIED_SINGLE_REPLICA_MAINTENANCE';
const REQUIRED = ['admins','products','orders'];
const COMPARE_TABLES = ['orders','order_items','stock','customers','products'];
function inspect(database) {
  const integrity=database.prepare('PRAGMA integrity_check').all();
  if(integrity.length!==1||Object.values(integrity[0])[0]!=='ok')
    throw new Error('SQLite integrity_check failed');
  if(database.prepare('PRAGMA foreign_key_check').all().length)
    throw new Error('SQLite foreign_key_check failed');
  const names=new Set(database.prepare(
    "SELECT name FROM sqlite_schema WHERE type='table' "+
    "AND name IN ('admins','products','orders','order_items','stock','customers')"
  ).all().map(x=>x.name));
  if(!REQUIRED.every(name=>names.has(name)))
    throw new Error('SQLite database is missing core tables');
  const counts={};
  for(const table of COMPARE_TABLES){
    if(names.has(table))counts[table]=database.prepare(
      'SELECT COUNT(*) AS n FROM "'+table+'"').get().n;
  }
  // VACUUM INTO does not guarantee preserving schema_version header.
  // Fingerprint actual schema SQL rather than an implementation counter.
  const schema=database.prepare(
    "SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name"
  ).all();
  const schemaFingerprint=createHash('sha256').update(JSON.stringify(schema)).digest('hex');
  return {counts,schemaFingerprint};
}
function same(a,b) {
  return a.schemaFingerprint===b.schemaFingerprint &&
    JSON.stringify(a.counts)===JSON.stringify(b.counts);
}
function journalMode(database){
  return String(database.prepare('PRAGMA journal_mode').get()?.journal_mode||'').toLowerCase();
}
function maybeMigrateJournalAtBoot({
  dataDir=process.env.DATA_DIR||path.join(__dirname,'..','data'),
  target=process.env.HM_SQLITE_JOURNAL_TARGET||'',
  confirmation=process.env.HM_SQLITE_MAINTENANCE_CONFIRMED||'',
  backupProof=process.env.HM_SQLITE_OFFSITE_BACKUP_SHA256||'',
}={}) {
  if(!target)return {skipped:true};
  const to=String(target).toLowerCase();
  if(!['wal','delete'].includes(to)||confirmation!==CONFIRM||
     !/^[a-f0-9]{64}$/i.test(String(backupProof)))
    throw new Error('Journal switch refused: target, maintenance confirmation and offsite SHA-256 are required');
  const file=path.join(dataDir,'taiga.db');
  if(!fs.existsSync(file)||!fs.statSync(file).isFile())
    throw new Error('Journal switch refused: existing taiga.db not found');
  let database;
  try {
    database=new DatabaseSync(file);
    database.exec('PRAGMA busy_timeout=3000');
    const from=journalMode(database);
    if(from===to)return {skipped:true,alreadyConfigured:true,mode:to};
    if(!['wal','delete'].includes(from))
      throw new Error('Journal switch refused: unexpected current SQLite mode');
    const before=inspect(database);
    // On-volume snapshot is an extra safety copy, NOT a replacement for
    // a separately downloaded and verified offsite backup.
    const backupDir=path.join(dataDir,'.sqlite-maintenance-backups');
    fs.mkdirSync(backupDir,{recursive:true,mode:0o700});
    const destination=path.join(backupDir,
      'taiga-before-'+to+'-'+Date.now()+'-'+randomUUID()+'.db');
    database.exec("VACUUM INTO '"+destination.replace(/'/g,"''")+"'");
    let backup;
    try {
      backup=new DatabaseSync(destination,{readOnly:true});
      if(!same(before,inspect(backup)))throw new Error('Safety snapshot mismatch');
    }finally{backup?.close();}
    if(from==='wal'){
      const ck=database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if(!ck||Number(ck.busy)!==0)
        throw new Error('WAL checkpoint busy: other connections may be active');
    }
    const applied=String(database.prepare('PRAGMA journal_mode='+to.toUpperCase()).get()?.journal_mode||'').toLowerCase();
    if(applied!==to)throw new Error('SQLite refused requested journal mode');
    if(!same(before,inspect(database)))
      throw new Error('Journal mode changed but validation failed; manual review required');
    return {switched:true,from,to,backupDir,safetyBackup:path.basename(destination)};
  } finally {
    // Never automatically overwrite an existing DB with an older snapshot.
    // A failed verification aborts startup for manual investigation.
    database?.close();
  }
}
module.exports={maybeMigrateJournalAtBoot,CONFIRM};
