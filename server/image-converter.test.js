'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createImageConverter}=require('./image-converter');

test('ImageMagick is asynchronous: unrelated timers run while conversion is active',async()=>{
  let finish;
  const pending=new Promise(resolve=>{finish=resolve});
  const calls=[];
  const convert=createImageConverter(async(command,args,options)=>{
    calls.push({command,args,options});
    await pending;
  });
  const job=convert(['input.png','output.webp']);
  let ticked=false;
  await new Promise(resolve=>setImmediate(()=>{ticked=true;resolve()}));
  assert.equal(ticked,true,'event loop must remain responsive while process works');
  assert.equal(calls[0].command,'magick');
  assert.equal(calls[0].options.timeout,30000);
  finish();
  await job;
});

test('uploads are converted one at a time rather than overloading Amvera',async()=>{
  let releaseFirst;
  const hold=new Promise(resolve=>{releaseFirst=resolve;});
  const calls=[];
  const convert=createImageConverter(async(_command,args)=>{
    calls.push(args[0]);
    if(args[0]==='one')await hold;
  });
  const first=convert(['one']);
  const second=convert(['two']);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,['one']);
  releaseFirst();
  await Promise.all([first,second]);
  assert.deepEqual(calls,['one','two']);
});

test('ImageMagick 7 fallback preserves ImageMagick 6 installations',async()=>{
  const commands=[];
  const convert=createImageConverter(async(command)=>{
    commands.push(command);
    if(command==='magick')throw Object.assign(new Error('missing'),{code:'ENOENT'});
  });
  await convert(['source.png','destination.webp']);
  assert.deepEqual(commands,['magick','convert']);
});

test('a failed image does not block later conversions',async()=>{
  let calls=0;
  const convert=createImageConverter(async()=>{
    calls++;
    if(calls===1)throw new Error('corrupt image');
  });
  await assert.rejects(convert(['bad']),/corrupt image/);
  await convert(['good']);
  assert.equal(calls,2);
});


test('excess image uploads receive 503 instead of saturating container memory',async()=>{
  let release;
  const wait=new Promise(resolve=>{release=resolve;});
  const convert=createImageConverter(async()=>wait);
  const active=convert(['active.png']);
  const queued1=convert(['queued1.png']);
  const queued2=convert(['queued2.png']);
  await assert.rejects(convert(['overflow.png']),error=>
    error.statusCode===503&&/занят/.test(error.message));
  release();
  await Promise.all([active,queued1,queued2]);
});


test('photo conversion caps ImageMagick RAM, mapped memory and threads',async()=>{
  const seen=[];
  const convert=createImageConverter(async(_command,_args,options)=>{seen.push(options);});
  await convert(['image.jpg','image.webp']);
  assert.equal(seen.length,1);
  assert.equal(seen[0].env.MAGICK_MEMORY_LIMIT,'64MiB');
  assert.equal(seen[0].env.MAGICK_MAP_LIMIT,'128MiB');
  assert.equal(seen[0].env.MAGICK_DISK_LIMIT,'256MiB');
  assert.equal(seen[0].env.MAGICK_THREAD_LIMIT,'1');
});
