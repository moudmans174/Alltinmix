const db = require('../db');
const { HttpError } = require('../lib/util');

/** Look up a coupon a buyer typed and check everything that does not depend on the cart. */
async function loadCoupon(q, rawCode, userId, { lock = false } = {}) {
  const code = String(rawCode || '').trim();
  if (!code) throw new HttpError(400, 'Enter a coupon code.', { code: 'COUPON_INVALID' });
  const { rows } = await q.query(`SELECT * FROM coupons WHERE upper(code) = upper($1)${lock ? ' FOR UPDATE' : ''}`, [code]);
  const c = rows[0];
  if (!c || !c.active) throw new HttpError(400, 'That coupon code is not valid.', { code: 'COUPON_INVALID' });
  if (c.expires_at && new Date(c.expires_at) < new Date()) throw new HttpError(400, 'That coupon has expired.', { code: 'COUPON_EXPIRED' });
  if (c.max_uses && c.used_count >= c.max_uses) throw new HttpError(400, 'That coupon has been used up.', { code: 'COUPON_EXHAUSTED' });
  if (c.seller_id === userId) throw new HttpError(400, "You can't use your own coupon.", { code: 'COUPON_INVALID' });
  const used = await q.query('SELECT 1 FROM coupon_uses WHERE coupon_id = $1 AND user_id = $2', [c.id, userId]);
  if (used.rowCount) throw new HttpError(400, 'You have already used this coupon.', { code: 'COUPON_USED' });
  return c;
}

/**
 * Work out the discount on each cart line. Coupons are funded by the seller who made them, apply only to that seller's
 * items, and not to items bought at a negotiated price. lines: [{ sellerId, lineTotal, haggled }]. Returns a number per line.
 */
function discountsFor(coupon, lines) {
  const eligible = lines.map((l) => l.sellerId === coupon.seller_id && !l.haggled);
  const sum = lines.reduce((s, l, i) => s + (eligible[i] ? l.lineTotal : 0), 0);
  if (!sum) throw new HttpError(400, 'This coupon only works on items from the seller who issued it (and not on negotiated prices).', { code: 'COUPON_NOT_APPLICABLE' });
  if (sum < Number(coupon.min_order_minor)) throw new HttpError(400, 'Your cart is below the minimum for this coupon.', { code: 'COUPON_MIN', min: Number(coupon.min_order_minor) });
  if (coupon.percent_off) return lines.map((l, i) => (eligible[i] ? Math.floor((l.lineTotal * coupon.percent_off) / 100) : 0));
  const total = Math.min(Number(coupon.amount_off_minor), sum - 1);
  let left = total;
  return lines.map((l, i) => {
    if (!eligible[i]) return 0;
    const d = Math.min(Math.floor((total * l.lineTotal) / sum), l.lineTotal - 1);
    left -= d;
    return d;
  }).map((d, i, arr) => (i === eligible.indexOf(true) ? Math.min(d + left, lines[i].lineTotal - 1) : d));
}

module.exports = { loadCoupon, discountsFor };
