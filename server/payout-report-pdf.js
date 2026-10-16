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
  const pages = []; let commands, y;
  const name = report.role === 'owner' ? 'владельца салона' : report.role === 'manager' ? 'менеджера' : 'грумера';
  const text = (x, top, value, size = 21, color = '#202D28') => commands.push(`font '${escape(font)}' font-size ${size} fill '${color}' text ${x},${top} '${escape(value)}'`);
  const rect = (x, top, width, height, color) => commands.push(`fill '${color}' rectangle ${x},${top} ${x + width},${top + height}`);
  const newPage = () => {
    if (pages.length >= 100) throw Object.assign(new Error('Отчёт слишком большой. Выберите более короткий период.'), { statusCode: 413 });
    commands = ['push graphic-context', 'viewbox 0 0 1240 1754', "fill '#FFFFFF' rectangle 0,0 1240,1754"];
    pages.push(commands);
    rect(0, 0, 1240, 180, '#1C3A2F');
    text(62, 64, 'ХвостМаркет', 37, '#FFFFFF');
    text(62, 110, 'Отчёт ' + name + (report.id ? ' № ' + report.id : ''), 28, '#FFFFFF');
    text(62, 151, 'Период расчёта: ' + date(report.period_start) + ' - ' + date(report.period_end) + ' (UTC)', 21, '#DAE9E0');
    y = 224;
  };
  const paragraph = (value, { size = 21, color = '#202D28', gap = 14 } = {}) => {
    const lines = wrap(value, Math.floor(1116 / (size * .65)));
    for (const line of lines) {
      if (y + size * 1.5 > 1630) newPage();
      text(62, y, line, size, color); y += size * 1.45;
    }
    y += gap;
  };
  const table = (headers, rows, widths) => {
    let headerNeeded = true;
    const header = () => {
      rect(62, y, 1116, 62, '#E9F0EB');
      let x = 62;
      headers.forEach((v, i) => { wrap(v, Math.floor((widths[i] - 20) / 11)).forEach((s, j) => text(x + 10, y + 24 + j * 22, s, 17)); x += widths[i]; });
      y += 62; headerNeeded = false;
    };
    rows.forEach((row, rowIndex) => {
      const cells = row.map((v, i) => wrap(v, Math.floor((widths[i] - 20) / 12)));
      const length = Math.max(...cells.map(c => c.length));
      let offset = 0;
      while (offset < length) {
        if (y + (headerNeeded ? 62 : 0) + 68 > 1630) { newPage(); headerNeeded = true; }
        if (headerNeeded) header();
        const count = Math.min(length - offset, Math.floor((1630 - y - 18) / 26));
        const height = count * 26 + 18;
        rect(62, y, 1116, height, rowIndex % 2 ? '#F1F5F2' : '#FAFBFA');
        let x = 62;
        cells.forEach((lines, i) => { lines.slice(offset, offset + count).forEach((s, j) => text(x + 10, y + 29 + j * 26, s, 19)); x += widths[i]; });
        y += height; offset += count;
        if (offset < length) { newPage(); headerNeeded = true; }
      }
    });
    if (!rows.length) paragraph('За выбранный период заказов нет.', { size: 20 });
    y += 22;
  };
  newPage();
  paragraph('Получатель: ' + report.recipient.name, { size: 28 });
  paragraph('Код: ' + (report.recipient.code || 'не указан') + '   |   Точка: ' + (report.recipient.point || 'по заказам получателя'));
  if (report.kind === 'payout') paragraph('Выплата № ' + (report.payout_id || report.bonus_payout_id || '') + ' от ' + date(report.paid_at) + ': ' + money(report.payout_amount), { size: 23 });
  paragraph('Заказов: ' + report.items.length + '   |   Начислено: ' + money(report.accrued), { size: 25 });
  paragraph('Уже выплачено: ' + money(report.kind === 'payout' ? report.payout_amount : report.already_paid) + '   |   ' + (report.kind === 'payout' ? 'Сумма выплаты: ' + money(report.payout_amount) : 'К выплате: ' + money(report.unpaid)), { size: 24, color: '#1C6144' });
  if (report.role === 'manager' && report.point_totals?.length) {
    paragraph('Комиссия по точкам', { size:26 });
    table(['Точка','Заказов','Начислено'], report.point_totals.map(p=>[p.point,p.orders,money(p.amount)]), [636,180,300]);
    paragraph('В сводке только комиссия с заказов. Бонусы показаны отдельно.', { size:18 });
  }
  paragraph('Расчёт по каждому заказу', { size: 26 });
  table(['Заказ', 'Дата UTC', 'База', 'Ставка', 'Расчёт', 'Вознаграждение'], report.items.map(i => [
    i.order_code + (report.role === 'manager' && i.point ? ' / ' + i.point : ''), i.date || 'Не сохранена', money(i.base), percent(i.rate),
    i.base == null || i.rate == null ? 'Исторический расчёт не сохранён' : money(i.base) + ' × ' + percent(i.rate) + ' = ' + money(i.amount),
    money(i.amount) + ' / ' + (report.kind === 'payout' ? 'Выплачено' : i.already_paid ? 'Уже выплачено' : 'К выплате'),
  ]), [220,175,160,110,240,211]);
  const bonusTable = (title, rows, key, informational = false) => {
    if (!rows?.length) return;
    paragraph(title, { size: 25 });
    table(['Точка', 'Дата UTC', 'Сумма', 'Учёт'], rows.map(b => [b.point || b.point_name || '-', b[key] || 'Не сохранена', money(b.amount), informational ? 'Вне итогов' : key === 'paid_at' || report.kind === 'payout' || b.already_paid ? 'Выплата зафиксирована' : 'К выплате']), [380,260,200,276]);
  };
  bonusTable('Бонусы за привлечение точек', report.bonuses, 'accrued_at');
  paragraph('Комиссия с заказов: ' + money(report.commission_accrued ?? report.accrued) + '. Бонусы: ' + money(report.bonus_accrued || 0) + '.', { size: 23 });
  bonusTable('Переводы бонусов за период (справочно)', report.bonus_payments, 'paid_at', true);
  bonusTable('Старые бонусы без даты (вне итогов)', report.undated_bonuses, 'accrued_at', true);
  const m = report.metadata || {};
  if (m.contract_number || m.contract_date) paragraph('Договор № ' + (m.contract_number || '-') + ' от ' + date(m.contract_date));
  for (const [key, title] of [['principal','Заказчик'], ['recipient_details','Реквизиты получателя'], ['actions','Выполненные действия'], ['tax_note','Налоговый статус и удержания'], ['payment_reference','Банковский платёж']]) {
    if (m[key]) paragraph(title + ': ' + m[key], { size: 20 });
  }
  paragraph('Итого начислено за период: ' + money(report.accrued), { size: 26 });
  paragraph(report.kind === 'payout' ? 'Итоговая сумма выплаты: ' + money(report.payout_amount) : 'Осталось к выплате: ' + money(report.unpaid), { size: 28, color: '#1C6144' });
  paragraph('Каждое вознаграждение округлено до целого рубля. Итог - сумма строк, а не процент от общей выручки.', { size: 18, color: '#5C675F' });
  for (const warning of report.warnings || []) paragraph(String(warning)
    .replace('статусом paid', 'статусом «Оплачен»')
    .replace('Историческое поле bonus_paid означает начисление, а не перевод денег.', 'Отметка о начислении бонуса не подтверждает перевод денег.'), { size: 17, color: '#5C675F', gap: 8 });
  pages.forEach((p, i) => { commands = p; text(62, 1700, 'Сформировано: ' + date(report.generated_at) + '  |  Отчёт ' + (report.id || 'проект'), 16, '#5C675F'); text(980, 1700, 'Стр. ' + (i + 1) + ' / ' + pages.length, 16, '#5C675F'); p.push('pop graphic-context'); });
  return pages.map(p => p.join('\n'));
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
