'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

const money = value => value == null ? 'Не сохранена' : Number(value).toLocaleString('ru-RU') + ' ₽';
const percent = value => value == null ? 'Нет данных' : (Number(value) * 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + '%';
const date = value => value ? String(value).slice(0, 10).split('-').reverse().join('.') : 'Не сохранена';
const escape = value => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\r\n\t\x00-\x1f]/g, ' ');

function wrap(value, count) {
  const words = String(value == null ? '' : value).replace(/\u00a0|\u202f/g, ' ').split(/\s+/).filter(Boolean);
  const lines = []; let line = '';
  for (let word of words) {
    if (word.length > count) {
      if (line) { lines.push(line); line = ''; }
      while (word.length > count) { lines.push(word.slice(0, count)); word = word.slice(count); }
    }
    if (line && (line + ' ' + word).length > count) { lines.push(line); line = ''; }
    line += (line ? ' ' : '') + word;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function payoutPdfPages(report, font) {
  const { localDateTime, itemNames, rub, rate, shortDate } = require('./payout-report-compact');
  const pages = [];
  let commands = [], y = 0;
  const esc = value => String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\r\n\t]/g, ' ');
  const write = (x, yy, value, size = 19, fill = '#263B2D') =>
    commands.push("font '" + esc(font) + "' font-size " + size + " fill '" + fill + "' text " + x + "," + yy + " '" + esc(value) + "'");
  const rect = (x, yy, w, h, fill) => commands.push("fill '" + fill + "' rectangle " + x + "," + yy + " " + (x+w) + "," + (yy+h));
  const page = () => {
    commands = ['push graphic-context','viewbox 0 0 1240 1754',"fill '#FFFFFF' rectangle 0,0 1240,1754"];
    pages.push(commands);
    rect(0,0,1240,170,'#1C3A2F');
    write(60,68,'ХвостМаркет',36,'#FFFFFF');
    write(60,119,'Расчёт вознаграждения',29,'#FFFFFF');
    write(60,151,shortDate(report.period_start) + ' - ' + shortDate(report.period_end),19,'#FFFFFF');
    y=222;
  };
  const paragraph = (value,size=19,fill='#263B2D') => {
    for (const line of wrap(value,Math.floor(1080/(size*.56)))) {
      if(y>1615) page();
      write(60,y,line,size,fill);y+=size*1.45;
    }
    y+=12;
  };
  page();
  paragraph((report.role === 'manager'?'Менеджер':report.role === 'owner'?'Владелец салона':'Грумер') + ': ' + report.recipient.name,25);
  if (report.recipient.point) paragraph('Точка: ' + report.recipient.point,19);
  paragraph('Проданные товары · Красноярск',23);
  rect(58,y-25,1120,44,'#E8EFEA');
  write(70,y+4,'Дата и время / товары',18);
  write(790,y+4,'Продажи',17);
  write(930,y+4,'Ставка',17);
  write(1040,y+4,'Начислено',17);
  y+=43;
  if(!(report.items||[]).length) paragraph('Продаж нет');
  for(const item of report.items||[]) {
    const names=itemNames(item).flatMap(name=>wrap(name,62));
    const detail=(report.role==='manager' && item.point) ? wrap('Точка: '+item.point,62) : [];
    const height=Math.max(88,57+names.length*27+detail.length*24);
    if(y+height>1590) { page(); paragraph('Проданные товары (продолжение)',21); }
    rect(58,y-25,1120,height,(report.items.indexOf(item)%2)?'#F5F7F5':'#FFFFFF');
    write(70,y+3,localDateTime(item.date),18);
    write(790,y+3,rub(item.base),18);
    write(930,y+3,rate(item.rate),18);
    write(1040,y+3,rub(item.amount),18);
    let py=y+35;
    names.forEach(s=>{write(87,py,s,18);py+=27;});
    detail.forEach(s=>{write(87,py,s,16,'#607267');py+=24;});
    y+=height;
  }
  const totalLine=(label,value,emphasis=false)=>{
    if(y>1570)page();
    rect(58,y-22,1120,51,emphasis?'#E8F1EA':'#FFFFFF');
    write(76,y+10,label,emphasis?25:21);
    write(960,y+10,rub(value),emphasis?27:22,emphasis?'#1C6144':'#263B2D');
    y+=60;
  };
  if(y>1370)page();
  y+=25;
  totalLine('Вознаграждение с продаж',report.commission_accrued);
  if((report.bonuses||[]).length) {
    for(const bonus of report.bonuses) {
      paragraph('Бонус: '+(bonus.point||bonus.point_name||'за точку'),17);
      totalLine('Начислено за бонус',bonus.amount);
    }
  }
  totalLine('Всего начислено',report.accrued);
  if(report.kind === 'payout') totalLine('Сумма выплаты',report.payout_amount,true);
  else {
    totalLine('Уже выплачено',report.already_paid);
    totalLine('Осталось выплатить',report.unpaid,true);
  }
  if(report.lifetime_earned != null) totalLine('Заработано всего',report.lifetime_earned);
  paragraph('Комиссия округляется по каждому заказу отдельно. Время - Красноярск (UTC+7).',15,'#65766A');
  pages.forEach((p,i)=>{commands=p;write(60,1715,'ХвостМаркет · отчёт '+(report.id||'предпросмотр'),15,'#64766A');write(1020,1715,(i+1)+' / '+pages.length,15,'#64766A');p.push('pop graphic-context');});
  return pages.map(p=>p.join('\n'));
}

let pdfRunning = false;
async function renderPayoutPdf(report) {
  if (pdfRunning) throw Object.assign(new Error('Другой PDF ещё формируется. Повторите через несколько секунд.'), { statusCode: 429 });
  pdfRunning = true;
  let dir;
  try {
    const { findFont, writePdfFromJpegs } = require('./weekly-report');
    const pages = payoutPdfPages(report, findFont());
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hvost-payout-pdf-'));
    let command = 'convert';
    try { await run(command, ['-version']); } catch { command = 'magick'; await run(command, ['-version']); }
    const images = [];
    for (let i = 0; i < pages.length; i++) {
      const input = path.join(dir, 'page-' + i + '.mvg'), output = path.join(dir, 'page-' + i + '.jpg');
      await fs.promises.writeFile(input, pages[i]);
      await run(command, ['-limit','memory','128MiB','-limit','map','256MiB','mvg:' + input, '-background','white','-alpha','remove','-strip','-quality','94',output], { timeout:20000, maxBuffer:1024 * 1024 });
      images.push(output);
    }
    const output = path.join(dir, 'report.pdf');
    writePdfFromJpegs(images, output);
    return await fs.promises.readFile(output);
  } finally {
    try { if (dir) await fs.promises.rm(dir, { recursive:true, force:true }); }
    finally { pdfRunning = false; }
  }
}

module.exports = { wrap, payoutPdfPages, renderPayoutPdf };
