// A readable, private daily PDF with all open tasks of one responsible person.
// Uses DejaVu Sans/ImageMagick already installed for HvostMarket reports.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

const W=1240, H=1754;
const palette={forest:'#1C3A2F',light:'#F3F7F3',text:'#24372E',
  muted:'#607267',red:'#A64140',green:'#1A6E4F',blue:'#526C87'};

function safe(value, max=450){
  return String(value ?? '').replace(/[\x00-\x1f\x7f]/g,' ')
    .replace(/\s+/g,' ').trim().slice(0,max);
}
function esc(value){
  return String(value ?? '').replace(/\\/g,'\\\\').replace(/'/g,"\\'")
    .replace(/[\x00-\x1f\x7f]/g,' ');
}
function wrap(value,max=75){
  const words=safe(value,2000).split(' ').filter(Boolean),rows=[];
  let line='';
  for(let word of words){
    if(word.length>max){
      if(line){rows.push(line);line='';}
      while(word.length>max){rows.push(word.slice(0,max));word=word.slice(max);}
    }
    if(line&&line.length+1+word.length>max){rows.push(line);line='';}
    line+=(line?' ':'')+word;
  }
  if(line)rows.push(line);
  return rows.length?rows:[''];
}
const dateRu=value=> /^\d{4}-\d{2}-\d{2}$/.test(String(value||''))
  ? String(value).split('-').reverse().join('.') : 'без срока';
const priorityName={critical:'Критический',high:'Высокий',normal:'Обычный',low:'Низкий'};
const statusName={new:'Не начато',in_progress:'В работе',blocked:'Заблокировано'};
function cardParts(task){
  const title=wrap('#'+task.id+' · '+safe(task.title,260),77);
  const meta='Срок: '+dateRu(task.due_date)+
    '    Статус: '+(statusName[task.status]||safe(task.status,30))+
    '    Приоритет: '+(priorityName[task.priority]||'Обычный');
  const detail=task.description?wrap('Описание: '+safe(task.description,340),105).slice(0,4):[];
  return {title,meta,detail,height:45+title.length*32+35+detail.length*27};
}
function taskDigestPdfPages(report,font){
  if(!report||!report.assignee||!report.sections)throw Error('Недостаточно данных для PDF задач');
  const pages=[];
  let current,y;
  function text(x,yy,value,size=20,color=palette.text){
    current.push("font '"+esc(font)+"' font-size "+size+" fill '"+color+
      "' text "+x+","+yy+" '"+esc(value)+"'");
  }
  function rect(x1,y1,x2,y2,fill){
    current.push("fill '"+fill+"' rectangle "+x1+","+y1+" "+x2+","+y2);
  }
  function page(continued=false){
    current=['push graphic-context','viewbox 0 0 '+W+' '+H,
      "fill '#FFFFFF' rectangle 0,0 "+W+","+H];
    pages.push(current);
    rect(0,0,W,182,palette.forest);
    text(64,69,'ХвостМаркет',39,'#FFFFFF');
    text(64,117,'Поручения · утренняя сводка'+(continued?' (продолжение)':''),28,'#FFFFFF');
    text(64,151,safe(report.local_date,12)+' · Красноярск',20,'#E1EEE4');
    y=227;
  }
  function ensure(height=40){if(y+height>1620)page(true);}
  page();
  for(const line of wrap('Ответственный: '+safe(report.assignee.full_name,110),75)){
    ensure(38);text(64,y,line,26,palette.text);y+=38;
  }
  const total=report.totals?.total??['overdue','work','later'].reduce((sum,k)=>
    sum+(report.sections[k]||[]).length,0);
  text(64,y+16,'Активных: '+total+'  |  Просрочено: '+report.sections.overdue.length+
    '  |  В работе: '+report.sections.work.length+
    '  |  Позже: '+report.sections.later.length,20,palette.muted);
  y+=85;
  const sections=[
    {key:'overdue',name:'ПРОСРОЧЕНО',color:palette.red},
    {key:'work',name:'В РАБОТЕ / АКТУАЛЬНО',color:palette.green},
    {key:'later',name:'ПОЗЖЕ',color:palette.blue},
  ];
  for(const section of sections){
    const tasks=report.sections[section.key]||[];
    ensure(104);
    rect(60,y-27,1180,y+24,section.color);
    text(80,y+7,section.name+' · '+tasks.length,23,'#FFFFFF');
    y+=66;
    if(!tasks.length){
      text(76,y,'Поручений нет',18,palette.muted);y+=46;
      continue;
    }
    for(let index=0;index<tasks.length;index++){
      const task=tasks[index];
      const parts=cardParts(task);
      const height=Math.max(98,parts.height);
      ensure(height+23);
      const top=y-31;
      rect(62,top,1180,top+height,index%2===0?'#F3F7F3':'#FFFFFF');
      rect(62,top,69,top+height,section.color);
      let ty=y+1;
      for(const titleLine of parts.title){text(86,ty,titleLine,22,palette.text);ty+=32;}
      text(86,ty+3,parts.meta,17,palette.muted);ty+=40;
      for(const detailLine of parts.detail){text(86,ty,detailLine,17,palette.text);ty+=27;}
      y=top+height+18;
    }
    y+=20;
  }
  pages.forEach((commands,index)=>{
    current=commands;
    rect(0,1667,W,H,'#F3F7F3');
    text(64,1705,'Управляйте поручениями кнопкой под PDF или командой /tasks.',17,palette.muted);
    text(64,1731,'Отчёт — срез на дату формирования. Завершённые задачи не показаны.',15,palette.muted);
    text(1080,1725,String(index+1)+' / '+pages.length,18,palette.muted);
    commands.push('pop graphic-context');
  });
  return pages.map(commands=>commands.join('\n'));
}

let rendering=false;
async function renderTaskDailyDigestPdf(report){
  if(rendering)throw Error('Другой PDF поручений ещё формируется');
  rendering=true;
  let dir;
  try{
    const {findFont,writePdfFromJpegs}=require('./weekly-report');
    const pages=taskDigestPdfPages(report,findFont());
    dir=await fs.promises.mkdtemp(path.join(os.tmpdir(),'hvost-task-digest-'));
    let binary='convert';
    try{await run(binary,['-version'],{timeout:4000});}
    catch{binary='magick';await run(binary,['-version'],{timeout:4000});}
    const images=[];
    for(let i=0;i<pages.length;i++){
      const input=path.join(dir,'task-'+i+'.mvg');
      const output=path.join(dir,'task-'+i+'.jpg');
      await fs.promises.writeFile(input,pages[i],{mode:0o600});
      await run(binary,['-limit','memory','128MiB','-limit','map','256MiB',
        'mvg:'+input,'-background','white','-alpha','remove','-strip','-quality','90',output],
        {timeout:25000,maxBuffer:1048576});
      images.push(output);
    }
    const output=path.join(dir,'tasks.pdf');
    writePdfFromJpegs(images,output);
    return await fs.promises.readFile(output);
  }finally{
    try{if(dir)await fs.promises.rm(dir,{recursive:true,force:true});}
    finally{rendering=false;}
  }
}
module.exports={taskDigestPdfPages,renderTaskDailyDigestPdf,wrap,cardParts};
