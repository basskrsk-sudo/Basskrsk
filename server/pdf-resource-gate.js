'use strict';
const {readContainerMemory,memoryMetrics,MiB}=require('./container-memory');
// One rendering slot across the HTTP and Telegram entry points. No timer,
// no unbounded queue and no retained report payload. A rejected request can
// be repeated by the administrator; checkout never waits for this slot.
function createPdfResourceGate({readMemory=readContainerMemory,log=console.info}={}){
  let busy=false;
  function refused(message){
    return Object.assign(new Error(message),{statusCode:503,publicMessage:true});
  }
  function acquire(kind){
    if(busy)throw refused('Другой PDF уже формируется. Повторите запрос после его завершения.');
    const before=readMemory();
    const reserve=before.limit?Math.max(32*MiB,before.limit*0.20):0;
    if(before.limit&&before.limit-before.working<reserve)
      throw refused('Недостаточно свободной памяти для PDF. Покупки и оплата доступны; повторите запрос позднее.');
    busy=true;
    let peak=before.working,closed=false;
    const started=Date.now();
    function checkpoint(){
      const m=readMemory();
      peak=Math.max(peak,m.working);
      if(m.ratio!==null&&m.ratio>=0.90)
        throw refused('Формирование PDF остановлено: недостаточно памяти. Повторите запрос позднее.');
    }
    function release(){
      if(closed)return;
      closed=true;
      try{
        const after=readMemory();
        peak=Math.max(peak,after.working);
        log('[pdf-memory] '+JSON.stringify({kind,duration_ms:Date.now()-started,
          before:memoryMetrics(before),after:memoryMetrics(after),sampled_peak_mb:Math.round(peak/MiB)}));
      }finally{busy=false;}
    }
    return {checkpoint,release};
  }
  return {acquire};
}
const shared=createPdfResourceGate();
module.exports={createPdfResourceGate,acquirePdfSlot:shared.acquire};
