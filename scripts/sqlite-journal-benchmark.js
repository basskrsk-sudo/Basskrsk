#!/usr/bin/env node
'use strict';

// Offline-only A/B comparison. NEVER changes the application's live DB,
// WAL configuration, files under /data, or any customer/financial records.
// Writes only to fresh temporary SQLite copies which are deleted afterward.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { DatabaseSync } = require('node:sqlite');

const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const TEMP_PREFIX = 'hm-journal-benchmark-';

function parseArgs(args) {
  const options = { source: null, transactions: 80 };
  for (let i=0; i<args.length; i++) {
    const flag = args[i];
    if (flag==='--source' && args[i+1]) options.source=args[++i];
    else if (flag==='--transactions' && args[i+1]) options.transactions=Number(args[++i]);
    else throw new Error('Usage: node scripts/sqlite-journal-benchmark.js [--source OFFLINE_BACKUP.db] [--transactions 10..300]');
  }
  if (!Number.isInteger(options.transactions) || options.transactions<10 ||
      options.transactions>300) throw new Error('Transactions must be between 10 and 300');
  return options;
}

function isWithin(file,root) {
  const relative=path.relative(root,file);
  return relative==='' || (relative!=='..' && !relative.startsWith('..'+path.sep) &&
    !path.isAbsolute(relative));
}

function validateOfflineSource(file) {
  const actual=fs.realpathSync(path.resolve(file));
  if (!fs.statSync(actual).isFile() ||
      !/\.(db|sqlite|sqlite3)$/i.test(actual))
    throw new Error('Source must be an offline SQLite backup file');
  // An explicit backup filename is required; fail closed on active taiga.db.
  if (!/(backup|snapshot|copy)/i.test(path.basename(actual)) ||
      path.basename(actual)==='taiga.db')
    throw new Error('Refusing a live database: use an offline backup/snapshot copy');
  if (isWithin(actual, '/data'))
    throw new Error('Refusing a file from Amvera persistent /data');
  if (process.env.DATA_DIR) {
    const root=fs.realpathSync(path.resolve(process.env.DATA_DIR));
    if (isWithin(actual,root)) throw new Error('Refusing a file under DATA_DIR');
  }
  if (fs.statSync(actual).size>MAX_SOURCE_BYTES)
    throw new Error('Backup exceeds 128 MiB: use a smaller offline sample');
  return actual;
}

function vacuumCopy(source,destination) {
  const reader=new DatabaseSync(source,{readOnly:true});
  try {
    reader.exec("PRAGMA busy_timeout=500");
    reader.exec("VACUUM INTO '"+destination.replace(/'/g,"''")+"'");
  } finally {reader.close();}
}

function syntheticFixture(file) {
  const db=new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE hm_fixture(id INTEGER PRIMARY KEY, status TEXT NOT NULL)');
    const insert=db.prepare('INSERT INTO hm_fixture(id,status) VALUES(?,?)');
    db.exec('BEGIN IMMEDIATE');
    try { for(let i=1;i<=160;i++)insert.run(i,i%3?'paid':'pending'); db.exec('COMMIT'); }
    catch(error){db.exec('ROLLBACK');throw error;}
  } finally {db.close();}
}

const round=x=>Math.round(x*1000)/1000;
function percentile(numbers,pct) {
  const ordered=numbers.slice().sort((a,b)=>a-b);
  return ordered[Math.ceil(pct*ordered.length)-1]||0;
}
function fileBytes(file){try{return fs.statSync(file).size;}catch(error){if(error.code==='ENOENT')return 0;throw error;}}

function oneTrial(mode,source,temporary,transactions,sequence) {
  const file=path.join(temporary,'trial-'+sequence+'.db');
  fs.copyFileSync(source,file);
  const db=new DatabaseSync(file);
  const samples=[],reads=[];
  let fileInfo=null;
  try {
    const modeStart=performance.now();
    const actual=db.prepare('PRAGMA journal_mode='+mode).get().journal_mode;
    if (actual!==mode.toLowerCase()) throw new Error('Requested journal mode was not applied: '+actual);
    // Compare with identical durability settings. Production synchronous
    // may differ, so this test is NOT a production sizing recommendation.
    db.exec('PRAGMA synchronous=FULL');
    db.exec('PRAGMA busy_timeout=100');
    const switchMs=round(performance.now()-modeStart);
    db.exec('CREATE TABLE hm_benchmark(id INTEGER PRIMARY KEY, quantity INTEGER NOT NULL, created_at TEXT)');
    const insert=db.prepare('INSERT INTO hm_benchmark(id,quantity,created_at) VALUES(?,?,?)');
    const update=db.prepare('UPDATE hm_benchmark SET quantity=quantity+1 WHERE id=?');
    const select=db.prepare('SELECT quantity FROM hm_benchmark WHERE id=?');
    for(let i=1;i<=transactions;i++) {
      const begin=performance.now();
      db.exec('BEGIN IMMEDIATE');
      try {
        insert.run(i,1,'2026-11-19');
        update.run(i);
        if(select.get(i).quantity!==2)throw new Error('Incorrect benchmark transaction');
        db.exec('COMMIT');
      } catch(error) {
        try{db.exec('ROLLBACK');}catch(_){}
        throw error;
      }
      samples.push(round(performance.now()-begin));
    }
    for(let i=0;i<transactions;i++) {
      const begin=performance.now();
      select.get(i%transactions+1);
      reads.push(round(performance.now()-begin));
    }
    // Independent read transaction remains open during a write. DELETE may
    // block a commit; WAL generally permits it. No production reader is used.
    const reader=new DatabaseSync(file,{readOnly:true});
    let readLock='written',readLockMs=0;
    try {
      reader.exec('BEGIN');
      reader.prepare('SELECT COUNT(*) AS n FROM hm_benchmark').get();
      const t=performance.now();
      try {insert.run(transactions+1,1,'2026-11-19');}
      catch(error) {
        if(error.code==='ERR_SQLITE_ERROR' || error.code==='SQLITE_BUSY' ||
           /database is locked|SQLITE_BUSY/i.test(error.message))
          readLock='blocked';
        else throw error;
      }
      readLockMs=round(performance.now()-t);
      reader.exec('ROLLBACK');
    } finally {reader.close();}
    fileInfo={
      mode:actual,
      synchronous:db.prepare('PRAGMA synchronous').get().synchronous,
      switch_ms:switchMs,
      write_total_ms:round(samples.reduce((a,b)=>a+b,0)),
      write_p50_ms:round(percentile(samples,0.50)),
      write_p95_ms:round(percentile(samples,0.95)),
      read_p95_ms:round(percentile(reads,0.95)),
      write_with_open_reader:readLock,
      read_lock_wait_ms:readLockMs,
      db_bytes:fileBytes(file),
      journal_bytes:fileBytes(file+'-journal'),
      wal_bytes:fileBytes(file+'-wal'),
    };
    return fileInfo;
  } finally {db.close();}
}

function runBenchmark(opts={}) {
  const sourcePath=opts.source?validateOfflineSource(opts.source):null;
  const transactions=opts.transactions||80;
  if(!Number.isInteger(transactions)||transactions<10||transactions>300)
    throw new Error('Invalid transaction count');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),TEMP_PREFIX));
  try {
    const base=path.join(temp,'baseline.db');
    if(sourcePath)vacuumCopy(sourcePath,base);
    else syntheticFixture(base);
    const trials=[];
    for(const [i,mode] of ['WAL','DELETE','DELETE','WAL'].entries())
      trials.push(oneTrial(mode,base,temp,transactions,i));
    return {
      method:'offline temporary SQLite copies; synchronous=FULL; no writes to source',
      source:sourcePath?'offline-backup':'generated-fixture',
      transactions_per_trial:transactions,
      trial_order:trials.map(x=>x.mode),
      trials,
      warning:'Filesystem benchmarks outside the Amvera persistent mount cannot predict /data latency. Do not switch live WAL based only on these results.',
    };
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
}

if (require.main===module) {
  try {console.log(JSON.stringify(runBenchmark(parseArgs(process.argv.slice(2))),null,2));}
  catch(error){console.error('Offline SQLite journal benchmark: '+error.message);process.exitCode=1;}
}
module.exports={parseArgs,validateOfflineSource,runBenchmark};
