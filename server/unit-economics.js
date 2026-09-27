// unit-economics.js — плановая модель экономики одного заказа и одной точки.
// Допущения не меняют реальные тарифы, начисления и P&L: это отдельный
// управленческий калькулятор, доступный только супер-администратору.
'use strict';

const db = require('./db');

const SETTINGS_KEY = 'unit_economics';

const DEFAULTS = {
  average_order_value: 650,
  monthly_orders_per_point: 70,
  gross_margin_percent: 50,
  groomer_commission_percent: 15,
  self_selected_orders_percent: 0,
  manager_commission_percent: 7,
  owner_commission_percent: 5,
  acquiring_percent: 2.7,
  logistics_percent: 5,
  writeoffs_percent: 1.5,
  bonuses_it_percent: 1.5,
  tax_percent: 6,
  launch_cost: 20000,
  manager_launch_bonus: 2000,
};

const LIMITS = {
  average_order_value: [1, 1000000],
  monthly_orders_per_point: [0, 1000000],
  gross_margin_percent: [0, 100],
  groomer_commission_percent: [0, 100],
  self_selected_orders_percent: [0, 100],
  manager_commission_percent: [0, 100],
  owner_commission_percent: [0, 100],
  acquiring_percent: [0, 100],
  logistics_percent: [0, 100],
  writeoffs_percent: [0, 100],
  bonuses_it_percent: [0, 100],
  tax_percent: [0, 100],
  launch_cost: [0, 100000000],
  manager_launch_bonus: [0, 100000000],
};

function round(value, precision = 2) {
  const multiplier = 10 ** precision;
  return Math.round(Number(value || 0) * multiplier) / multiplier;
}

function normalizeAssumptions(raw, base = DEFAULTS) {
  const result = { ...base };
  for (const [key, bounds] of Object.entries(LIMITS)) {
    if (raw[key] === undefined) continue;
    const value = Number(raw[key]);
    if (!Number.isFinite(value) || value < bounds[0] || value > bounds[1]) {
      const error = new Error('Некорректное значение: ' + key);
      error.code = 'INVALID_ASSUMPTION';
      throw error;
    }
    result[key] = round(value, 2);
  }
  return result;
}

function getUnitEconomicsSettings() {
  const row = db.prepare('SELECT value, updated_at FROM site_settings WHERE key = ?').get(SETTINGS_KEY);
  if (!row) return { assumptions: { ...DEFAULTS }, updated_at: null, updated_by: null };
  try {
    const stored = JSON.parse(row.value);
    return {
      assumptions: normalizeAssumptions(stored.assumptions || stored, DEFAULTS),
      updated_at: row.updated_at || null,
      updated_by: stored.updated_by || null,
    };
  } catch (error) {
    return { assumptions: { ...DEFAULTS }, updated_at: row.updated_at || null, updated_by: null };
  }
}

function calculateUnitEconomics(assumptions) {
  const a = normalizeAssumptions(assumptions, DEFAULTS);
  const revenue = a.average_order_value;
  const grossProfit = revenue * a.gross_margin_percent / 100;
  const productCost = revenue - grossProfit;
  const effectiveGroomerRate = a.groomer_commission_percent * (1 - a.self_selected_orders_percent / 100);
  const rateCosts = {
    groomer_commission: revenue * effectiveGroomerRate / 100,
    manager_commission: revenue * a.manager_commission_percent / 100,
    owner_commission: revenue * a.owner_commission_percent / 100,
    acquiring: revenue * a.acquiring_percent / 100,
    logistics: revenue * a.logistics_percent / 100,
    writeoffs: revenue * a.writeoffs_percent / 100,
    bonuses_it: revenue * a.bonuses_it_percent / 100,
    tax: revenue * a.tax_percent / 100,
  };
  const variableCostsAfterProduct = Object.values(rateCosts).reduce((sum, value) => sum + value, 0);
  const totalVariableCosts = productCost + variableCostsAfterProduct;
  const contributionPerOrder = revenue - totalVariableCosts;
  const contributionMargin = revenue ? contributionPerOrder / revenue * 100 : 0;
  const breakEvenGrossMargin = effectiveGroomerRate + a.manager_commission_percent +
    a.owner_commission_percent + a.acquiring_percent + a.logistics_percent +
    a.writeoffs_percent + a.bonuses_it_percent + a.tax_percent;
  const monthlyRevenue = revenue * a.monthly_orders_per_point;
  const monthlyContribution = contributionPerOrder * a.monthly_orders_per_point;
  const launchInvestment = a.launch_cost + a.manager_launch_bonus;

  return {
    revenue_per_order: round(revenue),
    product_cost_per_order: round(productCost),
    gross_profit_per_order: round(grossProfit),
    effective_groomer_rate_percent: round(effectiveGroomerRate),
    costs_per_order: Object.fromEntries(Object.entries(rateCosts).map(([key, value]) => [key, round(value)])),
    total_variable_costs_per_order: round(totalVariableCosts),
    contribution_per_order: round(contributionPerOrder),
    contribution_margin_percent: round(contributionMargin),
    break_even_gross_margin_percent: round(breakEvenGrossMargin),
    monthly_revenue_per_point: round(monthlyRevenue),
    monthly_contribution_per_point: round(monthlyContribution),
    launch_investment: round(launchInvestment),
    orders_to_payback: contributionPerOrder > 0 ? round(launchInvestment / contributionPerOrder, 1) : null,
    payback_months: monthlyContribution > 0 ? round(launchInvestment / monthlyContribution, 1) : null,
  };
}

function saveUnitEconomicsSettings(partial, admin) {
  const current = getUnitEconomicsSettings().assumptions;
  const assumptions = normalizeAssumptions(partial || {}, current);
  const updatedBy = admin && admin.login || null;
  const payload = JSON.stringify({ assumptions, updated_by: updatedBy });
  db.prepare(`
    INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(SETTINGS_KEY, payload);
  db.prepare(`
    INSERT INTO unit_economics_settings_log (admin_id, admin_login, assumptions_json)
    VALUES (?, ?, ?)
  `).run(admin && admin.id || null, updatedBy, JSON.stringify(assumptions));
  return { assumptions, updated_by: updatedBy };
}

module.exports = {
  DEFAULTS,
  calculateUnitEconomics,
  getUnitEconomicsSettings,
  saveUnitEconomicsSettings,
};
