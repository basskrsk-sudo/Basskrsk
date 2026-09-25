// partner-tiers.js — расчёт уровня партнёра (грумера) по календарным месяцам.
//
// Правило (по требованию бизнеса):
// — Если в месяце M показатели партнёра дотягивают до уровня — уровень
//   применяется сразу и держится весь месяц M и весь следующий месяц M+1
//   (льготный месяц) БЕЗ повторного подтверждения.
// — Если и в месяце M+1 показатели снова не дотянули до уровня — начиная
//   с месяца M+2 партнёр понижается ровно до того уровня, который реально
//   заработал по факту (может быть средний, может сразу базовый — смотря
//   что фактически набрал).
'use strict';

const db = require('./db');

// Пороги — совпадают с тем, что показывается на странице регистрации
// (taiga-register.html). Если меняете пороги там — не забудьте поменять и тут.
const TIERS = [
  { rate: 0.20, minRevenue: 70000, minReferrals: 7, name: 'Эксперт' },
  { rate: 0.18, minRevenue: 30000, minReferrals: 3, name: 'Старший партнёр' },
  { rate: 0.15, minRevenue: 0,     minReferrals: 0, name: 'Партнёр' },
];

function currentMonthKey(date) {
  const d = date || new Date();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

// Разница в месяцах между 'YYYY-MM' строками (b - a), положительная если b позже a.
function monthDiff(a, b) {
  if (!a) return Infinity; // ещё ни разу не подтверждал — считаем, что льгота давно кончилась
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}

// Выручка партнёра ЗА КАЛЕНДАРНЫЙ МЕСЯЦ (с 1-го числа по текущий момент, если
// месяц ещё не закончился — тот же принцип применяется и к прошлым месяцам,
// просто окно уже полностью в прошлом).
function getMonthRevenue(partner, monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
  // Конец окна — начало следующего месяца (эксклюзивно)
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const monthEnd = `${nextY}-${String(nextM).padStart(2, '0')}-01`;

  if (!partner.point_id) return 0;

  const otherActiveOnSamePoint = db.prepare('SELECT COUNT(*) AS c FROM partners WHERE point_id = ? AND id != ? AND active = 1').get(partner.point_id, partner.id).c;

  if (otherActiveOnSamePoint === 0) {
    const row = db.prepare(`
      SELECT COALESCE(SUM(total), 0) AS rev FROM orders
      WHERE point_id = ? AND status = 'paid' AND created_at >= ? AND created_at < ?
        AND (partner_id = ? OR partner_id IS NULL)
    `).get(partner.point_id, monthStart, monthEnd, partner.id);
    return row.rev;
  }
  const row = db.prepare(`
    SELECT COALESCE(SUM(total), 0) AS rev FROM orders
    WHERE partner_id = ? AND status = 'paid' AND created_at >= ? AND created_at < ?
  `).get(partner.id, monthStart, monthEnd);
  return row.rev;
}

function getReferralsCount(partnerId) {
  return db.prepare('SELECT COUNT(*) AS c FROM partners WHERE referred_by_partner_id = ?').get(partnerId).c;
}

function getEligibleTier(revenue, referralsCount) {
  for (const tier of TIERS) {
    if (revenue >= tier.minRevenue || referralsCount >= tier.minReferrals) return tier;
  }
  return TIERS[TIERS.length - 1];
}

function getPartnerStats(partnerId, monthKey) {
  const partner = db.prepare('SELECT * FROM partners WHERE id = ?').get(partnerId);
  if (!partner) return null;
  const month = monthKey || currentMonthKey();
  const revenue = getMonthRevenue(partner, month);
  const referralsCount = getReferralsCount(partnerId);
  return { partner, revenue, referralsCount, month };
}

// Основная проверка — вызывается после каждого оплаченного заказа партнёра,
// а также раз в сутки по расписанию (на случай, если у партнёра давно не
// было заказов, но льготный месяц уже истёк — понижение всё равно должно
// произойти вовремя, а не только "при следующей продаже").
async function checkAndUpgradePartnerTier(partnerId) {
  const stats = getPartnerStats(partnerId);
  if (!stats) return null;
  const { partner, revenue, referralsCount, month } = stats;

  const earnedTier = getEligibleTier(revenue, referralsCount);

  if (earnedTier.rate >= partner.commission_rate) {
    // Показатели ЭТОГО месяца дотягивают до текущего уровня (или выше) —
    // подтверждаем (обновляем месяц подтверждения), и повышаем, если заработал больше.
    const isUpgrade = earnedTier.rate > partner.commission_rate;
    db.prepare('UPDATE partners SET commission_rate = ?, tier_confirmed_month = ? WHERE id = ?')
      .run(earnedTier.rate, month, partnerId);
    if (isUpgrade) {
      await notifyTierChange(partner, earnedTier, revenue, referralsCount, 'up');
      return { tierName: earnedTier.name, newRate: earnedTier.rate, direction: 'up' };
    }
    return null;
  }

  // Показатели этого месяца НЕ дотягивают до текущего уровня — проверяем
  // льготный период: сколько месяцев прошло с последнего подтверждения.
  const monthsSinceConfirmed = monthDiff(partner.tier_confirmed_month, month);
  if (monthsSinceConfirmed <= 1) {
    // Месяц заработка (0) или следующий льготный месяц (1) — держим уровень,
    // ничего не трогаем.
    return null;
  }

  // Льготный месяц истёк без подтверждения — понижаем до того, что реально
  // заработано сейчас (средний уровень или сразу базовый — по факту).
  db.prepare('UPDATE partners SET commission_rate = ?, tier_confirmed_month = ? WHERE id = ?')
    .run(earnedTier.rate, month, partnerId);
  await notifyTierChange(partner, earnedTier, revenue, referralsCount, 'down');
  return { tierName: earnedTier.name, newRate: earnedTier.rate, direction: 'down' };
}

async function notifyTierChange(partner, tier, revenue, referralsCount, direction) {
  try {
    const { sendTelegram } = require('./telegram');
    const emoji = direction === 'up' ? '🎉' : '📉';
    const title = direction === 'up' ? 'Партнёр повышен' : 'Партнёр понижен (льготный месяц истёк без подтверждения)';
    await sendTelegram(
      emoji + ' <b>' + title + ' до уровня «' + tier.name + '»</b>\n\n' +
      '👤 ' + partner.full_name + ' (' + partner.partner_code + ')\n' +
      '📊 Новая комиссия: ' + Math.round(tier.rate * 100) + '%\n' +
      '💰 Выручка за этот месяц: ' + revenue.toLocaleString('ru-RU') + ' ₽\n' +
      '🤝 Привлечённых партнёров: ' + referralsCount
    ).catch(() => {});

    // Отдельное предупреждение об экономическом риске — только при ПОВЫШЕНИИ
    // до «Старший» (18%) или «Эксперт» (20%). На этих тарифах в сочетании
    // с максимальным списанием косточек клиентом (30%, доступно на заказах
    // от 800₽ — лимит ступенчатый по сумме заказа) заказ уходит в минус
    // при недостаточной наценке — см. разбор безубыточности:
    // Старший безубыточен от наценки ×2.23, Эксперт — от ×2.30. Базовый
    // тариф (15%) безопаснее (от ×2.13), поэтому на нём такого предупреждения нет.
    if (direction === 'up' && tier.rate >= 0.18) {
      const breakevenMarkup = tier.rate >= 0.20 ? '×2.30' : '×2.23';
      await sendTelegram(
        '⚠️ <b>Экономический риск: новый тариф «' + tier.name + '» (' + Math.round(tier.rate * 100) + '%)</b>\n\n' +
        'У партнёра ' + partner.full_name + ' теперь высокая комиссия. Если клиент на его точке оформит заказ от 800₽ и спишет максимум косточек (30% от заказа), заказ станет убыточным при наценке ниже ' + breakevenMarkup + '.\n\n' +
        '→ Проверьте вашу реальную наценку по товарам этой точки — если она ниже ' + breakevenMarkup + ', стоит пересмотреть закупочные цены или лимит списания косточек для таких заказов.'
      ).catch(() => {});
    }
  } catch (e) { /* уведомление необязательно — не роняем основной процесс */ }
}

// Прогулка по всем активным партнёрам — для ежедневной фоновой проверки,
// ловит понижения даже у тех, у кого давно не было заказов.
async function checkAllPartnerTiers() {
  const partners = db.prepare('SELECT id FROM partners WHERE active = 1').all();
  for (const p of partners) {
    try { await checkAndUpgradePartnerTier(p.id); } catch (e) { console.warn('Ошибка проверки уровня партнёра #' + p.id + ':', e.message); }
  }
}

// Прогресс до следующего уровня — для отображения партнёру в кабинете.
function getTierProgress(partnerId) {
  const stats = getPartnerStats(partnerId);
  if (!stats) return null;
  const { partner, revenue, referralsCount, month } = stats;

  const currentTierIndex = TIERS.findIndex((t) => t.rate === partner.commission_rate);
  const nextTier = currentTierIndex > 0 ? TIERS[currentTierIndex - 1] : null; // TIERS отсортирован по убыванию

  const monthsSinceConfirmed = monthDiff(partner.tier_confirmed_month, month);
  const inGracePeriod = monthsSinceConfirmed === 1; // сейчас — тот самый льготный месяц

  const result = {
    currentRate: partner.commission_rate,
    revenueThisMonth: revenue,
    referralsCount,
    inGracePeriod,
    nextTier: null,
  };

  if (nextTier) {
    const revenueLeft = Math.max(0, nextTier.minRevenue - revenue);
    const referralsLeft = Math.max(0, nextTier.minReferrals - referralsCount);
    const revenueProgress = nextTier.minRevenue > 0 ? Math.min(100, Math.round(revenue / nextTier.minRevenue * 100)) : 100;
    const referralsProgress = nextTier.minReferrals > 0 ? Math.min(100, Math.round(referralsCount / nextTier.minReferrals * 100)) : 100;
    result.nextTier = {
      name: nextTier.name,
      rate: nextTier.rate,
      revenueNeeded: nextTier.minRevenue,
      revenueLeft,
      referralsNeeded: nextTier.minReferrals,
      referralsLeft,
      progressPercent: Math.max(revenueProgress, referralsProgress),
    };
  }

  // Если партнёр держится на уровне только за счёт льготного месяца (в этом
  // месяце показатели уже не дотягивают) — предупреждаем его явно.
  if (inGracePeriod) {
    const earnedNow = getEligibleTier(revenue, referralsCount);
    if (earnedNow.rate < partner.commission_rate) {
      result.graceWarning = {
        currentTierName: TIERS.find((t) => t.rate === partner.commission_rate).name,
        willDropTo: earnedNow.name,
        willDropToRate: earnedNow.rate,
      };
    }
  }

  return result;
}

module.exports = { checkAndUpgradePartnerTier, checkAllPartnerTiers, getTierProgress, getPartnerStats, currentMonthKey, TIERS, notifyTierChange };
