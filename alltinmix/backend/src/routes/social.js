const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { HttpError, parse } = require('../lib/util');
const { requireAuth, requireVerified } = require('../lib/auth');
const { notify } = require('../lib/notify');
const { isBlockedBetween } = require('./safety');

const conversations = express.Router();
const notifications = express.Router();
conversations.use(requireAuth);
notifications.use(requireAuth);

const uuid = (v) => /^[0-9a-f-]{36}$/.test(v);

// ------------------------------------------------------------ conversations (inquiries to sellers)

/** Starting a conversation about a listing (this is how real estate and vehicle inquiries work). */
conversations.post('/', requireVerified, async (req, res) => {
  const body = parse(z.object({ listingId: z.string().uuid(), message: z.string().trim().min(1, 'Write a message.').max(2000) }), req.body);
  const result = await db.tx(async (c) => {
    const { rows } = await c.query("SELECT id, seller_id, title FROM listings WHERE id = $1 AND status = 'active'", [body.listingId]);
    const l = rows[0];
    if (!l) throw new HttpError(404, 'Listing not found.');
    if (l.seller_id === req.user.id) throw new HttpError(400, "You can't message yourself about your own listing.");
    if (await isBlockedBetween(req.user.id, l.seller_id, c)) throw new HttpError(403, "You can't message this seller.", { code: 'BLOCKED' });
    const conv = await c.query(
      `INSERT INTO conversations (listing_id, buyer_id, seller_id) VALUES ($1,$2,$3)
       ON CONFLICT (listing_id, buyer_id) DO UPDATE SET last_message_at = now() RETURNING id`,
      [l.id, req.user.id, l.seller_id]
    );
    await c.query('INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1,$2,$3)', [conv.rows[0].id, req.user.id, body.message]);
    await c.query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [conv.rows[0].id]);
    await notify(c, { userId: l.seller_id, type: 'message', email: true, link: `/messages/${conv.rows[0].id}`, title: `New inquiry: ${l.title}`, body: `${req.user.name}: ${body.message.slice(0, 200)}` });
    return { conversationId: conv.rows[0].id };
  });
  res.status(201).json(result);
});

conversations.get('/', async (req, res) => {
  const { rows } = await db.query(
    `SELECT c.id, c.listing_id, c.last_message_at, l.title AS listing_title, l.images AS listing_images,
            CASE WHEN c.buyer_id = $1 THEN s.name ELSE b.name END AS other_name,
            (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
            (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id AND m.sender_id <> $1 AND m.read_at IS NULL) AS unread
     FROM conversations c
     JOIN listings l ON l.id = c.listing_id
     JOIN users b ON b.id = c.buyer_id
     JOIN users s ON s.id = c.seller_id
     WHERE (c.buyer_id = $1 OR c.seller_id = $1)
       AND NOT EXISTS (SELECT 1 FROM blocks k WHERE k.blocker_id = $1 AND k.blocked_id = CASE WHEN c.buyer_id = $1 THEN c.seller_id ELSE c.buyer_id END)
     ORDER BY c.last_message_at DESC LIMIT 100`,
    [req.user.id]
  );
  res.json({
    conversations: rows.map((r) => ({
      id: r.id, listingId: r.listing_id, listingTitle: r.listing_title, listingImage: r.listing_images?.[0] || null,
      otherName: r.other_name, lastMessage: r.last_body, lastMessageAt: r.last_message_at, unread: r.unread,
    })),
  });
});

async function loadConversation(req) {
  if (!uuid(req.params.id)) throw new HttpError(404, 'Conversation not found.');
  const { rows } = await db.query(
    `SELECT c.*, l.title AS listing_title, b.name AS buyer_name, s.name AS seller_name
     FROM conversations c JOIN listings l ON l.id = c.listing_id JOIN users b ON b.id = c.buyer_id JOIN users s ON s.id = c.seller_id WHERE c.id = $1`,
    [req.params.id]
  );
  const c = rows[0];
  if (!c || (c.buyer_id !== req.user.id && c.seller_id !== req.user.id)) throw new HttpError(404, 'Conversation not found.');
  return c;
}

conversations.get('/:id', async (req, res) => {
  const c = await loadConversation(req);
  await db.query('UPDATE messages SET read_at = now() WHERE conversation_id = $1 AND sender_id <> $2 AND read_at IS NULL', [c.id, req.user.id]);
  const { rows } = await db.query('SELECT id, sender_id, body, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 500', [c.id]);
  res.json({
    conversation: { id: c.id, listingId: c.listing_id, listingTitle: c.listing_title, otherId: c.buyer_id === req.user.id ? c.seller_id : c.buyer_id, otherName: c.buyer_id === req.user.id ? c.seller_name : c.buyer_name },
    messages: rows.map((m) => ({ id: m.id, mine: m.sender_id === req.user.id, body: m.body, createdAt: m.created_at })),
  });
});

conversations.post('/:id/messages', async (req, res) => {
  const body = parse(z.object({ body: z.string().trim().min(1, 'Write a message.').max(2000) }), req.body);
  const c = await loadConversation(req);
  const otherId = c.buyer_id === req.user.id ? c.seller_id : c.buyer_id;
  if (await isBlockedBetween(req.user.id, otherId)) throw new HttpError(403, "You can't send messages in this conversation.", { code: 'BLOCKED' });
  await db.tx(async (q) => {
    // Only email the other person if they haven't already got an unread message from this person (avoids spam).
    const { rows } = await q.query('SELECT 1 FROM messages WHERE conversation_id = $1 AND sender_id = $2 AND read_at IS NULL LIMIT 1', [c.id, req.user.id]);
    await q.query('INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1,$2,$3)', [c.id, req.user.id, body.body]);
    await q.query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [c.id]);
    await notify(q, { userId: otherId, type: 'message', email: rows.length === 0, link: `/messages/${c.id}`, title: `New message: ${c.listing_title}`, body: `${req.user.name}: ${body.body.slice(0, 200)}` });
  });
  res.status(201).json({ ok: true });
});

// ------------------------------------------------------------ notifications

notifications.get('/', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
  const { rows: n } = await db.query('SELECT count(*)::int AS unread FROM notifications WHERE user_id = $1 AND NOT is_read', [req.user.id]);
  res.json({
    unread: n[0].unread,
    notifications: rows.map((r) => ({ id: r.id, type: r.type, title: r.title, body: r.body, link: r.link, read: r.is_read, createdAt: r.created_at })),
  });
});

notifications.post('/read-all', async (req, res) => {
  await db.query('UPDATE notifications SET is_read = true WHERE user_id = $1', [req.user.id]);
  res.json({ ok: true });
});

notifications.post('/:id/read', async (req, res) => {
  if (uuid(req.params.id)) await db.query('UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

module.exports = { conversations, notifications };
