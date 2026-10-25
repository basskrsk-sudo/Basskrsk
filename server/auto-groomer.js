'use strict';

// Rules for assigning a groomer when a customer did not select anybody.
// The server remains authoritative: the public form only displays the resolved default.
const db = require('./db');

function normalizedPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 11 && /^[78]/.test(digits)) return digits.slice(1);
  return null;
}

function findDefaultGroomer(pointId) {
  if (!pointId) return { partner: null, source: null };
  const partners = db.prepare(
    'SELECT id,point_id,full_name,phone,commission_rate FROM partners ' +
    'WHERE point_id=? AND active=1 ORDER BY id'
  ).all(pointId);

  if (partners.length === 1) {
    return { partner: partners[0], source: 'auto_single' };
  }
  if (partners.length < 2) return { partner: null, source: null };

  const owner = db.prepare(
    'SELECT id,phone,groomer_partner_id FROM salon_owners ' +
    'WHERE point_id=? AND active=1 ORDER BY id LIMIT 1'
  ).get(pointId);
  if (!owner) return { partner: null, source: null };

  if (owner.groomer_partner_id != null) {
    const selected = partners.find(p => Number(p.id) === Number(owner.groomer_partner_id));
    // If an explicitly linked groomer was moved/deactivated, do not silently
    // pay another partner. An admin must repair the association.
    return { partner: selected || null, source: selected ? 'auto_owner_link' : null };
  }

  const phone = normalizedPhone(owner.phone);
  if (!phone) return { partner: null, source: null };
  const matching = partners.filter(p => normalizedPhone(p.phone) === phone);
  return {
    partner: matching.length === 1 ? matching[0] : null,
    source: matching.length === 1 ? 'auto_owner_phone' : null,
  };
}

function validateOwnerGroomer(pointId, partnerId) {
  if (partnerId == null || partnerId === '') return { valid: true, id: null };
  const id = Number(partnerId);
  if (!Number.isSafeInteger(id) || id < 1 || !pointId) {
    return { valid: false, error: 'Выберите существующую точку и её грумера-владельца.' };
  }
  const linked = db.prepare(
    'SELECT id FROM partners WHERE id=? AND point_id=? AND active=1'
  ).get(id,pointId);
  if (!linked) {
    return { valid: false, error: 'Выбранный грумер неактивен или работает на другой точке.' };
  }
  return { valid: true, id };
}

function resolveCheckoutGroomer({ pointId, partnerId, advisorSelection,
  selfOrderingPartner, fulfillmentType }) {
  if (fulfillmentType !== 'pickup') {
    return { id: null, name: null, source: null };
  }
  // Genuine self-orders take precedence over all selection options.
  if (selfOrderingPartner) {
    return { id: selfOrderingPartner.id,
      name: selfOrderingPartner.full_name, source: 'self_order' };
  }
  if (partnerId) {
    const selected = db.prepare(
      'SELECT id,point_id,full_name FROM partners WHERE id=? AND active=1'
    ).get(partnerId);
    if (!selected || !pointId || String(selected.point_id) !== String(pointId)) {
      const error = new Error('Выбранный сотрудник не работает на этой точке');
      error.code = 'PARTNER_POINT_MISMATCH';
      throw error;
    }
    return { id: selected.id, name: selected.full_name, source: 'selected' };
  }
  if (advisorSelection === 'self') {
    return { id: null, name: null, source: 'self' };
  }
  const auto = findDefaultGroomer(pointId);
  if (auto.partner) {
    return { id: auto.partner.id, name: auto.partner.full_name, source: auto.source };
  }
  if (pointId && db.prepare(
    'SELECT 1 FROM partners WHERE point_id=? AND active=1 LIMIT 1'
  ).get(pointId)) {
    const error = new Error(
      'Не удалось автоматически определить грумера-владельца салона. Выберите грумера или «Выбрал всё сам».'
    );
    error.code = 'ADVISOR_SELECTION_REQUIRED';
    throw error;
  }
  return { id: null, name: null, source: null };
}

module.exports = { findDefaultGroomer, validateOwnerGroomer, normalizedPhone, resolveCheckoutGroomer };
