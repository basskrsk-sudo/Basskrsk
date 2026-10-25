// routes-reviews.js — отзывы и звёздные оценки товаров: публичный просмотр,
// оставление/редактирование отзыва клиентом (с модерацией), и админка-модерация.
'use strict';

const db = require('./db');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { sendJson } = require('./http-utils');
const { requireAuth, tryAuth } = require('./routes-auth');


// Photos are deliberately stored outside public/ and served only when a review is
// approved (or when the requester is an administrator). No unaudited uploads.
const REVIEW_PHOTO_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'review-photos');
const PHOTO_NAME = /^review-[a-f0-9]{32}\.webp$/;
const PHOTO_LIMIT = 3;
const PHOTO_MAX_BYTES = 4 * 1024 * 1024;
const PHOTO_DISK_CAP = Math.max(100, Number(process.env.REVIEW_PHOTO_STORAGE_LIMIT_MB) || 1024) * 1024 * 1024;

function storedPhotos(raw) {
  try {
    const photos = JSON.parse(raw || '[]');
    return Array.isArray(photos) ? photos.filter(x => typeof x === 'string' && PHOTO_NAME.test(x)).slice(0, PHOTO_LIMIT) : [];
  } catch (_) { return []; }
}
function photoUrls(raw) {
  return storedPhotos(raw).map(name => '/api/reviews/photo/' + name);
}
function removePhotos(files) {
  for (const name of files) {
    if (PHOTO_NAME.test(name)) {
      try { fs.unlinkSync(path.join(REVIEW_PHOTO_DIR, name)); } catch (_) {}
    }
  }
}
function photoInputError(message, code = 400) {
  const err = new Error(message);
  err.statusCode = code;
  return err;
}
function saveReviewPhotos(photos) {
  if (!Array.isArray(photos) || photos.length > PHOTO_LIMIT) {
    throw photoInputError('Можно добавить не более 3 фотографий к отзыву.');
  }
  if (!photos.length) return [];
  fs.mkdirSync(REVIEW_PHOTO_DIR, { recursive: true });
  // No database blobs: images are compressed to WebP in the persistent storage.
  let existingBytes = fs.readdirSync(REVIEW_PHOTO_DIR).filter(name => PHOTO_NAME.test(name))
    .reduce((sum, name) => {
      try { return sum + fs.statSync(path.join(REVIEW_PHOTO_DIR, name)).size; } catch (_) { return sum; }
    }, 0);
  const saved = [];
  try {
    for (const input of photos) {
      if (typeof input !== 'string' || input.length > 5_700_000) {
        throw photoInputError('Фотография слишком большая. Максимум 4 МБ.');
      }
      const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(input);
      if (!match) throw photoInputError('Разрешены только фотографии JPG, PNG и WebP.');
      const bytes = Buffer.from(match[2], 'base64');
      if (!bytes.length || bytes.length > PHOTO_MAX_BYTES) {
        throw photoInputError('Фотография должна быть не больше 4 МБ.');
      }
      const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
      if (!(match[1] === 'jpeg' && jpeg || match[1] === 'png' && png || match[1] === 'webp' && webp)) {
        throw photoInputError('Формат фотографии не соответствует содержимому файла.');
      }
      const id = crypto.randomBytes(16).toString('hex');
      const temp = path.join(REVIEW_PHOTO_DIR, 'temp-' + id + '.' + (match[1] === 'jpeg' ? 'jpg' : match[1]));
      const name = 'review-' + id + '.webp';
      const dest = path.join(REVIEW_PHOTO_DIR, name);
      try {
        fs.writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
        const args = ['-limit', 'memory', '64MiB', '-limit', 'map', '128MiB',
          temp, '-auto-orient', '-strip', '-resize', '1280x1280>', '-quality', '80', dest];
        try { execFileSync('magick', args, { timeout: 25000, maxBuffer: 65536 }); }
        catch (err) {
          if (err.code !== 'ENOENT') throw err;
          execFileSync('convert', args, { timeout: 25000, maxBuffer: 65536 });
        }
        const size = fs.statSync(dest).size;
        if (!size || existingBytes + size > PHOTO_DISK_CAP) {
          throw photoInputError('Хранилище фотографий заполнено.', 507);
        }
        existingBytes += size;
        saved.push(name);
      } catch (err) {
        try { fs.unlinkSync(dest); } catch (_) {}
        if (err.statusCode) throw err;
        console.warn('Не удалось обработать фотографию отзыва:', err.message);
        throw photoInputError('Не удалось обработать фотографию. Используйте JPG, PNG или WebP.', 415);
      } finally {
        try { fs.unlinkSync(temp); } catch (_) {}
      }
    }
    return saved;
  } catch (err) {
    removePhotos(saved);
    throw err;
  }
}
function getSubmittedPhotos(body) {
  if (!Object.prototype.hasOwnProperty.call(body || {}, 'photos')) return null;
  if (!Array.isArray(body.photos)) throw photoInputError('Некорректный список фотографий.');
  return body.photos.length ? saveReviewPhotos(body.photos) : null;
}
function serveReviewPhoto(req, res, filename) {
  if (!PHOTO_NAME.test(filename)) return sendJson(res, 404, { error: 'Фото не найдено' });
  // JSON1 searches individual array members, not vulnerable LIKE matches.
  const published = db.prepare(
    "SELECT 1 AS found FROM product_reviews r, json_each(r.photos_json) p WHERE r.status='approved' AND p.value=? " +
    "UNION ALL SELECT 1 FROM guest_product_reviews r, json_each(r.photos_json) p WHERE r.status='approved' AND p.value=? LIMIT 1"
  ).get(filename, filename);
  const isAdmin = !!tryAuth(['admin'])(req);
  if (!published && !isAdmin) return sendJson(res, 404, { error: 'Фото не найдено' });
  // Admins may only view images belonging to a review. No arbitrary file reads.
  if (!published) {
    const exists = db.prepare(
      "SELECT 1 AS found FROM product_reviews r, json_each(r.photos_json) p WHERE p.value=? " +
      "UNION ALL SELECT 1 FROM guest_product_reviews r, json_each(r.photos_json) p WHERE p.value=? LIMIT 1"
    ).get(filename, filename);
    if (!exists) return sendJson(res, 404, { error: 'Фото не найдено' });
  }
  const file = path.join(REVIEW_PHOTO_DIR, filename);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'Фото не найдено' });
    res.writeHead(200, {
      'Content-Type': 'image/webp',
      'Content-Length': st.size,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': published ? 'public, max-age=600' : 'private, no-store',
    });
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

// Средний рейтинг и число отзывов — только по одобренным (не показываем
// сырые/непроверенные цифры публично). Используется и в карточке товара,
// и в каталоге/на главной для маленького бейджа со звёздами.
function getReviewSummary(productId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS cnt, AVG(rating) AS avg
    FROM (SELECT rating FROM product_reviews WHERE product_id = ? AND status = 'approved' UNION ALL SELECT rating FROM guest_product_reviews WHERE product_id = ? AND status = 'approved')
  `).get(productId,productId);
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
  router.get('/api/reviews/photo/:filename', (req, res, ctx) => serveReviewPhoto(req, res, ctx.params.filename));
  // GET /api/products/:id/reviews — публичный список одобренных отзывов + агрегат
  router.get('/api/products/:id/reviews', (req, res, ctx) => {
    const productId = parseInt(ctx.params.id, 10);
    if (!productId) return sendJson(res, 400, { error: 'Некорректный id товара' });

    const product = db.prepare('SELECT id, name FROM products WHERE id = ?').get(productId);
    if (!product) return sendJson(res, 404, { error: 'Товар не найден' });

    const payload = tryAuth(['customer'])(req);
    const rows = db.prepare(`
      SELECT r.id, r.rating, r.text, r.created_at, r.customer_id, r.photos_json,
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
      photos: photoUrls(r.photos_json),
    }));

    const guestRows = db.prepare("SELECT id,author_name,rating,text,created_at,photos_json FROM guest_product_reviews WHERE product_id=? AND status='approved' ORDER BY created_at DESC").all(productId);
    reviews.push(...guestRows.map(r=>({id:'g'+r.id,rating:r.rating,text:r.text,created_at:r.created_at,author:r.author_name,verified_purchase:false,is_own:false,photos:photoUrls(r.photos_json)})));
    reviews.sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
    // Свой отзыв (даже на модерации) клиент должен видеть у себя в карточке —
    // иначе кажется, что он потерялся. Публично он не в списке выше, только у автора.
    let ownPending = null;
    if (payload) {
      const own = db.prepare(`
        SELECT id, rating, text, status, photos_json FROM product_reviews WHERE product_id = ? AND customer_id = ?
      `).get(productId, payload.id);
      if (own && own.status !== 'approved') ownPending = { ...own, photos: photoUrls(own.photos_json), photos_json: undefined };
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

    const existing = db.prepare('SELECT id,photos_json FROM product_reviews WHERE product_id = ? AND customer_id = ?').get(productId, payload.id);
    let addedPhotos;
    try { addedPhotos = getSubmittedPhotos(ctx.body || {}); }
    catch (err) { return sendJson(res, err.statusCode || 400, { error: err.message }); }
    try {
      if (existing) {
        const nextPhotos = addedPhotos || storedPhotos(existing.photos_json);
        db.prepare("UPDATE product_reviews SET rating = ?, text = ?, photos_json=?, status = 'pending', created_at = datetime('now') WHERE id = ?")
          .run(ratingNum, cleanText, JSON.stringify(nextPhotos), existing.id);
        if (addedPhotos) removePhotos(storedPhotos(existing.photos_json));
        return sendJson(res, 200, { ok: true, updated: true, message: 'Отзыв и фотографии отправлены на повторную проверку.' });
      }
      db.prepare("INSERT INTO product_reviews (product_id,customer_id,rating,text,photos_json,status) VALUES (?,?,?,?,?,'pending')")
        .run(productId, payload.id, ratingNum, cleanText, JSON.stringify(addedPhotos || []));
      return sendJson(res, 201, { ok: true, message: 'Спасибо! Отзыв с фотографиями появится на сайте после проверки.' });
    } catch (err) {
      if (addedPhotos) removePhotos(addedPhotos);
      console.error('Ошибка сохранения отзыва:', err.message);
      return sendJson(res, 500, { error: 'Не удалось сохранить отзыв.' });
    }
  });

  // Анонимный отзыв: имя + текст, оценка, ловушка для ботов, лимиты по IP.
  router.post('/api/products/:id/guest-reviews',(req,res,ctx)=>{
    const productId=Number(ctx.params.id),b=ctx.body||{};
    if(!Number.isSafeInteger(productId)||productId<=0)return sendJson(res,400,{error:'Некорректный товар'});
    const product=db.prepare('SELECT id FROM products WHERE id=? AND active=1 AND archived_at IS NULL').get(productId);
    if(!product)return sendJson(res,404,{error:'Товар недоступен'});
    if(String(b.website||'').trim())return sendJson(res,200,{ok:true,message:'Отзыв отправлен на модерацию.'});
    const author=String(b.author_name||'').trim().replace(/\\s+/g,' ').slice(0,70);
    const reviewText=String(b.text||'').trim().slice(0,2000);
    const rating=Number(b.rating);
    if(author.length<2||reviewText.length<15||!Number.isInteger(rating)||rating<1||rating>5)
      return sendJson(res,400,{error:'Укажите имя, оценку и отзыв от 15 символов'});
    const origin=String(req.headers.origin||'');
    const host=String(req.headers.host||'').toLowerCase();
    if(origin){try{if(new URL(origin).host.toLowerCase()!==host)return sendJson(res,403,{error:'Недопустимый источник запроса'});}catch(e){return sendJson(res,403,{error:'Недопустимый источник запроса'});}}
    const forwarded=String(req.headers['x-forwarded-for']||'').split(',')[0].trim();
    const ip=forwarded||req.socket.remoteAddress||'unknown';
    const visitor=crypto.createHash('sha256').update(ip+'|'+(process.env.REVIEW_SPAM_SECRET||process.env.SESSION_SECRET||'review-public-rate') ).digest('hex');
    const recent=db.prepare("SELECT COUNT(*) AS n FROM guest_product_reviews WHERE visitor_hash=? AND created_at>=datetime('now','-24 hours')").get(visitor).n;
    const same=db.prepare("SELECT 1 FROM guest_product_reviews WHERE visitor_hash=? AND product_id=? AND created_at>=datetime('now','-30 days')").get(visitor,productId);
    if(recent>=3||same)return sendJson(res,429,{error:'Отзыв уже отправлен или превышен лимит. Попробуйте позже.'});
    let addedPhotos;
    try { addedPhotos = getSubmittedPhotos(b); }
    catch (err) { return sendJson(res, err.statusCode || 400, { error: err.message }); }
    try {
      db.prepare("INSERT INTO guest_product_reviews(product_id,author_name,rating,text,visitor_hash,photos_json,status) VALUES (?,?,?,?,?,?,'pending')").run(productId,author,rating,reviewText,visitor,JSON.stringify(addedPhotos || []));
      sendJson(res,201,{ok:true,message:'Спасибо! Отзыв и фотографии появятся после проверки модератором.'});
    } catch (err) {
      if (addedPhotos) removePhotos(addedPhotos);
      console.error('Ошибка сохранения гостевого отзыва:', err.message);
      sendJson(res,500,{error:'Не удалось сохранить отзыв.'});
    }
  });

  // DELETE /api/products/:id/reviews/me — клиент удаляет свой отзыв
  router.delete('/api/products/:id/reviews/me', (req, res, ctx) => {
    const payload = requireAuth(['customer'])(req, res, ctx);
    if (!payload) return;
    const productId = parseInt(ctx.params.id, 10);
    if (!productId) return sendJson(res, 400, { error: 'Некорректный id товара' });
    const old = db.prepare('SELECT photos_json FROM product_reviews WHERE product_id = ? AND customer_id = ?').get(productId, payload.id);
    db.prepare('DELETE FROM product_reviews WHERE product_id = ? AND customer_id = ?').run(productId, payload.id);
    if (old) removePhotos(storedPhotos(old.photos_json));
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
    const guest=db.prepare(status==='all' ?
      "SELECT g.id,g.product_id,g.author_name AS customer_name,NULL AS customer_phone,g.rating,g.text,g.photos_json,g.status,g.created_at,p.name AS product_name FROM guest_product_reviews g JOIN products p ON p.id=g.product_id ORDER BY g.created_at DESC" :
      "SELECT g.id,g.product_id,g.author_name AS customer_name,NULL AS customer_phone,g.rating,g.text,g.photos_json,g.status,g.created_at,p.name AS product_name FROM guest_product_reviews g JOIN products p ON p.id=g.product_id WHERE g.status=? ORDER BY g.created_at DESC").all(...(status==='all'?[]:[status]));
    const combined=[...rows.map(r=>({...r,photos:photoUrls(r.photos_json),photos_json:undefined,guest:false})),...guest.map(r=>({...r,photos:photoUrls(r.photos_json),photos_json:undefined,guest:true}))].sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
    sendJson(res, 200, { reviews: combined });
  });

  // PUT /api/admin/reviews/:id — одобрить/отклонить/вернуть на проверку
  router.put('/api/admin/reviews/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const { status } = ctx.body || {};
    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return sendJson(res, 400, { error: 'Некорректный статус' });
    }
    const guest=!!ctx.body?.guest;
    const table=guest?'guest_product_reviews':'product_reviews';
    const existing=db.prepare('SELECT id FROM '+table+' WHERE id=?').get(ctx.params.id);
    if (!existing) return sendJson(res, 404, { error: 'Отзыв не найден' });
    db.prepare('UPDATE '+table+' SET status = ? WHERE id = ?').run(status, ctx.params.id);
    sendJson(res, 200, { ok: true });
  });

  // DELETE /api/admin/reviews/:id — удалить отзыв полностью (спам, мат и т.п.)
  router.delete('/api/admin/reviews/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const table=ctx.query?.guest==='1'?'guest_product_reviews':'product_reviews';
    const old = db.prepare('SELECT photos_json FROM '+table+' WHERE id = ?').get(ctx.params.id);
    db.prepare('DELETE FROM '+table+' WHERE id = ?').run(ctx.params.id);
    if (old) removePhotos(storedPhotos(old.photos_json));
    sendJson(res, 200, { ok: true });
  });
}

module.exports = { registerReviewRoutes, getReviewSummary };
