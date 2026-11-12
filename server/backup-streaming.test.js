'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { streamMimeMessage } = require('./email');

test('large SQLite attachments are transferred as streaming base64 with backpressure', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hvost-backup-mail-'));
  const name=path.join(dir,'snapshot.db');
  const bytes=Buffer.alloc(750003);
  for (let i=0; i<bytes.length; i++) bytes[i]=i%251;
  fs.writeFileSync(name,bytes);
  const written=[];
  const outgoing=new Writable({
    highWaterMark:512,
    write(chunk,encoding,done) {
      written.push(Buffer.from(chunk));
      setImmediate(done); // Simulate slow SMTP recipient and backpressure.
    },
  });
  const original=fs.readFileSync;
  fs.readFileSync=function(file,...args) {
    if (file===name) throw new Error('Attempted synchronous read of entire backup');
    return original.call(fs,file,...args);
  };
  try {
    await streamMimeMessage(outgoing,{
      from:'sender@example.org',to:'backup@example.org',subject:'Резервная копия',
      text:'База ХвостМаркета',attachments:[{filename:'backup.db',filePath:name,
        contentType:'application/x-sqlite3'}],
    });
    // streamMimeMessage must leave the SMTP socket open for the 250 reply.
    // Flush pending writes on this test-only Writable before inspecting bytes.
    await new Promise(resolve => outgoing.end(resolve));
    const wire=Buffer.concat(written).toString('utf8');
    assert.match(wire,/Content-Transfer-Encoding: base64/);
    assert.match(wire,/Content-Disposition: attachment; filename="backup.db"/);
    assert.ok(wire.endsWith('\r\n.\r\n'),'SMTP DATA terminator present');
    const data=wire.split('Content-Disposition: attachment; filename="backup.db"\r\n\r\n')[1]
      .split('\r\n--taiga-stream-')[0].replace(/\s/g,'');
    assert.deepEqual(Buffer.from(data,'base64'),bytes);
    assert.ok(written.length>8,'large attachment must be split into smaller writes');
  } finally {
    fs.readFileSync=original;
    outgoing.destroy();
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('backup scheduler shares one in-flight operation and no longer buffers DB into heap', () => {
  const code=fs.readFileSync(path.join(__dirname,'backup.js'),'utf8');
  assert.match(code,/if \(backupInFlight\) return backupInFlight/);
  assert.match(code,/filePath: tempPath/);
  assert.doesNotMatch(code,/fs\.readFileSync\(tempPath\)/);
  assert.doesNotMatch(code,/fs\.writeFileSync\(tempPath/);
});
