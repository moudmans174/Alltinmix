const express = require('express');
const { z } = require('zod');
const db = require('../db');
const config = require('../config');
const { HttpError, parse } = require('../lib/util');
const { requireAuth, publicUser } = require('../lib/auth');
const { notifyAdmins } = require('../lib/notify');
const { money } = require('../services/orders');

const router = express.Router();
router.use(requireAuth);

const PAYOUT_METHODS = ['Orange Money', 'Afrimoney', 'QMoney', 'Bank transfer', 'PayPal'];

router.patch('/profile', async (req, res) => {
  const body = parse(z.object({
    name: z.string().trim().min(2).max(80).optional(),
    tag: z.string().trim().max(60).optional(),
    phone: z.string().trim().max(30).optional(),
    payoutMethod: z.enum(PAYOUT_METHODS).optional(),
    payoutDetails: z.string().trim().max(200).optional(),
  }), req.body);
  const { rows } = await db.query(
    `UPDATE users SET name = COALESCE($2, name), tag = COALESCE($3, tag), phone = COALESCE($4, phone),
       payout_method = COALESCE($5, payout_method), payout_details = COALESCE($6, payout_details), updated_at = now()
     WHERE id = $1 RETURNING *`,
    [req.user.id, body.name ?? null, body.tag ?? null, body.phone ?? null, body.payoutMethod ?? null, body.payoutDetails ?? null]
  );
  res.json({ user: publicUser(rows[0]) });
});

// Saved delivery addresses (max 10). The first one saved becomes the default.
const addrSchema = z.object({
  label: z.string().trim().max(40).default(''),
  name: z.string().trim().min(2).max(80),
  phone: z.string().trim().min(5).max(30),
  zone: z.string().trim().max(80).optional().nullable(),
  address: z.string().trim().min(5).max(300),
  isDefault: z.boolean().optional(),
});
const addrApi = (a) => ({ id: a.id, label: a.label, name: a.name, phone: a.phone, zone: a.zone, address: a.address, isDefault: a.is_default });

router.get('/addresses', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC', [req.user.id]);
  res.json({ addresses: rows.map(addrApi) });
});

router.post('/addresses', async (req, res) => {
  const b = parse(addrSchema, req.body);
  const out = await db.tx(async (c) => {
    const { rows: ex } = await c.query('SELECT * FROM addresses WHERE user_id = $1 FOR UPDATE', [req.user.id]);
    // Saving the same address twice just returns the existing one.
    const dup = ex.find((a) => a.address.toLowerCase() === b.address.toLowerCase() && a.phone === b.phone);
    if (dup) return dup;
    if (ex.length >= 10) throw new HttpError(400, 'You can save up to 10 addresses. Delete one first.');
    const makeDefault = b.isDefault || ex.length === 0;
    if (makeDefault) await c.query('UPDATE addresses SET is_default = false WHERE user_id = $1', [req.user.id]);
    const { rows } = await c.query(
      'INSERT INTO addresses (user_id, label, name, phone, zone, address, is_default) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [req.user.id, b.label, b.name, b.phone, b.zone || null, b.address, makeDefault]);
    return rows[0];
  });
  res.status(201).json({ address: addrApi(out) });
});

router.patch('/addresses/:id', async (req, res) => {
  if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw new HttpError(404, 'Address not found.');
  const b = parse(addrSchema.partial(), req.body);
  const out = await db.tx(async (c) => {
    const { rows: ex } = await c.query('SELECT * FROM addresses WHERE id = $1 AND user_id = $2 FOR UPDATE', [req.params.id, req.user.id]);
    if (!ex[0]) throw new HttpError(404, 'Address not found.');
    if (b.isDefault) await c.query('UPDATE addresses SET is_default = false WHERE user_id = $1', [req.user.id]);
    const { rows } = await c.query(
      `UPDATE addresses SET label = COALESCE($3,label), name = COALESCE($4,name), phone = COALESCE($5,phone), zone = COALESCE($6,zone),
         address = COALESCE($7,address), is_default = COALESCE($8,is_default) WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, req.user.id, b.label ?? null, b.name ?? null, b.phone ?? null, b.zone ?? null, b.address ?? null, b.isDefault ?? null]);
    return rows[0];
  });
  res.json({ address: addrApi(out) });
});

router.delete('/addresses/:id', async (req, res) => {
  if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw new HttpError(404, 'Address not found.');
  const { rows } = await db.query('DELETE FROM addresses WHERE id = $1 AND user_id = $2 RETURNING is_default', [req.params.id, req.user.id]);
  if (!rows[0]) throw new HttpError(404, 'Address not found.');
  // If the default was removed, promote the newest remaining one.
  if (rows[0].is_default) await db.query('UPDATE addresses SET is_default = true WHERE id = (SELECT id FROM addresses WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1)', [req.user.id]);
  res.json({ ok: true });
});

async function walletSummary(userId, q = db) {
  const { rows } = await q.query(
    `SELECT
       COALESCE((SELECT sum(amount_minor) FROM wallet_entries WHERE user_id = $1), 0) AS available,
       COALESCE((SELECT sum(seller_earnings_minor) FROM orders WHERE seller_id = $1 AND status IN ('pending_acceptance','in_progress','delivered','disputed')), 0) AS pending,
       COALESCE((SELECT sum(amount_minor) FROM payouts WHERE user_id = $1 AND status = 'paid'), 0) AS withdrawn,
       COALESCE((SELECT sum(amount_minor) FROM wallet_entries WHERE user_id = $1 AND kind = 'earning'), 0) AS lifetime`,
    [userId]
  );
  const r = rows[0];
  return { availableMinor: r.available, owedMinor: Number(r.available) < 0 ? -r.available : 0, pendingMinor: r.pending, withdrawnMinor: r.withdrawn, lifetimeEarnedMinor: r.lifetime };
}

router.get('/wallet', async (req, res) => {
  const { rows } = await db.query('SELECT id, amount_minor, status, method, details, reference, admin_note, created_at FROM payouts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
  res.json({
    wallet: await walletSummary(req.user.id),
    minPayoutMinor: config.minPayoutMinor,
    payouts: rows.map((p) => ({ id: p.id, amountMinor: p.amount_minor, status: p.status, method: p.method, details: p.details, reference: p.reference, adminNote: p.admin_note, createdAt: p.created_at })),
  });
});

/** Ask to withdraw. The balance is deducted immediately so it can't be requested twice; an admin then sends the money. */
router.post('/wallet/payouts', async (req, res) => {
  const body = parse(z.object({ amount: z.coerce.number().positive().optional() }), req.body);
  const payout = await db.tx(async (c) => {
    const { rows: u } = await c.query('SELECT payout_method, payout_details FROM users WHERE id = $1 FOR UPDATE', [req.user.id]); // serializes this user's requests
    if (!u[0].payout_method || !u[0].payout_details) throw new HttpError(400, 'Add your payout details first (where should we send your money?).', { code: 'NO_PAYOUT_DETAILS' });
    const { availableMinor } = await walletSummary(req.user.id, c);
    const amount = body.amount ? Math.round(body.amount * 10 ** config.marketplace.currency.decimals) : availableMinor;
    if (amount > availableMinor) throw new HttpError(400, 'That is more than your available balance.', { code: 'INSUFFICIENT_FUNDS' });
    if (amount < config.minPayoutMinor) throw new HttpError(400, `The minimum withdrawal is ${money(config.minPayoutMinor)}.`, { code: 'BELOW_MINIMUM' });
    const { rows } = await c.query("INSERT INTO payouts (user_id, amount_minor, method, details) VALUES ($1,$2,$3,$4) RETURNING *", [req.user.id, amount, u[0].payout_method, u[0].payout_details]);
    await c.query("INSERT INTO wallet_entries (user_id, kind, amount_minor, payout_id, note) VALUES ($1,'withdrawal',$2,$3,'Payout requested')", [req.user.id, -amount, rows[0].id]);
    await notifyAdmins(c, { type: 'payout_request', email: true, link: '/admin', title: 'Payout requested', body: `${req.user.name} requested ${money(amount)} via ${u[0].payout_method}.` });
    return rows[0];
  });
  res.status(201).json({ payout: { id: payout.id, amountMinor: payout.amount_minor, status: payout.status } });
});

module.exports = router;
