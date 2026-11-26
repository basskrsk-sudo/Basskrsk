// routes-news.js — новости/обновления для кабинетов партнёров и менеджеров,
// публикуются из админки.
'use strict';

const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireAuth } = require('./routes-auth');
const PUBLIC_NEWS_TTL_MS = 60 * 1000;
// Public news is empty in current production; the homepage still requests
// the endpoint on every visit. Cache even empty lists and invalidate them
// immediately on admin edits instead of hitting slow /data for each visitor.
function createPublicNewsCache(load, {clock=Date.now,ttlMs=PUBLIC_NEWS_TTL_MS}={}) {
  if(typeof load!=='function'||!Number.isFinite(ttlMs)||ttlMs<=0)
    throw new TypeError('News cache requires a loader and positive TTL');
  let cached=null,expiresAt=0;
  return {
    get() {
      const now=clock();
      if(cached!==null&&now<expiresAt)return cached;
      const fresh=load();
      if(!Array.isArray(fresh))throw new TypeError('Public news loader must return rows');
      cached=fresh;
      expiresAt=now+ttlMs;
      return fresh;
    },
    invalidate(){cached=null;expiresAt=0;},
  };
}
const publicNewsCache=createPublicNewsCache(()=>db.prepare(
  "SELECT id, title, body, created_at FROM news WHERE active = 1 AND target_role = 'public' ORDER BY id DESC LIMIT 10"
).all());

// Company announcements are shared by audience, not by user. Keep caches
// independent so partner-only news cannot leak into the manager response.
function createStaffNewsCaches(load,options={}) {
  const roles=['partner','manager','admin'];
  const caches=new Map(roles.map(role=>[role,createPublicNewsCache(()=>load(role),options)]));
  return {
    get(role) {
      if(!caches.has(role))throw new Error('Unknown news audience');
      return caches.get(role).get();
    },
    invalidate(){for(const cache of caches.values())cache.invalidate();},
  };
}
const staffNewsCaches=createStaffNewsCaches(role=>role==='admin'
  ? db.prepare("SELECT * FROM news WHERE active = 1 ORDER BY id DESC LIMIT 30").all()
  : db.prepare("SELECT * FROM news WHERE active = 1 AND (target_role = 'all' OR target_role = ?) ORDER BY id DESC LIMIT 30").all(role));

function registerNewsRoutes(router) {
  // GET /api/news/public — публично, без авторизации, для главной страницы сайта
  router.get('/api/news/public', (req, res, ctx) => {
    sendJson(res, 200, { news: publicNewsCache.get() });
  });

  // GET /api/news — свои новости для партнёра/менеджера (target_role = его роль ИЛИ 'all')
  router.get('/api/news', (req, res, ctx) => {
    const payload = requireAuth(['partner', 'manager', 'admin'])(req, res, ctx);
    if (!payload) return;
    sendJson(res, 200, { news: staffNewsCaches.get(payload.role) });
  });

  // GET /api/news/admin — все новости (включая отключённые) для управления
  router.get('/api/news/admin', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const rows = db.prepare('SELECT * FROM news ORDER BY id DESC').all();
    sendJson(res, 200, { news: rows });
  });

  // POST /api/news — админ публикует новость
  router.post('/api/news', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const { title, body, target_role } = ctx.body || {};
    if (!title || !title.trim()) return sendJson(res, 400, { error: 'Укажите заголовок' });
    const role = ['all', 'partner', 'manager', 'public'].includes(target_role) ? target_role : 'all';
    const info = db.prepare('INSERT INTO news (title, body, target_role, active) VALUES (?, ?, ?, 1)')
      .run(title.trim(), body || null, role);
    publicNewsCache.invalidate();
    staffNewsCaches.invalidate();
    sendJson(res, 201, { ok: true, id: info.lastInsertRowid });
  });

  // PUT /api/news/:id — включить/отключить или отредактировать
  router.put('/api/news/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const existing = db.prepare('SELECT * FROM news WHERE id = ?').get(ctx.params.id);
    if (!existing) return sendJson(res, 404, { error: 'Новость не найдена' });
    const { active, title, body, target_role } = ctx.body || {};
    db.prepare('UPDATE news SET active=?, title=?, body=?, target_role=? WHERE id=?').run(
      active !== undefined ? (active ? 1 : 0) : existing.active,
      title !== undefined ? title : existing.title,
      body !== undefined ? body : existing.body,
      target_role !== undefined ? target_role : existing.target_role,
      ctx.params.id
    );
    publicNewsCache.invalidate();
    staffNewsCaches.invalidate();
    sendJson(res, 200, { ok: true });
  });

  // DELETE /api/news/:id
  router.delete('/api/news/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    db.prepare('DELETE FROM news WHERE id = ?').run(ctx.params.id);
    publicNewsCache.invalidate();
    staffNewsCaches.invalidate();
    sendJson(res, 200, { ok: true });
  });
}

module.exports = { registerNewsRoutes, createPublicNewsCache, createStaffNewsCaches, PUBLIC_NEWS_TTL_MS };
