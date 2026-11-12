'use strict';
// Pure PDF renderer. Deliberately never imports ./db: worker startup must not
// repeat schema migrations or open a second writable SQLite connection.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

function findFont() {
  const candidates = [
    process.env.REPORT_FONT_PATH,
    '/usr/share/fonts/dejavu/DejaVuSans.ttf',           // Alpine (пакет font-dejavu)
    '/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf',       // старые Alpine / Arch
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',  // Debian / Ubuntu
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) return found;
  // Запасной вариант: ищем DejaVuSans.ttf рекурсивно по стандартным папкам
  // шрифтов — на случай, если пакет в очередной версии ОС переедет в новый путь.
  for (const dir of ['/usr/share/fonts', '/usr/local/share/fonts']) {
    const hit = findFontRecursive(dir, 'DejaVuSans.ttf', 4);
    if (hit) return hit;
  }
  throw new Error('Шрифт DejaVu Sans для PDF не найден');
}

function findFontRecursive(dir, name, depth) {
  if (depth < 0) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    const full = dir + '/' + entry.name;
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const hit = findFontRecursive(full, name, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

function mvgEscape(value) { return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' '); }
function wrapText(value, maxChars) {
  const words = String(value || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  words.forEach((word) => {
    if (!line || (line + ' ' + word).length <= maxChars) line += (line ? ' ' : '') + word;
    else { lines.push(line); line = word; }
  });
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

class ReportPage {
  constructor(font, title, subtitle) {
    this.font = font;
    this.commands = [
      'push graphic-context', 'viewbox 0 0 1240 1754', "fill '#F7F5EF'", 'rectangle 0,0 1240,1754',
      "fill '#1C3A2F'", 'rectangle 0,0 1240,175', "font '" + mvgEscape(font) + "'",
    ];
    this.text(62, 78, title, 38, '#FFFFFF');
    this.text(62, 128, subtitle, 22, '#D9F0E5');
  }
  rect(x1, y1, x2, y2, fill, radius) {
    this.commands.push("fill '" + fill + "'", radius ? 'roundrectangle ' + [x1,y1,x2,y2,radius,radius].join(',') : 'rectangle ' + [x1,y1,x2,y2].join(','));
  }
  text(x, y, value, size, color, bold) {
    this.commands.push("font '" + mvgEscape(this.font) + "'", 'font-size ' + size, "fill '" + (color || '#2A2218') + "'", 'font-weight ' + (bold ? 700 : 400), "text " + x + ',' + y + " '" + mvgEscape(value) + "'");
  }
  wrapped(x, y, value, maxChars, size, color, lineHeight, bold) {
    const lines = wrapText(value, maxChars);
    lines.forEach((line, index) => this.text(x, y + index * (lineHeight || size * 1.35), line, size, color, bold));
    return y + lines.length * (lineHeight || size * 1.35);
  }
  card(x, y, width, height, label, value, accent) {
    this.rect(x, y, x + width, y + height, '#FFFFFF', 20);
    this.text(x + 22, y + 35, label, 18, '#7A7165', false);
    this.text(x + 22, y + 86, value, 31, accent || '#1C3A2F', true);
  }
  table(x, y, widths, headers, rows, options = {}) {
    const rowHeight = options.rowHeight || 52;
    const fontSize = options.fontSize || 17;
    const totalWidth = widths.reduce((a, b) => a + b, 0);
    this.rect(x, y, x + totalWidth, y + rowHeight, '#1C3A2F', 8);
    let cursor = x;
    headers.forEach((header, index) => { this.text(cursor + 10, y + 33, header, 15, '#FFFFFF', true); cursor += widths[index]; });
    rows.forEach((row, rowIndex) => {
      const top = y + rowHeight * (rowIndex + 1);
      this.rect(x, top, x + totalWidth, top + rowHeight, rowIndex % 2 ? '#F3EFE7' : '#FFFFFF', 0);
      let cellX = x;
      row.forEach((cell, index) => {
        const maxChars = Math.max(5, Math.floor(widths[index] / (fontSize * .56)));
        const text = String(cell == null ? '' : cell);
        this.text(cellX + 10, top + 33, text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text, fontSize, '#2A2218', index === 0);
        cellX += widths[index];
      });
    });
    return y + rowHeight * (rows.length + 1);
  }
  finish() { return this.commands.concat(['pop graphic-context']).join('\n'); }
}

function rub(value) { return Math.round(Number(value || 0)).toLocaleString('ru-RU') + ' ₽'; }
function metricChange(value) { return value === null ? 'нет базы' : (value > 0 ? '+' : '') + value + '%'; }

function buildPdfPages(report, font) {
  const pages = [];
  const subtitle = report.period.start_local + ' — ' + report.period.end_local + ' · сформирован ' + new Date(report.generated_at).toLocaleString('ru-RU', { timeZone: 'Asia/Krasnoyarsk' });
  const strategy = new ReportPage(font, 'ХвостМаркет · Стратегия BSC', subtitle);
  strategy.card(62, 225, 350, 150, 'Общий индекс бизнеса', report.bsc.overall_score + ' / 100', report.bsc.overall_score >= 70 ? '#1C3A2F' : '#9B2335');
  strategy.text(450, 260, report.bsc.readiness.title, 29, report.bsc.overall_score >= 70 ? '#1C3A2F' : '#9B2335', true);
  strategy.wrapped(450, 305, report.bsc.readiness.description, 56, 18, '#7A7165', 26, false);
  strategy.text(62, 430, 'Четыре направления', 27, '#1C3A2F', true);
  report.bsc.perspectives.forEach((perspective, index) => {
    const x = 62 + (index % 2) * 570;
    const y = 465 + Math.floor(index / 2) * 150;
    strategy.card(x, y, 535, 118, perspective.name + ' · вес ' + perspective.weight + '%', perspective.score + ' / 100', perspective.score >= 85 ? '#2D7D46' : (perspective.score >= 70 ? '#D4872A' : '#9B2335'));
  });
  const deviations = report.bsc.perspectives.flatMap((item) => item.kpis.map((kpi) => ({ ...kpi, perspective: item.name })))
    .filter((kpi) => kpi.status !== 'green').sort((a, b) => (a.score ?? -1) - (b.score ?? -1)).slice(0, 9);
  strategy.text(62, 790, 'Основные отклонения', 27, '#1C3A2F', true);
  strategy.table(62, 820, [290,330,150,150], ['Направление','Показатель','Факт','Цель'], deviations.map((kpi) => [
    kpi.perspective, kpi.name, kpi.actual === null ? 'нет базы' : kpi.actual + ' ' + kpi.unit, kpi.target + ' ' + kpi.unit,
  ]), { rowHeight: 56, fontSize: 16 });
  const initiativeY = Math.min(1510, 930 + deviations.length * 56);
  strategy.text(62, initiativeY, 'Планы улучшения', 27, '#1C3A2F', true);
  strategy.text(390, initiativeY, 'Открыто: ' + report.bsc.initiatives_summary.open + ' · просрочено: ' + report.bsc.initiatives_summary.overdue, 19, report.bsc.initiatives_summary.overdue ? '#9B2335' : '#7A7165', true);
  pages.push(strategy.finish());
  const first = new ReportPage(font, 'ХвостМаркет · Планёрка ГД', subtitle);
  first.text(62, 225, 'Ключевые показатели', 27, '#1C3A2F', true);
  const cards = [
    ['Выручка', rub(report.current.revenue), metricChange(report.comparison.revenue_change_percent)],
    ['Оплаченные заказы', String(report.current.paidOrders.length), metricChange(report.comparison.orders_change_percent)],
    ['Средний чек', rub(report.current.average_check), metricChange(report.comparison.average_check_change_percent)],
    ['Чистая прибыль', rub(report.current.net_profit), report.current.margin_percent + '% маржа'],
    ['Покупатели', String(report.current.unique_customers), metricChange(report.comparison.customers_change_percent)],
    ['Оплата заказов', report.current.payment_conversion + '%', report.current.orders.length + ' создано'],
  ];
  cards.forEach((card, index) => {
    const column = index % 3;
    const row = Math.floor(index / 3);
    const x = 62 + column * 382;
    const y = 255 + row * 145;
    first.card(x, y, 350, 118, card[0], card[1], index === 3 && report.current.net_profit < 0 ? '#9B2335' : '#1C3A2F');
    first.text(x + 22, y + 108, card[2], 14, '#D4872A', true);
  });
  first.text(62, 570, 'Выручка по дням', 27, '#1C3A2F', true);
  const maxDaily = Math.max(1, ...report.daily.flatMap((day) => [day.revenue, day.previous_revenue]));
  // Шаг и ширина столбцов зависят от числа дней периода: для недели (7) раскладываем
  // широко, для длинного периода (до 31) — компактно, с прореженными подписями дат.
  const dailyDays = Math.max(1, report.daily.length);
  const step = Math.min(158, Math.floor(1086 / dailyDays));
  const barWidth = Math.max(7, Math.min(42, Math.floor(step * 0.27)));
  const labelEvery = Math.max(1, Math.ceil(dailyDays / 8));
  report.daily.forEach((day, index) => {
    const x = 92 + index * step;
    const baseY = 900;
    const currentHeight = Math.round(day.revenue / maxDaily * 250);
    const prevHeight = Math.round(day.previous_revenue / maxDaily * 250);
    first.rect(x, baseY - prevHeight, x + barWidth, baseY, '#C9C2B7', 5);
    first.rect(x + barWidth + 6, baseY - currentHeight, x + barWidth * 2 + 6, baseY, '#D4872A', 5);
    if (index % labelEvery === 0) first.text(x, baseY + 32, day.date.slice(5), 15, '#7A7165', false);
    if (dailyDays <= 10) first.text(x, baseY - currentHeight - 12, String(day.revenue), 13, '#1C3A2F', true);
  });
  first.text(62, 970, 'Риски и вопросы для обсуждения', 27, '#1C3A2F', true);
  let alertY = 1020;
  report.alerts.slice(0, 8).forEach((alert, index) => {
    first.rect(62, alertY - 28, 1178, alertY + 34, index === 0 && /сниз|отриц|ниже/.test(alert) ? '#FDECEA' : '#FFFFFF', 12);
    first.text(82, alertY + 7, String(index + 1) + '.', 18, '#D4872A', true);
    alertY = first.wrapped(118, alertY + 7, alert, 92, 17, '#2A2218', 24, false) + 22;
  });
  pages.push(first.finish());

  const second = new ReportPage(font, 'Продажи по точкам', subtitle);
  second.text(62, 225, 'Рейтинг точек', 27, '#1C3A2F', true);
  second.table(62, 255, [285,145,145,100,120,120], ['Точка','Город','Выручка','Заказы','Динамика','Низкий остаток'],
    report.points.slice(0, 12).map((point) => [point.name, point.city, rub(point.revenue), point.orders_count, metricChange(point.change_percent), point.out_count + point.low_count]),
    { rowHeight: 56, fontSize: 16 });
  second.text(62, 1030, 'Топ товаров', 27, '#1C3A2F', true);
  second.table(62, 1060, [360,150,150,160,160], ['Товар','Вариант','Штук','Выручка','Динамика'],
    report.products.slice(0, 9).map((product) => [product.name, product.weight, product.units, rub(product.revenue), metricChange(product.change_percent)]),
    { rowHeight: 56, fontSize: 16 });
  pages.push(second.finish());

  const third = new ReportPage(font, 'Финансы и клиенты', subtitle);
  third.text(62, 225, 'P&L периода', 27, '#1C3A2F', true);
  const pnlRows = [
    ['Выручка после возвратов', rub(report.current.revenue)],
    ['Комиссия грумерам', rub(report.current.costs.partnerCommission)],
    ['Комиссия менеджерам', rub(report.current.costs.managerCommission)],
    ['Комиссия владельцам', rub(report.current.costs.ownerCommission)],
    ['Налог 6%', rub(report.current.costs.tax)],
    ['Эквайринг 2%', rub(report.current.costs.acquiring)],
    ['Ручные расходы', rub(report.current.costs.manualExpenses)],
    ['Всего затрат', rub(report.current.costs.totalCosts)],
    ['Чистая прибыль', rub(report.current.net_profit)],
  ];
  third.table(62, 255, [500,300], ['Статья','Сумма'], pnlRows, { rowHeight: 58, fontSize: 18 });
  third.text(62, 880, 'Клиенты и лояльность', 27, '#1C3A2F', true);
  third.table(62, 910, [500,300], ['Показатель','Значение'], [
    ['Уникальные покупатели', report.customers.unique],
    ['Новые покупатели', report.customers.new_customers],
    ['Вернувшиеся покупатели', report.customers.returning_customers + ' · ' + report.customers.returning_share + '%'],
    ['Более одной покупки за период', report.customers.repeat_within_week],
    ['Начислено / потрачено косточек', report.customers.bones_accrued + ' / ' + report.customers.bones_spent],
    ['Возвращено клиентам', rub(report.current.refunds)],
  ], { rowHeight: 58, fontSize: 18 });
  pages.push(third.finish());

  const fourth = new ReportPage(font, 'Остатки и развитие сети', subtitle);
  fourth.text(62, 225, 'Операционное состояние', 27, '#1C3A2F', true);
  fourth.table(62, 255, [610,300], ['Показатель','Значение'], [
    ['Активных точек', report.operations.team.active_points],
    ['Позиций нет в наличии', report.operations.stock.out_positions],
    ['Позиций с остатком 1–2 шт.', report.operations.stock.low_positions],
    ['Розничная стоимость товара на точках', rub(report.operations.stock.retail_value)],
    ['Себестоимость товара на точках', rub(report.operations.stock.cost_value)],
    ['Единиц на центральных складах', report.operations.warehouse.units],
    ['Розничная стоимость центральных складов', rub(report.operations.warehouse.retail_value)],
    ['Перемещений согласовано / ожидает', report.operations.movements.approved_week + ' / ' + report.operations.movements.pending],
  ], { rowHeight: 60, fontSize: 18 });
  fourth.text(62, 850, 'Команда и выплаты', 27, '#1C3A2F', true);
  fourth.table(62, 880, [610,300], ['Показатель','Значение'], [
    ['Новых грумеров', report.operations.team.new_partners],
    ['Новых владельцев салонов', report.operations.team.new_owners],
    ['Новых менеджеров', report.operations.team.new_managers],
    ['Фактически выплачено грумерам', rub(report.operations.payouts.partner)],
    ['Фактически выплачено владельцам', rub(report.operations.payouts.owner)],
    ['Начислено комиссий за период', rub(report.current.costs.partnerCommission + report.current.costs.managerCommission + report.current.costs.ownerCommission)],
  ], { rowHeight: 60, fontSize: 18 });
  fourth.wrapped(62, 1390, 'Примечание: остатки приведены на момент формирования отчёта. Прибыль является управленческой оценкой на основе внесённых расходов, налога 6%, эквайринга 2% и действующих ставок комиссий.', 105, 17, '#7A7165', 25, false);
  pages.push(fourth.finish());

  const growth = report.growth_plan;
  const fifth = new ReportPage(font, 'План 1000 активных точек', subtitle);
  fifth.text(62, 225, 'План-факт-прогноз', 27, '#1C3A2F', true);
  const growthCards = [
    ['Активны 30 дней', String(growth.facts.active_30d)],
    ['План на дату', String(growth.progress.target_to_date)],
    ['Прогноз года', String(growth.progress.forecast_year_end)],
    ['Нужно / месяц', String(growth.progress.required_per_month)],
    ['Валовые запуски', rub(growth.financial.totals.expansion_investment)],
    ['Внешний капитал', rub(growth.financial.totals.external_funding)],
  ];
  growthCards.forEach((card, index) => {
    const x = 62 + (index % 3) * 382;
    const y = 255 + Math.floor(index / 3) * 145;
    fifth.card(x, y, 350, 118, card[0], card[1], index === 5 ? '#D4872A' : '#1C3A2F');
  });
  fifth.text(62, 570, 'Пятилетняя траектория', 27, '#1C3A2F', true);
  fifth.table(62, 600, [110,130,150,180,200,200], ['Год','Новых','Сеть','Темп / мес.','Запуски','Поток'],
    growth.financial.rows.map((row) => [row.year,row.new_points,row.target_points,row.launches_per_month,rub(row.expansion_investment),rub(row.net_cash)]),
    { rowHeight:68, fontSize:17 });
  fifth.text(62, 1080, 'Сценарии и мощность команды', 27, '#1C3A2F', true);
  fifth.table(62, 1110, [250,150,220,220], ['Сценарий','Точки 2031','Внешний капитал','Поток 5 лет'],
    growth.scenarios.map((row) => [row.name,row.target_2031,rub(row.external_funding),rub(row.net_cash)]),
    { rowHeight:58, fontSize:16 });
  const cap = growth.capacity;
  fifth.text(62, 1395, 'Менеджеры: ' + cap.active_managers + ' из ' + cap.required_managers + ' · лиды: ' + cap.leads.actual + ' из ' + cap.leads.required + ' (' + cap.leads.coverage_percent + '%)', 19, cap.manager_gap >= 0 && cap.leads.coverage_percent >= 80 ? '#1C3A2F' : '#9B2335', true);
  const primaryGrowthAlert = growth.alerts[0];
  fifth.wrapped(62, 1450, primaryGrowthAlert ? primaryGrowthAlert.title + ': ' + primaryGrowthAlert.detail : 'Критичных отклонений пятилетнего плана нет.', 105, 17, '#2A2218', 25, false);
  fifth.wrapped(62, 1630, 'Базовая модель: запуск одной точки 20 000 ₽; центральные расходы временно равны нулю. Активной считается включённая точка с оплаченной продажей за последние 30 дней.', 110, 15, '#7A7165', 22, false);
  pages.push(fifth.finish());

  const quarterPage = new ReportPage(font, 'Квартальный план и условия роста', subtitle);
  const firstFunding = growth.quarterly.first_funding;
  const decisionShort = { stop:'Стоп', caution:'Осторожно', not_ready:'Нет данных', go:'Можно расти' }[growth.gates.decision] || growth.gates.title;
  quarterPage.card(62, 225, 350, 125, 'Квартальный резерв', rub(growth.quarterly.totals.external_funding), '#D4872A');
  quarterPage.card(445, 225, 350, 125, 'Первый транш', firstFunding ? firstFunding.period : 'не требуется', '#1C3A2F');
  quarterPage.card(828, 225, 350, 125, 'Решение', decisionShort, growth.gates.decision === 'stop' ? '#9B2335' : '#1C3A2F');
  quarterPage.text(62, 400, 'Календарь 2027-2031', 27, '#1C3A2F', true);
  quarterPage.table(62, 430, [145,110,110,190,190,190], ['Квартал','Новых','Сеть','Запуски','Поток','Транш'],
    growth.quarterly.quarters.map((row) => [row.period,row.new_points,row.target_points,rub(row.expansion_investment),rub(row.net_cash),row.investor_tranche ? rub(row.investor_tranche) : '-']),
    { rowHeight:45, fontSize:14 });
  const failedGates = growth.gates.gates.filter((row) => row.status === 'red');
  quarterPage.text(62, 1435, 'Условия масштабирования', 25, '#1C3A2F', true);
  quarterPage.wrapped(62, 1480, failedGates.length
    ? 'Стоп-сигналы: ' + failedGates.map((row) => row.name).join('; ')
    : growth.gates.title + '. Красных стоп-сигналов нет.', 110, 17, failedGates.length ? '#9B2335' : '#2D7D46', 25, true);
  quarterPage.wrapped(62, 1640, 'Квартальный резерв учитывает внутригодовую потребность в ликвидности. Он может отличаться от годовой модели даже при тех же целях и полном реинвестировании.', 110, 15, '#7A7165', 22, false);
  pages.push(quarterPage.finish());
  return pages;
}

function imageMagickCommand() {
  if (spawnSync('convert', ['-version'], { stdio: 'ignore' }).status === 0) return 'convert';
  if (spawnSync('magick', ['-version'], { stdio: 'ignore' }).status === 0) return 'magick';
  throw new Error('ImageMagick не найден — PDF не может быть сформирован');
}

// Собираем PDF сами из JPEG-страниц. Это намеренно не поручается ImageMagick:
// в серверных сборках его security policy нередко запрещает PDF-кодер, даже
// когда Ghostscript установлен. JPEG поддерживается тем же ImageMagick,
// который уже обязателен для фотографий товаров, а простой PDF-контейнер не
// требует дополнительных npm-пакетов или системных делегатов.
function writePdfFromJpegs(jpegPaths, outputPath) {
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const objects = [];
  const pageRefs = jpegPaths.map((_, index) => 3 + index * 3);
  objects.push(Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'));
  objects.push(Buffer.from(
    '<< /Type /Pages /Kids [' + pageRefs.map((id) => id + ' 0 R').join(' ') + '] /Count ' + jpegPaths.length + ' >>',
    'ascii'
  ));

  jpegPaths.forEach((jpegPath, index) => {
    const pageId = 3 + index * 3;
    const contentId = pageId + 1;
    const imageId = pageId + 2;
    const imageName = 'Im' + (index + 1);
    const image = fs.readFileSync(jpegPath);
    const paint = Buffer.from(
      'q\n' + pageWidth + ' 0 0 ' + pageHeight + ' 0 0 cm\n/' + imageName + ' Do\nQ\n',
      'ascii'
    );
    objects.push(Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pageWidth + ' ' + pageHeight + '] ' +
      '/Resources << /XObject << /' + imageName + ' ' + imageId + ' 0 R >> >> /Contents ' + contentId + ' 0 R >>',
      'ascii'
    ));
    objects.push(Buffer.concat([
      Buffer.from('<< /Length ' + paint.length + ' >>\nstream\n', 'ascii'),
      paint,
      Buffer.from('endstream', 'ascii'),
    ]));
    objects.push(Buffer.concat([
      Buffer.from(
        '<< /Type /XObject /Subtype /Image /Width 1240 /Height 1754 /ColorSpace /DeviceRGB ' +
        '/BitsPerComponent 8 /Filter /DCTDecode /Length ' + image.length + ' >>\nstream\n',
        'ascii'
      ),
      image,
      Buffer.from('\nendstream', 'ascii'),
    ]));
  });

  const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary')];
  const offsets = [0];
  let length = chunks[0].length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const wrapped = Buffer.concat([
      Buffer.from((index + 1) + ' 0 obj\n', 'ascii'), object, Buffer.from('\nendobj\n', 'ascii'),
    ]);
    chunks.push(wrapped);
    length += wrapped.length;
  });
  const xrefOffset = length;
  const xref = ['xref', '0 ' + (objects.length + 1), '0000000000 65535 f '];
  for (let id = 1; id <= objects.length; id += 1) {
    xref.push(String(offsets[id]).padStart(10, '0') + ' 00000 n ');
  }
  chunks.push(Buffer.from(
    xref.join('\n') + '\ntrailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\n' +
    'startxref\n' + xrefOffset + '\n%%EOF\n',
    'ascii'
  ));
  fs.writeFileSync(outputPath, Buffer.concat(chunks));
}

function buildPdf(report, outputPath) {
  const font = findFont();
  const command = imageMagickCommand();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiga-weekly-report-'));
  try {
    const pageMvgs = buildPdfPages(report, font);
    const pageJpegs = [];
    pageMvgs.forEach((content, index) => {
      const mvgPath = path.join(tempDir, 'page-' + index + '.mvg');
      const jpegPath = path.join(tempDir, 'page-' + index + '.jpg');
      fs.writeFileSync(mvgPath, content, 'utf8');
      execFileSync(command, [
        'mvg:' + mvgPath, '-background', 'white', '-alpha', 'remove', '-strip', '-quality', '90', jpegPath,
      ], {
        stdio: 'pipe',
        timeout: 60000,
        env: { ...process.env,
          MAGICK_MEMORY_LIMIT: '128MiB', MAGICK_MAP_LIMIT: '256MiB',
          MAGICK_DISK_LIMIT: '512MiB', MAGICK_THREAD_LIMIT: '1' },
      });
      pageJpegs.push(jpegPath);
    });
    writePdfFromJpegs(pageJpegs, outputPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}


module.exports = { findFont, writePdfFromJpegs, buildPdf };
