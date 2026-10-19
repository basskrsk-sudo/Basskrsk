'use strict';

// Compact display model only; monetary figures come from the saved report
// snapshot and from sums of per-order rounded commissions.
function summarizeCompensation(report) {
  const groups = new Map();
  for (const item of report.items || []) {
    const point = String(item.point || report.recipient?.point || 'Продажи').trim();
    const rate = item.rate == null ? null : Number(item.rate);
    const knownBase = item.base != null;
    const key = JSON.stringify([item.point_id || point, point, rate, knownBase]);
    if (!groups.has(key)) groups.set(key, { point, rate, orders: 0, base: knownBase ? 0 : null, amount: 0 });
    const row = groups.get(key);
    row.orders += 1;
    if (knownBase) row.base += Number(item.base);
    row.amount += Number(item.amount || 0);
  }
  return {
    groups: [...groups.values()],
    bonuses: (report.bonuses || []).map(b => ({
      point: b.point || b.point_name || 'Бонус',
      amount: Number(b.amount || 0),
      already_paid: !!b.already_paid,
    })),
    commission: Number(report.commission_accrued ?? 0),
    bonus: Number(report.bonus_accrued || 0),
    accrued: Number(report.accrued || 0),
    alreadyPaid: Number(report.already_paid || 0),
    unpaid: Number(report.unpaid || 0),
    payoutAmount: report.payout_amount == null ? null : Number(report.payout_amount),
    hasHistoricalGaps: (report.items || []).some(i => i.base == null || i.rate == null),
    hasUndatedBonuses: !!report.undated_bonuses?.length,
    orderCount: (report.items || []).length,
  };
}

module.exports = { summarizeCompensation };
