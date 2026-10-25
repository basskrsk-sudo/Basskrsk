// Print-ready consolidated payout statement: one independent section per payee.
// Uses the same DejaVu/ImageMagick + JPEG PDF pipeline as other HvostMarket reports.
'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);
const {money,clean}=require('./payout-brief');

const LABELS={partner:'Грумер',owner:'Владелец салона',manager:'Менеджер'};
const W=1240,H=1754;
function esc(value){
  return String(value??'').replace(/\\/g,'\\\\').replace(/'/g,"\\'")
    .replace(/[\x00-\x1f\x7f]/g,' ');
}
function wrap(value,width){
  const words=String(value??'').replace(/\s+/g,' ').trim().split(' ').filter(Boolean);
  const lines=[];let current='';
  for(let word of words){
    if(word.length>width){
      if(current){lines.push(current);current='';}
      while(word.length>width){lines.push(word.slice(0,width));word=word.slice(width);}
    }
    if(current && current.length+1+word.length>width){lines.push(current);current='';}
    current+=(current?' ':'')+word;
  }
  if(current)lines.push(current);
  return lines.length?lines:[''];
}
function payoutBriefPdfPages(report,font){
  const pages=[];
  let lines=[],y=0,person=null,pageNo=0;
  function rectangle(x1,y1,x2,y2,fill){
    lines.push("fill '"+fill+"' rectangle "+x1+","+y1+" "+x2+","+y2);
  }
  function text(x,yy,value,size=19,color='#22382C'){
    lines.push("font '"+esc(font)+"' font-size "+size+" fill '"+color+
      "' text "+x+","+yy+" '"+esc(value)+"'");
  }
  function startPage(recipient,continuation=false){
    person=recipient || person;
    lines=['push graphic-context',"viewbox 0 0 "+W+" "+H,
      "fill '#FFFFFF' rectangle 0,0 "+W+","+H];
    pages.push(lines);pageNo++;
    rectangle(0,0,W,166,'#1C3A2F');
    text(60,69,'ХвостМаркет',36,'#FFFFFF');
    text(60,115,'Справка для подготовки выплат',29,'#FFFFFF');
    text(60,147,'Невыплаченные начисления · '+report.generated_at.slice(0,10),18,'#FFFFFF');
    y=218;
    if(person){
      for(const part of wrap('Получатель: '+clean(person.name,110),62)){
        text(60,y,part,part.startsWith('Получатель:')?27:25);y+=38;
      }
      text(60,y,person.roles_label+(continuation?' (продолжение)':''),19,'#52695A');
      y+=40;
    }
  }
  function footer(){
    for(let i=0;i<pages.length;i++){
      const p=pages[i];
      p.push("font '"+esc(font)+"' font-size 15 fill '#66776A' text 60,1695 'Подготовлено в ХвостМаркете. Не является подтверждением перевода денег.'");
      p.push("font '"+esc(font)+"' font-size 15 fill '#66776A' text 1035,1695 'Лист "+(i+1)+" из "+pages.length+"'");
      p.push('pop graphic-context');
    }
  }
  function ensure(height=58){
    if(y+height>1625)startPage(person,true);
  }
  function paragraph(value,color='#52695A',size=18){
    for(const part of wrap(value,Math.max(37,Math.floor(1075/(size*.56))))){
      ensure(size*1.55);
      text(65,y,part,size,color);y+=size*1.4;
    }
    y+=7;
  }
  function line(label,amount,style='normal'){
    const labelLines=wrap(label,style==='total'?49:70);
    const height=Math.max(58,24+labelLines.length*25);
    ensure(height+16);
    const background=style==='total'?'#E4F1E5':style==='heading'?'#F1F6F0':'#FFFFFF';
    rectangle(58,y-25,1180,y+height-28,background);
    for(let i=0;i<labelLines.length;i++)text(75,y+i*25,labelLines[i],style==='total'?22:19);
    text(965,y+2,money(amount),style==='total'?26:21,
      style==='total'?'#1B6944':'#263B2D');
    y+=height;
  }
  startPage(null);
  paragraph('Ведомость · '+report.people.length+' получателей', '#1C3A2F',27);
  line('Всего к выплате (предварительно)',report.total,'total');
  line('Комиссионные начисления',report.commission);
  line('Невыплаченные бонусы',report.bonus);
  for(const role of ['partner','owner','manager'])line('В том числе: '+LABELS[role],report.role_totals[role]);
  if(report.held_orders)paragraph('Внимание: '+report.held_orders+' заказов с возвратами исключены из расчёта до ручной сверки.','#A33D32',18);
  if(report.identities_to_verify?.length)paragraph('Совпадающие ФИО без подтверждённой личности не объединены; проверьте в админке.','#A33D32',17);
  paragraph('На следующих листах — отдельная справка каждому получателю. Если человек одновременно грумер и менеджер, начисления представлены в одной справке с разбивкой по ролям.', '#52695A',18);
  if(!report.people.length)paragraph('Невыплаченных начислений нет.');
  for(const recipient of report.people){
    startPage(recipient);
    line('Общая сумма к выплате',recipient.total,'total');
    line('Комиссии со всех ролей',recipient.commission);
    if(recipient.bonus)line('Бонусы',recipient.bonus);
    for(const section of recipient.statements){
      ensure(140);
      y+=20;
      paragraph(section.role_label+(section.point?' · '+section.point:''),'#1C3A2F',23);
      line('Вознаграждение с продаж ('+section.orders+' заказов)',section.commission,'heading');
      for(const row of section.points){
        const rate=(row.rate*100).toLocaleString('ru-RU',{maximumFractionDigits:2})+'%';
        line(row.point+' · '+row.orders+' заказов · '+rate,row.amount);
      }
      for(const bonus of section.bonuses){
        line((bonus.type==='launch_bonus'?'Бонус за запуск':'Реферальный бонус')+' · '+bonus.point,bonus.amount);
      }
      if(section.held_orders)paragraph('На сверке: '+section.held_orders+' заказов с возвратами; комиссия '+money(section.held_amount)+' не включена.','#A33D32',17);
    }
    ensure(95);
    y+=18;
    line('ИТОГО к выплате · '+recipient.name,recipient.total,'total');
    paragraph('Сумма предварительная, до возможных налоговых удержаний. Заказы с возвратами исключены до проверки. Указанные средства ещё не перечислены.','#52695A',17);
  }
  footer();
  return pages.map(commands=>commands.join('\n'));
}

let running=false;
async function renderPayoutBriefPdf(report){
  if(running)throw new Error('Другой PDF выплат уже формируется. Повторите запрос позже.');
  running=true;
  let dir;
  try{
    const {findFont,writePdfFromJpegs}=require('./weekly-report');
    dir=await fs.promises.mkdtemp(path.join(os.tmpdir(),'hvost-payout-brief-'));
    const pages=payoutBriefPdfPages(report,findFont());
    let binary='convert';
    try{await run(binary,['-version']);}catch{binary='magick';await run(binary,['-version']);}
    const images=[];
    for(let i=0;i<pages.length;i++){
      const source=path.join(dir,'page-'+i+'.mvg');
      const image=path.join(dir,'page-'+i+'.jpg');
      await fs.promises.writeFile(source,pages[i],{mode:0o600});
      await run(binary,['-limit','memory','128MiB','-limit','map','256MiB',
        'mvg:'+source,'-background','white','-alpha','remove','-strip','-quality','91',image],
        {timeout:25000,maxBuffer:1048576});
      images.push(image);
    }
    const output=path.join(dir,'statement.pdf');
    writePdfFromJpegs(images,output);
    return await fs.promises.readFile(output);
  }finally{
    try{if(dir)await fs.promises.rm(dir,{recursive:true,force:true});}
    finally{running=false;}
  }
}
module.exports={payoutBriefPdfPages,renderPayoutBriefPdf,wrap};
