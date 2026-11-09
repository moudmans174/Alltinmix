const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { HttpError, parse } = require('../lib/util');
const { requireAuth, verifyPassword, hashPassword } = require('../lib/auth');
const { notifyAdmins } = require('../lib/notify');
const crypto = require('node:crypto');

const reports = express.Router();
const blocks = express.Router();
const account = express.Router();
reports.use(requireAuth);
blocks.use(requireAuth);
account.use(requireAuth);

const REASONS = ['spam', 'scam_fraud', 'offensive', 'illegal', 'wrong_category', 'other'];

// ------------------------------------------------------------ reports (user-generated content)

reports.post('/', async (req, res) => {
  const body = parse(z.object({
    targetType: z.enum(['listing', 'user', 'message']),
    targetId: z.string().uuid(),
    reason: z.enum(REASONS),
    details: z.string().trim().max(1000).optional(),
  }), req.body);
  const table = { listing: 'listings', user: 'users', message: 'messages' }[body.targetType];
  const { rows } = await db.query(`SELECT id FROM ${table} WHERE id = $1`, [body.targetId]);
  if (!rows[0]) throw new HttpError(404, 'We could not find what you are reporting.');
  if (body.targetType === 'user' && body.targetId === req.user.id) throw new HttpError(400, "You can't report yourself.");
  if (body.targetType === 'message') {
    // You may only report messages from conversations you are part of.
    const m = await db.query('SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = $1 AND (c.buyer_id = $2 OR c.seller_id = $2)', [body.targetId, req.user.id]);
    if (!m.rows[0]) throw new HttpError(404, 'We could not find what you are reporting.');
  }
  const ins = await db.query(
    `INSERT INTO reports (reporter_id, target_type, target_id, reason, details) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT DO NOTHING RETURNING id`,
    [req.user.id, body.targetType, body.targetId, body.reason, body.details || '']
  );
  if (ins.rows[0]) {
    await db.tx((c) => notifyAdmins(c, { type: 'report', link: '/admin', title: `New report: ${body.targetType}`, body: `${body.reason.replace('_', ' ')}${body.details ? ': ' + body.details.slice(0, 150) : ''}` }));
  }
  res.status(201).json({ ok: true });
});

// ------------------------------------------------------------ blocking

blocks.get('/', async (req, res) => {
  const { rows } = await db.query('SELECT u.id, u.name FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = $1 ORDER BY b.created_at DESC', [req.user.id]);
  res.json({ blocked: rows });
});

blocks.post('/', async (req, res) => {
  const { userId } = parse(z.object({ userId: z.string().uuid() }), req.body);
  if (userId === req.user.id) throw new HttpError(400, "You can't block yourself.");
  const u = await db.query('SELECT id FROM users WHERE id = $1', [userId]);
  if (!u.rows[0]) throw new HttpError(404, 'User not found.');
  await db.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, userId]);
  res.status(201).json({ ok: true });
});

blocks.delete('/:userId', async (req, res) => {
  if (/^[0-9a-f-]{36}$/.test(req.params.userId)) await db.query('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [req.user.id, req.params.userId]);
  res.json({ ok: true });
});

/** True if either person has blocked the other. */
async function isBlockedBetween(a, b, q = db) {
  const { rows } = await q.query('SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1) LIMIT 1', [a, b]);
  return !!rows[0];
}

// ------------------------------------------------------------ account deletion

account.delete('/', async (req, res) => {
  const { password } = parse(z.object({ password: z.string().min(1).max(200) }), req.body);
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const user = rows[0];
  if (!(await verifyPassword(password, user.password_hash))) throw new HttpError(403, 'That password is not correct.', { code: 'BAD_CREDENTIALS' });
  if (user.role === 'admin') throw new HttpError(400, 'Admin accounts cannot be deleted here. Ask another admin to change your role first.');

  await db.tx(async (c) => {
    await c.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    const open = await c.query(
      "SELECT count(*)::int AS n FROM orders WHERE (buyer_id = $1 OR seller_id = $1) AND status IN ('awaiting_payment','pending_acceptance','in_progress','delivered','disputed')",
      [req.user.id]
    );
    if (open.rows[0].n > 0) throw new HttpError(409, 'You still have orders in progress. Finish or cancel them first, then delete your account.', { code: 'ACTIVE_ORDERS' });
    const bal = await c.query('SELECT COALESCE(sum(amount_minor),0)::bigint AS n FROM wallet_entries WHERE user_id = $1', [req.user.id]);
    const pend = await c.query("SELECT count(*)::int AS n FROM payouts WHERE user_id = $1 AND status = 'requested'", [req.user.id]);
    if (Number(bal.rows[0].n) !== 0 || pend.rows[0].n > 0) throw new HttpError(409, 'Your wallet balance is not zero (or a withdrawal is in progress). Withdraw what you are owed, or settle what you owe, then delete your account.', { code: 'WALLET_NOT_EMPTY' });

    const dead = await hashPassword(crypto.randomBytes(24).toString('hex'));
    await c.query(
      `UPDATE users SET name = 'Deleted user', email = $2, phone = NULL, tag = '', payout_method = NULL, payout_details = NULL,
         password_hash = $3, status = 'deleted', deleted_at = now(), token_version = token_version + 1, updated_at = now() WHERE id = $1`,
      [req.user.id, `deleted-${crypto.randomUUID()}@deleted.invalid`, dead]
    );
    await c.query('DELETE FROM auth_tokens WHERE user_id = $1', [req.user.id]);
    await c.query('DELETE FROM notifications WHERE user_id = $1', [req.user.id]);
    await c.query('DELETE FROM conversations WHERE buyer_id = $1 OR seller_id = $1', [req.user.id]);
    await c.query('DELETE FROM blocks WHERE blocker_id = $1', [req.user.id]);
    await c.query("UPDATE listings SET status = 'deleted', updated_at = now() WHERE seller_id = $1 AND status <> 'deleted'", [req.user.id]);
  });
  res.json({ ok: true });
});

module.exports = { reports, blocks, account, isBlockedBetween };
