// routes-point-launch.js — API чек-листа открытия точки.
'use strict';

const { sendJson } = require('./http-utils');
const { requireAuth } = require('./routes-auth');
const {
  getPointLaunchChecklist,
  getAllPointLaunchSummaries,
  setManualChecklistItem,
} = require('./point-launch-checklist');

function registerPointLaunchRoutes(router) {
  router.get('/api/point-launch-checklists', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    sendJson(res, 200, { points: getAllPointLaunchSummaries(ctx.query.all !== '1') });
  });

  router.get('/api/points/:id/launch-checklist', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const checklist = getPointLaunchChecklist(ctx.params.id);
    if (!checklist) return sendJson(res, 404, { error: 'Точка не найдена' });
    sendJson(res, 200, checklist);
  });

  router.put('/api/points/:id/launch-checklist/:key', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    try {
      const checklist = setManualChecklistItem(
        ctx.params.id,
        ctx.params.key,
        !!(ctx.body && ctx.body.completed),
        ctx.body && ctx.body.note,
        payload.login || 'admin'
      );
      sendJson(res, 200, { ok: true, checklist });
    } catch (error) {
      if (error.code === 'POINT_NOT_FOUND' || error.code === 'ITEM_NOT_FOUND') {
        return sendJson(res, 404, { error: error.message, code: error.code });
      }
      if (['AUTO_ITEM', 'PAID_ORDER_REQUIRED', 'NOTE_REQUIRED'].includes(error.code)) {
        return sendJson(res, 409, { error: error.message, code: error.code });
      }
      console.error('[point-launch-checklist] Не удалось сохранить пункт:', error);
      sendJson(res, 500, { error: 'Не удалось сохранить пункт чек-листа' });
    }
  });
}

module.exports = { registerPointLaunchRoutes };
