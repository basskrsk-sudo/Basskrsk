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

function isReservationExpiryOverdue(expiry,nowMs=Date.now()){
  if(!expiry)return false;
  const expiresAt=parseReservationExpiry(expiry);
  // Legacy invalid deadlines must follow safe YooKassa reconciliation.
  return !Number.isFinite(expiresAt)||expiresAt<=nowMs;
}
function nextReservationCleanupDelayFromExpiry(expiry,nowMs=Date.now()){
  if(!expiry)return IDLE_RECHECK_MS;
  const expiresAt=parseReservationExpiry(expiry);
  if(!Number.isFinite(expiresAt)||expiresAt<=nowMs)return OVERDUE_RETRY_MS;
  return Math.max(1000,Math.min(IDLE_RECHECK_MS,
    expiresAt-nowMs+EXPIRY_CUSHION_MS));
}
function hasOverdueReservation(nowMs=Date.now(),database=require('./db')){
  return isReservationExpiryOverdue(earliestActiveReservationExpiry(database),nowMs);
}
function nextReservationCleanupDelay(nowMs=Date.now(),database=require('./db')){
  return nextReservationCleanupDelayFromExpiry(earliestActiveReservationExpiry(database),nowMs);
}

function createReservationCleanupScheduler({
  database = require('./db'),
  run,
  readExpiry = null,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
  onError = error => console.warn('[reservations] Ошибка планировщика сверки:',error.message),
} = {}) {
  if (typeof run !== 'function') throw new TypeError('Reservation cleanup job is required');
  let started = false;
  let running = false;
  let wakeRequested = false;
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
  async function tick(){
    if(!started)return;
    if(running){wakeRequested=true;return;}
    running=true;
    let expiry=null,ran=false,failed=false;
    try{
      if(readExpiry){
        // Read-only SQLite worker: even if /data stalls, checkout still runs.
        expiry=await readExpiry();
        if(!started)return;
        if(isReservationExpiryOverdue(expiry,now())){
          ran=true;
          await run();
        }
      }else if(hasOverdueReservation(now(),database)){
        ran=true;
        await run();
      }
    }catch(error){
      failed=true;
      onError(error);
    }finally{
      running=false;
      if(!started)return;
      const wake=wakeRequested;
      wakeRequested=false;
      if(readExpiry){
        // A reservation created while the worker was busy takes priority.
        // Reconciliation itself never releases stock without YooKassa.
        schedule(wake?0:(failed||ran?OVERDUE_RETRY_MS:
          nextReservationCleanupDelayFromExpiry(expiry,now())));
      }else schedule(calculateDelay());
    }
  }
  return {
    start() {
      if (started) return;
      started = true;
      schedule(FIRST_RUN_MS); // Restore overdue reservations after a restart.
    },
    wake(){
      if(!started)return;
      if(readExpiry){
        // No synchronous SQLite query on the customer's payment request.
        if(running)wakeRequested=true;
        else schedule(0);
      }else if(!running)schedule(calculateDelay());
    },
    stop() {
      started = false;
      wakeRequested = false;
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
  nextReservationCleanupDelay, nextReservationCleanupDelayFromExpiry,
  hasOverdueReservation, isReservationExpiryOverdue,
  createReservationCleanupScheduler,
};
