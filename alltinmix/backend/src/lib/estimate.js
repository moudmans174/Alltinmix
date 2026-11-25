/**
 * "When will it arrive?" estimates, shown on the product page, at checkout, on the confirmation page and in the receipt.
 * They are estimates, based on what the seller promised on the listing (shipping days or delivery days).
 * Returns { kind, minDays, maxDays } or null when no estimate makes sense (property, vehicles).
 */
function estimateFor({ type, fulfillment, commerce, deliveryMethod, shippingDays, deliveryDays }) {
  if (commerce === 'classified') return null;
  if (fulfillment === 'digital') return { kind: 'instant', minDays: 0, maxDays: 0 };
  if (commerce === 'service') {
    const d = Number(deliveryDays) || 1;
    return { kind: 'service', minDays: d, maxDays: d + 1 };
  }
  if (deliveryMethod === 'pickup') return { kind: 'pickup', minDays: 0, maxDays: 2 };
  const d = Number(shippingDays) || 3;
  return { kind: 'ship', minDays: d, maxDays: d + 2 };
}

const addDays = (date, n) => new Date(new Date(date).getTime() + n * 86400000);

/** Human text such as "Mon 1 Dec to Wed 3 Dec". */
function windowText(est, from = new Date()) {
  if (!est) return '';
  if (est.kind === 'instant') return 'Instant download after payment';
  const f = (d) => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const a = addDays(from, est.minDays);
  const b = addDays(from, est.maxDays);
  if (est.kind === 'pickup') return `Ready for pickup by ${f(b)}`;
  return a.toDateString() === b.toDateString() ? f(a) : `${f(a)} to ${f(b)}`;
}

module.exports = { estimateFor, windowText, addDays };
