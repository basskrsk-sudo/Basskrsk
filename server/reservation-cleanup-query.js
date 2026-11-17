'use strict';

// Pure SQL shared by the app and the dedicated read-only worker.
// Do not import db.js here: that module runs migrations on initialization.
const EXPIRED_RESERVATIONS_BATCH_SQL = [
  "SELECT id, order_code, yookassa_payment_id FROM orders",
  "WHERE status = 'pending' AND reservation_status = 'active'",
  "AND reservation_expires_at IS NOT NULL",
  "AND reservation_expires_at <= datetime('now') AND id > ?",
  "ORDER BY id ASC LIMIT ?",
].join(' ');
module.exports = { EXPIRED_RESERVATIONS_BATCH_SQL };
