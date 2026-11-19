'use strict';

// Deadline-driven reservation reconciliation. An idle storefront has no
// 15-second polling or background SQLite worker churn.
// Delay importing the real database until the production scheduler actually
// needs it. Test harnesses pass an in-memory database without side effects.

const IDLE_RECHECK_MS = 5 * 60 * 1000;
const OVERDUE_RETRY_MS = 30 * 1000;
const FIRST_RUN_MS = 3000;
const EXPIRY_CUSHION_MS = 1000;

function earliestActiveReservationExpiry(database) {
  // Existing idx_orders_active_reservations supports the MIN deadline lookup;
  // read only one value, never load customers, items or the order history.
  return database.prepare(
    "SELECT MIN(reservation_expires_at) AS expiry FROM orders " +
    "WHERE reservation_status='active' AND status='pending' " +
    "AND reservation_expires_at IS NOT NULL"
  ).get()?.expiry || null;
}

function parseReservationExpiry(expiry) {
  return Date.parse(String(expiry).replace(' ', 'T') + 'Z');
}

function hasOverdueReservation(nowMs = Date.now(), database = require('./db')) {
  const expiry = earliestActiveReservationExpiry(database);
  if (!expiry) return false;
  const expiresAt = parseReservationExpiry(expiry);
  // An unreadable legacy deadline is safer to reconcile than to ignore.
  return !Number.isFinite(expiresAt) || expiresAt <= nowMs;
}

function nextReservationCleanupDelay(nowMs = Date.now(), database = require('./db')) {
  const expiry = earliestActiveReservationExpiry(database);
  if (!expiry) return IDLE_RECHECK_MS;
  const expiresAt = parseReservationExpiry(expiry);
  if (!Number.isFinite(expiresAt)) return OVERDUE_RETRY_MS;
  // An overdue payment must be checked with YooKassa. If it cannot be safely
  // cancelled, retry later rather than burning API requests every second.
  if (expiresAt <= nowMs) return OVERDUE_RETRY_MS;
  return Math.max(1000, Math.min(IDLE_RECHECK_MS,
    expiresAt - nowMs + EXPIRY_CUSHION_MS));
}

function createReservationCleanupScheduler({
  database = require('./db'),
  run,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
  onError = error => console.warn('[reservations] Ошибка планировщика сверки:',error.message),
} = {}) {
  if (typeof run !== 'function') throw new TypeError('Reservation cleanup job is required');
  let started = false;
  let running = false;
  let timer = null;
  let dueAt = Infinity;

  function schedule(delayMs) {
    if (!started) return;
    const delay = Math.max(0, Math.round(delayMs));
    const due = now() + delay;
    if (timer && dueAt <= due) return;
    if (timer) clearTimer(timer);
    dueAt = due;
    timer = setTimer(() => {
      timer = null;
      dueAt = Infinity;
      void tick();
    }, delay);
    timer?.unref?.();
  }
  function calculateDelay() {
    try {
      return nextReservationCleanupDelay(now(), database);
    } catch (error) {
      onError(error);
      return OVERDUE_RETRY_MS;
    }
  }
  async function tick() {
    if (!started || running) return;
    running = true;
    try {
      // A healthy empty store otherwise spawned a fresh SQLite reader worker
      // at boot and every five minutes without a single expired reservation.
      // Keep the worker for overdue or unparseable deadlines only.
      if (hasOverdueReservation(now(), database)) await run();
    } catch (error) {
      onError(error);
    } finally {
      running = false;
      // Includes any new checkout started while the preceding scan was busy.
      if (started) schedule(calculateDelay());
    }
  }
  return {
    start() {
      if (started) return;
      started = true;
      schedule(FIRST_RUN_MS); // Restore overdue reservations after a restart.
    },
    wake() {
      if (started && !running) schedule(calculateDelay());
      // A running scan always replans at completion.
    },
    stop() {
      started = false;
      if (timer) clearTimer(timer);
      timer = null;
      dueAt = Infinity;
    },
  };
}

module.exports = {
  IDLE_RECHECK_MS,
  OVERDUE_RETRY_MS,
  FIRST_RUN_MS,
  EXPIRY_CUSHION_MS,
  nextReservationCleanupDelay,
  hasOverdueReservation,
  createReservationCleanupScheduler,
};
