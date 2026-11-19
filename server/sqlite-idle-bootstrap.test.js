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
function bootstrap(){
  const script=[
    "const db=require('./server/db');",
    "const version=db.prepare('PRAGMA schema_version').get().schema_version;",
    "const changes=db.prepare('SELECT total_changes() AS changes').get().changes;",
    "const mode=db.prepare('PRAGMA journal_mode').get().journal_mode;",
    "const names=['trg_partner_first_purchase_promo_insert','trg_point_first_purchase_promo_insert'];",
    "const triggers=names.map(name=>db.prepare(\"SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?\").get(name)?.sql||null);",
    "console.log('BOOT_RESULT:'+JSON.stringify({version,changes,mode,triggers}));",
    "db.close();",
  ].join('\n');
  const result=spawnSync(process.execPath,['-e',script],{
    cwd:projectRoot,
    env:{...process.env,DATA_DIR:directory},
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
  assert.equal(first.mode,'wal','keep production journal mode unchanged');
  assert.ok(first.triggers.every(Boolean));
  const second=bootstrap();
  assert.equal(second.version,first.version,
    'no repeated DROP/CREATE trigger and schema metadata writes');
  assert.equal(second.changes,0,'fully migrated idle database has no data writes');
  assert.equal(second.mode,'wal');
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
