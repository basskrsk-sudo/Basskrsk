// routes-settings.js — настройки лояльности (проценты кэшбэка косточками,
// пороги викторины/шахмат и т.п.): публичное чтение, нужно сайту для расчёта
// на лету. Раньше был ещё PUT-эндпоинт для правки этих настроек из админки
// (раздел «Настройки скидок») — убран вместе с самим разделом; значения
// теперь берутся из DEFAULTS в settings.js без возможности править через UI.
'use strict';

const { sendJson } = require('./http-utils');
const { getDiscountSettings } = require('./settings');

function registerSettingsRoutes(router) {
  // GET /api/settings/discounts — публичный, нужен сайту для расчёта
  // косточек на лету (лояльность, викторина, шахматы и т.п.) без хардкода
  // на фронтенде.
  router.get('/api/settings/discounts', (req, res, ctx) => {
    sendJson(res, 200, getDiscountSettings());
  });
}

module.exports = { registerSettingsRoutes };
