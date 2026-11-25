/**
 * Order, payment and escrow logic. Every state change runs in a database transaction with the
 * affected rows locked, so double clicks, retried webhooks and concurrent buyers cannot corrupt stock or balances.
 *
 * Order lifecycle:
 *   awaiting_payment -> pending_acceptance -> in_progress -> delivered -> completed
 *   (digital products skip straight to "delivered" once paid)
 *   side exits: cancelled (refunded), disputed -> completed | refunded
 */
const crypto = require('node:crypto');
const db = require('../db');
const config = require('../config');
const { HttpError, commissionMinor } = require('../lib/util');
const { notify, notifyAdmins } = require('../lib/notify');
const coupons = require('./coupons');
const payments = require('../payments');

const symbolGap = /[A-Za-z]$/.test(config.marketplace.currency.symbol) ? ' ' : ''; // "Le 85.00" but "$85.00"
const money = (minor) => `${config.marketplace.currency.symbol}${symbolGap}${(minor / 10 ** config.marketplace.currency.decimals).toFixed(config.marketplace.currency.decimals)}`;

/** Format an amount in any offered currency, e.g. moneyIn(2250, 'USD') -> "$22.50". */
function moneyIn(minor, code) {
  const cur = config.currencyOf(code) || config.marketplace.currency;
  const gap = /[A-Za-z]$/.test(cur.symbol) ? ' ' : '';
  return `${cur.symbol}${gap}${(minor / 10 ** cur.decimals).toFixed(cur.decimals)}`;
}

/** Exchange rates: base units per 1 unit of each currency. The base currency is always 1. Admins can change them. */
async function getRates(q = db) {
  const { rows } = await q.query("SELECT value FROM settings WHERE key = 'fxRates'");
  const stored = rows[0] ? rows[0].value : {};
  const rates = { [config.baseCurrency]: 1 };
  for (const [code, start] of Object.entries(config.marketplace.fxRates)) rates[code] = Number(stored[code]) > 0 ? Number(stored[code]) : start;
  return rates;
}

/** Base-currency minor units -> minor units of another currency (rate = base units per 1 unit of that currency). */
const convertMinor = (baseMinor, rate) => Math.round(baseMinor / rate);

async function getCommissionPct(q = db) {
  const { rows } = await q.query("SELECT value FROM settings WHERE key = 'commissionPct'");
  return rows[0] ? Number(rows[0].value) : config.marketplace.commissionPctDefault;
}

async function getDeliveryZones(q = db) {
  const { rows } = await q.query("SELECT value FROM settings WHERE key = 'deliveryZones'");
  return rows[0] ? rows[0].value : config.deliveryZonesDefault;
}

/** Validate what the buyer typed for delivery. Returns { method, zone, address } for physical orders. */
function parseDelivery(raw, zones) {
  const d = raw || {};
  if (!['ship', 'pickup'].includes(d.method)) throw new HttpError(400, 'Choose delivery or pickup.', { code: 'DELIVERY_REQUIRED' });
  const phone = String(d.phone || '').trim();
  if (phone.replace(/\D/g, '').length < 7) throw new HttpError(400, 'Enter a phone number the seller can reach you on.', { code: 'DELIVERY_PHONE' });
  const name = String(d.name || '').trim().slice(0, 100);
  const note = String(d.note || '').trim().slice(0, 300);
  if (d.method === 'pickup') return { method: 'pickup', zone: null, fee: 0, address: { name, phone, note } };
  const address = String(d.address || '').trim().slice(0, 300);
  if (address.length < 5) throw new HttpError(400, 'Enter your delivery address.', { code: 'DELIVERY_ADDRESS' });
  let zone = null;
  let fee = 0;
  if (zones.length) {
    zone = zones.find((z) => z.name === d.zone);
    if (!zone) throw new HttpError(400, 'Choose your delivery area.', { code: 'DELIVERY_ZONE' });
    fee = zone.feeMinor;
  }
  return { method: 'ship', zone: zone ? zone.name : null, fee, address: { name, phone, address, note } };
}

// ---------------------------------------------------------------- checkout

async function checkout(user, rawItems, methodKey, currencyCode, deliveryInput, couponCode) {
  const method = payments.getMethod(methodKey);
  const payCode = String(currencyCode || config.baseCurrency).toUpperCase();
  if (!method.currencies.includes(payCode)) {
    throw new HttpError(400, `${method.label} can't be paid in ${payCode}. Choose ${method.currencies.join(' or ')} or another method.`, { code: 'CURRENCY_UNSUPPORTED' });
  }
  const provider = payments.providerByName(method.provider);
  const isCod = method.kind === 'cod';

  // Merge duplicate lines, then lock listings in a fixed order so two checkouts can't deadlock.
  const merged = new Map();
  const offerOf = new Map();
  for (const it of rawItems) { merged.set(it.listingId, (merged.get(it.listingId) || 0) + it.qty); if (it.offerId) offerOf.set(it.listingId, it.offerId); }
  const lines = [...merged.entries()].map(([listingId, qty]) => ({ listingId, qty, offerId: offerOf.get(listingId) })).sort((a, b) => a.listingId.localeCompare(b.listingId));

  const created = await db.tx(async (c) => {
    const pct = await getCommissionPct(c);
    const rates = await getRates(c);
    const rate = rates[payCode];
    const paymentId = crypto.randomUUID();
    const orders = [];
    let total = 0;

    for (const line of lines) {
      const { rows } = await c.query('SELECT * FROM listings WHERE id = $1 FOR UPDATE', [line.listingId]);
      const l = rows[0];
      if (!l || l.status !== 'active') throw new HttpError(409, 'One of the items in your cart is no longer available.', { code: 'UNAVAILABLE' });
      const vertical = config.verticalOf(l.type);
      const classifiedBuy = !!(vertical && vertical.mode === 'inquiry' && vertical.commerce === 'classified' && config.classifiedCheckout);
      if (!vertical || (vertical.mode !== 'checkout' && !classifiedBuy)) throw new HttpError(400, `"${l.title}" can't be bought online. Please message the seller instead.`, { code: 'INQUIRY_ONLY' });
      if (l.seller_id === user.id) throw new HttpError(400, "You can't buy your own listing.");

      const digital = l.fulfillment === 'digital';
      // A vehicle or property is a single item: the first paid checkout reserves it.
      if (classifiedBuy && l.stock === null) { await c.query('UPDATE listings SET stock = 1 WHERE id = $1', [l.id]); l.stock = 1; }
      let qty = vertical.commerce === 'service' || vertical.commerce === 'classified' || digital ? 1 : line.qty;
      let unit = l.price_minor;
      if (line.offerId) {
        // A negotiated price: valid only for the buyer, for the agreed quantity, until it expires, and only once.
        const { rows: of } = await c.query('SELECT * FROM offers WHERE id = $1 FOR UPDATE', [line.offerId]);
        const off = of[0];
        if (!off || off.buyer_id !== user.id || off.listing_id !== l.id || off.status !== 'accepted' || new Date(off.expires_at) < new Date()) {
          throw new HttpError(409, `The agreed price for "${l.title}" is no longer valid. Remove it from your cart or make a new offer.`, { code: 'OFFER_INVALID' });
        }
        qty = off.qty;
        unit = Number(off.agreed_minor);
      }
      if (l.stock !== null) {
        if (l.stock < qty) throw new HttpError(409, l.stock === 0 ? `"${l.title}" is out of stock.` : `Only ${l.stock} left of "${l.title}".`, { code: 'OUT_OF_STOCK' });
        await c.query('UPDATE listings SET stock = stock - $2, updated_at = now() WHERE id = $1', [l.id, qty]);
      }
      const lineTotal = unit * qty;
      orders.push({ id: crypto.randomUUID(), listing: l, qty, unit, offerId: line.offerId, lineTotal, commission: commissionMinor(lineTotal, pct), pct, physical: l.fulfillment === 'physical', fee: 0 });
    }

    // Coupon: seller-funded discount. Commission is charged on the price after the discount.
    let coupon = null;
    if (couponCode) {
      coupon = await coupons.loadCoupon(c, couponCode, user.id, { lock: true });
      const ds = coupons.discountsFor(coupon, orders.map((o) => ({ sellerId: o.listing.seller_id, lineTotal: o.lineTotal, haggled: !!o.offerId })));
      orders.forEach((o, i) => { o.discount = ds[i]; o.lineTotal -= ds[i]; o.commission = commissionMinor(o.lineTotal, o.pct); });
      if (!ds.some((d) => d > 0)) throw new HttpError(400, 'That coupon gives no discount on this cart.', { code: 'COUPON_NOT_APPLICABLE' });
    }

    // Delivery: physical goods are shipped to the buyer or picked up. One delivery fee per seller.
    const physical = orders.filter((o) => o.physical);
    let delivery = null;
    if (physical.length) {
      delivery = parseDelivery(deliveryInput, await getDeliveryZones(c));
      if (delivery.method === 'ship' && delivery.fee > 0) {
        const charged = new Set();
        for (const o of physical) if (!charged.has(o.listing.seller_id)) { charged.add(o.listing.seller_id); o.fee = delivery.fee; }
      }
    }
    for (const o of orders) total += o.lineTotal + o.fee;

    if (isCod) {
      if (orders.some((o) => !o.physical)) throw new HttpError(400, 'Cash on delivery is only for physical items. Remove services or downloads, or choose another way to pay.', { code: 'COD_NOT_AVAILABLE' });
      if (config.cod.maxMinor && total > config.cod.maxMinor) throw new HttpError(400, `Cash on delivery is limited to ${money(config.cod.maxMinor)} per order. Choose another way to pay.`, { code: 'COD_TOO_LARGE' });
      for (const sellerId of new Set(orders.map((o) => o.listing.seller_id))) {
        const { rows: bal } = await c.query('SELECT COALESCE(sum(amount_minor),0) AS n FROM wallet_entries WHERE user_id = $1', [sellerId]);
        if (Number(bal[0].n) < -config.cod.sellerDebtLimitMinor) throw new HttpError(409, 'This seller cannot take cash-on-delivery orders right now. Please choose another way to pay.', { code: 'COD_SELLER_BLOCKED' });
      }
    }

    const payAmount = convertMinor(total, rate);
    await c.query(
      'INSERT INTO payments (id, buyer_id, provider, method, amount_minor, currency, status, base_amount_minor, fx_rate) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [paymentId, user.id, method.provider, method.key, payAmount, payCode, isCod ? 'cod' : 'pending', total, rate]
    );
    for (const o of orders) {
      await c.query(
        `INSERT INTO orders (id, payment_id, listing_id, title, type, fulfillment, qty, unit_price_minor, total_minor, currency,
           buyer_id, seller_id, commission_pct, commission_minor, seller_earnings_minor, status,
           delivery_method, delivery_fee_minor, delivery_zone, delivery_address, discount_minor, coupon_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [o.id, paymentId, o.listing.id, o.listing.title, o.listing.type, o.listing.fulfillment, o.qty, o.unit, o.lineTotal + o.fee,
          config.marketplace.currency.code, user.id, o.listing.seller_id, o.pct, o.commission, o.lineTotal - o.commission + o.fee,
          isCod ? 'pending_acceptance' : 'awaiting_payment',
          o.physical ? delivery.method : null, o.fee, o.physical ? delivery.zone : null,
          o.physical ? JSON.stringify({ ...delivery.address, ...(delivery.method === 'pickup' ? { pickupLocation: o.listing.location || '' } : {}) }) : null,
          o.discount || 0, o.discount ? coupon.code : null]
      );
      if (o.discount) {
        await c.query('INSERT INTO coupon_uses (coupon_id, user_id, order_id) VALUES ($1,$2,$3) ON CONFLICT (coupon_id, user_id) DO NOTHING', [coupon.id, user.id, o.id]);
      }
      if (o.offerId) await c.query("UPDATE offers SET status = 'used', order_id = $2, updated_at = now() WHERE id = $1", [o.offerId, o.id]);
      if (isCod) {
        await c.query('UPDATE listings SET sold_count = sold_count + $2 WHERE id = $1', [o.listing.id, o.qty]);
        await notify(c, { userId: o.listing.seller_id, type: 'order_received', email: true, sms: true, link: '/seller/orders', title: `New cash-on-delivery order: ${o.listing.title}`, body: `Collect ${money(o.lineTotal + o.fee)} in cash when you hand it over. The platform fee of ${money(o.commission)} is deducted from your balance.` });
        await notify(c, { userId: user.id, type: 'order_placed', email: true, link: '/orders', title: `Order placed: ${o.listing.title}`, body: `Pay ${money(o.lineTotal + o.fee)} in cash when it arrives.` });
      }
    }
    if (coupon) await c.query('UPDATE coupons SET used_count = used_count + 1 WHERE id = $1', [coupon.id]);
    return { paymentId, total, payAmount, titles: orders.map((o) => o.listing.title) };
  });

  if (isCod) {
    require('../lib/receipt').sendReceipt(created.paymentId);
    return { paymentId: created.paymentId, method: method.key, kind: 'cod', redirectUrl: `/pay/return/${created.paymentId}`, totalMinor: created.total, payAmountMinor: created.payAmount, payCurrency: payCode };
  }

  // The provider call happens outside the transaction (it is a slow network request).
  const description = created.titles.length === 1 ? created.titles[0] : `${created.titles.length} items from ${config.marketplace.brand.name}`;
  try {
    const out = await provider.createCheckout({
      payment: { id: created.paymentId, amount_minor: created.payAmount, currency: payCode },
      buyer: user,
      description,
      method,
    });
    await db.query('UPDATE payments SET provider_ref = $2, updated_at = now() WHERE id = $1', [created.paymentId, out.providerRef]);
    return { paymentId: created.paymentId, method: method.key, kind: method.kind, redirectUrl: out.redirectUrl, totalMinor: created.total, payAmountMinor: created.payAmount, payCurrency: payCode };
  } catch (err) {
    console.error('[checkout] provider error:', err.message);
    await failPayment(created.paymentId, 'Could not start payment').catch(() => {});
    throw new HttpError(502, 'We could not start the payment. Please try again or choose another method.', { code: 'PAYMENT_START_FAILED' });
  }
}

// ---------------------------------------------------------------- payment outcomes

/** Called when a provider (or an admin, for mobile money) confirms the money arrived. Safe to call twice. */
async function markPaymentPaid(paymentId, { providerTxnId } = {}) {
  const outcome = await db.tx(async (c) => {
    const { rows } = await c.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
    const p = rows[0];
    if (!p) throw new HttpError(404, 'Payment not found.');
    if (!['pending', 'awaiting_confirmation', 'failed'].includes(p.status)) return { already: true, lateOrderIds: [] };

    await c.query("UPDATE payments SET status = 'paid', provider_txn_id = COALESCE($2, provider_txn_id), updated_at = now() WHERE id = $1", [paymentId, providerTxnId || null]);
    const { rows: orders } = await c.query(
      'SELECT o.*, l.delivery_url FROM orders o LEFT JOIN listings l ON l.id = o.listing_id WHERE o.payment_id = $1 FOR UPDATE OF o',
      [paymentId]
    );
    const lateOrderIds = [];
    for (const o of orders) {
      if (o.status !== 'awaiting_payment') {
        // Paid after we already cancelled (payment window expired): the money must go back.
        if (o.status === 'cancelled' && !o.refund_ref) lateOrderIds.push(o.id);
        continue;
      }
      const digital = o.fulfillment === 'digital';
      await c.query(
        `UPDATE orders SET status = $2, download_url = $3, delivered_at = $4, updated_at = now() WHERE id = $1`,
        [o.id, digital ? 'delivered' : 'pending_acceptance', digital ? o.delivery_url : null, digital ? new Date() : null]
      );
      if (o.listing_id) await c.query('UPDATE listings SET sold_count = sold_count + $2 WHERE id = $1', [o.listing_id, o.qty]);
      await notify(c, {
        userId: o.buyer_id, type: 'order_paid', email: true, link: '/orders',
        title: digital ? `Your download is ready: ${o.title}` : `Payment received: ${o.title}`,
        body: digital ? 'Your purchase is complete. Open My Orders to get your download.' : `Your payment of ${money(o.total_minor)} is held safely until you confirm delivery.`,
      });
      await notify(c, {
        userId: o.seller_id, type: 'order_received', email: true, sms: true, link: '/seller/orders',
        title: `New order: ${o.title}`,
        body: `You earn ${money(o.seller_earnings_minor)} once it is completed (after the platform fee).`,
      });
    }
    return { already: false, lateOrderIds };
  });

  if (!outcome.already) require('../lib/receipt').sendReceipt(paymentId);

  for (const id of outcome.lateOrderIds) {
    await db.tx(async (c) => {
      const { rows } = await c.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
      if (rows[0] && rows[0].status === 'cancelled' && !rows[0].refund_ref) {
        await refundOrder(c, rows[0], 'refunded');
        await notify(c, { userId: rows[0].buyer_id, type: 'order_refunded', email: true, link: '/orders', title: `Refund issued: ${rows[0].title}`, body: 'Your payment arrived after the checkout window closed, so it has been refunded.' });
      }
    }).catch((err) => console.error('[late-payment refund]', err.message));
  }
  return outcome;
}

/** Cancel a payment that never completed and release the stock it was holding. */
async function failPayment(paymentId, reason = 'Payment not completed', { notifyBuyer = false } = {}) {
  return db.tx(async (c) => {
    const { rows } = await c.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
    const p = rows[0];
    if (!p || !['pending', 'awaiting_confirmation'].includes(p.status)) return false;
    await c.query("UPDATE payments SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1", [paymentId, reason]);
    const { rows: orders } = await c.query("SELECT * FROM orders WHERE payment_id = $1 AND status = 'awaiting_payment' FOR UPDATE", [paymentId]);
    for (const o of orders) {
      await c.query("UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1", [o.id]);
      // ...and gives a coupon back so the buyer can use it again.
      const freed = await c.query('DELETE FROM coupon_uses WHERE order_id = $1 RETURNING coupon_id', [o.id]);
      if (freed.rowCount) await c.query('UPDATE coupons SET used_count = GREATEST(used_count - 1, 0) WHERE id = $1', [freed.rows[0].coupon_id]);
      // An unpaid checkout gives the negotiated price back to the buyer while it is still valid.
      await c.query("UPDATE offers SET status = 'accepted', order_id = NULL, updated_at = now() WHERE order_id = $1 AND status = 'used' AND expires_at > now()", [o.id]);
      if (o.listing_id) await c.query('UPDATE listings SET stock = stock + $2 WHERE id = $1 AND stock IS NOT NULL', [o.listing_id, o.qty]);
      if (notifyBuyer) await notify(c, { userId: o.buyer_id, type: 'payment_failed', email: true, link: '/orders', title: `Payment not confirmed: ${o.title}`, body: reason });
    }
    return true;
  });
}

/** Look up a payment with the provider and apply the result. Used when the buyer returns from the payment page. */
async function verifyPayment(paymentId, user) {
  const { rows } = await db.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
  const p = rows[0];
  if (!p || (p.buyer_id !== user.id && user.role !== 'admin')) throw new HttpError(404, 'Payment not found.');
  if (p.status === 'pending') {
    const provider = payments.providerByName(p.provider);
    const r = await provider.verify(p);
    if (r.status === 'paid') await markPaymentPaid(p.id, { providerTxnId: r.providerTxnId });
    else if (r.status === 'failed') await failPayment(p.id, 'The payment was not completed.');
  }
  const fresh = await db.query('SELECT status, method FROM payments WHERE id = $1', [paymentId]);
  return fresh.rows[0];
}

/** Webhook entry point. Providers that can't be trusted blindly (needsVerify) are re-checked via their API. */
async function handleWebhook(event) {
  if (!event) return;
  let p;
  if (event.candidates) {
    // The provider's payload carried ids we have to match ourselves (Monime). Only our own, still-open payments count.
    p = (await db.query("SELECT * FROM payments WHERE (id::text = ANY($1) OR provider_ref = ANY($1)) AND provider = ANY($2) LIMIT 1", [event.candidates, ['monime']])).rows[0];
  } else if (event.paymentId) p = (await db.query('SELECT * FROM payments WHERE id = $1', [event.paymentId])).rows[0];
  else if (event.providerRef) p = (await db.query('SELECT * FROM payments WHERE provider_ref = $1', [event.providerRef])).rows[0];
  if (!p) return;
  if (event.status === 'paid') {
    let txn = event.providerTxnId;
    if (event.needsVerify) {
      const r = await payments.providerByName(p.provider).verify(p);
      if (r.status !== 'paid') return;
      txn = r.providerTxnId;
    }
    await markPaymentPaid(p.id, { providerTxnId: txn });
  } else if (event.status === 'failed') {
    await failPayment(p.id, 'The payment was declined or expired.');
  }
}

// ---- mobile money (manual confirmation)

async function submitManualProof(user, paymentId, { senderPhone, transactionId }) {
  return db.tx(async (c) => {
    const { rows } = await c.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
    const p = rows[0];
    if (!p || p.buyer_id !== user.id) throw new HttpError(404, 'Payment not found.');
    if (p.provider !== 'momo') throw new HttpError(400, 'This payment does not use mobile money.');
    if (!['pending', 'awaiting_confirmation'].includes(p.status)) throw new HttpError(409, 'This payment can no longer be updated.');
    await c.query(
      "UPDATE payments SET status = 'awaiting_confirmation', proof = $2, updated_at = now() WHERE id = $1",
      [paymentId, JSON.stringify({ senderPhone, transactionId, submittedAt: new Date().toISOString() })]
    );
    await notifyAdmins(c, { type: 'payment_review', email: true, link: '/admin', title: 'Mobile money payment to confirm', body: `${user.name} reports sending ${moneyIn(p.amount_minor, p.currency)} via ${p.method.replace('_', ' ')} (transaction ${transactionId}, reference ${p.provider_ref}).` });
    return { status: 'awaiting_confirmation' };
  });
}

async function confirmManualPayment(adminId, paymentId) {
  const { rows } = await db.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
  const p = rows[0];
  if (!p || p.provider !== 'momo' || p.status !== 'awaiting_confirmation') throw new HttpError(409, 'This payment is not waiting for confirmation.');
  const out = await markPaymentPaid(paymentId, { providerTxnId: p.proof?.transactionId });
  await db.query("INSERT INTO admin_audit (admin_id, action, target, details) VALUES ($1,'payment.confirm',$2,$3)", [adminId, paymentId, JSON.stringify({ txn: p.proof?.transactionId })]);
  return out;
}

async function rejectManualPayment(adminId, paymentId, note) {
  const ok = await failPayment(paymentId, note || 'We could not find your mobile money transfer.', { notifyBuyer: true });
  if (!ok) throw new HttpError(409, 'This payment is not waiting for confirmation.');
  await db.query("INSERT INTO admin_audit (admin_id, action, target, details) VALUES ($1,'payment.reject',$2,$3)", [adminId, paymentId, JSON.stringify({ note })]);
}

// ---------------------------------------------------------------- refunds & completion

/** Refund one order through the provider that took the money. Call inside a transaction with the order row locked. */
async function refundOrder(c, order, finalStatus, { restock = false } = {}) {
  const { rows } = await c.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [order.payment_id]);
  const p = rows[0];
  let ref = null;
  let manual = false;
  if (['paid', 'partially_refunded'].includes(p.status)) {
    // The order is in the base currency; the buyer paid in p.currency, so refund the same share of what they actually paid.
    const refundAmount = p.currency === config.baseCurrency ? order.total_minor : Math.round((order.total_minor * p.amount_minor) / p.base_amount_minor);
    const r = await payments.providerByName(p.provider).refund(p, refundAmount);
    ref = r.ref || null;
    manual = !!r.manual;
  }
  await c.query('UPDATE orders SET status = $2, refund_ref = $3, refund_manual = $4, updated_at = now() WHERE id = $1', [order.id, finalStatus, ref, manual]);
  if (order.listing_id) {
    await c.query('UPDATE listings SET sold_count = GREATEST(sold_count - $2, 0) WHERE id = $1', [order.listing_id, order.qty]);
    if (restock) await c.query('UPDATE listings SET stock = stock + $2 WHERE id = $1 AND stock IS NOT NULL', [order.listing_id, order.qty]);
  }
  const { rows: sum } = await c.query('SELECT COALESCE(SUM(total_minor),0) AS refunded FROM orders WHERE payment_id = $1 AND refund_ref IS NOT NULL', [order.payment_id]);
  if (['paid', 'partially_refunded'].includes(p.status)) {
    await c.query('UPDATE payments SET status = $2, updated_at = now() WHERE id = $1', [p.id, sum[0].refunded >= p.base_amount_minor ? 'refunded' : 'partially_refunded']);
  }
}

/** Mark an order complete and credit the seller's balance exactly once. */
async function completeOrder(c, order) {
  await c.query("UPDATE orders SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = $1", [order.id]);
  const { rows: pay } = await c.query('SELECT status FROM payments WHERE id = $1', [order.payment_id]);
  if (pay[0] && pay[0].status === 'cod') {
    // The seller already collected the cash, so only the platform fee is charged to their balance.
    await c.query(
      "INSERT INTO wallet_entries (user_id, kind, amount_minor, order_id, note) VALUES ($1,'commission_due',$2,$3,$4) ON CONFLICT DO NOTHING",
      [order.seller_id, -order.commission_minor, order.id, `Platform fee (cash on delivery): ${order.title}`]
    );
    await notify(c, { userId: order.seller_id, type: 'order_status', email: true, link: '/seller/earnings', title: `Order completed: ${order.title}`, body: `The platform fee of ${money(order.commission_minor)} was deducted from your balance. It is settled from your future earnings or when you pay it to us.` });
    return;
  }
  await c.query(
    "INSERT INTO wallet_entries (user_id, kind, amount_minor, order_id, note) VALUES ($1,'earning',$2,$3,$4) ON CONFLICT DO NOTHING",
    [order.seller_id, order.seller_earnings_minor, order.id, `Order: ${order.title}`]
  );
  await notify(c, { userId: order.seller_id, type: 'payout_released', email: true, link: '/seller/earnings', title: `Payment released: ${order.title}`, body: `${money(order.seller_earnings_minor)} was added to your balance.` });
}

const ACTIONS = ['accept', 'deliver', 'confirm', 'cancel', 'dispute'];

async function transition(user, orderId, action, body = {}) {
  if (!ACTIONS.includes(action)) throw new HttpError(400, 'Unknown action.');
  await db.tx(async (c) => {
    const { rows } = await c.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    const o = rows[0];
    const isBuyer = !!o && o.buyer_id === user.id;
    const isSeller = !!o && o.seller_id === user.id;
    if (!o || (!isBuyer && !isSeller)) throw new HttpError(404, 'Order not found.');
    const wrongState = () => new HttpError(409, `This order can't be changed from its current status (${o.status.replace('_', ' ')}).`, { code: 'BAD_STATE' });
    const notAllowed = () => new HttpError(403, 'You are not allowed to do that on this order.', { code: 'FORBIDDEN' });

    switch (action) {
      case 'accept':
        if (!isSeller) throw notAllowed();
        if (o.status !== 'pending_acceptance') throw wrongState();
        await c.query("UPDATE orders SET status = 'in_progress', updated_at = now() WHERE id = $1", [o.id]);
        await notify(c, { userId: o.buyer_id, type: 'order_status', email: true, sms: true, link: '/orders', title: `Order accepted: ${o.title}`, body: 'The seller has accepted your order and is working on it.' });
        break;
      case 'deliver':
        if (!isSeller) throw notAllowed();
        if (o.status !== 'in_progress') throw wrongState();
        await c.query("UPDATE orders SET status = 'delivered', delivered_at = now(), updated_at = now() WHERE id = $1", [o.id]);
        await notify(c, { userId: o.buyer_id, type: 'order_status', email: true, sms: true, link: '/orders', title: `Delivered: ${o.title}`, body: `Please confirm it arrived as expected. Payment is released to the seller when you confirm (or automatically after ${config.autoCompleteDays} days).` });
        break;
      case 'confirm':
        if (!isBuyer) throw notAllowed();
        if (o.status !== 'delivered') throw wrongState();
        await completeOrder(c, o);
        break;
      case 'cancel':
        if (!((isBuyer && o.status === 'pending_acceptance') || (isSeller && ['pending_acceptance', 'in_progress'].includes(o.status)))) {
          if (!isBuyer && !isSeller) throw notAllowed();
          throw o.status === 'pending_acceptance' || o.status === 'in_progress' ? notAllowed() : wrongState();
        }
        await refundOrder(c, o, 'cancelled', { restock: true });
        await notify(c, { userId: isBuyer ? o.seller_id : o.buyer_id, type: 'order_cancelled', email: true, link: isBuyer ? '/seller/orders' : '/orders', title: `Order cancelled: ${o.title}`, body: isBuyer ? 'The buyer cancelled this order.' : 'The seller cancelled your order and your payment is being refunded.' });
        break;
      case 'dispute': {
        if (!isBuyer) throw notAllowed();
        if (!['in_progress', 'delivered'].includes(o.status)) throw wrongState();
        const reason = String(body.reason || '').trim();
        if (reason.length < 10) throw new HttpError(400, 'Please describe the problem (at least 10 characters).', { code: 'VALIDATION' });
        await c.query("UPDATE orders SET status = 'disputed', dispute_reason = $2, updated_at = now() WHERE id = $1", [o.id, reason.slice(0, 2000)]);
        await notify(c, { userId: o.seller_id, type: 'order_disputed', email: true, link: '/seller/orders', title: `Dispute opened: ${o.title}`, body: 'The buyer opened a dispute. Our team will review it. Payment is on hold.' });
        await notifyAdmins(c, { type: 'dispute_opened', email: true, link: '/admin', title: `Dispute: ${o.title}`, body: reason.slice(0, 300) });
        break;
      }
    }
  });
  return getOrder(orderId);
}

async function resolveDispute(adminId, orderId, resolution, note = '') {
  await db.tx(async (c) => {
    const { rows } = await c.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    const o = rows[0];
    if (!o) throw new HttpError(404, 'Order not found.');
    if (o.status !== 'disputed') throw new HttpError(409, 'This order is not in dispute.');
    if (resolution === 'release') {
      await completeOrder(c, o);
      await notify(c, { userId: o.buyer_id, type: 'dispute_resolved', email: true, link: '/orders', title: `Dispute resolved: ${o.title}`, body: `We reviewed the case and released the payment to the seller. ${note}`.trim() });
    } else {
      await refundOrder(c, o, 'refunded');
      await notify(c, { userId: o.buyer_id, type: 'dispute_resolved', email: true, link: '/orders', title: `Dispute resolved: ${o.title}`, body: `We reviewed the case and refunded your payment. ${note}`.trim() });
      await notify(c, { userId: o.seller_id, type: 'dispute_resolved', email: true, link: '/seller/orders', title: `Dispute resolved: ${o.title}`, body: `The buyer was refunded. ${note}`.trim() });
    }
    await c.query("INSERT INTO admin_audit (admin_id, action, target, details) VALUES ($1,'dispute.resolve',$2,$3)", [adminId, orderId, JSON.stringify({ resolution, note })]);
  });
  return getOrder(orderId);
}

async function getOrder(id) {
  const { rows } = await db.query(ORDER_SELECT + ' WHERE o.id = $1', [id]);
  return rows[0] ? orderToApi(rows[0]) : null;
}

// ---------------------------------------------------------------- reviews

async function createReview(user, orderId, { rating, comment, images = [] }) {
  return db.tx(async (c) => {
    const { rows } = await c.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    const o = rows[0];
    if (!o || o.buyer_id !== user.id) throw new HttpError(404, 'Order not found.');
    if (o.status !== 'completed') throw new HttpError(409, 'You can review an order once it is completed.');
    const dup = await c.query('SELECT 1 FROM reviews WHERE order_id = $1', [orderId]);
    if (dup.rowCount) throw new HttpError(409, 'You already reviewed this order.');
    await c.query('INSERT INTO reviews (order_id, listing_id, reviewer_id, seller_id, rating, comment, images) VALUES ($1,$2,$3,$4,$5,$6,$7)', [orderId, o.listing_id, user.id, o.seller_id, rating, comment || '', JSON.stringify(images)]);
    if (o.listing_id) {
      await c.query(
        `UPDATE listings SET rating_count = (SELECT count(*) FROM reviews WHERE listing_id = $1),
           rating_avg = COALESCE((SELECT round(avg(rating)::numeric, 2) FROM reviews WHERE listing_id = $1), 0) WHERE id = $1`,
        [o.listing_id]
      );
    }
    await notify(c, { userId: o.seller_id, type: 'review', link: '/seller/orders', title: `New ${rating}-star review: ${o.title}`, body: comment ? comment.slice(0, 200) : '' });
    return { ok: true };
  });
}

// ---------------------------------------------------------------- background jobs

/** Release stock held by checkouts that were never paid. */
async function expireStalePayments() {
  const { rows } = await db.query("SELECT id FROM payments WHERE status = 'pending' AND created_at < now() - make_interval(mins => $1)", [config.paymentExpiryMinutes]);
  let n = 0;
  for (const r of rows) if (await failPayment(r.id, 'Checkout expired')) n++;
  return n;
}

/** Check pending Monime payments with Monime itself. Orders complete even if the webhook never arrives. */
async function pollProviderPayments() {
  if (!config.paymentMethods.some((m) => m.provider === 'monime')) return 0;
  const { rows } = await db.query("SELECT * FROM payments WHERE provider = 'monime' AND status IN ('pending','failed') AND created_at > now() - interval '3 days' AND created_at < now() - interval '20 seconds' ORDER BY created_at DESC LIMIT 25");
  let n = 0;
  for (const p of rows) {
    try {
      const r = await payments.providerByName('monime').verify(p);
      if (r.status === 'paid') { await markPaymentPaid(p.id, { providerTxnId: r.providerTxnId }); n++; }
      else if (r.status === 'failed' && p.status === 'pending') await failPayment(p.id, 'The payment was not completed.');
    } catch (err) { console.error('[monime poll]', p.id, err.message); }
  }
  return n;
}

/** Complete delivered orders the buyer never confirmed, so sellers always get paid. */
async function autoCompleteDelivered() {
  const { rows } = await db.query("SELECT id FROM orders WHERE status = 'delivered' AND delivered_at < now() - make_interval(days => $1)", [config.autoCompleteDays]);
  let n = 0;
  for (const r of rows) {
    await db.tx(async (c) => {
      const { rows: l } = await c.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [r.id]);
      if (l[0] && l[0].status === 'delivered') {
        await completeOrder(c, l[0]);
        n++;
      }
    });
  }
  return n;
}

// ---------------------------------------------------------------- shared serializers

const ORDER_SELECT = `
  SELECT o.*, b.name AS buyer_name, s.name AS seller_name,
         EXISTS (SELECT 1 FROM reviews r WHERE r.order_id = o.id) AS reviewed,
         b.phone AS buyer_phone, s.phone AS seller_phone,
         p.method AS payment_method, p.status AS payment_status,
         p.currency AS paid_currency, p.amount_minor AS paid_amount_minor, p.base_amount_minor AS paid_base_minor
  FROM orders o
  JOIN users b ON b.id = o.buyer_id
  JOIN users s ON s.id = o.seller_id
  JOIN payments p ON p.id = o.payment_id`;

function orderToApi(r, { forSeller = false } = {}) {
  return {
    id: r.id,
    paymentId: r.payment_id,
    listingId: r.listing_id,
    title: r.title,
    type: r.type,
    fulfillment: r.fulfillment,
    qty: r.qty,
    unitPriceMinor: r.unit_price_minor,
    totalMinor: r.total_minor,
    currency: r.currency,
    commissionPct: r.commission_pct,
    commissionMinor: r.commission_minor,
    sellerEarningsMinor: r.seller_earnings_minor,
    status: r.status,
    buyerId: r.buyer_id,
    buyerName: r.buyer_name,
    sellerId: r.seller_id,
    sellerName: r.seller_name,
    // The download link is only ever shown to the buyer who paid for it.
    downloadUrl: forSeller ? undefined : r.download_url,
    disputeReason: r.dispute_reason,
    refundManual: r.refund_manual,
    refundSettledAt: r.refund_settled_at,
    reviewed: r.reviewed,
    discountMinor: r.discount_minor,
    couponCode: r.coupon_code,
    deliveryMethod: r.delivery_method,
    deliveryFeeMinor: r.delivery_fee_minor,
    deliveryZone: r.delivery_zone,
    deliveryAddress: r.delivery_address,
    buyerPhone: forSeller ? (r.delivery_address && r.delivery_address.phone) || r.buyer_phone : undefined,
    sellerPhone: forSeller ? undefined : r.seller_phone,
    cod: r.payment_status === 'cod',
    paymentMethod: r.payment_method,
    paymentStatus: r.payment_status,
    // What the buyer was actually charged for this order (differs from totalMinor when they paid in another currency).
    paidCurrency: r.paid_currency,
    paidMinor: r.paid_base_minor ? Math.round((r.total_minor * r.paid_amount_minor) / r.paid_base_minor) : r.total_minor,
    deliveredAt: r.delivered_at,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

module.exports = {
  getCommissionPct, getRates, getDeliveryZones, convertMinor, moneyIn, checkout, markPaymentPaid, failPayment, verifyPayment, handleWebhook,
  submitManualProof, confirmManualPayment, rejectManualPayment,
  transition, resolveDispute, createReview, getOrder,
  expireStalePayments, pollProviderPayments, autoCompleteDelivered, ORDER_SELECT, orderToApi, money,
};
