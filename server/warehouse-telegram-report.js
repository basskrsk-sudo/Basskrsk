// Live central-warehouse balances by city for the administrators' Telegram bot.
// Reads the same city warehouses as /api/warehouse/stock. It does not include
// stock already delivered to grooming salons (table stock).
'use strict';

const db = require('./db');

const PAGE_LIMIT = 3500;
const KRASNOYARSK_TIMEZONE = 'Asia/Krasnoyarsk';

function sanitize(value, maxLength = 120) {
  return String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function asPositiveOrZero(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : 0;
}

function asOfKrasnoyarsk(now) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: KRASNOYARSK_TIMEZONE,
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(now);
}

function warehouseSelector(selector) {
  const val = String(selector || '').trim();
  return val.toLowerCase() === 'all' || val.toLowerCase() === 'все' ? '' : val;
}

function collectWarehouseStockReport(selector = '', now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) {
    throw new Error('Некорректная дата отчёта');
  }

  // Active city warehouses plus historical city stock where city was disabled.
  const cityRecords = db.prepare(
    "SELECT c.id, c.name, c.active FROM cities c " +
    "WHERE c.active = 1 OR EXISTS " +
    "(SELECT 1 FROM warehouse_stock ws WHERE ws.city_id = c.id) " +
    "ORDER BY c.name COLLATE NOCASE, c.id"
  ).all();

  const wanted = warehouseSelector(selector).toLocaleLowerCase('ru-RU');
  const matching = wanted
    ? cityRecords.filter(c =>
        String(c.id).toLocaleLowerCase('ru-RU') === wanted ||
        String(c.name).toLocaleLowerCase('ru-RU') === wanted)
    : cityRecords;

  if (wanted && matching.length === 0) {
    const error = new Error('Город не найден');
    error.code = 'UNKNOWN_WAREHOUSE_CITY';
    error.cities = cityRecords.map(c => ({ id: String(c.id), name: String(c.name) }));
    throw error;
  }

  // Include every active catalog variant even if it has never been received:
  // such items correctly have balance zero. Also include archived products
  // while any warehouse_stock row still exists for them, incl. a zero row.
  // Snapshot is read fresh for each command; no Telegram-side caching.
  const rows = db.prepare([
    'SELECT c.id AS city_id, p.name AS product_name, v.id AS variant_id,',
    'v.weight, p.active AS product_active, v.active AS variant_active,',
    'COALESCE(ws.qty, 0) AS qty',
    'FROM cities c',
    'CROSS JOIN product_variants v',
    'JOIN products p ON p.id = v.product_id',
    'LEFT JOIN warehouse_stock ws ON ws.city_id = c.id AND ws.variant_id = v.id',
    'WHERE (c.active = 1 OR ws.variant_id IS NOT NULL)',
    'AND ((p.active = 1 AND v.active = 1) OR ws.variant_id IS NOT NULL)',
    'ORDER BY c.name COLLATE NOCASE, p.name COLLATE NOCASE,',
    'v.sort_order, v.weight, v.id',
  ].join(' ')).all();

  const byCity = new Map(matching.map(c => [
    String(c.id), {
      id: String(c.id), name: String(c.name), active: !!c.active,
      items: [], total_qty: 0, positions_in_stock: 0, zero_positions: 0,
      negative_positions: 0,
    },
  ]));

  for (const row of rows) {
    const city = byCity.get(String(row.city_id));
    if (!city) continue;
    const qty = asPositiveOrZero(row.qty);
    const archived = !row.product_active || !row.variant_active;
    city.items.push({
      variant_id: Number(row.variant_id),
      name: String(row.product_name),
      weight: String(row.weight),
      qty, archived,
    });
    city.total_qty += qty;
    if (qty > 0) city.positions_in_stock++;
    else if (qty === 0) city.zero_positions++;
    else city.negative_positions++;
  }

  const cities = Array.from(byCity.values());
  return {
    generated_at: now.toISOString(),
    local_time: asOfKrasnoyarsk(now),
    cities,
    city_count: cities.length,
    total_qty: cities.reduce((a, c) => a + c.total_qty, 0),
    positions_in_stock: cities.reduce((a, c) => a + c.positions_in_stock, 0),
    zero_positions: cities.reduce((a, c) => a + c.zero_positions, 0),
    negative_positions: cities.reduce((a, c) => a + c.negative_positions, 0),
  };
}

function formatCityHeader(report, city) {
  return [
    '📦 ХвостМаркет · центральный склад',
    '🕒 На ' + report.local_time + ' · Красноярск',
    '🏙 ' + sanitize(city.name, 65) + (city.active ? '' : ' (неактивный город)'),
  ].join('\n');
}

function formatCityTotal(city) {
  const lines = [
    '📊 ИТОГО: ' + city.total_qty.toLocaleString('ru-RU') + ' шт.',
    '✅ В наличии: ' + city.positions_in_stock + ' поз. · ' +
      '⚪ Нет в наличии: ' + city.zero_positions + ' поз.',
  ];
  if (city.negative_positions) {
    lines.push('⚠️ Некорректных отрицательных остатков: ' +
      city.negative_positions + ' поз. — проверьте учёт.');
  }
  lines.push('Учтён только центральный склад, без остатков в салонах.');
  return lines.join('\n');
}

function formatWarehouseStockMessages(report) {
  const result = [];
  if (!report.cities.length) {
    return ['📦 ХвостМаркет · центральный склад\nСклады городов пока не зарегистрированы.'];
  }
  for (const city of report.cities) {
    const prefix = formatCityHeader(report, city);
    const summary = formatCityTotal(city);
    const itemLines = city.items.map(item => {
      const label = sanitize(item.name, 110) + ' (' + sanitize(item.weight, 36) + ')';
      const mark = item.qty < 0 ? '⚠️' : item.qty > 0 ? '🟢' : '⚪';
      return mark + ' ' + label + ' — ' +
        item.qty.toLocaleString('ru-RU') + ' шт.' + (item.archived ? ' [архив]' : '');
    });
    const chunks = [];
    let current = [];
    let currentLength = 0;
    const room = PAGE_LIMIT - prefix.length - summary.length - 90;
    for (const line of itemLines) {
      if (current.length && currentLength + line.length + 1 > room) {
        chunks.push(current);
        current = [];
        currentLength = 0;
      }
      current.push(line);
      currentLength += line.length + 1;
    }
    if (current.length) chunks.push(current);
    else if (!chunks.length) chunks.push(['На складе нет позиций каталога.']);

    chunks.forEach((chunk, index) => {
      const page = [
        prefix,
        chunks.length > 1 ? '📄 Часть ' + (index + 1) + '/' + chunks.length : null,
        '',
        ...chunk,
        ...(index === chunks.length - 1 ? ['', summary] : []),
      ].filter(x => x !== null).join('\n');
      if (page.length > 4000) throw new Error('Отчёт склада превысил лимит Telegram');
      result.push(page);
    });
  }
  return result;
}

function formatWarehouseStockSummary(report) {
  const lines = [
    '📦 ХвостМаркет · центральный склад',
    '🕒 На ' + report.local_time + ' · Красноярск',
    '',
  ];
  for (const city of report.cities) {
    lines.push('🏙 ' + sanitize(city.name, 65) + ': ' +
      city.total_qty.toLocaleString('ru-RU') + ' шт. · ' +
      city.positions_in_stock + ' поз. в наличии' +
      (city.active ? '' : ' (неактивный город)'));
  }
  lines.push('', '📊 Всего по выбранным складам: ' +
    report.total_qty.toLocaleString('ru-RU') + ' шт.');
  lines.push('📎 Полная детализация по товарам и фасовкам — в CSV-файле.');
  return lines.join('\n');
}

function csvCell(value) {
  let text = sanitize(value, 500);
  if (typeof value !== 'number' && /^[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
function buildWarehouseStockCsv(report) {
  const lines = [[
    'Срез, Красноярск', 'Город', 'Код города', 'Товар',
    'Фасовка', 'ID варианта', 'Остаток, шт.', 'Статус товара', 'Наличие',
  ].map(csvCell).join(';')];
  for (const city of report.cities) {
    for (const item of city.items) {
      lines.push([
        report.local_time, city.name, city.id, item.name,
        item.weight, item.variant_id, item.qty,
        item.archived ? 'Архивный' : 'Активный',
        item.qty > 0 ? 'В наличии' : item.qty === 0 ? 'Нет в наличии' : 'Ошибка остатка',
      ].map(csvCell).join(';'));
    }
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

module.exports = {
  collectWarehouseStockReport,
  formatWarehouseStockMessages,
  formatWarehouseStockSummary,
  buildWarehouseStockCsv,
};
