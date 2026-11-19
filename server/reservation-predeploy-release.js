'use strict';

// One-time pre-deployment reconciliation for a live Amvera container.
// EXECUTE ONLY INSIDE THE RUNNING APP'S OWN ENVIRONMENT and after a database backup.
// This file is compatible with the existing (15-minute) reservation module.
// A one-minute age threshold overrides legacy expiry timestamps for this manual run,
// but a payment is never released until YooKassa explicitly confirms cancellation.
//
// node server/reservation-predeploy-release.js                  # dry run
// node server/reservation-predeploy-release.js --execute        # reconcile
//
// Paid / unknown / unreachable / unlinked payments remain reserved.

const MINIMUM_AGE_SECONDS = 60;
const BATCH_SIZE = 20;

async function reconcileOldReservations({
  database,
  gateway,
  release,
  execute = false,
  minimumAgeSeconds = MINIMUM_AGE_SECONDS,
  batchSize = BATCH_SIZE,
  onProgress = () => {},
} = {}) {
  if (!database || !gateway || typeof release !== 'function')
    throw new TypeError('Database, payment gateway and reservation release function are required');
  const age = Number(minimumAgeSeconds);
  if (!Number.isSafeInteger(age) || age < 60)
    throw new RangeError('Minimum order age must be at least 60 seconds');
  const size = Number(batchSize);
  if (!Number.isSafeInteger(size) || size < 1 || size > 100)
    throw new RangeError('Invalid batch size');

  const summary = {
    mode: execute ? 'execute' : 'dry-run',
    inspected: 0,
    released: 0,
    already_closed: 0,
    paid_or_succeeded: 0,
    awaiting_payment_identifier: 0,
    unresolved: 0,
    errors: 0,
    unchanged: 0,
  };
  if (execute && !gateway.isConfigured()) throw new Error(
    'YooKassa credentials are unavailable. No reservations were released.');

  const select = database.prepare(
    "SELECT id, order_code, yookassa_payment_id " +
    "FROM orders WHERE id>? AND status='pending' AND reservation_status='active' " +
    "AND created_at<=datetime('now', ?) ORDER BY id LIMIT ?"
  );
  const fresh = database.prepare(
    'SELECT status, reservation_status FROM orders WHERE id=?'
  );
  let cursor = 0;
  const ageSql = '-' + age + ' seconds';

  for (;;) {
    const orders = select.all(cursor, ageSql, size);
    if (!orders.length) break;
    for (const order of orders) {
      cursor = order.id;
      summary.inspected++;
      if (!execute) {
        summary.unchanged++;
        continue;
      }
      if (!order.yookassa_payment_id) {
        // We cannot prove that an in-flight createPayment request did not
        // succeed at the gateway. Require a person to review it, do not free.
        summary.awaiting_payment_identifier++;
        continue;
      }
      try {
        let payment = await gateway.getPayment(order.yookassa_payment_id);
        if (payment?.status === 'succeeded') {
          summary.paid_or_succeeded++;
          continue; // Existing server webhook/finalization must process it.
        }
        if (payment?.status !== 'canceled') {
          if (!['pending','waiting_for_capture'].includes(payment?.status)) {
            summary.unresolved++;
            continue;
          }
          payment = await gateway.cancelPayment(order.yookassa_payment_id);
        }
        if (payment?.status !== 'canceled') {
          summary.unresolved++;
          continue;
        }
        const latest = fresh.get(order.id);
        if (latest?.status !== 'pending' || latest.reservation_status !== 'active') {
          summary.already_closed++;
          continue;
        }
        // Atomic stock restoration, bone restoration and promo-claim release.
        const outcome = release(order.id);
        if (outcome?.released) summary.released++;
        else summary.already_closed++;
      } catch (error) {
        summary.errors++;
        onProgress({order_id:order.id,outcome:'error',error_code:error.code || 'RECONCILE_ERROR'});
      }
    }
  }
  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(x => !['--execute','--dry-run'].includes(x))) {
    throw new Error('Usage: node server/reservation-predeploy-release.js [--dry-run|--execute]');
  }
  const execute = args.includes('--execute');
  const db = require('./db');
  const yookassa = require('./yookassa');
  const { withImmediateTransaction, releaseOrderReservationInTransaction } = require('./reservations');
  const { releaseFirstPurchasePromoClaim } = require('./first-purchase-promo');

  const summary = await reconcileOldReservations({
    database:db,
    gateway:yookassa,
    execute,
    release:(orderId)=>withImmediateTransaction(()=>{
      const outcome = releaseOrderReservationInTransaction(orderId,'failed',
        'Ручная сверка: ЮKassa подтвердила отмену платежа');
      if (outcome.released) releaseFirstPurchasePromoClaim(orderId);
      return outcome;
    }),
    onProgress:(event)=>console.warn('[predeploy-reservations]',JSON.stringify(event)),
  });
  console.log('[predeploy-reservations]',JSON.stringify(summary));
  if (execute && (summary.errors || summary.unresolved || summary.awaiting_payment_identifier ||
      summary.paid_or_succeeded)) {
    console.warn('Часть резервов не освобождена: оплату нельзя считать отменённой. '+
      'Проверьте эти заказы вручную; оплаченные продажи нельзя возвращать на полку.');
  }
  try { db.close(); } catch (_) {}
}

if (require.main === module) {
  main().catch(error=>{
    console.error('[predeploy-reservations] Операция не завершена:',error.message);
    process.exitCode=1;
  });
}
module.exports = { reconcileOldReservations, MINIMUM_AGE_SECONDS, BATCH_SIZE };