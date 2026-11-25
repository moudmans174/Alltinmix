const db = require('../db');
const config = require('../config');
const { layout, enqueueEmail } = require('./notify');
const { escapeHtml } = require('./util');
const { estimateFor, windowText } = require('./estimate');

const fmt = (minor, code) => {
  const cur = config.marketplace.currencies.find((c) => c.code === code) || config.marketplace.currency;
  return `${cur.symbol}${(minor / 10 ** (cur.decimals ?? 2)).toFixed(cur.decimals ?? 2)}`;
};

/** Orders for one payment, with the listing details the estimates need. */
async function paymentOrders(q, paymentId) {
  const { rows } = await q.query(
    `SELECT o.*, l.shipping_days, l.delivery_days FROM orders o LEFT JOIN listings l ON l.id = o.listing_id
      WHERE o.payment_id = $1 AND o.status <> 'cancelled' ORDER BY o.created_at`, [paymentId]);
  return rows.map((o) => {
    const v = config.verticalOf(o.type);
    const est = estimateFor({ type: o.type, fulfillment: o.fulfillment, commerce: v?.commerce, deliveryMethod: o.delivery_method, shippingDays: o.shipping_days, deliveryDays: o.delivery_days });
    return { ...o, estimate: est, expected: windowText(est, o.created_at) };
  });
}

/** Email an itemised receipt (paid online) or order confirmation (cash on delivery). Never throws: a failed email must not undo a payment. */
async function sendReceipt(paymentId) {
  try {
    const { rows: pr } = await db.query('SELECT p.*, u.email, u.name FROM payments p JOIN users u ON u.id = p.buyer_id WHERE p.id = $1', [paymentId]);
    const p = pr[0];
    if (!p) return;
    const orders = await paymentOrders(db, paymentId);
    if (!orders.length) return;
    const cod = p.status === 'cod';
    const rate = Number(p.fx_rate) || 1;
    const rowsHtml = orders.map((o) => `<tr><td style="padding:6px 0">${escapeHtml(o.title)} × ${o.qty}${o.coupon_code ? `<br><small style="color:#6b7280">Coupon ${escapeHtml(o.coupon_code)}: −${fmt(o.discount_minor, config.baseCurrency)}</small>` : ''}${o.expected ? `<br><small style="color:#6b7280">Expected: ${escapeHtml(o.expected)}</small>` : ''}</td><td style="padding:6px 0;text-align:right;white-space:nowrap">${fmt(o.total_minor, config.baseCurrency)}</td></tr>`).join('');
    const fee = orders.reduce((s, o) => s + Number(o.delivery_fee_minor || 0), 0);
    const addr = orders.find((o) => o.delivery_address)?.delivery_address;
    const where = !addr ? '' : orders[0].delivery_method === 'pickup'
      ? `<p><b>Pickup:</b> ${escapeHtml(addr.pickupLocation || 'The seller will contact you with the place and time.')}</p>`
      : `<p><b>Delivery to:</b> ${escapeHtml([addr.name, addr.address, orders[0].delivery_zone].filter(Boolean).join(', '))}<br>${escapeHtml(addr.phone || '')}</p>`;
    const title = cod ? 'Your order is placed' : 'Payment received. Here is your receipt';
    const html = layout({
      title,
      bodyHtml: `<p>Hi ${escapeHtml(p.name)}, thank you for your order.</p>
        <table style="width:100%;border-collapse:collapse;border-top:1px solid #e3e1da">${rowsHtml}
        ${fee ? `<tr><td style="padding:6px 0;color:#6b7280">Delivery included above</td><td style="text-align:right;color:#6b7280">${fmt(fee, config.baseCurrency)}</td></tr>` : ''}
        <tr><td style="padding:10px 0;border-top:1px solid #e3e1da"><b>${cod ? 'To pay in cash on delivery' : 'Total paid'}</b></td><td style="padding:10px 0;border-top:1px solid #e3e1da;text-align:right"><b>${fmt(p.amount_minor, p.currency)}</b>${p.currency !== config.baseCurrency ? `<br><small style="color:#6b7280">(${fmt(p.base_amount_minor, config.baseCurrency)} at 1 ${escapeHtml(p.currency)} = ${rate})</small>` : ''}</td></tr></table>
        ${where}
        <p style="color:#6b7280;font-size:12px">${cod ? 'Pay the seller in cash only when you have the item in your hands.' : 'Your money is held safely until you confirm delivery.'} Reference: ${escapeHtml(p.id.slice(0, 8).toUpperCase())}</p>`,
      ctaUrl: `${config.clientUrl}/orders`, ctaLabel: 'Track my order',
    });
    const text = `${title}\n\n${orders.map((o) => `${o.title} x${o.qty}: ${fmt(o.total_minor, config.baseCurrency)}`).join('\n')}\n\nTotal: ${fmt(p.amount_minor, p.currency)}\nReference: ${p.id.slice(0, 8).toUpperCase()}\n${config.clientUrl}/orders`;
    await enqueueEmail(db, { to: p.email, subject: `${cod ? 'Order placed' : 'Receipt'}: ${config.marketplace.brand.name} order ${p.id.slice(0, 8).toUpperCase()}`, html, text });
  } catch (err) {
    console.error('[receipt]', err.message);
  }
}

module.exports = { sendReceipt, paymentOrders };
