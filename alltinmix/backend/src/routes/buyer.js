const express = require('express');
const { z } = require('zod');
const db = require('../db');
const config = require('../config');
const { HttpError, parse, toMinor } = require('../lib/util');
const { requireAuth, requireVerified } = require('../lib/auth');
const { notify } = require('../lib/notify');
const { toApi, SELECT } = require('./listings');

const wishlist = express.Router();
const offers = express.Router();
wishlist.use(requireAuth);
offers.use(requireAuth);

const money = (minor) => `${config.marketplace.currency.symbol}${(Number(minor) / 10 ** config.marketplace.currency.decimals).toLocaleString()}`;
const isId = (s) => /^[0-9a-f-]{36}$/.test(String(s));
const OFFER_HOURS = 48;

// ------------------------------------------------------------ wishlist

wishlist.get('/', async (req, res) => {
  const { rows } = await db.query(
    `${SELECT} JOIN wishlist w ON w.listing_id = l.id WHERE w.user_id = $1 AND l.status = 'active'
       AND l.seller_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = $1) ORDER BY w.created_at DESC LIMIT 200`,
    [req.user.id]
  );
  res.json({ listings: rows.map((r) => toApi(r)) });
});

wishlist.get('/ids', async (req, res) => {
  const { rows } = await db.query('SELECT listing_id FROM wishlist WHERE user_id = $1', [req.user.id]);
  res.json({ ids: rows.map((r) => r.listing_id) });
});

wishlist.post('/', async (req, res) => {
  const { listingId } = parse(z.object({ listingId: z.string().uuid() }), req.body);
  const l = await db.query("SELECT id FROM listings WHERE id = $1 AND status = 'active'", [listingId]);
  if (!l.rows[0]) throw new HttpError(404, 'Listing not found.');
  const n = await db.query('SELECT count(*)::int AS n FROM wishlist WHERE user_id = $1', [req.user.id]);
  if (n.rows[0].n >= 500) throw new HttpError(400, 'Your wishlist is full.');
  await db.query('INSERT INTO wishlist (user_id, listing_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, listingId]);
  res.status(201).json({ ok: true });
});

wishlist.delete('/:listingId', async (req, res) => {
  if (isId(req.params.listingId)) await db.query('DELETE FROM wishlist WHERE user_id = $1 AND listing_id = $2', [req.user.id, req.params.listingId]);
  res.json({ ok: true });
});

// ------------------------------------------------------------ offers (haggling)

const OFFER_SELECT = `SELECT o.*, l.title, l.price_minor AS list_price_minor, l.images, l.status AS listing_status, l.stock,
                             b.name AS buyer_name, s.name AS seller_name
                      FROM offers o JOIN listings l ON l.id = o.listing_id JOIN users b ON b.id = o.buyer_id JOIN users s ON s.id = o.seller_id`;

function offerToApi(r, viewer) {
  const open = ['pending', 'countered', 'accepted'].includes(r.status);
  const expired = open && new Date(r.expires_at) < new Date();
  return {
    id: r.id, listingId: r.listing_id, title: r.title, image: r.images?.[0] || null, listPriceMinor: r.list_price_minor,
    qty: r.qty, amountMinor: r.amount_minor, counterMinor: r.counter_minor, agreedMinor: r.agreed_minor, message: r.message,
    status: expired ? 'expired' : r.status, expiresAt: r.expires_at, createdAt: r.created_at,
    buyerName: r.buyer_name, sellerName: r.seller_name, mine: r.buyer_id === viewer,
  };
}

offers.post('/', requireVerified, async (req, res) => {
  const body = parse(z.object({
    listingId: z.string().uuid(),
    amount: z.coerce.number().positive('Enter your offer.'),
    qty: z.coerce.number().int().min(1).max(100).default(1),
    message: z.string().trim().max(300).default(''),
  }), req.body);
  const { rows } = await db.query("SELECT * FROM listings WHERE id = $1 AND status = 'active'", [body.listingId]);
  const l = rows[0];
  if (!l) throw new HttpError(404, 'Listing not found.');
  const vertical = config.verticalOf(l.type);
  if (!vertical || vertical.mode !== 'checkout') throw new HttpError(400, 'Message the seller to agree a price on this one.', { code: 'INQUIRY_ONLY' });
  if (l.seller_id === req.user.id) throw new HttpError(400, "You can't make an offer on your own listing.");
  const blocked = await db.query('SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)', [req.user.id, l.seller_id]);
  if (blocked.rowCount) throw new HttpError(403, "You can't make an offer to this seller.", { code: 'BLOCKED' });
  const qty = vertical.commerce === 'service' || l.fulfillment === 'digital' ? 1 : body.qty;
  if (l.stock !== null && l.stock < qty) throw new HttpError(409, `Only ${l.stock} left.`, { code: 'OUT_OF_STOCK' });
  const minor = toMinor(body.amount);
  if (minor >= l.price_minor) throw new HttpError(400, `Your offer must be below the listed price of ${money(l.price_minor)}. You can buy at the listed price instead.`, { code: 'OFFER_TOO_HIGH' });
  if (minor < Math.ceil(l.price_minor / 2)) throw new HttpError(400, `Offers must be at least half the listed price (${money(Math.ceil(l.price_minor / 2))}).`, { code: 'OFFER_TOO_LOW' });
  await db.query("UPDATE offers SET status = 'expired' WHERE buyer_id = $1 AND listing_id = $2 AND status IN ('pending','countered','accepted') AND expires_at < now()", [req.user.id, l.id]);
  const created = await db.tx(async (c) => {
    let r;
    try {
      r = await c.query(
        `INSERT INTO offers (listing_id, buyer_id, seller_id, qty, amount_minor, message, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(hours => $7)) RETURNING id`,
        [l.id, req.user.id, l.seller_id, qty, minor, body.message, OFFER_HOURS]
      );
    } catch (err) {
      if (err.code === '23505') throw new HttpError(409, 'You already have an open offer on this listing.', { code: 'OFFER_EXISTS' });
      throw err;
    }
    await notify(c, { userId: l.seller_id, type: 'offer', email: true, sms: true, link: '/seller/offers', title: `New offer on ${l.title}`, body: `${req.user.name} offers ${money(minor)}${qty > 1 ? ` each for ${qty}` : ''} (listed ${money(l.price_minor)}). Reply within ${OFFER_HOURS} hours.` });
    return r.rows[0].id;
  });
  res.status(201).json({ id: created });
});

offers.get('/mine', async (req, res) => {
  const { rows } = await db.query(`${OFFER_SELECT} WHERE o.buyer_id = $1 ORDER BY o.created_at DESC LIMIT 100`, [req.user.id]);
  res.json({ offers: rows.map((r) => offerToApi(r, req.user.id)) });
});

offers.get('/received', async (req, res) => {
  const { rows } = await db.query(`${OFFER_SELECT} WHERE o.seller_id = $1 ORDER BY o.created_at DESC LIMIT 100`, [req.user.id]);
  res.json({ offers: rows.map((r) => offerToApi(r, req.user.id)) });
});

/** Seller answers: accept, decline or counter. */
offers.post('/:id/respond', async (req, res) => {
  if (!isId(req.params.id)) throw new HttpError(404, 'Offer not found.');
  const body = parse(z.object({ action: z.enum(['accept', 'decline', 'counter']), counter: z.coerce.number().positive().optional() }), req.body);
  await db.tx(async (c) => {
    const { rows } = await c.query(`${OFFER_SELECT} WHERE o.id = $1 FOR UPDATE OF o`, [req.params.id]);
    const o = rows[0];
    if (!o || o.seller_id !== req.user.id) throw new HttpError(404, 'Offer not found.');
    if (o.status !== 'pending' || new Date(o.expires_at) < new Date()) throw new HttpError(409, 'This offer is no longer open.', { code: 'BAD_STATE' });
    if (body.action === 'accept') {
      await c.query("UPDATE offers SET status = 'accepted', agreed_minor = amount_minor, expires_at = now() + make_interval(hours => $2), updated_at = now() WHERE id = $1", [o.id, OFFER_HOURS]);
      await notify(c, { userId: o.buyer_id, type: 'offer', email: true, sms: true, link: '/offers', title: `Offer accepted: ${o.title}`, body: `The seller accepted ${money(o.amount_minor)}. Buy it within ${OFFER_HOURS} hours at that price.` });
    } else if (body.action === 'decline') {
      await c.query("UPDATE offers SET status = 'declined', updated_at = now() WHERE id = $1", [o.id]);
      await notify(c, { userId: o.buyer_id, type: 'offer', email: true, link: '/offers', title: `Offer declined: ${o.title}`, body: 'The seller did not accept your price. You can still buy at the listed price.' });
    } else {
      const minor = toMinor(body.counter || 0);
      if (!(minor > o.amount_minor && minor < o.list_price_minor)) throw new HttpError(400, `A counter-offer must be above ${money(o.amount_minor)} and below the listed price of ${money(o.list_price_minor)}.`, { code: 'BAD_COUNTER' });
      await c.query("UPDATE offers SET status = 'countered', counter_minor = $2, expires_at = now() + make_interval(hours => $3), updated_at = now() WHERE id = $1", [o.id, minor, OFFER_HOURS]);
      await notify(c, { userId: o.buyer_id, type: 'offer', email: true, sms: true, link: '/offers', title: `Counter-offer: ${o.title}`, body: `The seller counters with ${money(minor)}. Accept it within ${OFFER_HOURS} hours.` });
    }
  });
  res.json({ ok: true });
});

/** Buyer answers a counter-offer, or withdraws an open offer. */
offers.post('/:id/buyer', async (req, res) => {
  if (!isId(req.params.id)) throw new HttpError(404, 'Offer not found.');
  const body = parse(z.object({ action: z.enum(['accept', 'withdraw']) }), req.body);
  await db.tx(async (c) => {
    const { rows } = await c.query(`${OFFER_SELECT} WHERE o.id = $1 FOR UPDATE OF o`, [req.params.id]);
    const o = rows[0];
    if (!o || o.buyer_id !== req.user.id) throw new HttpError(404, 'Offer not found.');
    const open = ['pending', 'countered', 'accepted'].includes(o.status) && new Date(o.expires_at) >= new Date();
    if (!open) throw new HttpError(409, 'This offer is no longer open.', { code: 'BAD_STATE' });
    if (body.action === 'withdraw') {
      await c.query("UPDATE offers SET status = 'withdrawn', updated_at = now() WHERE id = $1", [o.id]);
    } else {
      if (o.status !== 'countered') throw new HttpError(409, 'There is no counter-offer to accept.', { code: 'BAD_STATE' });
      await c.query("UPDATE offers SET status = 'accepted', agreed_minor = counter_minor, expires_at = now() + make_interval(hours => $2), updated_at = now() WHERE id = $1", [o.id, OFFER_HOURS]);
      await notify(c, { userId: o.seller_id, type: 'offer', link: '/seller/offers', title: `Counter-offer accepted: ${o.title}`, body: `The buyer accepted ${money(o.counter_minor)}. They can now check out at that price.` });
    }
  });
  res.json({ ok: true });
});

const expireOffers = () => db.query("UPDATE offers SET status = 'expired', updated_at = now() WHERE status IN ('pending','countered','accepted') AND expires_at < now()");

module.exports = { wishlist, offers, expireOffers };
