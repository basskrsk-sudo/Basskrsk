#!/usr/bin/env node
'use strict';
// Offline-only verifier. NEVER opens the source SQLite backup as a database.
// It validates a disposable private copy, without writing source, /data,
// orders, or a payment record. Not a procedure to modify a production DB.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {validateOfflineSource}=require('./sqlite-journal-benchmark');
const REQUIRED_TABLES=['admins','products','orders'];
function parseArgs(args){
  if(args.length!==2 || args[0]!=='--source' || !args[1])
    throw new Error('Usage: node scripts/sqlite-offline-verify.js --source OFFLINE_BACKUP.db');
  return {source:args[1]};
}
async function sha256(file){
  const hash=createHash('sha256');
  for await(const bytes of fs.createReadStream(file))hash.update(bytes);
  return hash.digest('hex');
}
async function sqliteHeader(file){
  const handle=await fs.promises.open(file,'r');
  try{
    const data=Buffer.alloc(16);
    const {bytesRead}=await handle.read(data,0,16,0);
    return bytesRead===16 && data.toString('utf8')==='SQLite format 3\0';
  }finally{await handle.close();}
}
function inspectDisposableDatabase(file){
  let database;
  try{
    database=new DatabaseSync(file,{readOnly:true});
    database.exec('PRAGMA busy_timeout=1000');
    const rawMode=database.prepare('PRAGMA journal_mode').get()?.journal_mode;
    const mode=String(rawMode||'').toLowerCase();
    const rows=database.prepare('PRAGMA integrity_check').all();
    const integrity=rows.length===1 && Object.values(rows[0])[0]==='ok';
    // Report only aggregate counts. Never output table contents or row IDs.
    const fk=database.prepare('PRAGMA foreign_key_check').all().length;
    const names=database.prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('admins','products','orders')"
    ).all();
    const present=new Set(names.map(row=>row.name));
    return {
      sqlite_header:true,
      integrity_check:integrity?'ok':'failed',
      foreign_key_violations:fk,
      required_tables_present:REQUIRED_TABLES.every(name=>present.has(name)),
      journal_mode:mode,
    };
  }finally{try{database?.close()}catch(_){}}
}
async function verifyOfflineBackup(requested){
  const source=validateOfflineSource(requested);
  // A raw copy made during a WAL transaction may rely on unshipped -wal
  // pages; reject it rather than pretending the main .db file is sufficient.
  if(fs.existsSync(source+'-wal') || fs.existsSync(source+'-shm'))
    throw new Error('Sidecar WAL/SHM exists: provide a standalone SQLite snapshot, not a live file copy');
  if(!await sqliteHeader(source))
    throw new Error('Invalid SQLite header in the offline backup');
  const oldStat=await fs.promises.stat(source);
  const oldSha=await sha256(source);
  const temp=await fs.promises.mkdtemp(path.join(os.tmpdir(),'hm-verify-backup-'));
  try{
    const copy=path.join(temp,'isolated-copy.db');
    await fs.promises.copyFile(source,copy);
    const newStat=await fs.promises.stat(source);
    const newSha=await sha256(source);
    const copySha=await sha256(copy);
    // Fail if a purported "offline" source was changed during verification.
    if(oldSha!==newSha || oldSha!==copySha || oldStat.size!==newStat.size ||
       oldStat.mtimeMs!==newStat.mtimeMs)
      throw new Error('Backup changed during verification: stop any writer and recopy a standalone snapshot');
    const checks=inspectDisposableDatabase(copy);
    if(checks.integrity_check!=='ok')throw new Error('SQLite integrity_check failed on the offline copy');
    if(checks.foreign_key_violations!==0)
      throw new Error('Foreign key integrity failed on the offline copy: '+
        checks.foreign_key_violations+' violations');
    if(!checks.required_tables_present)
      throw new Error('Offline SQLite copy does not contain required HvostMarket tables');
    return {
      result:'pass',
      source:'standalone_offline_backup',
      source_sha256:oldSha,
      size_bytes:oldStat.size,
      source_unchanged:true,
      ...checks,
      note:'Verified only a disposable copy. This does not measure Amvera /data performance or authorize a live journal-mode switch.',
    };
  }finally{
    await fs.promises.rm(temp,{recursive:true,force:true});
  }
}
if(require.main===module){
  verifyOfflineBackup(parseArgs(process.argv.slice(2)).source).then(result=>{
    console.log(JSON.stringify(result,null,2));
  }).catch(error=>{
    console.error('[sqlite-offline-verify] '+error.message);
    process.exitCode=1;
  });
}
module.exports={parseArgs,sha256,sqliteHeader,inspectDisposableDatabase,verifyOfflineBackup};
