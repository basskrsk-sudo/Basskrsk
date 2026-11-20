'use strict';

// A retry can only recover an existing QR checkout for the same product,
// salon, phone and price. This endpoint never authorizes stock or payment.
function digits(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

function matchesQrPaymentRetry(order, oldItems, request) {
  if (!order || !request || request.confirmationMode !== 'redirect') return false;
  if (!/^\/p\/[-A-Za-z0-9._~%]+\/[-A-Za-z0-9._~%]+\/?$/.test(String(request.returnPath || ''))) return false;
  if (order.fulfillment_type !== 'pickup' || !order.point_id ||
      String(order.point_id) !== String(request.pointId || '')) return false;
  if (digits(order.customer_phone).length !== 10 ||
      digits(order.customer_phone) !== digits(request.customerPhone)) return false;
  if (!Number.isFinite(request.amount) ||
      Math.round(Number(order.total) * 100) !== Math.round(request.amount * 100)) return false;
  if (!Array.isArray(oldItems) || !Array.isArray(request.cartItems) ||
      oldItems.length === 0 || oldItems.length !== request.cartItems.length) return false;
  const previous = oldItems.map(item => [String(item.variant_id), Number(item.qty)])
    .sort((a, b) => a[0].localeCompare(b[0]));
  const incoming = request.cartItems.map(item => [String(item.variantId), Number(item.qty)])
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (incoming.some(item => !Number.isSafeInteger(item[1]) || item[1] < 1)) return false;
  return JSON.stringify(previous) === JSON.stringify(incoming);
}

module.exports = { matchesQrPaymentRetry };
