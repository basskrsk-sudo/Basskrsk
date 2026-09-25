// routes-reviews.js — отзывы и звёздные оценки товаров: публичный просмотр,
// оставление/редактирование отзыва клиентом (с модерацией), и админка-модерация.
'use strict';

const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireAuth, tryAuth } = require('./routes-auth');

// Средний рейтинг и число отзывов — только по одобренным (не показываем
// сырые/непроверенные цифры публично). Используется и в карточке товара,
// и в каталоге/на главной для маленького бейджа со звёздами.
function getReviewSummary(productId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS cnt, AVG(rating) AS avg
    FROM product_reviews WHERE product_id = ? AND status = 'approved'
  `).get(productId);
  return {
    review_count: row.cnt || 0,
    review_avg: row.cnt ? Math.round(row.avg * 10) / 10 : null,
  };
}

// «Подтверждённая покупка» — реально ли этот телефон заказывал этот товар
// (по названию: order_items хранит name текстом, а не product_id, т.к. там
// же лежат и вручную вписанные позиции без товара в каталоге).
function hasVerifiedPurchase(customerPhone, productName) {
  if (!customerPhone || !productName) return false;
  const row = db.prepare(`
    SELECT 1 FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    WHERE o.customer_phone = ? AND oi.name = ? AND o.status = 'paid'
    LIMIT 1
  `).get(customerPhone, productName);
  return !!row;
}

function registerReviewRoutes(router) {
  // GET /api/products/:id/reviews — публичный список одобренных отзывов + агрегат
  router.get('/api/products/:id/reviews', (req, res, ctx) => {
    const productId = parseInt(ctx.params.id, 10);
    if (!productId) return sendJson(res, 400, { error: 'Некорректный id товара' });

    const product = db.prepare('SELECT id, name FROM products WHERE id = ?').get(productId);
    if (!product) return sendJson(res, 404, { error: 'Товар не найден' });

    const payload = tryAuth(['customer'])(req);
    const rows = db.prepare(`
      SELECT r.id, r.rating, r.text, r.created_at, r.customer_id,
             c.name AS customer_name, c.phone AS customer_phone
      FROM product_reviews r
      JOIN customers c ON c.id = r.customer_id
      WHERE r.product_id = ? AND r.status = 'approved'
      ORDER BY r.created_at DESC
    `).all(productId);

    const reviews = rows.map((r) => ({
      id: r.id,
      rating: r.rating,
      text: r.text,
      created_at: r.created_at,
      author: r.customer_name || 'Покупатель',
      verified_purchase: hasVerifiedPurchase(r.customer_phone, product.name),
      is_own: !!(payload && payload.id === r.customer_id),
    }));

    // Свой отзыв (даже на модерации) клиент должен видеть у себя в карточке —
    // иначе кажется, что он потерялся. Публично он не в списке выше, только у автора.
    let ownPending = null;
    if (payload) {
      const own = db.prepare(`
        SELECT id, rating, text, status FROM product_reviews WHERE product_id = ? AND customer_id = ?
      `).get(productId, payload.id);
      if (own && own.status !== 'approved') ownPending = own;
    }

    sendJson(res, 200, { reviews, summary: getReviewSummary(productId), own_pending: ownPending });
  });

  // POST /api/products/:id/reviews — оставить/обновить свой отзыв (нужен вход в кабинет клиента)
  router.post('/api/products/:id/reviews', (req, res, ctx) => {
    const payload = requireAuth(['customer'])(req, res, ctx);
    if (!payload) return;
    const productId = parseInt(ctx.params.id, 10);
    if (!productId) return sendJson(res, 400, { error: 'Некорректный id товара' });

    const product = db.prepare('SELECT id FROM products WHERE id = ?').get(productId);
    if (!product) return sendJson(res, 404, { error: 'Товар не найден' });

    const { rating, text } = ctx.body || {};
    const ratingNum = parseInt(rating, 10);
    if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
      return sendJson(res, 400, { error: 'Оценка должна быть от 1 до 5 звёзд' });
    }
    const cleanText = String(text || '').trim().slice(0, 2000);

    const existing = db.prepare('SELECT id FROM product_reviews WHERE product_id = ? AND customer_id = ?').get(productId, payload.id);
    if (existing) {
      // Изменённый текст/оценка уходят на повторную модерацию — старое одобрение
      // не гарантирует, что новое содержимое всё ещё уместно.
      db.prepare("UPDATE product_reviews SET rating = ?, text = ?, status = 'pending', created_at = datetime('now') WHERE id = ?")
        .run(ratingNum, cleanText, existing.id);
      return sendJson(res, 200, { ok: true, updated: true, message: 'Отзыв обновлён и отправлен на повторную проверку.' });
    }

    db.prepare("INSERT INTO product_reviews (product_id, customer_id, rating, text, status) VALUES (?, ?, ?, ?, 'pending')")
      .run(productId, payload.id, ratingNum, cleanText);
    sendJson(res, 201, { ok: true, message: 'Спасибо! Отзыв появится на сайте после проверки.' });
  });

  // DELETE /api/products/:id/reviews/me — клиент удаляет свой отзыв
  router.delete('/api/products/:id/reviews/me', (req, res, ctx) => {
    const payload = requireAuth(['customer'])(req, res, ctx);
    if (!payload) return;
    const productId = parseInt(ctx.params.id, 10);
    if (!productId) return sendJson(res, 400, { error: 'Некорректный id товара' });
    db.prepare('DELETE FROM product_reviews WHERE product_id = ? AND customer_id = ?').run(productId, payload.id);
    sendJson(res, 200, { ok: true });
  });

  // ── АДМИНКА: модерация отзывов ──────────────────────────────────────
  // GET /api/admin/reviews?status=pending|approved|rejected|all
  router.get('/api/admin/reviews', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const status = ctx.query.status || 'pending';
    const rows = status === 'all'
      ? db.prepare(`
          SELECT r.*, p.name AS product_name, c.name AS customer_name, c.phone AS customer_phone
          FROM product_reviews r
          JOIN products p ON p.id = r.product_id
          JOIN customers c ON c.id = r.customer_id
          ORDER BY r.created_at DESC
        `).all()
      : db.prepare(`
          SELECT r.*, p.name AS product_name, c.name AS customer_name, c.phone AS customer_phone
          FROM product_reviews r
          JOIN products p ON p.id = r.product_id
          JOIN customers c ON c.id = r.customer_id
          WHERE r.status = ?
          ORDER BY r.created_at DESC
        `).all(status);
    sendJson(res, 200, { reviews: rows });
  });

  // PUT /api/admin/reviews/:id — одобрить/отклонить/вернуть на проверку
  router.put('/api/admin/reviews/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const { status } = ctx.body || {};
    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return sendJson(res, 400, { error: 'Некорректный статус' });
    }
    const existing = db.prepare('SELECT id FROM product_reviews WHERE id = ?').get(ctx.params.id);
    if (!existing) return sendJson(res, 404, { error: 'Отзыв не найден' });
    db.prepare('UPDATE product_reviews SET status = ? WHERE id = ?').run(status, ctx.params.id);
    sendJson(res, 200, { ok: true });
  });

  // DELETE /api/admin/reviews/:id — удалить отзыв полностью (спам, мат и т.п.)
  router.delete('/api/admin/reviews/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    db.prepare('DELETE FROM product_reviews WHERE id = ?').run(ctx.params.id);
    sendJson(res, 200, { ok: true });
  });
}

module.exports = { registerReviewRoutes, getReviewSummary };
