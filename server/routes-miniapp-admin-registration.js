'use strict';

// Canonical, privacy-minimal choices for network registrations from the
// Telegram administrator Mini App. Never trust IDs offered by the client:
// POST routes independently validate current roles and point assignments.
const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireActiveAdmin } = require('./routes-auth');

function registerMiniAppAdminRegistrationRoutes(router) {
  router.get('/api/miniapp/admin/registration-options', (req, res, ctx) => {
    if (!requireActiveAdmin(req, res, ctx)) return;
    const cities = db.prepare(
      'SELECT id,name FROM cities WHERE active = 1 ORDER BY name COLLATE NOCASE'
    ).all();
    const managers = db.prepare(
      'SELECT id,full_name,mgr_code,city_id FROM managers WHERE active = 1 ORDER BY full_name COLLATE NOCASE,id'
    ).all();
    const points = db.prepare(`
      SELECT p.id,p.name,p.addr,p.icon,p.city_id,p.manager_id,
             EXISTS (SELECT 1 FROM salon_owners o WHERE o.point_id = p.id) AS has_owner
      FROM points p
      WHERE p.active = 1 AND COALESCE(p.is_hub,0) = 0
      ORDER BY p.name COLLATE NOCASE,p.id
    `).all();
    const groomers = db.prepare(`
      SELECT g.id,g.point_id,g.full_name
      FROM partners g JOIN points p ON p.id = g.point_id
      WHERE g.active = 1 AND p.active = 1 AND COALESCE(p.is_hub,0) = 0
      ORDER BY g.full_name COLLATE NOCASE,g.id
    `).all();
    sendJson(res, 200, {
      cities, managers,
      points: points.map(({has_owner, ...point}) => point),
      owner_points: points.filter(p => !p.has_owner).map(({has_owner, ...point}) => point),
      groomers,
      referral_leads: require('./referral-program').referralLeadOptions(null,null),
    });
  });
}

module.exports = { registerMiniAppAdminRegistrationRoutes };
