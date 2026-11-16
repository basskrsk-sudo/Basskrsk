// Fixed historical owner report, 16 November 2026.
// This deliberately uses the archived analytical snapshot, never replaces it
// with current sales from production. Delivered only to linked super-admins.
'use strict';
const db = require('./db');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile);

const REPORT_DATE = '16.11.2026';
const FILE_NAME = 'HvostMarket_Otchet_Sobstvennikam_16-11-2026.pdf';
const W=1240,H=1754;
let renderInFlight = null;
let savedReport = null;

function esc(value) {
  return String(value ?? '').replace(/\\/g,'\\\\').replace(/'/g,"\\'")
    .replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,400);
}
function wrap(input,maxLen=62) {
  const words=String(input||'').replace(/\s+/g,' ').trim().split(' ');
  const lines=[],current=[];
  for(const word of words){
    if(current.length && (current.join(' ').length + word.length + 1 > maxLen)){
      lines.push(current.join(' '));current.length=0;
    }
    if(word.length>maxLen){
      if(current.length){lines.push(current.join(' '));current.length=0;}
      for(let i=0;i<word.length;i+=maxLen)lines.push(word.slice(i,i+maxLen));
    }else current.push(word);
  }
  if(current.length)lines.push(current.join(' '));
  return lines;
}
const COLORS={green:'#075642',dark:'#163D34',white:'#FFFFFF',
  ink:'#1D342D',muted:'#63796F',pale:'#F0F6F1',mint:'#DDEFE5',
  gold:'#DCA64A',line:'#D9E6DB',amber:'#8C5D19'};
function buildOwnerReportPages(font){
  const pages=[];
  function page(title,label,pageNo) {
    const b=['push graphic-context','viewbox 0 0 '+W+' '+H,
      "fill '#FFFFFF' rectangle 0,0 "+W+","+H];
    const rect=(x,y,w,h,color)=>b.push("fill '"+color+"' rectangle "+x+","+y+" "+(x+w)+","+(y+h));
    const txt=(x,y,str,size=28,color=COLORS.ink)=>
      b.push("font '"+esc(font)+"' font-size "+size+" fill '"+color+"' text "+x+","+y+" '"+esc(str)+"'");
    const lines=(x,y,str,size=24,max=72,leading=36,color=COLORS.ink)=>{
      const parts=wrap(str,max);
      parts.forEach((part,i)=>txt(x,y+i*leading,part,size,color));
      return y+parts.length*leading;
    };
    const bar=(x,y,width,proportion,color=COLORS.green)=>{
      rect(x,y,width,18,COLORS.pale);
      rect(x,y,Math.max(3,Math.round(width*Math.max(0,Math.min(1,proportion)))),18,color);
    };
    rect(0,0,W,142,COLORS.dark);
    txt(70,58,'ХвостМаркет',45,COLORS.white);
    txt(70,103,title,28,COLORS.white);
    txt(70,195,label,29,COLORS.green);
    rect(70,1640,W-140,2,COLORS.line);
    txt(70,1680,'ВНУТРЕННИЙ АНАЛИТИЧЕСКИЙ ОТЧЁТ · СРЕЗ БАЗЫ 16.11.2026',17,COLORS.muted);
    txt(1090,1680,String(pageNo)+' / 6',21,COLORS.green);
    pages.push(b);
    return {b,rect,txt,lines,bar};
  }
  // Page 1: Executive summary.
  {
    const q=page('Отчёт собственникам · 16 ноября 2026','Продажи точек и прогноз развития сети',1);
    const {rect,txt,lines}=q;
    const vals=[['АКТИВНЫХ ТОЧЕК','7'],['С ТОВАРНЫМИ ОСТАТКАМИ','6'],['ОПЛАЧЕННЫХ ЗАКАЗОВ','41'],['ВЫРУЧКА','11 500 ₽']];
    for(let i=0;i<4;i++){
      const x=70+i*281;
      rect(x,244,266,143,COLORS.pale);
      txt(x+17,288,vals[i][0],18,COLORS.muted);
      txt(x+17,348,vals[i][1],38,COLORS.green);
    }
    txt(70,477,'Ключевой вывод',35,COLORS.ink);
    lines(70,532,'Продажи реальны, но стабильная продуктивность одной точки пока не подтверждена. Увеличивать сеть без проверки повторяемого спроса рискованно.',27,73,44);
    txt(70,727,'Что важно собственникам',31,COLORS.ink);
    const items=[
      ['01','Первая продажа: у 6 из 6 точек с товаром в течение 1–9 дней от даты карточки.'],
      ['02','Концентрация: две наиболее успешные точки дали около 66% выручки.'],
      ['03','За 28 завершённых дней (19.10–15.11): 23 заказа на 5 584 ₽.'],
      ['04','Для прогнозов ориентир — около 1 000 ₽ на наполненную точку в месяц.'],
    ];
    items.forEach((item,i)=>{
      const y=791+i*127;
      rect(70,y,1095,103,COLORS.pale);
      txt(94,y+45,item[0],31,COLORS.green);
      lines(164,y+40,item[1],24,75,33);
    });
    rect(70,1370,1095,164,COLORS.mint);
    txt(94,1427,'Решение на 30 дней',31,COLORS.dark);
    lines(94,1475,'Повысить продажи действующих точек, проверить БаркЛай и Грум Рум, измерить конверсию и только затем ускорять тиражирование.',22,82,32);
  }
  // Page 2: every point from archived data.
  {
    const q=page('Сеть минимаркетов','Результаты по семи точкам',2);
    const {rect,txt,lines,bar}=q;
    lines(70,243,'Даты ниже — даты карточек точек в базе или уточнённые вручную. Они не всегда совпадают с фактической установкой и выкладкой товара.',23,90,35,COLORS.muted);
    rect(70,353,1095,62,COLORS.dark);
    txt(90,393,'ТОЧКА',21,COLORS.white);
    txt(490,393,'СТАРТ',21,COLORS.white);
    txt(625,393,'ЗАКАЗЫ',21,COLORS.white);
    txt(789,393,'ВЫРУЧКА',21,COLORS.white);
    txt(1014,393,'SKU',21,COLORS.white);
    const rows=[
      ['Sir Barsik','09.09','12','5 228 ₽','18',5228],
      ['Zveryuga','14.09','9','2 370 ₽','14',2370],
      ['Мистер Лапсик','29.09','6','1 490 ₽','17',1490],
      ['БаркЛай','07.10','1','250 ₽','15',250],
      ['Дог Стиль','21.10','6','1 128 ₽','7',1128],
      ['Грум Рум','21.10','0','0 ₽','0',0],
      ['Лапочки','22.10','7','1 034 ₽','5',1034],
    ];
    rows.forEach((r,i)=>{
      const y=416+i*104;
      rect(70,y,1095,98,i%2===0?COLORS.pale:'#FFFFFF');
      txt(91,y+39,r[0],25,COLORS.ink);
      txt(490,y+39,r[1],25);
      txt(655,y+39,r[2],26);
      txt(788,y+39,r[3],25);
      txt(1020,y+39,r[4],25);
      bar(91,y+66,760,r[5]/5228);
    });
    rect(70,1172,1095,105,COLORS.mint);
    txt(92,1211,'ИТОГО',25,COLORS.dark);
    txt(655,1211,'41',27,COLORS.dark);
    txt(785,1211,'11 500 ₽',27,COLORS.dark);
    txt(70,1363,'Приоритетные точки для проверки',30,COLORS.ink);
    lines(70,1420,'БаркЛай: одна продажа за длительный период. Грум Рум: нулевой остаток и нулевые продажи. Sir Barsik: проверить остановку регулярных заказов.',23,84,38);
  }
  // Page 3: dynamics and concentration.
  {
    const q=page('Динамика продаж','Проверяемые сигналы',3);
    const {rect,txt,lines,bar}=q;
    const monthly=[['Сентябрь','≈343 ₽'],['Октябрь','≈274 ₽'],['Ноябрь*','≈225 ₽']];
    txt(70,265,'Средний чек по месяцам',33,COLORS.ink);
    monthly.forEach((r,i)=>{
      const y=337+i*138;
      txt(90,y,r[0],27,COLORS.ink);
      bar(324,y-20,580,[343/350,274/350,225/350][i]);
      txt(944,y,r[1],28,COLORS.green);
    });
    lines(70,797,'* Ноябрь включает только оплаченные заказы, доступные в копии базы на 16 ноября; месяц не завершён.',22,84,38,COLORS.muted);
    rect(70,914,526,221,COLORS.pale);
    txt(96,975,'19 из 40',42,COLORS.green);
    lines(96,1024,'заказов до конца 15.11 пришлись всего на пять календарных дней.',23,37,35);
    rect(610,914,555,221,COLORS.pale);
    txt(634,975,'1 310 ₽',42,COLORS.green);
    lines(634,1024,'крупнейший чек, существенный фактор средней выручки.',23,37,35);
    txt(70,1240,'Возраст точки не гарантирует рост',31,COLORS.ink);
    lines(70,1306,'Sir Barsik: 8 заказов в первые 28 дней, затем 4. Zveryuga: 3 заказа в первые 28 дней, затем 6. Поведение точек противоположно.',24,78,39);
    rect(70,1490,1095,100,'#FDF3E0');
    lines(94,1530,'Вывод: по трём неполным месяцам нельзя надёжно оценить сезонность или установить причинно-следственную связь скидок и продаж.',20,89,32,COLORS.amber);
  }
  // Page 4: retention and activation.
  {
    const q=page('Клиенты и повторные покупки','Что приводит к устойчивой выручке',4);
    const {rect,txt,lines}=q;
    const cards=[
      ['6 из 6','точек с остатками получили первую покупку за 1–9 дней от даты карточки'],
      ['31','уникальный покупатель по приведённому к 10 цифрам номеру телефона'],
      ['5 из 31','покупателей имели повторный заказ через 7 и более дней'],
    ];
    cards.forEach((p,i)=>{
      const x=70+i*370;
      rect(x,254,350,289,COLORS.pale);
      txt(x+25,322,p[0],44,COLORS.green);
      lines(x+25,388,p[1],22,30,34);
    });
    txt(70,654,'Что требуется проверить на точках',34,COLORS.ink);
    const tests=[
      ['БаркЛай','Есть товар, но зафиксирована одна продажа. Проверить QR-код, выкладку и рекомендации грумера.'],
      ['Грум Рум','Нет продаж и товарных остатков по копии. Подтвердить установку и корректное проведение поступления.'],
      ['Sir Barsik','Значительная доля выручки сети, но снижение частоты заказов. Проверить действия персонала и ассортимент.'],
    ];
    tests.forEach((p,i)=>{
      const y=729+i*180;
      rect(70,y,1095,150,i%2?COLORS.pale:'#FFFFFF');
      txt(91,y+43,p[0],29,COLORS.green);
      lines(91,y+84,p[1],23,86,34);
    });
    rect(70,1373,1095,175,COLORS.mint);
    txt(95,1429,'Первый чек ≠ регулярные продажи',31,COLORS.dark);
    lines(95,1484,'Нужны данные о числе посетителей, рекомендациях сотрудников, открытиях QR и конверсии в покупку. Одних заказов недостаточно.',23,81,36);
  }
  // Page 5: scenario forecasting.
  {
    const q=page('Сценарии на 30 дней','Прогноз валовой выручки',5);
    const {rect,txt,lines,bar}=q;
    txt(70,261,'Последние 28 завершённых дней',32,COLORS.ink);
    rect(70,301,1095,159,COLORS.pale);
    txt(95,368,'23 заказа',37,COLORS.green);
    txt(456,368,'5 584 ₽',37,COLORS.green);
    txt(808,368,'≈243 ₽',37,COLORS.green);
    txt(95,417,'Всего',21,COLORS.muted);
    txt(456,417,'Выручка',21,COLORS.muted);
    txt(808,417,'Средний чек',21,COLORS.muted);
    const head=[['СЦЕНАРИЙ',80],['6 ТОЧЕК',460],['30 ТОЧЕК',745],['100 ТОЧЕК',989]];
    rect(70,541,1095,69,COLORS.dark);
    head.forEach(p=>txt(p[1],586,p[0],21,COLORS.white));
    const rows=[
      ['Осторожный','3 000 ₽','15 000 ₽','50 000 ₽'],
      ['Базовый','6 000 ₽','30 000 ₽','100 000 ₽'],
      ['Рост','10 920 ₽','54 600 ₽','182 000 ₽'],
    ];
    rows.forEach((r,i)=>{
      const y=611+i*116;
      rect(70,y,1095,111,i===1?COLORS.mint:COLORS.pale);
      head.forEach((h,j)=>txt(h[1],y+65,r[j],j===0?26:29,j===0?COLORS.ink:COLORS.green));
    });
    txt(70,1070,'Что означает базовый сценарий',32,COLORS.ink);
    lines(70,1131,'Четыре заказа на одну наполненную точку за 30 дней при среднем чеке 250 ₽. Рост количества стоек не гарантирует такого же спроса на каждом новом месте.',25,79,41);
    txt(70,1343,'Базовый прогноз при разном размере сети',27,COLORS.ink);
    [['6 точек',6000],['30 точек',30000],['100 точек',100000]].forEach((p,i)=>{
      const y=1394+i*70;
      txt(70,y,p[0],23);bar(262,y-17,720,p[1]/100000);
      txt(1002,y,p[1].toLocaleString('ru-RU')+' ₽',21,COLORS.green);
    });
  }
  // Page 6: recommendations.
  {
    const q=page('План на 30 дней','Решения и контрольные показатели',6);
    const {rect,txt,lines}=q;
    const stages=[
      ['ДНИ 1–7','Проверить все активные стойки','Уточнить наполнение Грум Рум, работу QR в БаркЛай, причины простоя Sir Barsik.'],
      ['ДНИ 8–14','Эксперимент в шести салонах','Одинаковый короткий скрипт рекомендации товара и простая выкладка, затем сравнить с контрольными точками.'],
      ['ДНИ 15–30','Оценить эффект и масштабировать','Сопоставить продажи до и после, зафиксировать лучшие практики в регламенте запуска.'],
    ];
    stages.forEach((st,i)=>{
      const y=255+i*279;
      rect(70,y,1095,251,COLORS.pale);
      rect(89,y+30,157,57,COLORS.green);
      txt(111,y+71,st[0],24,COLORS.white);
      txt(270,y+70,st[1],29,COLORS.dark);
      lines(98,y+128,st[2],24,84,38);
    });
    txt(70,1162,'Еженедельные KPI',32,COLORS.ink);
    [
      'Первая продажа в течение 10 дней после фактического наполнения стойки.',
      'Цель для теста: 8–10 заказов на точку в месяц при среднем чеке от 250 ₽.',
      'Повторные покупки через 7 и более дней по доле уникальных клиентов.',
      'Поток клиентов салона → рекомендации → QR → оплаченные заказы.',
    ].forEach((line,i)=>lines(90,1222+i*72,'• '+line,23,90,34));
    rect(70,1530,1095,91,COLORS.mint);
    lines(93,1575,'Ограничение: себестоимость заполнена только для 6 из 32 вариантов; достоверную прибыльность и окупаемость пока рассчитать нельзя.',21,88,31);
  }
  return pages.map(p=>p.concat(['pop graphic-context']).join('\n'));
}
async function buildOwnerSnapshotPdf(){
  const {findFont,writePdfFromJpegsAsync}=require('./weekly-report-pdf');
  let dir;
  try{
    dir=await fs.promises.mkdtemp(path.join(os.tmpdir(),'hm-owner-20261116-'));
    let binary='convert';
    try{await run(binary,['-version'],{timeout:3000});}
    catch(_){binary='magick';await run(binary,['-version'],{timeout:3000});}
    const images=[];
    const pages=buildOwnerReportPages(findFont());
    for(let i=0;i<pages.length;i++){
      const input=path.join(dir,'page-'+i+'.mvg'),output=path.join(dir,'page-'+i+'.jpg');
      await fs.promises.writeFile(input,pages[i],{mode:0o600});
      await run(binary,['-limit','memory','128MiB','-limit','map','256MiB',
        'mvg:'+input,'-background','white','-alpha','remove','-strip','-quality','89',output],
        {timeout:30000,maxBuffer:1048576,env:{...process.env,
          MAGICK_THREAD_LIMIT:'1',MAGICK_MEMORY_LIMIT:'128MiB',
          MAGICK_MAP_LIMIT:'256MiB',MAGICK_DISK_LIMIT:'512MiB'}});
      images.push(output);
    }
    const pdfPath=path.join(dir,'owner-report.pdf');
    await writePdfFromJpegsAsync(images,pdfPath);
    return await fs.promises.readFile(pdfPath);
  }finally{
    if(dir)await fs.promises.rm(dir,{recursive:true,force:true});
  }
}
function mayReadOwnerReport(chatId,senderId) {
  const chat=String(chatId||''),sender=String(senderId||'');
  if(!/^[1-9]\d{0,19}$/.test(chat)||chat!==sender)return false;
  return !!db.prepare(
    "SELECT id FROM admins WHERE active=1 AND role='super' AND CAST(telegram_chat_id AS TEXT)=? LIMIT 1"
  ).get(chat);
}
function cachedPdf() {
  if(savedReport)return Promise.resolve(savedReport);
  if(renderInFlight)return renderInFlight;
  renderInFlight=buildOwnerSnapshotPdf().then(value=>{
    if(!Buffer.isBuffer(value)||value.length<1000||value.length>20*1024*1024)
      throw new Error('Неправильный размер отчёта');
    savedReport=value;
    return value;
  }).finally(()=>{renderInFlight=null;});
  return renderInFlight;
}
async function uploadPdf(chatId,pdf,fetchImpl=fetch,token=process.env.TG_TOKEN) {
  if(!token)throw new Error('TG_TOKEN не настроен');
  const form=new FormData();
  form.append('chat_id',String(chatId));
  form.append('caption','ХвостМаркет · отчёт собственникам по срезу базы на 16.11.2026. Продажи семи точек и прогноз.');
  form.append('document',new Blob([pdf],{type:'application/pdf'}),FILE_NAME);
  const response=await fetchImpl('https://api.telegram.org/bot'+token+'/sendDocument',{
    method:'POST',body:form,signal:AbortSignal.timeout(30000),
  });
  const body=await response.json().catch(()=>({}));
  if(!response.ok||!body.ok)throw new Error(body.description||'Telegram не подтвердил доставку PDF');
  return body.result;
}
async function sendOwnerReport(chatId,senderId,deps={}){
  if(!mayReadOwnerReport(chatId,senderId)){
    return {ok:false,message:'🔒 PDF для собственников доступен только привязанному супер-администратору ХвостМаркета в личном Telegram-чате.'};
  }
  try{
    const content=await (deps.renderPdf||cachedPdf)();
    const receipt=await (deps.uploadPdf||uploadPdf)(chatId,content);
    if(!receipt)return {ok:false,message:'Не удалось подтвердить отправку отчёта. Попробуйте команду /ownerpdf ещё раз.'};
    return {ok:true,message:'✅ Отчёт собственникам за 16.11.2026 отправлен в этот чат PDF-файлом.'};
  }catch(error){
    console.warn('[ownerpdf] failed:',error.message);
    return {ok:false,message:'⚠️ Не удалось отправить PDF: '+String(error.message).slice(0,160)+'. Попробуйте позже.'};
  }
}
module.exports={
  REPORT_DATE,FILE_NAME,buildOwnerReportPages,buildOwnerSnapshotPdf,
  mayReadOwnerReport,sendOwnerReport,uploadPdf,
};
