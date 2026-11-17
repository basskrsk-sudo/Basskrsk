'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { createTemporaryBackupWorkspace } = require('./backup-temp-storage');
const { createDatabaseSnapshot } = require('./database-snapshot');

test('SMTP/download snapshots use private ephemeral storage and preserve live SQLite',async()=>{
  const data = fs.mkdtempSync(path.join(os.tmpdir(),'hm-backup-source-'));
  let workspace;
  try {
    const source=path.join(data,'live.db');
    const database=new DatabaseSync(source);
    database.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE receipts(id INTEGER PRIMARY KEY,amount INTEGER);"+
      "INSERT INTO receipts(amount) VALUES(250),(360)");
    workspace=await createTemporaryBackupWorkspace();
    assert.ok(!workspace.path.startsWith(data+path.sep));
    assert.equal(fs.statSync(workspace.directory).mode&0o777,0o700);
    await createDatabaseSnapshot(source,workspace.path);
    const snapshot=new DatabaseSync(workspace.path,{readOnly:true});
    assert.deepEqual(snapshot.prepare('SELECT amount FROM receipts ORDER BY id').all()
      .map(row=>row.amount),[250,360]);
    assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    snapshot.close();
    database.close();
    await workspace.cleanup();
    assert.equal(fs.existsSync(workspace.directory),false);
    workspace=null;
    assert.equal(fs.existsSync(source),true,'live database remains in /data');
  }finally {
    if(workspace)await workspace.cleanup();
    fs.rmSync(data,{recursive:true,force:true});
  }
});

test('workspace must never target persistent /data',async()=>{
  const persistent=fs.mkdtempSync(path.join(os.tmpdir(),'hm-backup-persist-'));
  const previous=process.env.DATA_DIR;
  try{
    process.env.DATA_DIR=persistent;
    await assert.rejects(createTemporaryBackupWorkspace({tempRoot:persistent}),
      /outside persistent storage/);
  }finally{
    if(previous===undefined)delete process.env.DATA_DIR;
    else process.env.DATA_DIR=previous;
    fs.rmSync(persistent,{recursive:true,force:true});
  }
});
