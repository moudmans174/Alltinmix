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
  return { availableMinor: r.available, pendingMinor: r.pending, withdrawnMinor: r.withdrawn, lifetimeEarnedMinor: r.lifetime };
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
