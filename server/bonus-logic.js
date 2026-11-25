// Общий бюджет премии за запуск точки: 2 000 ₽ при 2 000 ₽ оплаченной выручки.
// Без пригласившего менеджеру начисляется 2 000 ₽. При зафиксированном
// пригласившем: 1 000 ₽ менеджеру и отдельно 1 000 ₽ пригласившему
// при выполнении условий его реферальной программы.
// Для всех рекомендателей порог един: 1 000 ₽ оплаченной выручки за вычетом возвратов.
'use strict';

const db = require('./db');
const { sendTelegram } = require('./telegram');

// Комиссия платёжной системы — оценочная, пока не согласован окончательный
// тариф с ЮKassa. Раньше жила в quarterly-bonus.js (тот модуль удалён вместе
// с разделом «Квартальный бонус» в админке), но эта же оценка нужна и здесь
// для расчёта прямой прибыли компании с точки — перенесена как есть.
// Для единого сценария ЮKassa заранее неизвестно, какой способ выберет клиент.
// В прогнозе используем консервативную карточную ставку.
const FEE_RATE = { card: 0.025, bank_card: 0.025, sbp: 0.007, yookassa: 0.025 };

const LAUNCH_BONUS = 2000; // бюджет премии менеджеру и пригласившему вместе
const MANAGER_REVENUE_THRESHOLD = 2000; // оплаченная выручка за всё время
const {REFERRAL_REVENUE_THRESHOLD,REFERRAL_SPLIT,computeReferralRevenue}=require('./referral-policy');

// Прямая прибыль компании с точки за ВСЁ время (без квартальных накладных —
// те распределяются отдельно, раз в квартал, см. quarterly-bonus.js). Та же
// формула себестоимости и комиссий, что и там — чтобы цифры не расходились
// между "когда выплачивать бонус" и "квартальный отчёт по прибыльности".
function computePointRevenueSoFar(pointId) { return computeReferralRevenue(db,pointId); }

function computePointProfitSoFar(pointId, partnerRate, managerRate) {
  const orders = db.prepare(`
    SELECT id, total, payment_method, commission_rate FROM orders WHERE point_id = ? AND status = 'paid' AND COALESCE(refund_status,'') <> 'refunded'
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

  // Комиссия партнёра — по фактической ставке КАЖДОГО заказа,
  // зафиксированной при оплате (включая тариф грумера для самозаказа),
  // а не единым текущим уровнем партнёра на всю выручку.
  const partnerCommission = orders.reduce((s, o) => s + o.total * (o.commission_rate ?? (partnerRate || 0)), 0);
  const managerCommission = revenue * (managerRate || 0);

  return revenue - cogs - paymentFee - partnerCommission - managerCommission;
}

// Вызывается после каждой подтверждённой оплаты — проверяет, не пора ли
// начислить бонус за точку, к которой относится этот заказ.
async function checkAndPayManagerBonus(pointId) {
  if (!pointId) return;
  const mgrPoint = db.prepare('SELECT * FROM manager_points WHERE point_id = ? ORDER BY id LIMIT 1').get(pointId);
  if (!mgrPoint) return;
  const revenueSoFar = computePointRevenueSoFar(pointId);
  const managerIsDue = !mgrPoint.bonus_paid && revenueSoFar >= MANAGER_REVENUE_THRESHOLD;
  const locked = require('./referral-program').storedReferral(pointId);
  const partner = db.prepare(
    "SELECT * FROM partners WHERE point_id=? AND active=1 " +
    "ORDER BY CASE WHEN referred_by_partner_id IS NOT NULL OR referred_by_owner_id IS NOT NULL " +
    "THEN 0 ELSE 1 END,id LIMIT 1"
  ).get(pointId);
  const groomerReferrer = locked
    ? locked.role === 'partner'
      ? db.prepare('SELECT * FROM partners WHERE id=?').get(locked.recipient_id) : null
    : partner && partner.referred_by_partner_id
      ? db.prepare('SELECT * FROM partners WHERE id=?').get(partner.referred_by_partner_id) : null;
  const ownerReferrer = locked
    ? locked.role === 'owner'
      ? db.prepare('SELECT * FROM salon_owners WHERE id=?').get(locked.recipient_id) : null
    : partner && partner.referred_by_owner_id
      ? db.prepare('SELECT * FROM salon_owners WHERE id=?').get(partner.referred_by_owner_id) : null;
  const alreadyAccruedReferral = !!(mgrPoint.referred_groomer_id || mgrPoint.referred_owner_id);
  // Reserve the second half of the launch budget as soon as the inviter is
  // recorded. The owner referral can accrue after the manager's threshold.
  const hasReferrer = !!(groomerReferrer || ownerReferrer || alreadyAccruedReferral);
  const managerBonusAmount = hasReferrer ? LAUNCH_BONUS - REFERRAL_SPLIT : LAUNCH_BONUS;
  // If an inviter was attached AFTER manager accrual, correct only an UNPAID
  // amount (including older split values). Never rewrite a transfer or snapshot.
  if (hasReferrer && mgrPoint.bonus_paid && Number(mgrPoint.bonus_manager_amount ?? LAUNCH_BONUS) !== managerBonusAmount) {
    db.prepare(
      "UPDATE manager_points SET bonus_manager_amount=? WHERE id=? AND bonus_paid=1 " +
      "AND COALESCE(bonus_manager_amount,?)<>? " +
      "AND NOT EXISTS (SELECT 1 FROM manager_launch_bonus_payouts bp WHERE bp.manager_point_id=manager_points.id)"
    ).run(managerBonusAmount,mgrPoint.id,LAUNCH_BONUS,managerBonusAmount);
  }
  // A historical full launch payment cannot be silently clawed back or
  // doubled. Refuse a new referral if this point's budget is already spent.
  const referralBudgetUsed=!!db.prepare(`SELECT 1 FROM manager_launch_bonus_payouts bp
    JOIN manager_points old ON old.id=bp.manager_point_id WHERE old.point_id=? AND bp.amount>?
    UNION ALL SELECT 1 FROM referral_bonus_payouts bp JOIN manager_points old ON old.id=bp.manager_point_id
    WHERE old.point_id=? LIMIT 1`).get(pointId,REFERRAL_SPLIT,pointId);
  const otherAccrual=!!db.prepare(`SELECT 1 FROM manager_points
    WHERE point_id=? AND id<>? AND (referred_groomer_id IS NOT NULL OR referred_owner_id IS NOT NULL) LIMIT 1`).get(pointId,mgrPoint.id);
  const referralIsDue = !!(groomerReferrer||ownerReferrer) && !alreadyAccruedReferral &&
    !referralBudgetUsed && !otherAccrual && revenueSoFar >= REFERRAL_REVENUE_THRESHOLD;
  if (!managerIsDue && !referralIsDue) return;

  let managerAccrued = false;
  let referralAccrued = false;
  // Independent thresholds, but a shared 2k launch budget: manager receives
  // 1k when an inviter is registered, independently of the referral threshold.
  if (managerIsDue) {
    const result = db.prepare(
      "UPDATE manager_points SET bonus_paid=1,bonus_manager_amount=?," +
      "bonus_accrued_at=datetime('now') WHERE id=? AND bonus_paid=0"
    ).run(managerBonusAmount,mgrPoint.id);
    managerAccrued = !!result.changes;
  }
  if (referralIsDue) {
    const result = db.prepare(
      "UPDATE manager_points SET referred_groomer_id=?,referred_groomer_amount=?," +
      "referred_owner_id=?,referred_owner_amount=?," +
      "referral_bonus_accrued_at=datetime('now') " +
      "WHERE id=? AND referred_groomer_id IS NULL AND referred_owner_id IS NULL"
    ).run(groomerReferrer ? groomerReferrer.id : null,
      groomerReferrer ? REFERRAL_SPLIT : null,
      ownerReferrer ? ownerReferrer.id : null,
      ownerReferrer ? REFERRAL_SPLIT : null,
      mgrPoint.id);
    referralAccrued = !!result.changes;
  }
  if (!managerAccrued && !referralAccrued) return;

  const manager = db.prepare('SELECT * FROM managers WHERE id=?').get(mgrPoint.manager_id);
  const lines = ['🎉 <b>Начисления за точку «' + mgrPoint.point_name + '»</b>', ''];
  if (managerAccrued) {
    lines.push('✅ Накопленная оплаченная выручка: ' + Math.round(revenueSoFar) +
      ' ₽ (порог ' + MANAGER_REVENUE_THRESHOLD + ' ₽).');
    lines.push('🌟 Менеджеру ' + (manager ? manager.full_name : '№' + mgrPoint.manager_id) +
      ': <b>' + managerBonusAmount + ' ₽</b> за запуск — начислено к выплате.');
  }
  if (referralAccrued) {
    lines.push('✅ Оплаченная выручка новой точки за вычетом возвратов: ' + Math.round(revenueSoFar) +
      ' ₽ (порог ' + REFERRAL_REVENUE_THRESHOLD + ' ₽).');
    if (groomerReferrer) lines.push('🤝 Пригласившему грумеру ' + groomerReferrer.full_name +
      ': <b>' + REFERRAL_SPLIT + ' ₽</b> — начислено к выплате.');
    if (ownerReferrer) lines.push('🏠 Пригласившему владельцу ' + ownerReferrer.full_name +
      ': <b>' + REFERRAL_SPLIT + ' ₽</b> — начислено к выплате.');
  }
  lines.push('', 'Фактическую выплату администратор подтверждает отдельно.');
  await sendTelegram(lines.join('\n')).catch(() => {});
}

module.exports = { checkAndPayManagerBonus, computePointRevenueSoFar, computePointProfitSoFar, LAUNCH_BONUS, MANAGER_REVENUE_THRESHOLD, REFERRAL_REVENUE_THRESHOLD, REFERRAL_SPLIT };
