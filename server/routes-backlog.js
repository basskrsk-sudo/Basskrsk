// routes-backlog.js — просмотр продуктового и бизнес-бэклога из админки.
// Канонические данные лежат в backlog.json рядом с package.json, поэтому
// их можно менять в следующем релизе без миграций рабочей базы.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sendJson } = require('./http-utils');
const { requireAuth } = require('./routes-auth');

const BACKLOG_FILE = path.join(__dirname, '..', 'backlog.json');

function loadBacklog() {
  const parsed = JSON.parse(fs.readFileSync(BACKLOG_FILE, 'utf8'));
  if (!parsed || !Array.isArray(parsed.items)) {
    throw new Error('Некорректный формат backlog.json');
  }
  return parsed;
}

function registerBacklogRoutes(router) {
  router.get('/api/backlog', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    try {
      sendJson(res, 200, loadBacklog());
    } catch (error) {
      console.error('[backlog] Не удалось прочитать backlog.json:', error);
      sendJson(res, 500, { error: 'Не удалось загрузить бэклог' });
    }
  });
}

module.exports = { registerBacklogRoutes, loadBacklog };
