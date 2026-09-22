// routes-products.js — каталог товаров (публичный, для сайта) и управление остатками (для админки).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireAuth, tryAuth } = require('./routes-auth');
const { reverseAndDeleteOrdersBy } = require('./order-reversal');
const { getReviewSummary } = require('./routes-reviews');
const { sendTelegram } = require('./telegram');
const { logManagerAction } = require('./audit-log');

const PRODUCT_CATEGORIES = new Set(['treats', 'toys', 'accessories', 'care']);

// Папка с загруженными фото товаров — специально ВНЕ public/, в постоянном
// хранилище (DATA_DIR, то же самое, где живёт база данных). public/
// пересобирается заново из архива при каждом деплое на Amvera — если бы
// фото лежали внутри неё, любой следующий деплой стирал бы всё, что
// владелец успел загрузить через админку. Для запуска без Amvera
// (DATA_DIR не задан) — используем локальную папку рядом с проектом, как
// раньше.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

function productWithVariantsAndStock(product, includeCost, includeInactiveVariants) {
  const variants = db.prepare(
    includeCost
      ? 'SELECT id, weight, price, cost_price, active FROM product_variants WHERE product_id = ? ORDER BY sort_order'
      : 'SELECT id, weight, price, active FROM product_variants WHERE product_id = ? ORDER BY sort_order'
  ).all(product.id).filter((v) => includeInactiveVariants || v.active);
  const variantIds = variants.map((v) => v.id);
  const stockRows = variantIds.length
    ? db.prepare(
        `SELECT variant_id, point_id, qty FROM stock WHERE variant_id IN (${variantIds.map(() => '?').join(',')})`
      ).all(...variantIds)
    : [];
  const stockByVariant = {};
  for (const row of stockRows) {
    if (!stockByVariant[row.variant_id]) stockByVariant[row.variant_id] = {};
    stockByVariant[row.variant_id][row.point_id] = row.qty;
  }
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    category: product.category,
    icon: product.icon,
    badge: product.badge,
    img: product.img,
    desc: product.desc,
    comp: JSON.parse(product.comp),
    active: !!product.active,
    ...getReviewSummary(product.id),
    variants: variants.map((v) => Object.assign({
      id: v.id,
      weight: v.weight,
      price: v.price,
      active: !!v.active,
      stock: stockByVariant[v.id] || {},
    }, includeCost ? { cost_price: v.cost_price } : {})),
  };
}

function registerProductRoutes(router) {
  // POST /api/products/upload-image — загрузка фото товара (админ или кладовщик).
  // Картинка приходит base64 в JSON-теле (без multipart — сервер без внешних
  // библиотек), сжимается и приводится к единому размеру через ImageMagick,
  // сохраняется в public/images/uploads/.
  router.post('/api/products/upload-image', (req, res, ctx) => {
    const payload = requireAuth(['admin', 'warehouse'])(req, res, ctx);
    if (!payload) return;
    const { data } = ctx.body || {};
    if (!data || typeof data !== 'string') {
      return sendJson(res, 400, { error: 'Укажите data — картинку в base64' });
    }
    // Реальная причина повального "no decode delegate" в проде (ImageMagick 7,
    // в отличие от 6-й ветки, которой это тестировалось раньше) — временный
    // файл сохранялся вообще БЕЗ расширения. IMv7 в такой ситуации не может
    // надёжно определить формат по содержимому и отказывается декодировать
    // ЛЮБУЮ картинку, а не только нестандартную — отсюда падали вообще все
    // загрузки на сервере с IMv7, хотя в песочнице с IMv6 всё работало.
    // Извлекаем реальный MIME-тип из data-URL и даём файлу расширение исходя
    // из него — так у ImageMagick есть явная подсказка формата независимо
    // от версии и настроек автоопределения.
    const mimeMatch = data.match(/^data:image\/(\w+);base64,/);
    const mimeToExt = { jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp', gif: 'gif', bmp: 'bmp' };
    const srcExt = mimeMatch ? (mimeToExt[mimeMatch[1].toLowerCase()] || mimeMatch[1].toLowerCase()) : 'jpg';
    const base64 = data.replace(/^data:image\/\w+;base64,/, '');
    let buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch (e) {
      return sendJson(res, 400, { error: 'Не удалось прочитать base64' });
    }
    if (buffer.length === 0 || buffer.length > 15 * 1024 * 1024) {
      return sendJson(res, 400, { error: 'Пустой файл или больше 15 МБ' });
    }

    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const id = crypto.randomBytes(8).toString('hex');
    const tempPath = path.join(UPLOADS_DIR, 'tmp-' + id + '.' + srcExt);
    const finalName = 'product-' + id + '.webp';
    const finalPath = path.join(UPLOADS_DIR, finalName);

    try {
      fs.writeFileSync(tempPath, buffer);
      // Приводим к единому размеру (макс. 800×800, с сохранением пропорций)
      // и конвертируем в webp — чтобы каталог не раздувался большими фото с телефона.
      // ImageMagick 7 переименовал основную команду в `magick` и считает
      // `convert` устаревшим (хотя пока и рабочим, просто с предупреждением
      // в stderr при каждом вызове) — пробуем современную команду первой,
      // откатываемся на `convert` только если именно её нет в системе
      // (ENOENT), а не если она есть, но упала по другой причине.
      try {
        execFileSync('magick', [tempPath, '-auto-orient', '-resize', '800x800>', '-quality', '85', finalPath]);
      } catch (magickErr) {
        if (magickErr.code === 'ENOENT') {
          execFileSync('convert', [tempPath, '-auto-orient', '-resize', '800x800>', '-quality', '85', finalPath]);
        } else {
          throw magickErr;
        }
      }
      fs.unlinkSync(tempPath);
    } catch (e) {
      try { fs.unlinkSync(tempPath); } catch (e2) {}
      // Настоящая причина сбоя ImageMagick (stderr) гораздо информативнее общей
      // фразы — например, "no decode delegate for this image format" означает,
      // что файл на самом деле не JPEG/PNG внутри (частый случай — HEIC-фото с
      // iPhone, сохранённое с расширением .jpg: система показывает "jpeg", но
      // реального JPEG-содержимого внутри нет, и ImageMagick честно не может
      // его декодировать). Раньше сообщение не показывало этого и все сбои
      // выглядели одинаково как "файл не подходит", без возможности понять, что
      // конкретно случилось.
      const rawError = (e.stderr ? e.stderr.toString() : '') || e.message || '';
      const isUnsupportedFormat = /no decode delegate|improper image header|not authorized/i.test(rawError);
      const friendlyMessage = isUnsupportedFormat
        ? 'Файл не распознан как изображение — часто так бывает, если фото с iPhone сохранено в формате HEIC под именем .jpg (расширение не совпадает с реальным форматом). Откройте фото на телефоне и пересохраните (или экспортируйте) как JPEG/PNG — после этого загрузка сработает.'
        : 'Не удалось обработать картинку. Убедитесь, что это изображение (jpg/png/webp).';
      console.error('Ошибка обработки картинки:', rawError || e.message);
      return sendJson(res, 500, { error: friendlyMessage, debug: rawError.slice(0, 300) });
    }

    sendJson(res, 201, { ok: true, path: 'images/uploads/' + finalName });
  });

  // GET /api/products — публичный каталог (для index.html, а также для генератора QR-кодов в кабинетах менеджера/администратора), только активные товары и веса
  router.get('/api/products', (req, res, ctx) => {
    const includeInactive = ctx.query.all === '1';
    const adminPayload = tryAuth(['admin'])(req);
    const rows = db.prepare(
      includeInactive ? 'SELECT * FROM products' : 'SELECT * FROM products WHERE active = 1'
    ).all();

    // Популярность считаем по фактически оплаченным товарам. Возвращённые
    // заказы не должны продолжать поднимать товар в блоке «Популярно рядом».
    // Считаем одним запросом для всего каталога, а не отдельным запросом на
    // каждый товар — это останется быстрым и при расширении ассортимента.
    const salesRows = db.prepare(`
      SELECT pv.product_id, COALESCE(SUM(oi.qty), 0) AS sales_count
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN product_variants pv ON pv.id = oi.variant_id
      WHERE o.status = 'paid'
        AND COALESCE(o.refund_status, 'none') != 'refunded'
        AND oi.is_custom = 0
      GROUP BY pv.product_id
    `).all();
    const salesByProduct = new Map(
      salesRows.map((row) => [Number(row.product_id), Number(row.sales_count) || 0])
    );
    const products = rows
      .map((p) => Object.assign(
        productWithVariantsAndStock(p, !!adminPayload, includeInactive),
        { sales_count: salesByProduct.get(Number(p.id)) || 0 }
      ))
      .filter((p) => includeInactive || p.variants.length > 0); // товар без единого видимого веса — скрыт целиком
    sendJson(res, 200, { products });
  });

  // GET /api/product-of-day — функция ВЫКЛЮЧЕНА (решение владельца бизнеса,
  // 2026-08), а затем и весь файл product-of-day.js удалён вместе с системой
  // промокодов. Эндпоинт оставлен (не удалён), чтобы старый закэшированный
  // фронтенд у кого-то в браузере не падал с ошибкой — просто всегда отвечает
  // "недоступно".
  router.get('/api/product-of-day', (req, res, ctx) => {
    sendJson(res, 200, { available: false });
  });

  // GET /api/cities — справочник городов сети (для выпадающих списков)
  router.get('/api/cities', (req, res, ctx) => {
    const rows = db.prepare('SELECT * FROM cities WHERE active = 1 ORDER BY name').all();
    sendJson(res, 200, { cities: rows });
  });

  // GET /api/points — справочник точек, можно отфильтровать по городу (?city=krsk)
  router.get('/api/points', (req, res, ctx) => {
    const includeInactive = ctx.query.all === '1';
    const cityFilter = ctx.query.city || null;
    let sql = includeInactive ? 'SELECT * FROM points' : 'SELECT * FROM points WHERE active = 1';
    const params = [];
    if (cityFilter) {
      sql += (includeInactive ? ' WHERE' : ' AND') + ' city_id = ?';
      params.push(cityFilter);
    }
    const rows = db.prepare(sql).all(...params);
    sendJson(res, 200, { points: rows });
  });

  // GET /api/points/available-for-registration — публичный список хвостоматов,
  // на которые можно зарегистрироваться партнёром (активные). На одной точке
  // может работать несколько партнёров одновременно (см. orders.partner_id
  // и выбор грумера в чекауте на сайте) — поэтому список НЕ исключает точки,
  // где партнёр уже есть. Свободный ввод названия/адреса убран, чтобы не
  // плодить дублирующиеся точки мимо контроля сети. Необязательный
  // ?manager_id= сужает список до точек конкретного менеджера — используется
  // его собственным кабинетом.
  router.get('/api/points/available-for-registration', (req, res, ctx) => {
    const cityFilter = ctx.query.city || null;
    const managerFilter = ctx.query.manager_id || null;
    let sql = `SELECT p.* FROM points p WHERE p.active = 1`;
    const params = [];
    if (cityFilter) { sql += ' AND p.city_id = ?'; params.push(cityFilter); }
    if (managerFilter) { sql += ' AND p.manager_id = ?'; params.push(managerFilter); }
    sql += ' ORDER BY p.name';
    const rows = db.prepare(sql).all(...params);
    sendJson(res, 200, { points: rows });
  });

  // GET /api/points/available-for-owner-registration — то же самое, но для
  // владельцев салонов: точки без уже привязанного владельца (партнёр на
  // точке при этом не важен — роли независимы, у одной точки может быть и
  // партнёр, и отдельно владелец).
  router.get('/api/points/available-for-owner-registration', (req, res, ctx) => {
    const cityFilter = ctx.query.city || null;
    const managerFilter = ctx.query.manager_id || null;
    let sql = `
      SELECT p.* FROM points p
      LEFT JOIN salon_owners so ON so.point_id = p.id
      WHERE p.active = 1 AND so.id IS NULL
    `;
    const params = [];
    if (cityFilter) { sql += ' AND p.city_id = ?'; params.push(cityFilter); }
    if (managerFilter) { sql += ' AND p.manager_id = ?'; params.push(managerFilter); }
    sql += ' ORDER BY p.name';
    const rows = db.prepare(sql).all(...params);
    sendJson(res, 200, { points: rows });
  });

  // POST /api/points — админ вручную добавляет новую точку (без привязки к регистрации партнёра)
  router.post('/api/points', async (req, res, ctx) => {
    const payload = requireAuth(['admin', 'manager'])(req, res, ctx);
    if (!payload) return;
    const { name, addr, icon, lat, lng, city_id } = ctx.body || {};
    // Менеджер может создавать точки только на СЕБЯ — даже если в теле
    // запроса как-то оказался чужой manager_id, игнорируем его полностью.
    // Так не получится случайно (или намеренно) завести точку на другого
    // менеджера через прямой вызов API в обход интерфейса.
    const manager_id = payload.role === 'manager' ? payload.id : (ctx.body || {}).manager_id;
    if (!name || !addr) return sendJson(res, 400, { error: 'Укажите name и addr' });
    // Город больше не подставляется молча по умолчанию (раньше падал на
    // 'krsk', если фронтенд забывал его передать) — теперь обязателен явно.
    // При росте сети это реальный риск: точку легко было создать не в том
    // городе, просто не заметив, что поле осталось пустым/по умолчанию.
    if (!city_id) return sendJson(res, 400, { error: 'Укажите город точки' });
    if (!db.prepare('SELECT id FROM cities WHERE id = ?').get(city_id)) {
      return sendJson(res, 400, { error: 'Неизвестный город: ' + city_id });
    }
    let managerRow = null;
    if (manager_id) {
      managerRow = db.prepare('SELECT id FROM managers WHERE id = ? AND active = 1').get(manager_id);
      if (!managerRow) return sendJson(res, 400, { error: 'Менеджер не найден или неактивен' });
    }

    const { slugify } = require('./routes-warehouse');
    let base = slugify(name);
    let candidate = base, i = 1;
    while (db.prepare('SELECT id FROM points WHERE id = ?').get(candidate)) candidate = base + '-' + (++i);

    db.prepare('INSERT INTO points (id, name, addr, icon, lat, lng, city_id, manager_id, is_hub, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1)')
      .run(candidate, name, addr, icon || '📍', lat ?? null, lng ?? null, city_id, manager_id || null);

    // Если сразу назначили менеджера — заводим и связь в manager_points,
    // иначе точка физически не появится в его кабинете («Мои точки»,
    // «Пополнение», формы регистрации партнёра/владельца) до тех пор, пока
    // кто-то не зарегистрируется на неё как партнёр — то есть может вообще
    // никогда, если точку регистрирует сам менеджер, а не грумер с улицы.
    if (managerRow) {
      const { computeManagerCommissionRate } = require('./routes-managers');
      db.prepare(`
        INSERT INTO manager_points (manager_id, point_id, point_name, point_type, revenue, commission_rate, active, bonus_paid)
        VALUES (?, ?, ?, 'Точка', 0, ?, 1, 0)
      `).run(manager_id, candidate, name, computeManagerCommissionRate());
    }

    const products = db.prepare('SELECT id FROM products').all();
    for (const p of products) {
      const variants = db.prepare('SELECT id FROM product_variants WHERE product_id = ?').all(p.id);
      for (const v of variants) {
        db.prepare('INSERT OR IGNORE INTO stock (variant_id, point_id, qty) VALUES (?, ?, 0)').run(v.id, candidate);
      }
    }

    const cityRow = db.prepare('SELECT name FROM cities WHERE id = ?').get(city_id);
    const creatorLine = payload.role === 'manager'
      ? '👤 Создал менеджер: ' + payload.login
      : '👤 Создал администратор: ' + payload.login;
    await sendTelegram([
      '📍 <b>Новая точка</b>',
      '',
      (icon || '📍') + ' ' + name,
      '🏠 ' + addr,
      '🏙 ' + (cityRow ? cityRow.name : city_id),
      creatorLine,
      '🕐 ' + new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Krasnoyarsk' }),
    ].join('\n'));

    if (payload.role === 'manager') {
      logManagerAction(payload.id, 'Создание точки', {
        type: 'point', id: candidate, name,
        details: (cityRow ? cityRow.name : city_id) + ' · ' + addr,
      });
    }

    sendJson(res, 201, { ok: true, id: candidate });
  });

  // PUT /api/points/:id/manager — назначить/сменить/снять менеджера у уже
  // существующей точки. Нужен как для исправления точек, заведённых раньше
  // без менеджера (форма создания точки долгое время не предлагала его
  // выбрать), так и для обычной перепривязки точки другому менеджеру.
  // Заводит (или обновляет) связь в manager_points той же логикой, что и
  // при создании точки — иначе смена менеджера в points останется
  // незаметной для его собственного кабинета.
  router.put('/api/points/:id/manager', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const point = db.prepare('SELECT * FROM points WHERE id = ?').get(ctx.params.id);
    if (!point) return sendJson(res, 404, { error: 'Точка не найдена' });
    const { manager_id } = ctx.body || {};

    if (manager_id) {
      const managerRow = db.prepare('SELECT id FROM managers WHERE id = ? AND active = 1').get(manager_id);
      if (!managerRow) return sendJson(res, 400, { error: 'Менеджер не найден или неактивен' });
    }

    db.prepare('UPDATE points SET manager_id = ? WHERE id = ?').run(manager_id || null, point.id);

    if (manager_id) {
      const existingLink = db.prepare('SELECT id FROM manager_points WHERE point_id = ?').get(point.id);
      if (existingLink) {
        db.prepare('UPDATE manager_points SET manager_id = ? WHERE point_id = ?').run(manager_id, point.id);
      } else {
        const { computeManagerCommissionRate } = require('./routes-managers');
        db.prepare(`
          INSERT INTO manager_points (manager_id, point_id, point_name, point_type, revenue, commission_rate, active, bonus_paid)
          VALUES (?, ?, ?, 'Точка', 0, ?, 1, 0)
        `).run(manager_id, point.id, point.name, computeManagerCommissionRate());
      }
    }
    sendJson(res, 200, { ok: true });
  });

  // PUT /api/points/:id/active — включить/выключить точку (скрыть из чекаута, история заказов сохраняется)
  router.put('/api/points/:id/active', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const { active } = ctx.body || {};
    const existing = db.prepare('SELECT id FROM points WHERE id = ?').get(ctx.params.id);
    if (!existing) return sendJson(res, 404, { error: 'Точка не найдена' });
    db.prepare('UPDATE points SET active = ? WHERE id = ?').run(active ? 1 : 0, ctx.params.id);
    sendJson(res, 200, { ok: true });
  });

  // DELETE /api/points/:id — окончательное удаление (только если нет заказов с этой точки —
  // иначе рекомендуем деактивировать, чтобы не терять историю)
  router.delete('/api/points/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const existing = db.prepare('SELECT * FROM points WHERE id = ?').get(ctx.params.id);
    if (!existing) return sendJson(res, 404, { error: 'Точка не найдена' });

    const { force, restore_stock } = ctx.body || {};
    const ordersCount = db.prepare('SELECT COUNT(*) AS c FROM orders WHERE point_id = ?').get(ctx.params.id).c;
    if (ordersCount > 0 && !force) {
      return sendJson(res, 400, {
        error: 'У точки есть ' + ordersCount + ' заказ(ов) в истории — удаление уничтожит эту связь. Деактивируйте точку вместо удаления, либо удалите принудительно (это также откатит и удалит все её заказы).',
        hasOrders: true,
        ordersCount,
      });
    }
    // Принудительное удаление — сначала откатываем последствия (статистика
    // клиента, косточки, опционально остаток) и удаляем все оплаченные
    // заказы точки, как при принудительном удалении отдельного заказа, затем
    // саму точку. Только для тестовых данных — на реальном сервере с
    // настоящими заказами лучше деактивировать точку, не удалять.
    if (ordersCount > 0 && force) {
      reverseAndDeleteOrdersBy('point_id', ctx.params.id, !!restore_stock);
    }

    // Партнёр и владелец, привязанные к этой точке, удаляются вместе с ней —
    // без этого удаление падало с сырой ошибкой FOREIGN KEY constraint failed,
    // если на точке кто-то уже был зарегистрирован. То же самое — отчёты о
    // перемещении товара (обычный рабочий процесс менеджера: создал точку →
    // занёс товар → согласовано) и записи старой системы развоза через
    // кладовщика: у обеих point_id NOT NULL без ON DELETE CASCADE, поэтому
    // без явной чистки удаление точки падало ровно с той же ошибкой, если
    // по ней хоть раз был отчёт о поставке.
    db.prepare('DELETE FROM partners WHERE point_id = ?').run(ctx.params.id);
    db.prepare('DELETE FROM salon_owners WHERE point_id = ?').run(ctx.params.id);
    db.prepare('DELETE FROM stock WHERE point_id = ?').run(ctx.params.id);
    db.prepare('DELETE FROM stock_movements WHERE point_id = ?').run(ctx.params.id);
    db.prepare('DELETE FROM restock_deliveries WHERE point_id = ?').run(ctx.params.id);
    db.prepare('UPDATE manager_points SET point_id = NULL WHERE point_id = ?').run(ctx.params.id);
    db.prepare('DELETE FROM points WHERE id = ?').run(ctx.params.id);
    sendJson(res, 200, { ok: true });
  });

  // PUT /api/points/:id/location — админ задаёт/уточняет координаты точки (для Яндекс.Карт)
  router.put('/api/points/:id/location', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const { lat, lng } = ctx.body || {};
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return sendJson(res, 400, { error: 'Укажите lat и lng числами' });
    }
    const existing = db.prepare('SELECT id FROM points WHERE id = ?').get(ctx.params.id);
    if (!existing) return sendJson(res, 404, { error: 'Точка не найдена' });
    db.prepare('UPDATE points SET lat = ?, lng = ? WHERE id = ?').run(lat, lng, ctx.params.id);
    sendJson(res, 200, { ok: true });
  });

  // Проверяет, имеет ли текущий пользователь право редактировать страницу
  // конкретной точки — своя логика доступа под каждую роль: администратор
  // может любую, менеджер только свои точки, партнёр и владелец — только
  // ту единственную точку, к которой сами привязаны.
  function canEditSalonPage(payload, point) {
    if (payload.role === 'admin') return true;
    if (payload.role === 'manager') return point.manager_id === payload.id;
    if (payload.role === 'partner') {
      const partner = db.prepare('SELECT point_id FROM partners WHERE id = ?').get(payload.id);
      return !!partner && partner.point_id === point.id;
    }
    if (payload.role === 'owner') {
      const owner = db.prepare('SELECT point_id FROM salon_owners WHERE id = ?').get(payload.id);
      return !!owner && owner.point_id === point.id;
    }
    return false;
  }

  // GET /api/points/:id/salon-page — текущее содержимое страницы точки (для
  // формы редактирования в личном кабинете любой из четырёх ролей).
  router.get('/api/points/:id/salon-page', (req, res, ctx) => {
    const payload = requireAuth(['admin', 'manager', 'partner', 'owner'])(req, res, ctx);
    if (!payload) return;
    const point = db.prepare(`
      SELECT id, name, addr, manager_id, salon_tagline, salon_description, salon_photo_url,
             salon_instagram, salon_vk, salon_website, salon_page_published
      FROM points WHERE id = ?
    `).get(ctx.params.id);
    if (!point) return sendJson(res, 404, { error: 'Точка не найдена' });
    if (!canEditSalonPage(payload, point)) return sendJson(res, 403, { error: 'Это не ваша точка' });
    sendJson(res, 200, { point });
  });

  // PUT /api/points/:id/salon-page — редактирование страницы точки. Раньше
  // эта же страница жила на ПАРТНЁРЕ — значит, точка без назначенного
  // грумера не могла иметь её вообще, а редактировать мог только сам
  // грумер. Теперь принадлежит точке напрямую: доступна для любой точки
  // (в том числе будущей, без партнёра), и её могут вести администратор,
  // менеджер (только свои точки), партнёр и владелец (только свою точку).
  router.put('/api/points/:id/salon-page', (req, res, ctx) => {
    const payload = requireAuth(['admin', 'manager', 'partner', 'owner'])(req, res, ctx);
    if (!payload) return;
    const point = db.prepare('SELECT * FROM points WHERE id = ?').get(ctx.params.id);
    if (!point) return sendJson(res, 404, { error: 'Точка не найдена' });
    if (!canEditSalonPage(payload, point)) return sendJson(res, 403, { error: 'Это не ваша точка' });

    const {
      salon_tagline, salon_description, salon_photo_url,
      salon_instagram, salon_vk, salon_website, salon_page_published,
    } = ctx.body || {};

    if (salon_tagline !== undefined && String(salon_tagline).length > 120) {
      return sendJson(res, 400, { error: 'Слоган слишком длинный (максимум 120 символов)' });
    }
    if (salon_description !== undefined && String(salon_description).length > 3000) {
      return sendJson(res, 400, { error: 'Описание слишком длинное (максимум 3000 символов)' });
    }

    const nextTagline = salon_tagline !== undefined ? String(salon_tagline).trim() || null : point.salon_tagline;
    const nextDescription = salon_description !== undefined ? String(salon_description).trim() || null : point.salon_description;
    const nextPhoto = salon_photo_url !== undefined ? String(salon_photo_url).trim() || null : point.salon_photo_url;
    const nextInstagram = salon_instagram !== undefined ? String(salon_instagram).trim() || null : point.salon_instagram;
    const nextVk = salon_vk !== undefined ? String(salon_vk).trim() || null : point.salon_vk;
    const nextWebsite = salon_website !== undefined ? String(salon_website).trim() || null : point.salon_website;

    let nextPublished = salon_page_published !== undefined ? !!salon_page_published : !!point.salon_page_published;
    if (nextPublished && (!nextTagline || !nextDescription)) {
      return sendJson(res, 400, { error: 'Чтобы опубликовать страницу, заполните хотя бы слоган и описание' });
    }

    db.prepare(`
      UPDATE points SET
        salon_tagline = ?, salon_description = ?, salon_photo_url = ?,
        salon_instagram = ?, salon_vk = ?, salon_website = ?, salon_page_published = ?
      WHERE id = ?
    `).run(nextTagline, nextDescription, nextPhoto, nextInstagram, nextVk, nextWebsite, nextPublished ? 1 : 0, ctx.params.id);

    if (payload.role === 'manager') {
      logManagerAction(payload.id, 'Изменение страницы точки', {
        type: 'salon_page', id: point.id, name: point.name,
        details: nextPublished ? 'Страница сохранена и опубликована' : 'Страница сохранена без публикации',
      });
    }

    sendJson(res, 200, { ok: true, published: nextPublished });
  });

  // GET /api/salon/:pointId — публичная страница точки (было — по коду
  // партнёра; теперь по id самой точки, раз страница принадлежит ей).
  router.get('/api/salon/:pointId', (req, res, ctx) => {
    const p = db.prepare(`
      SELECT id, name, addr, salon_tagline, salon_description, salon_photo_url, salon_instagram, salon_vk, salon_website
      FROM points WHERE id = ? AND active = 1 AND salon_page_published = 1
    `).get(ctx.params.pointId);
    if (!p) return sendJson(res, 404, { error: 'Страница салона не найдена' });
    sendJson(res, 200, { salon: p });
  });

  // GET /api/salons — публичный каталог всех опубликованных страниц точек
  // (для витрины "Наши партнёры" на сайте).
  router.get('/api/salons', (req, res) => {
    const rows = db.prepare(`
      SELECT id, name, addr, salon_tagline, salon_photo_url
      FROM points WHERE active = 1 AND salon_page_published = 1
      ORDER BY name
    `).all();
    sendJson(res, 200, { salons: rows });
  });

  // PUT /api/products/:id/stock — раньше позволял админу напрямую вписать
  // любое число в остаток точки, в обход центрального склада. Единственный
  // разрешённый путь появления товара на точке — через склад: см.
  // POST /api/warehouse/receipts (приход на склад) и одобрение отчёта
  // менеджера в /api/stock-movements (перемещение склад → точка). Эндпоинт
  // оставлен только чтобы не менять сигнатуру API нигде ещё, но больше
  // ничего не делает.
  router.put('/api/products/:id/stock', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    sendJson(res, 410, {
      error: 'Прямая правка остатка точки отключена — товар может появиться на точке только через центральный склад (приход на склад → отчёт менеджера о размещении → согласование администратором).',
    });
  });

  // PUT /api/products/:id/variant-price  { variant_id, price, cost_price?, weight? } — цена, себестоимость и (опционально) сам вес конкретной позиции
  router.put('/api/products/:id/variant-price', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const { variant_id, price, cost_price, weight } = ctx.body || {};
    if (!variant_id || typeof price !== 'number' || price <= 0) {
      return sendJson(res, 400, { error: 'Укажите variant_id и цену больше нуля' });
    }
    if (cost_price !== undefined && cost_price !== null && (typeof cost_price !== 'number' || cost_price < 0)) {
      return sendJson(res, 400, { error: 'Себестоимость должна быть неотрицательным числом' });
    }
    if (weight !== undefined && !String(weight).trim()) {
      return sendJson(res, 400, { error: 'Вес не может быть пустым' });
    }
    const existing = db.prepare('SELECT cost_price, weight FROM product_variants WHERE id = ?').get(variant_id);
    db.prepare('UPDATE product_variants SET price = ?, cost_price = ?, weight = ? WHERE id = ? AND product_id = ?')
      .run(
        price,
        cost_price !== undefined ? cost_price : (existing ? existing.cost_price : null),
        weight !== undefined ? String(weight).trim() : (existing ? existing.weight : ''),
        variant_id, ctx.params.id
      );
    sendJson(res, 200, { ok: true });
  });

  // PUT /api/products/:id/variant-active  { variant_id, active } — показывать ли именно этот вес на сайте
  router.put('/api/products/:id/variant-active', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const { variant_id, active } = ctx.body || {};
    if (!variant_id || active === undefined) {
      return sendJson(res, 400, { error: 'Укажите variant_id и active' });
    }
    db.prepare('UPDATE product_variants SET active = ? WHERE id = ? AND product_id = ?')
      .run(active ? 1 : 0, variant_id, ctx.params.id);
    sendJson(res, 200, { ok: true });
  });

  // POST /api/products — админ или кладовщик добавляет новый товар (с вариантами)
  router.post('/api/products', (req, res, ctx) => {
    const payload = requireAuth(['admin', 'warehouse'])(req, res, ctx);
    if (!payload) return;
    const { slug, name, category, icon, badge, img, desc, comp, variants } = ctx.body || {};
    if (!slug || !name || !category || !icon || !desc || !Array.isArray(variants) || variants.length === 0) {
      return sendJson(res, 400, { error: 'Заполните slug, name, category, icon, desc и хотя бы один вариант' });
    }
    if (!PRODUCT_CATEGORIES.has(category)) {
      return sendJson(res, 400, { error: 'Выберите категорию: лакомства, игрушки, аксессуары или уход' });
    }
    const info = db.prepare(
      'INSERT INTO products (slug, name, category, icon, badge, img, desc, comp, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)'
    ).run(slug, name, category, icon, badge || null, img || null, desc, JSON.stringify(comp || []));
    const productId = info.lastInsertRowid;
    const points = db.prepare('SELECT id FROM points').all();
    variants.forEach((v, i) => {
      const vInfo = db.prepare(
        'INSERT INTO product_variants (product_id, weight, price, sort_order) VALUES (?, ?, ?, ?)'
      ).run(productId, v.weight, v.price, i);
      for (const pt of points) {
        db.prepare('INSERT OR IGNORE INTO stock (variant_id, point_id, qty) VALUES (?, ?, 0)')
          .run(vInfo.lastInsertRowid, pt.id);
      }
    });
    sendJson(res, 201, { ok: true, id: productId });
  });

  // PUT /api/products/:id — админ редактирует товар (название/категория/активность и т.п.)
  router.put('/api/products/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin', 'warehouse'])(req, res, ctx);
    if (!payload) return;
    const { name, category, icon, badge, desc, comp, active, img } = ctx.body || {};
    if (category !== undefined && !PRODUCT_CATEGORIES.has(category)) {
      return sendJson(res, 400, { error: 'Выберите категорию: лакомства, игрушки, аксессуары или уход' });
    }
    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(ctx.params.id);
    if (!existing) return sendJson(res, 404, { error: 'Товар не найден' });
    db.prepare(
      'UPDATE products SET name=?, category=?, icon=?, badge=?, desc=?, comp=?, active=?, img=? WHERE id=?'
    ).run(
      name ?? existing.name,
      category ?? existing.category,
      icon ?? existing.icon,
      badge !== undefined ? badge : existing.badge,
      desc ?? existing.desc,
      comp ? JSON.stringify(comp) : existing.comp,
      active !== undefined ? (active ? 1 : 0) : existing.active,
      img !== undefined ? img : existing.img,
      ctx.params.id
    );
    sendJson(res, 200, { ok: true });
  });

  // DELETE /api/products/:id — админ удаляет товар (каскадом удалятся варианты и остатки)
  router.delete('/api/products/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    db.prepare('DELETE FROM products WHERE id = ?').run(ctx.params.id);
    sendJson(res, 200, { ok: true });
  });
}

module.exports = { registerProductRoutes, productWithVariantsAndStock };
