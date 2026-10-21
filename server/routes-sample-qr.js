'use strict';
// Отдельная аналитика бесплатных пробников — не смешивается с воронкой продаж.
const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireAuth } = require('./routes-auth');

function getViewer(req, res, ctx) {
  const user = requireAuth(['admin', 'manager'])(req, res, ctx);
  if (!user) return null;
  if (user.role === 'manager' && !db.prepare('SELECT id FROM managers WHERE id = ? AND active = 1').get(user.id)) {
    sendJson(res, 403, { error: 'Менеджер больше не активен' });
    return null;
  }
  return user;
}
function viewerScope(viewer) {
  return viewer.role === 'manager' ? ['p.manager_id = ?', [viewer.id]] : ['1 = 1', []];
}
function registerSampleQrRoutes(router) {
  // QR всегда открывает страницу инструкции через этот редирект: запись
  // происходит на сервере, даже когда JS на телефоне отключён.
  router.get('/api/sample-qr/scan', (req, res, ctx) => {
    const pointId = String(ctx.query.point || '');
    if (!/^[a-z0-9_-]{1,80}$/i.test(pointId)) {
      return sendJson(res, 400, { error: 'Некорректная точка пробника' });
    }
    const point = db.prepare('SELECT id, city_id FROM points WHERE id = ? AND active = 1 AND COALESCE(is_hub, 0) = 0').get(pointId);
    if (!point) return sendJson(res, 404, { error: 'Точка не найдена или отключена' });
    db.prepare('INSERT INTO sample_qr_scans (point_id) VALUES (?)').run(point.id);
    const query = new URLSearchParams({ ref: point.id, sample: '1' });
    if (point.city_id) query.set('city', point.city_id);
    res.writeHead(302, {
      Location: '/purchase-guide.html?' + query.toString(),
      'Cache-Control': 'no-store, private',
      'Pragma': 'no-cache',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
    res.end();
  });

  router.get('/api/sample-qr/points', (req, res, ctx) => {
    const viewer = getViewer(req, res, ctx);
    if (!viewer) return;
    const [scope, params] = viewerScope(viewer);
    const points = db.prepare(`SELECT p.id, p.name, p.city_id
      FROM points p WHERE p.active = 1 AND COALESCE(p.is_hub, 0) = 0
      AND ${scope} ORDER BY p.name COLLATE NOCASE`).all(...params);
    sendJson(res, 200, { points });
  });

  router.get('/api/sample-qr/stats', (req, res, ctx) => {
    const viewer = getViewer(req, res, ctx);
    if (!viewer) return;
    const days = Number(ctx.query.days || 30);
    if (![7, 30, 90].includes(days)) return sendJson(res, 400, { error: 'Допустимый период: 7, 30 или 90 дней' });
    const point = String(ctx.query.point || '');
    if (point && !/^[a-z0-9_-]{1,80}$/i.test(point)) return sendJson(res, 400, { error: 'Некорректная точка' });
    const [scope, scopeParams] = viewerScope(viewer);
    if (point) {
      const accessible = db.prepare(`SELECT p.id FROM points p WHERE p.id = ? AND ${scope}`).get(point, ...scopeParams);
      if (!accessible) return sendJson(res, 403, { error: 'Нет доступа к точке' });
    }
    const pointSql = point ? 'AND p.id = ?' : '';
    const scopeValues = [...scopeParams, ...(point ? [point] : [])];
    const points = db.prepare(`SELECT p.id, p.name, p.active,
        COUNT(s.id) AS scans, MAX(s.created_at) AS last_scan
      FROM points p LEFT JOIN sample_qr_scans s
        ON s.point_id = p.id AND s.created_at >= datetime('now', ?)
      WHERE COALESCE(p.is_hub, 0) = 0 AND ${scope} ${pointSql}
      GROUP BY p.id, p.name, p.active ORDER BY scans DESC, p.name COLLATE NOCASE`)
      .all('-' + days + ' days', ...scopeValues);
    const daily = db.prepare(`SELECT date(s.created_at) AS day, COUNT(*) AS scans
      FROM sample_qr_scans s JOIN points p ON p.id = s.point_id
      WHERE s.created_at >= datetime('now', ?) AND COALESCE(p.is_hub, 0) = 0
        AND ${scope} ${pointSql}
      GROUP BY date(s.created_at) ORDER BY day`)
      .all('-' + days + ' days', ...scopeValues);
    sendJson(res, 200, {
      days, points, daily,
      total_scans: points.reduce((sum, row) => sum + Number(row.scans), 0),
    });
  });
}
module.exports = { registerSampleQrRoutes };
