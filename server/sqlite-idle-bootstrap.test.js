'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hm-sqlite-idle-'));
const projectRoot=path.join(__dirname,'..');
const databaseFile=path.join(directory,'taiga.db');
function bootstrap(dataDir=directory){
  const script=[
    "const {DatabaseSync}=require('node:sqlite');",
    "const actualPrepare=DatabaseSync.prototype.prepare;",
    "let pragmaTableInfoCalls=0,legacyOrderScans=0;",
    "DatabaseSync.prototype.prepare=function(sql,...args){if(/^PRAGMA\\s+table_info\\(/i.test(String(sql)))pragmaTableInfoCalls++;if(String(sql).includes(\"SELECT customer_phone, created_at FROM orders WHERE status != 'pending'\"))legacyOrderScans++;return actualPrepare.call(this,sql,...args);};",
    "const db=require('./server/db');",
    "const version=db.prepare('PRAGMA schema_version').get().schema_version;",
    "const changes=db.prepare('SELECT total_changes() AS changes').get().changes;",
    "const mode=db.prepare('PRAGMA journal_mode').get().journal_mode;",
    "const exportedMode=db.JOURNAL_MODE;",
    "const names=['trg_partner_first_purchase_promo_insert','trg_point_first_purchase_promo_insert'];",
    "const triggers=names.map(name=>db.prepare(\"SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?\").get(name)?.sql||null);",
    "console.log('BOOT_RESULT:'+JSON.stringify({version,changes,mode,exportedMode,triggers,pragmaTableInfoCalls,legacyOrderScans}));",
    "db.close();",
  ].join('\n');
  const result=spawnSync(process.execPath,['-e',script],{
    cwd:projectRoot,
    env:{...process.env,DATA_DIR:dataDir},
    encoding:'utf8',
    timeout:30000,
  });
  assert.equal(result.status,0,'SQLite bootstrap failed: '+(result.stderr||result.stdout));
  const output=result.stdout.split(/\r?\n/).find(line=>line.startsWith('BOOT_RESULT:'));
  assert.ok(output,'missing bootstrap metrics: '+result.stdout);
  return JSON.parse(output.slice('BOOT_RESULT:'.length));
}

test('a second SQLite startup preserves schema and performs zero data changes',()=>{
  const first=bootstrap();
  assert.ok(first.version>0);
  assert.equal(first.mode,'delete','fresh SQLite databases must retain the safe default');
  assert.equal(first.exportedMode,first.mode);
  assert.ok(first.triggers.every(Boolean));
  // An account without purchases keeps NULL last_order_at indefinitely:
  // it must not force a complete order-history scan on every restart.
  const seeded=new DatabaseSync(databaseFile);
  seeded.prepare('INSERT INTO customers(phone) VALUES(?)').run('79002000999');
  seeded.close();
  const second=bootstrap();
  assert.equal(second.version,first.version,
    'no repeated DROP/CREATE trigger and schema metadata writes');
  assert.equal(second.changes,0,'fully migrated idle database has no data writes');
  assert.equal(second.mode,'delete','a restart must not enable WAL');
  assert.equal(second.exportedMode,second.mode);
  assert.equal(second.legacyOrderScans,0,'one-time legacy customer scan must not repeat');
  assert.ok(second.pragmaTableInfoCalls<=70,
    'startup should read each table schema once (23 tables, not 151 PRAGMA queries): '+
    second.pragmaTableInfoCalls);
  assert.ok(first.pragmaTableInfoCalls<=70,
    'new-database startup also uses bounded schema lookups');
});


test('existing WAL stays WAL, an offline DELETE conversion survives subsequent deploys',()=>{
  const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'hm-sqlite-existing-wal-'));
  const file=path.join(isolated,'taiga.db');
  try {
    // Model a legacy production DB which has already opted into persistent WAL.
    const seed=new DatabaseSync(file);
    assert.equal(seed.prepare('PRAGMA journal_mode=WAL').get().journal_mode,'wal');
    seed.close();
    const existing=bootstrap(isolated);
    assert.equal(existing.mode,'wal','normal boot must not auto-convert a live WAL DB');
    assert.equal(existing.exportedMode,'wal');
    // Offline switch can only be performed after stopping the site and
    // verifying an independent backup. This disposable fixture models that.
    const offline=new DatabaseSync(file);
    try {
      assert.equal(offline.prepare('PRAGMA journal_mode=DELETE').get().journal_mode,'delete');
    } finally {offline.close();}
    const converted=bootstrap(isolated);
    assert.equal(converted.mode,'delete','a new deployment must never silently undo an offline DELETE switch');
    assert.equal(converted.exportedMode,'delete');
    assert.equal(converted.version,existing.version,'journal selection must not trigger a schema migration');
  } finally { fs.rmSync(isolated,{recursive:true,force:true}); }
});

test('a legacy promo trigger is repaired once; new referrers never get buyer promos',()=>{
  const old=new DatabaseSync(databaseFile);
  old.exec(`
    DROP TRIGGER trg_partner_first_purchase_promo_insert;
    CREATE TRIGGER trg_partner_first_purchase_promo_insert
    AFTER INSERT ON partners
    WHEN NEW.first_purchase_promo_code IS NULL
    BEGIN
      UPDATE partners SET first_purchase_promo_code =
        printf('HV20-G-%03d', NEW.id) WHERE id=NEW.id;
    END;
  `);
  old.close();
  const repaired=bootstrap();
  assert.match(repaired.triggers[0],/NEW\.partner_type\s*=\s*'groomer'/);
  assert.match(repaired.triggers[1],/first_purchase_point_promo_numbers/);
  const again=bootstrap();
  assert.equal(again.version,repaired.version,
    'after one legacy repair the trigger stays unchanged on next reboot');
  const db=new DatabaseSync(databaseFile);
  try{
    db.prepare('INSERT INTO points(id,name,addr,icon) VALUES(?,?,?,?)')
      .run('perf-idle-point','Тестовая грумерская','Красноярск, тест','🐾');
    const add=db.prepare(`
      INSERT INTO partners
        (partner_code,login,password_hash,full_name,phone,point_name,partner_type,commission_rate)
      VALUES (?,?,?,?,?,?,?,?)
    `);
    const groomer=add.run('GR-PERF-1','perf-groomer','hash','Тест грумер',
      '79002000001','Тестовая грумерская','groomer',0.15).lastInsertRowid;
    const referrer=add.run('GR-PERF-2','perf-referrer','hash','Тест рекомендатель',
      '79002000002','Рекомендатель без стойки','referrer',0).lastInsertRowid;
    assert.match(db.prepare('SELECT first_purchase_promo_code AS code FROM partners WHERE id=?')
      .get(groomer).code,/^HV20-G-\d+$/);
    assert.equal(db.prepare('SELECT first_purchase_promo_code AS code FROM partners WHERE id=?')
      .get(referrer).code,null,'referral-only partners get no buyer discount');
    assert.match(db.prepare('SELECT first_purchase_promo_code AS code FROM points WHERE id=?')
      .get('perf-idle-point').code,/^HV20-\d+$/);
  }finally{db.close();}
});
test.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
