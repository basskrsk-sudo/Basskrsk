// routes-backlog.js — просмотр продуктового и бизнес-бэклога из админки.
// Канонические данные лежат в backlog.json рядом с package.json, поэтому
// их можно менять в следующем релизе без миграций рабочей базы.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sendJson } = require('./http-utils');
const { requireAuth } = require('./routes-auth');
const db = require('./db');

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
      const backlog = loadBacklog();
      const titles = new Set(backlog.items.map((item) => item.title));
      const rows = db.prepare(`SELECT id, category, title, note FROM launch_tasks
        WHERE done = 0 AND category IN ('Безопасность', 'Технический долг', 'Платежи', 'Юридическое', 'Развитие сети')
        ORDER BY category, sort_order`).all();
      const legacy_items = rows.filter((row) => !titles.has(row.title)).map((row) => ({
        id: 'launch-' + row.id, category: row.category, title: row.title,
        summary: row.note || '', status_label: 'Открытая задача плана запуска',
      }));
      sendJson(res, 200, { ...backlog, legacy_items });
    } catch (error) {
      console.error('[backlog] Не удалось прочитать backlog.json:', error);
      sendJson(res, 500, { error: 'Не удалось загрузить бэклог' });
    }
  });
}

module.exports = { registerBacklogRoutes, loadBacklog };
