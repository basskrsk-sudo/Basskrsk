// point-launch-checklist.js — единый шаблон и расчёт готовности точки.
'use strict';

const db = require('./db');

const ITEMS = [
  {
    key: 'manager_assigned', group: 'Команда', mode: 'auto',
    title: 'Назначить ответственного менеджера',
    description: 'Менеджер отвечает за запуск, пополнение и развитие точки.',
  },
  {
    key: 'groomer_registered', group: 'Команда', mode: 'auto',
    title: 'Зарегистрировать минимум одного грумера',
    description: 'Грумер должен быть активен и привязан именно к этой точке.',
  },
  {
    key: 'owner_registered', group: 'Команда', mode: 'auto',
    title: 'Зарегистрировать владельца салона',
    description: 'Владелец получает доступ к статистике своей точки и выплатам.',
  },
  {
    key: 'referral_bonus_verified', group: 'Команда', mode: 'manual', requires_note_without_referrer: true,
    title: 'Проверить бонус грумеру за привлечение точки',
    description: 'Если точку привёл действующий грумер по своему коду, после 2 000 ₽ прямой прибыли бонус запуска делится: 1 000 ₽ грумеру и 1 000 ₽ менеджеру. Отметка только подтверждает проверку и не создаёт выплату повторно.',
  },
  {
    key: 'equipment_installed', group: 'Оснащение', mode: 'manual',
    title: 'Установить стойку или согласованный формат выкладки',
    description: 'Проверить устойчивость, доступность товара и заметность для клиентов.',
  },
  {
    key: 'stock_loaded', group: 'Оснащение', mode: 'auto',
    title: 'Загрузить стартовый ассортимент',
    description: 'В системе должен быть положительный остаток хотя бы одной активной позиции.',
  },
  {
    key: 'price_qr_placed', group: 'Оснащение', mode: 'manual',
    title: 'Разместить прейскурант и QR-коды',
    description: 'Распечатать цветной прейскурант, QR на товарах и QR на страницу инструкции по быстрой покупке.',
  },
  {
    key: 'certificates_delivered', group: 'Документы и материалы', mode: 'manual',
    title: 'Передать сертификаты на продукцию',
    description: 'Комплект документов должен храниться на точке вместе с чек-листом запуска.',
  },
  {
    key: 'samples_delivered', group: 'Документы и материалы', mode: 'manual',
    title: 'Передать пробники грумеру и клиентам',
    description: 'Подготовить пробники ассортимента для собаки грумера и выдачи клиентам.',
  },
  {
    key: 'map_ready', group: 'Сайт и продажи', mode: 'auto',
    title: 'Проверить адрес и отображение на карте',
    description: 'У точки должны быть корректные широта и долгота.',
  },
  {
    key: 'public_page_ready', group: 'Сайт и продажи', mode: 'auto',
    title: 'Опубликовать страницу точки с фотографией',
    description: 'Страница салона опубликована, добавлена минимум одна фотография.',
  },
  {
    key: 'staff_briefed', group: 'Сайт и продажи', mode: 'manual',
    title: 'Провести инструктаж сотрудника точки',
    description: 'Сотрудник знает путь покупки, правила выдачи и контакты для помощи клиенту.',
  },
  {
    key: 'test_sale_verified', group: 'Проверка открытия', mode: 'manual', requires_paid_order: true,
    title: 'Провести и проверить тестовую продажу',
    description: 'Проверить оплату, уменьшение остатка, экран успешной покупки и уведомления. Отметить можно только после появления оплаченного заказа этой точки.',
  },
];

const ITEM_BY_KEY = new Map(ITEMS.map((item) => [item.key, item]));
const MANUAL_KEYS = ITEMS.filter((item) => item.mode === 'manual').map((item) => item.key);

function parsePhotos(row) {
  let photos = [];
  try { photos = JSON.parse(row.salon_photo_urls || '[]'); } catch (_) {}
  if (!Array.isArray(photos)) photos = [];
  if (!photos.length && row.salon_photo_url) photos.push(row.salon_photo_url);
  return photos;
}

function pointFacts(pointId) {
  const point = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM partners g WHERE g.point_id = p.id AND g.active = 1) AS partners_count,
      (SELECT COUNT(*) FROM salon_owners so WHERE so.point_id = p.id AND so.active = 1) AS owners_count,
      (SELECT COALESCE(SUM(s.qty), 0) FROM stock s
        JOIN product_variants v ON v.id = s.variant_id AND v.active = 1
        JOIN products pr ON pr.id = v.product_id AND pr.active = 1
        WHERE s.point_id = p.id AND s.qty > 0) AS stock_qty,
      (SELECT COUNT(*) FROM orders o WHERE o.point_id = p.id AND o.status = 'paid') AS paid_orders_count,
      (SELECT o.order_code FROM orders o WHERE o.point_id = p.id AND o.status = 'paid'
        ORDER BY o.id DESC LIMIT 1) AS latest_paid_order,
      (SELECT mp.bonus_paid FROM manager_points mp WHERE mp.point_id = p.id ORDER BY mp.id DESC LIMIT 1) AS launch_bonus_accrued,
      (SELECT mp.bonus_manager_amount FROM manager_points mp WHERE mp.point_id = p.id ORDER BY mp.id DESC LIMIT 1) AS bonus_manager_amount,
      (SELECT mp.referred_groomer_amount FROM manager_points mp WHERE mp.point_id = p.id ORDER BY mp.id DESC LIMIT 1) AS referred_groomer_amount
    FROM points p WHERE p.id = ?
  `).get(pointId);
  if (!point) return null;
  point.photos_count = parsePhotos(point).length;
  point.referrers = db.prepare(`
    SELECT DISTINCT r.id, r.full_name, r.partner_code
    FROM partners g
    JOIN partners r ON r.id = g.referred_by_partner_id
    WHERE g.point_id = ? AND g.active = 1
  `).all(pointId);
  return point;
}

function autoState(key, facts) {
  if (key === 'manager_assigned') {
    return { completed: !!facts.manager_id, evidence: facts.manager_id ? 'Менеджер назначен' : 'Менеджер не назначен' };
  }
  if (key === 'groomer_registered') {
    return { completed: facts.partners_count > 0, evidence: facts.partners_count > 0 ? 'Активных грумеров: ' + facts.partners_count : 'Нет активного грумера' };
  }
  if (key === 'owner_registered') {
    return { completed: facts.owners_count > 0, evidence: facts.owners_count > 0 ? 'Владелец зарегистрирован' : 'Владелец не зарегистрирован' };
  }
  if (key === 'stock_loaded') {
    return { completed: facts.stock_qty > 0, evidence: facts.stock_qty > 0 ? 'На точке: ' + facts.stock_qty + ' шт.' : 'Положительных остатков нет' };
  }
  if (key === 'map_ready') {
    const complete = facts.lat !== null && facts.lng !== null;
    return { completed: complete, evidence: complete ? facts.lat + ', ' + facts.lng : 'Координаты не заполнены' };
  }
  if (key === 'public_page_ready') {
    const complete = !!facts.salon_page_published && facts.photos_count > 0;
    return { completed: complete, evidence: !facts.salon_page_published ? 'Страница не опубликована' : (facts.photos_count ? 'Опубликовано, фото: ' + facts.photos_count : 'Добавьте фотографию') };
  }
  return { completed: false, evidence: '' };
}

function referralEvidence(facts) {
  if (facts.referrers.length) {
    const people = facts.referrers.map((row) => row.full_name + ' (' + row.partner_code + ')').join(', ');
    return facts.launch_bonus_accrued
      ? 'Бонус начислен: ' + people + ' — ' + Number(facts.referred_groomer_amount || 1000).toLocaleString('ru-RU') +
        ' ₽; менеджеру — ' + Number(facts.bonus_manager_amount || 1000).toLocaleString('ru-RU') + ' ₽'
      : people + ' · после порога прибыли: 1 000 ₽ грумеру и 1 000 ₽ менеджеру';
  }
  return 'Грумер-реферал не указан. Подтвердите в комментарии, что точку никто из грумеров не приводил.';
}

function getPointLaunchChecklist(pointId) {
  const facts = pointFacts(pointId);
  if (!facts) return null;
  const saved = new Map(db.prepare('SELECT * FROM point_launch_checklist WHERE point_id = ?').all(pointId).map((row) => [row.item_key, row]));
  const items = ITEMS.map((definition) => {
    if (definition.mode === 'auto') {
      const state = autoState(definition.key, facts);
      return { ...definition, ...state, completed_by: null, completed_at: null, note: null };
    }
    const row = saved.get(definition.key);
    let evidence = '';
    if (definition.key === 'referral_bonus_verified') evidence = referralEvidence(facts);
    if (definition.key === 'test_sale_verified') {
      evidence = facts.paid_orders_count > 0
        ? 'Оплаченных заказов: ' + facts.paid_orders_count + ' · последний: ' + facts.latest_paid_order
        : 'Оплаченных заказов пока нет';
    }
    return {
      ...definition,
      completed: !!(row && row.completed),
      completed_by: row ? row.completed_by : null,
      completed_at: row ? row.completed_at : null,
      note: row ? row.note : null,
      evidence,
    };
  });
  const completed = items.filter((item) => item.completed).length;
  return {
    point: { id: facts.id, name: facts.name, addr: facts.addr, active: !!facts.active },
    items,
    summary: {
      total: items.length,
      completed,
      remaining: items.length - completed,
      percent: Math.round(completed / items.length * 100),
      ready: completed === items.length,
    },
  };
}

function getAllPointLaunchSummaries(activeOnly = true) {
  const manualPlaceholders = MANUAL_KEYS.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT p.id, p.name, p.addr, p.active, p.manager_id, p.lat, p.lng,
      p.salon_page_published, p.salon_photo_url, p.salon_photo_urls,
      (SELECT COUNT(*) FROM partners g WHERE g.point_id = p.id AND g.active = 1) AS partners_count,
      (SELECT COUNT(*) FROM salon_owners so WHERE so.point_id = p.id AND so.active = 1) AS owners_count,
      (SELECT COALESCE(SUM(s.qty), 0) FROM stock s
        JOIN product_variants v ON v.id = s.variant_id AND v.active = 1
        JOIN products pr ON pr.id = v.product_id AND pr.active = 1
        WHERE s.point_id = p.id AND s.qty > 0) AS stock_qty,
      (SELECT COUNT(*) FROM point_launch_checklist c
        WHERE c.point_id = p.id AND c.completed = 1 AND c.item_key IN (${manualPlaceholders})) AS manual_completed
    FROM points p ${activeOnly ? 'WHERE p.active = 1' : ''} ORDER BY p.name
  `).all(...MANUAL_KEYS);

  return rows.map((row) => {
    const autoCompleted = [
      !!row.manager_id,
      row.partners_count > 0,
      row.owners_count > 0,
      row.stock_qty > 0,
      row.lat !== null && row.lng !== null,
      !!row.salon_page_published && parsePhotos(row).length > 0,
    ].filter(Boolean).length;
    const completed = autoCompleted + Number(row.manual_completed || 0);
    return {
      point_id: row.id, point_name: row.name, addr: row.addr, active: !!row.active,
      total: ITEMS.length, completed, remaining: ITEMS.length - completed,
      percent: Math.round(completed / ITEMS.length * 100), ready: completed === ITEMS.length,
    };
  });
}

function setManualChecklistItem(pointId, itemKey, completed, note, actor) {
  const definition = ITEM_BY_KEY.get(itemKey);
  if (!definition) throw Object.assign(new Error('Пункт чек-листа не найден'), { code: 'ITEM_NOT_FOUND' });
  if (definition.mode !== 'manual') throw Object.assign(new Error('Этот пункт проверяется автоматически'), { code: 'AUTO_ITEM' });
  const facts = pointFacts(pointId);
  if (!facts) throw Object.assign(new Error('Точка не найдена'), { code: 'POINT_NOT_FOUND' });

  const cleanNote = String(note || '').trim().slice(0, 1000);
  if (completed && definition.requires_paid_order && facts.paid_orders_count <= 0) {
    throw Object.assign(new Error('Сначала проведите тестовую продажу: у точки ещё нет оплаченного заказа'), { code: 'PAID_ORDER_REQUIRED' });
  }
  if (completed && definition.requires_note_without_referrer && !facts.referrers.length && cleanNote.length < 3) {
    throw Object.assign(new Error('Укажите в комментарии, кто проверил отсутствие грумера-реферала'), { code: 'NOTE_REQUIRED' });
  }
  const finalNote = completed && definition.requires_paid_order && !cleanNote
    ? 'Проверено по заказу ' + facts.latest_paid_order
    : (cleanNote || null);
  db.prepare(`
    INSERT INTO point_launch_checklist
      (point_id, item_key, completed, note, completed_by, completed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END, datetime('now'))
    ON CONFLICT(point_id, item_key) DO UPDATE SET
      completed = excluded.completed,
      note = excluded.note,
      completed_by = excluded.completed_by,
      completed_at = excluded.completed_at,
      updated_at = excluded.updated_at
  `).run(pointId, itemKey, completed ? 1 : 0, finalNote, actor || null, completed ? 1 : 0);
  return getPointLaunchChecklist(pointId);
}

module.exports = {
  ITEMS,
  getPointLaunchChecklist,
  getAllPointLaunchSummaries,
  setManualChecklistItem,
};
