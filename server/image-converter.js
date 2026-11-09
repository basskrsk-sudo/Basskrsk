'use strict';
// Async ImageMagick runner. Blocking execFileSync used to freeze every API
// handler while an uploaded photo was resized, even on an idle Node process.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const defaultRun=promisify(execFile);
// Each request holds a decoded image plus base64 JSON in memory.
// Keep the backlog small on the compact Amvera container.
const IMAGE_MAX_QUEUED=2;

function createImageConverter(run=defaultRun) {
  let active=false;
  const queue=[];
  async function processFile(args) {
    // ImageMagick uses a separate process and can otherwise consume most of
    // a small Amvera container while decoding high-resolution phone photos.
    // Spill pixel cache to disk and avoid parallel image-processing threads.
    const options={timeout:30000,maxBuffer:128*1024,env:{
      ...process.env,
      MAGICK_MEMORY_LIMIT:'64MiB',
      MAGICK_MAP_LIMIT:'128MiB',
      MAGICK_DISK_LIMIT:'256MiB',
      MAGICK_THREAD_LIMIT:'1',
    }};
    try { await run('magick',args,options); }
    catch (error) {
      if (error.code!=='ENOENT') throw error;
      await run('convert',args,options);
    }
  }
  function drain() {
    if(active || !queue.length) return;
    active=true;
    const item=queue.shift();
    Promise.resolve().then(()=>processFile(item.args)).then(item.resolve,item.reject)
      .finally(()=>{active=false;drain();});
  }
  return function convert(args) {
    if(!Array.isArray(args)||!args.length)
      return Promise.reject(new TypeError('Неправильные аргументы конвертации изображения'));
    if(queue.length>=IMAGE_MAX_QUEUED){
      const error=new Error('Обработчик изображений занят. Попробуйте позже.');
      error.statusCode=503;
      return Promise.reject(error);
    }
    return new Promise((resolve,reject)=>{
      queue.push({args,resolve,reject});
      drain();
    });
  };
}
const convertImage=createImageConverter();
module.exports={createImageConverter,convertImage};
