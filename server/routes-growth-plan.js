// routes-growth-plan.js — API раздела «План 1000 точек».
'use strict';

const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireAuth, requireSuperAdmin } = require('./routes-auth');
const { buildGrowthPlanDashboard, saveSettings, syncGrowthPlanTasks } = require('./growth-plan');

function registerGrowthPlanRoutes(router) {
  router.get('/api/growth-plan', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    sendJson(res, 200, {
      ...buildGrowthPlanDashboard(),
      settings_history: db.prepare('SELECT id, admin_login, created_at FROM growth_plan_settings_log ORDER BY id DESC LIMIT 10').all(),
    });
  });

  router.put('/api/growth-plan/settings', (req, res, ctx) => {
    const payload = requireSuperAdmin(req, res, ctx);
    if (!payload) return;
    try {
      saveSettings(ctx.body || {}, payload);
      sendJson(res, 200, { ok: true, dashboard: buildGrowthPlanDashboard() });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Не удалось сохранить план' });
    }
  });

  router.post('/api/growth-plan/tasks/sync', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const dashboard = buildGrowthPlanDashboard();
    sendJson(res, 200, { ok: true, ...syncGrowthPlanTasks(dashboard, payload.login || 'admin') });
  });
}

module.exports = { registerGrowthPlanRoutes };
