// bonus-logic.js — автоматическая проверка и начисление бонуса, когда точка
// «окупает» бонус: накопленная прямая прибыль компании с этой точки (выручка
// минус себестоимость, эквайринг, комиссии грумера и менеджера — без учёта
// общих накладных, это отдельная квартальная история) достигает LAUNCH_BONUS.
//
// Если грумера на точке привёл другой грумер ИЛИ владелец салона (по своему
// реферальному коду) — бонус делится поровну: 1 000 ₽ рефереру (грумеру или
// владельцу) и 1 000 ₽ менеджеру, который нашёл саму точку. Обе роли внесли
// вклад — менеджер нашёл точку физически, реферер привёл на неё грумера —
// поэтому оба получают свою долю, а не только один из них.
'use strict';

const db = require('./db');
const { sendTelegram } = require('./telegram');

// Комиссия платёжной системы — оценочная, пока не согласован окончательный
// тариф с ЮKassa. Раньше жила в quarterly-bonus.js (тот модуль удалён вместе
// с разделом «Квартальный бонус» в админке), но эта же оценка нужна и здесь
// для расчёта прямой прибыли компании с точки — перенесена как есть.
const FEE_RATE = { card: 0.025, sbp: 0.007 };

const LAUNCH_BONUS = 2000;
const REFERRAL_SPLIT = 1000; // при наличии реферала — каждой стороне по 1000 ₽

// Прямая прибыль компании с точки за ВСЁ время (без квартальных накладных —
// те распределяются отдельно, раз в квартал, см. quarterly-bonus.js). Та же
// формула себестоимости и комиссий, что и там — чтобы цифры не расходились
// между "когда выплачивать бонус" и "квартальный отчёт по прибыльности".
function computePointProfitSoFar(pointId, partnerRate, managerRate) {
  const orders = db.prepare(`
    SELECT id, total, payment_method, commission_rate FROM orders WHERE point_id = ? AND status = 'paid'
  `).all(pointId);
  if (!orders.length) return 0;

  const revenue = orders.reduce((s, o) => s + o.total, 0);
  const paymentFee = orders.reduce((s, o) => s + o.total * (FEE_RATE[o.payment_method] ?? FEE_RATE.card), 0);

  const orderIds = orders.map((o) => o.id);
  const placeholders = orderIds.map(() => '?').join(',');
  const items = db.prepare(`
    SELECT oi.variant_id, oi.name, oi.weight, oi.qty FROM order_items oi
    WHERE oi.order_id IN (${placeholders}) AND oi.is_custom = 0
  `).all(...orderIds);
  let cogs = 0;
  for (const item of items) {
    const variant = item.variant_id
      ? db.prepare('SELECT cost_price FROM product_variants WHERE id = ?').get(item.variant_id)
      : db.prepare(`
      SELECT v.cost_price FROM product_variants v
      JOIN products p ON p.id = v.product_id
      WHERE p.name = ? AND v.weight = ?
    `).get(item.name, item.weight);
    if (variant && variant.cost_price) cogs += variant.cost_price * item.qty;
  }

  // Комиссия партнёра — по фактической ставке КАЖДОГО заказа (учитывает
  // ставку 0% для самозаказов грумера, см. routes-payment.js),
  // а не единым текущим уровнем партнёра на всю выручку.
  const partnerCommission = orders.reduce((s, o) => s + o.total * (o.commission_rate ?? (partnerRate || 0)), 0);
  const managerCommission = revenue * (managerRate || 0);

  return revenue - cogs - paymentFee - partnerCommission - managerCommission;
}

// Вызывается после каждой подтверждённой оплаты — проверяет, не пора ли
// начислить бонус за точку, к которой относится этот заказ.
async function checkAndPayManagerBonus(pointId) {
  if (!pointId) return;

  const mgrPoint = db.prepare('SELECT * FROM manager_points WHERE point_id = ?').get(pointId);
  if (!mgrPoint || mgrPoint.bonus_paid) return; // нет привязки к менеджеру или бонус уже выплачен

  const partner = db.prepare('SELECT * FROM partners WHERE point_id = ?').get(pointId);
  const profitSoFar = computePointProfitSoFar(pointId, partner ? partner.commission_rate : 0, mgrPoint.commission_rate);
  if (profitSoFar < LAUNCH_BONUS) return; // точка ещё не "окупила" бонус

  // Грумера на этой точке мог привести другой грумер ИЛИ владелец салона по
  // своему коду — проверяем оба варианта (в базе заполнено не больше одного
  // из двух полей, форма регистрации принимает только один код за раз).
  const groomerReferrer = partner && partner.referred_by_partner_id
    ? db.prepare('SELECT * FROM partners WHERE id = ?').get(partner.referred_by_partner_id)
    : null;
  const ownerReferrer = partner && partner.referred_by_owner_id
    ? db.prepare('SELECT * FROM salon_owners WHERE id = ?').get(partner.referred_by_owner_id)
    : null;
  const hasReferrer = !!(groomerReferrer || ownerReferrer);

  const managerAmount = hasReferrer ? REFERRAL_SPLIT : LAUNCH_BONUS;
  const groomerAmount = groomerReferrer ? REFERRAL_SPLIT : null;
  const ownerAmount = ownerReferrer ? REFERRAL_SPLIT : null;

  db.prepare(`
    UPDATE manager_points
    SET bonus_paid = 1, bonus_manager_amount = ?,
        referred_groomer_id = ?, referred_groomer_amount = ?,
        referred_owner_id = ?, referred_owner_amount = ?
    WHERE id = ?
  `).run(
    managerAmount,
    groomerReferrer ? groomerReferrer.id : null, groomerAmount,
    ownerReferrer ? ownerReferrer.id : null, ownerAmount,
    mgrPoint.id
  );

  const manager = db.prepare('SELECT * FROM managers WHERE id = ?').get(mgrPoint.manager_id);

  const lines = [
    '🎉 <b>Бонус за точку «' + mgrPoint.point_name + '»</b>',
    '',
    'Точка принесла компании ' + Math.round(profitSoFar) + ' ₽ прибыли (порог ' + LAUNCH_BONUS + ' ₽ пройден) — начислен бонус за запуск.',
    '',
  ];
  if (groomerReferrer) {
    lines.push('🤝 Грумер-реферал ' + groomerReferrer.full_name + ' (' + groomerReferrer.partner_code + '): ' + groomerAmount + ' ₽');
  }
  if (ownerReferrer) {
    lines.push('🏠 Владелец-реферал ' + ownerReferrer.full_name + ' (' + ownerReferrer.owner_code + '): ' + ownerAmount + ' ₽');
  }
  lines.push('🌟 Менеджер ' + (manager ? manager.full_name : '№' + mgrPoint.manager_id) + ': ' + managerAmount + ' ₽');
  lines.push('');
  lines.push(hasReferrer
    ? '→ Точку привёл менеджер, но грумера на ней — реферал по промокоду, поэтому бонус поделён поровну между ними.'
    : '→ Не забудьте выплатить бонус менеджеру.');

  await sendTelegram(lines.join('\n')).catch(() => {});
}

module.exports = { checkAndPayManagerBonus, computePointProfitSoFar, LAUNCH_BONUS, REFERRAL_SPLIT };
