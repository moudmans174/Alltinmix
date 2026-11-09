const express = require('express');
const { z } = require('zod');
const db = require('../db');
const config = require('../config');
const orders = require('../services/orders');
const { HttpError, parse, paging } = require('../lib/util');
const { requireAuth, requireRole } = require('../lib/auth');
const { notify } = require('../lib/notify');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

const audit = (adminId, action, target, details = {}) =>
  db.query('INSERT INTO admin_audit (admin_id, action, target, details) VALUES ($1,$2,$3,$4)', [adminId, action, target, JSON.stringify(details)]);

router.get('/stats', async (req, res) => {
  const { rows } = await db.query(`
    SELECT
      COALESCE(sum(total_minor) FILTER (WHERE status IN ('pending_acceptance','in_progress','delivered','completed','disputed')), 0) AS gmv,
      COALESCE(sum(commission_minor) FILTER (WHERE status = 'completed'), 0) AS commission_earned,
      COALESCE(sum(commission_minor) FILTER (WHERE status IN ('pending_acceptance','in_progress','delivered','disputed')), 0) AS commission_pending,
      count(*) FILTER (WHERE status NOT IN ('awaiting_payment')) AS total_orders,
      count(*) FILTER (WHERE status = 'completed') AS completed_orders,
      count(*) FILTER (WHERE status = 'disputed') AS open_disputes,
      count(*) FILTER (WHERE refund_manual AND refund_settled_at IS NULL) AS refunds_due
    FROM orders`);
  const byType = await db.query(`SELECT type, COALESCE(sum(total_minor),0) AS revenue, count(*)::int AS orders FROM orders
                                 WHERE status IN ('pending_acceptance','in_progress','delivered','completed','disputed') GROUP BY type ORDER BY revenue DESC`);
  const counts = await db.query(`SELECT
      (SELECT count(*)::int FROM users WHERE role <> 'admin') AS users,
      (SELECT count(*)::int FROM listings WHERE status = 'active') AS active_listings,
      (SELECT count(*)::int FROM payments WHERE status = 'awaiting_confirmation') AS payments_to_confirm,
      (SELECT count(*)::int FROM payouts WHERE status = 'requested') AS payouts_requested`);
  const s = rows[0];
  res.json({
    gmvMinor: s.gmv, commissionEarnedMinor: s.commission_earned, commissionPendingMinor: s.commission_pending,
    totalOrders: s.total_orders, completedOrders: s.completed_orders, openDisputes: s.open_disputes, refundsDue: s.refunds_due,
    revenueByType: byType.rows.map((r) => ({ type: r.type, revenueMinor: r.revenue, orders: r.orders })),
    users: counts.rows[0].users, activeListings: counts.rows[0].active_listings,
    paymentsToConfirm: counts.rows[0].payments_to_confirm, reportsOpen: (await db.query("SELECT count(*)::int AS n FROM reports WHERE status = 'open'")).rows[0].n, payoutsRequested: counts.rows[0].payouts_requested,
    commissionPct: await orders.getCommissionPct(),
  });
});

router.get('/settings/fx-rates', async (req, res) => {
  res.json({ base: config.baseCurrency, rates: await orders.getRates() });
});

router.patch('/settings/fx-rates', async (req, res) => {
  const known = Object.keys(config.marketplace.fxRates);
  const body = parse(z.object({ rates: z.record(z.string(), z.coerce.number().positive('Enter a rate above zero.').max(1_000_000)) }), req.body);
  const unknown = Object.keys(body.rates).filter((c) => !known.includes(c));
  if (unknown.length) throw new HttpError(400, `Unknown currency: ${unknown.join(', ')}.`);
  const merged = { ...(await orders.getRates()), ...body.rates };
  delete merged[config.baseCurrency];
  await db.query("INSERT INTO settings (key, value) VALUES ('fxRates', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(merged)]);
  await audit(req.user.id, 'settings.fx', 'fxRates', body.rates);
  res.json({ base: config.baseCurrency, rates: await orders.getRates() });
});

router.get('/settings/delivery-zones', async (req, res) => {
  res.json({ zones: await orders.getDeliveryZones() });
});

router.put('/settings/delivery-zones', async (req, res) => {
  const body = parse(z.object({ zones: z.array(z.object({ name: z.string().trim().min(1).max(60), feeMinor: z.coerce.number().int().min(0).max(1_000_000_000) })).max(60) }), req.body);
  if (new Set(body.zones.map((z) => z.name.toLowerCase())).size !== body.zones.length) throw new HttpError(400, 'Each delivery area name must be different.');
  await db.query("INSERT INTO settings (key, value) VALUES ('deliveryZones', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(body.zones)]);
  await audit(req.user.id, 'settings.delivery', 'deliveryZones', { count: body.zones.length });
  res.json({ zones: body.zones });
});

/** Sellers whose balance is negative because of cash-on-delivery platform fees. */
router.get('/cod-balances', async (req, res) => {
  const { rows } = await db.query(`SELECT u.id, u.name, u.email, u.phone, sum(w.amount_minor) AS balance FROM wallet_entries w JOIN users u ON u.id = w.user_id
                                   GROUP BY u.id HAVING sum(w.amount_minor) < 0 ORDER BY sum(w.amount_minor)`);
  res.json({ sellers: rows.map((r) => ({ id: r.id, name: r.name, email: r.email, phone: r.phone, owedMinor: -r.balance })) });
});

/** Record that a seller paid their platform fees (cash, mobile money...). Positive amounts reduce what they owe. */
router.post('/users/:id/wallet-adjustment', async (req, res) => {
  if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw new HttpError(404, 'User not found.');
  const body = parse(z.object({ amountMinor: z.coerce.number().int().refine((n) => n !== 0, 'Amount cannot be zero.'), note: z.string().trim().min(3).max(200) }), req.body);
  const u = await db.query('SELECT id FROM users WHERE id = $1', [req.params.id]);
  if (!u.rows[0]) throw new HttpError(404, 'User not found.');
  await db.query("INSERT INTO wallet_entries (user_id, kind, amount_minor, note) VALUES ($1,'adjustment',$2,$3)", [req.params.id, body.amountMinor, body.note]);
  await audit(req.user.id, 'wallet.adjustment', req.params.id, body);
  res.json({ ok: true });
});

router.patch('/settings/commission', async (req, res) => {
  const { commissionPct } = parse(z.object({ commissionPct: z.coerce.number().min(0).max(50) }), req.body);
  await db.query("INSERT INTO settings (key, value) VALUES ('commissionPct', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(commissionPct)]);
  await audit(req.user.id, 'settings.commission', 'commissionPct', { commissionPct });
  res.json({ commissionPct });
});

// ------------------------------------------------------------ users

router.get('/users', async (req, res) => {
  const { limit, offset, page } = paging(req.query);
  const params = [];
  const where = ['1=1'];
  if (req.query.q) { params.push(`%${String(req.query.q).slice(0, 60)}%`); where.push(`(name ILIKE $${params.length} OR email ILIKE $${params.length})`); }
  if (req.query.role) { params.push(String(req.query.role)); where.push(`role = $${params.length}`); }
  const { rows } = await db.query(`SELECT id, name, email, role, tag, status, email_verified_at, created_at FROM users WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`, params);
  res.json({ page, users: rows.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, tag: u.tag, status: u.status, emailVerified: !!u.email_verified_at, createdAt: u.created_at })) });
});

router.patch('/users/:id', async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['active', 'suspended']) }), req.body);
  if (req.params.id === req.user.id) throw new HttpError(400, "You can't suspend your own account.");
  const { rows } = await db.query('UPDATE users SET status = $2, token_version = token_version + 1, updated_at = now() WHERE id = $1 AND role <> $3 AND status <> \'deleted\' RETURNING id, status', [req.params.id, status, 'admin']);
  if (!rows[0]) throw new HttpError(404, 'User not found (or is an admin).');
  await audit(req.user.id, `user.${status}`, req.params.id);
  res.json({ user: rows[0] });
});

// ------------------------------------------------------------ reports (user-generated content)

router.get('/reports', async (req, res) => {
  const status = ['open', 'actioned', 'dismissed'].includes(req.query.status) ? req.query.status : 'open';
  const { rows } = await db.query(
    `SELECT r.*, ru.name AS reporter_name,
            CASE r.target_type
              WHEN 'listing' THEN (SELECT title FROM listings WHERE id = r.target_id)
              WHEN 'user' THEN (SELECT name || ' <' || email || '>' FROM users WHERE id = r.target_id)
              ELSE (SELECT left(body, 300) FROM messages WHERE id = r.target_id) END AS target_label
     FROM reports r JOIN users ru ON ru.id = r.reporter_id WHERE r.status = $1 ORDER BY r.created_at DESC LIMIT 100`, [status]);
  res.json({ reports: rows.map((r) => ({ id: r.id, targetType: r.target_type, targetId: r.target_id, targetLabel: r.target_label, reason: r.reason, details: r.details, status: r.status, reporterName: r.reporter_name, createdAt: r.created_at })) });
});

router.post('/reports/:id/resolve', async (req, res) => {
  const { action } = parse(z.object({ action: z.enum(['hide_listing', 'suspend_user', 'dismiss']) }), req.body);
  if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw new HttpError(404, 'Report not found.');
  await db.tx(async (c) => {
    const { rows } = await c.query("SELECT * FROM reports WHERE id = $1 AND status = 'open' FOR UPDATE", [req.params.id]);
    const r = rows[0];
    if (!r) throw new HttpError(404, 'Report not found (or already handled).');
    if (action === 'hide_listing') {
      if (r.target_type !== 'listing') throw new HttpError(400, 'This report is not about a listing.');
      await c.query("UPDATE listings SET status = 'hidden', updated_at = now() WHERE id = $1 AND status = 'active'", [r.target_id]);
    } else if (action === 'suspend_user') {
      let userId = r.target_id;
      if (r.target_type === 'listing') userId = (await c.query('SELECT seller_id FROM listings WHERE id = $1', [r.target_id])).rows[0]?.seller_id;
      if (r.target_type === 'message') userId = (await c.query('SELECT sender_id FROM messages WHERE id = $1', [r.target_id])).rows[0]?.sender_id;
      if (!userId) throw new HttpError(404, 'The reported user no longer exists.');
      await c.query("UPDATE users SET status = 'suspended', token_version = token_version + 1, updated_at = now() WHERE id = $1 AND role <> 'admin' AND status = 'active'", [userId]);
    }
    await c.query("UPDATE reports SET status = $2, handled_by = $3 WHERE id = $1", [r.id, action === 'dismiss' ? 'dismissed' : 'actioned', req.user.id]);
    await c.query("INSERT INTO admin_audit (admin_id, action, target, details) VALUES ($1,$2,$3,$4)", [req.user.id, `report.${action}`, r.id, JSON.stringify({ targetType: r.target_type, targetId: r.target_id })]);
  });
  res.json({ ok: true });
});

// ------------------------------------------------------------ listings moderation

router.get('/listings', async (req, res) => {
  const { limit, offset, page } = paging(req.query);
  const params = [];
  const where = ["l.status <> 'deleted'"];
  if (req.query.status) { params.push(String(req.query.status)); where.push(`l.status = $${params.length}`); }
  if (req.query.q) { params.push(`%${String(req.query.q).slice(0, 60)}%`); where.push(`l.title ILIKE $${params.length}`); }
  const { rows } = await db.query(`SELECT l.id, l.title, l.type, l.category, l.status, l.price_minor, u.name AS seller_name FROM listings l JOIN users u ON u.id = l.seller_id WHERE ${where.join(' AND ')} ORDER BY l.created_at DESC LIMIT ${limit} OFFSET ${offset}`, params);
  res.json({ page, listings: rows.map((l) => ({ id: l.id, title: l.title, type: l.type, category: l.category, status: l.status, priceMinor: l.price_minor, sellerName: l.seller_name })) });
});

router.patch('/listings/:id', async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['active', 'hidden']) }), req.body);
  const { rows } = await db.query("UPDATE listings SET status = $2, updated_at = now() WHERE id = $1 AND status <> 'deleted' RETURNING id, seller_id, title", [req.params.id, status]);
  if (!rows[0]) throw new HttpError(404, 'Listing not found.');
  await audit(req.user.id, `listing.${status}`, req.params.id);
  if (status === 'hidden') await notify(db, { userId: rows[0].seller_id, type: 'listing_hidden', email: true, link: '/seller/listings', title: `Listing hidden: ${rows[0].title}`, body: 'A moderator hid this listing. Contact support if you think this is a mistake.' });
  res.json({ listing: rows[0] });
});

// ------------------------------------------------------------ orders, disputes, refunds

router.get('/orders', async (req, res) => {
  const { limit, offset, page } = paging(req.query);
  const params = [];
  let where = "o.status <> 'awaiting_payment'";
  if (req.query.status) { params.push(String(req.query.status)); where += ` AND o.status = $${params.length}`; }
  const { rows } = await db.query(`${orders.ORDER_SELECT} WHERE ${where} ORDER BY o.created_at DESC LIMIT ${limit} OFFSET ${offset}`, params);
  res.json({ page, orders: rows.map((r) => orders.orderToApi(r)) });
});

router.post('/orders/:id/resolve', async (req, res) => {
  const body = parse(z.object({ resolution: z.enum(['release', 'refund']), note: z.string().trim().max(500).default('') }), req.body);
  res.json({ order: await orders.resolveDispute(req.user.id, req.params.id, body.resolution, body.note) });
});

// Refunds paid by mobile money can't be automatic: this lists the ones the merchant still has to send by hand.
router.get('/refunds-due', async (req, res) => {
  const { rows } = await db.query(
    `${orders.ORDER_SELECT} WHERE o.refund_manual AND o.refund_settled_at IS NULL ORDER BY o.updated_at ASC LIMIT 200`
  );
  res.json({ orders: rows.map((r) => orders.orderToApi(r)) });
});

router.post('/orders/:id/refund-settled', async (req, res) => {
  const { rowCount } = await db.query('UPDATE orders SET refund_settled_at = now() WHERE id = $1 AND refund_manual AND refund_settled_at IS NULL', [req.params.id]);
  if (!rowCount) throw new HttpError(404, 'No manual refund is due for this order.');
  await audit(req.user.id, 'refund.settled', req.params.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------ payments awaiting manual confirmation

router.get('/payments', async (req, res) => {
  const status = req.query.status ? String(req.query.status) : 'awaiting_confirmation';
  const { rows } = await db.query(
    `SELECT p.*, u.name AS buyer_name, u.email AS buyer_email,
            (SELECT string_agg(o.title, ', ') FROM orders o WHERE o.payment_id = p.id) AS titles
     FROM payments p JOIN users u ON u.id = p.buyer_id WHERE p.status = $1 ORDER BY p.created_at ASC LIMIT 200`,
    [status]
  );
  res.json({
    payments: rows.map((p) => ({ id: p.id, method: p.method, provider: p.provider, status: p.status, amountMinor: p.amount_minor, currency: p.currency, reference: p.provider_ref, proof: p.proof, buyerName: p.buyer_name, buyerEmail: p.buyer_email, titles: p.titles, createdAt: p.created_at })),
  });
});

router.post('/payments/:id/confirm', async (req, res) => {
  await orders.confirmManualPayment(req.user.id, req.params.id);
  res.json({ ok: true });
});

router.post('/payments/:id/reject', async (req, res) => {
  const { note } = parse(z.object({ note: z.string().trim().max(300).default('') }), req.body);
  await orders.rejectManualPayment(req.user.id, req.params.id, note);
  res.json({ ok: true });
});

// ------------------------------------------------------------ seller payouts

router.get('/payouts', async (req, res) => {
  const status = req.query.status ? String(req.query.status) : 'requested';
  const { rows } = await db.query('SELECT p.*, u.name AS user_name, u.email AS user_email FROM payouts p JOIN users u ON u.id = p.user_id WHERE p.status = $1 ORDER BY p.created_at ASC LIMIT 200', [status]);
  res.json({ payouts: rows.map((p) => ({ id: p.id, userName: p.user_name, userEmail: p.user_email, amountMinor: p.amount_minor, method: p.method, details: p.details, status: p.status, reference: p.reference, createdAt: p.created_at })) });
});

router.post('/payouts/:id/pay', async (req, res) => {
  const { reference } = parse(z.object({ reference: z.string().trim().max(100).default('') }), req.body);
  await db.tx(async (c) => {
    const { rows } = await c.query('SELECT * FROM payouts WHERE id = $1 FOR UPDATE', [req.params.id]);
    const p = rows[0];
    if (!p) throw new HttpError(404, 'Payout not found.');
    if (p.status !== 'requested') throw new HttpError(409, 'This payout was already handled.');
    await c.query("UPDATE payouts SET status = 'paid', reference = $2, updated_at = now() WHERE id = $1", [p.id, reference]);
    await notify(c, { userId: p.user_id, type: 'payout_paid', email: true, link: '/seller/earnings', title: 'Your payout was sent', body: `${orders.money(p.amount_minor)} was sent via ${p.method}${reference ? ` (ref ${reference})` : ''}.` });
    await c.query("INSERT INTO admin_audit (admin_id, action, target, details) VALUES ($1,'payout.paid',$2,$3)", [req.user.id, p.id, JSON.stringify({ reference })]);
  });
  res.json({ ok: true });
});

router.post('/payouts/:id/reject', async (req, res) => {
  const { note } = parse(z.object({ note: z.string().trim().max(300).default('') }), req.body);
  await db.tx(async (c) => {
    const { rows } = await c.query('SELECT * FROM payouts WHERE id = $1 FOR UPDATE', [req.params.id]);
    const p = rows[0];
    if (!p) throw new HttpError(404, 'Payout not found.');
    if (p.status !== 'requested') throw new HttpError(409, 'This payout was already handled.');
    await c.query("UPDATE payouts SET status = 'rejected', admin_note = $2, updated_at = now() WHERE id = $1", [p.id, note]);
    // Give the money back to the seller's balance.
    await c.query("INSERT INTO wallet_entries (user_id, kind, amount_minor, payout_id, note) VALUES ($1,'adjustment',$2,$3,'Payout rejected, funds returned')", [p.user_id, p.amount_minor, p.id]);
    await notify(c, { userId: p.user_id, type: 'payout_rejected', email: true, link: '/seller/earnings', title: 'Your payout request was declined', body: note || 'Please check your payout details and try again.' });
    await c.query("INSERT INTO admin_audit (admin_id, action, target, details) VALUES ($1,'payout.reject',$2,$3)", [req.user.id, p.id, JSON.stringify({ note })]);
  });
  res.json({ ok: true });
});

module.exports = router;
