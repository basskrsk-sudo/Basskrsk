'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const { writePdfFromJpegs, writePdfFromJpegsAsync } = require('./weekly-report-pdf');
const path = require('node:path');
const { createWeeklyPdfRunner } = require('./weekly-report-pdf-runner');

test('PDF worker module does not open SQLite or re-run migrations', () => {
  const source = fs.readFileSync(path.join(__dirname, 'weekly-report-pdf-worker.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, 'weekly-report-pdf.js'), 'utf8');
  assert.doesNotMatch(source, /require\(['"]\.\/weekly-report['"]\)/);
  assert.doesNotMatch(renderer, /require\(['"]\.\/db['"]\)/);
  assert.match(renderer, /MAGICK_THREAD_LIMIT/);
});

test('weekly PDFs use a worker instead of blocking Node.js and limit waiting jobs', async () => {
  const created = [];
  class FakeWorker extends EventEmitter {
    constructor(filename, options) {
      super();
      created.push({filename, options, instance:this});
    }
    terminate() { return Promise.resolve(0); }
  }
  const render = createWeeklyPdfRunner({WorkerClass:FakeWorker, timeoutMs:2000});
  const first = render({ name:'one' }, '/tmp/first.pdf');
  const second = render({ name:'two' }, '/tmp/second.pdf');
  await assert.rejects(render({name:'three'}, '/tmp/third.pdf'), {statusCode:503});
  assert.equal(created.length, 1, 'a second ImageMagick renderer must not start');
  assert.equal(created[0].options.workerData.report.name, 'one');
  let timerFired = false;
  setTimeout(() => { timerFired = true; created[0].instance.emit('message',{ok:true}); }, 5);
  assert.equal(await first, '/tmp/first.pdf');
  assert.equal(timerFired, true, 'the main event loop keeps handling timers');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(created.length, 2);
  created[1].instance.emit('message',{ok:true});
  assert.equal(await second,'/tmp/second.pdf');
});

test('PDF worker errors are propagated and the queue continues', async () => {
  const created = [];
  class FakeWorker extends EventEmitter {
    constructor() { super(); created.push(this); }
    terminate() { return Promise.resolve(); }
  }
  const render = createWeeklyPdfRunner({WorkerClass:FakeWorker});
  const fail = render({name:'bad'},'/tmp/bad.pdf');
  const next = render({name:'good'},'/tmp/good.pdf');
  created[0].emit('message',{ok:false,error:'Font missing'});
  await assert.rejects(fail,/Font missing/);
  await new Promise(resolve => setImmediate(resolve));
  created[1].emit('message',{ok:true});
  assert.equal(await next,'/tmp/good.pdf');
});

test('on-demand PDF assembly streams JPEG bytes asynchronously and remains byte-for-byte compatible',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hm-pdf-stream-'));
  try {
    const jpegs=[1,2,3].map((id)=>{
      const file=path.join(dir,'page-'+id+'.jpg');
      fs.writeFileSync(file,Buffer.concat([
        Buffer.from([0xff,0xd8,0xff,0xe0,id]),Buffer.alloc(129*1024,id),Buffer.from([0xff,0xd9])
      ]));
      return file;
    });
    const oldPath=path.join(dir,'old.pdf');
    const newPath=path.join(dir,'new.pdf');
    writePdfFromJpegs(jpegs,oldPath);
    let eventLoopWasResponsive=false;
    const assembling=writePdfFromJpegsAsync(jpegs,newPath);
    await new Promise(resolve=>setImmediate(()=>{eventLoopWasResponsive=true;resolve();}));
    await assembling;
    assert.equal(eventLoopWasResponsive,true);
    assert.deepEqual(fs.readFileSync(newPath),fs.readFileSync(oldPath));
    assert.ok(fs.statSync(newPath).size>3*129*1024);
  }finally{
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('asynchronous PDF writer removes incomplete files when an image is missing',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hm-pdf-fail-'));
  try{
    const output=path.join(dir,'incomplete.pdf');
    await assert.rejects(writePdfFromJpegsAsync([path.join(dir,'missing.jpg')],output),/ENOENT/);
    assert.equal(fs.existsSync(output),false);
  }finally{
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
