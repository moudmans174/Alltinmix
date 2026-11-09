const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const { z } = require('zod');
const db = require('../db');
const config = require('../config');
const { HttpError, parse, toMinor } = require('../lib/util');
const { requireAuth, requireRole } = require('../lib/auth');
const { notify, notifyAdmins } = require('../lib/notify');
const listings = require('./listings');

const UUID = /^[0-9a-f-]{36}$/;
const sellers = express.Router();   // /api/sellers  (public profile + verification)
const growth = express.Router();    // /api/seller   (seller tools)
growth.use(requireAuth, requireRole('seller', 'admin'));

// ------------------------------------------------------------ public seller profile

sellers.get('/:id', async (req, res) => {
  if (!UUID.test(req.params.id)) throw new HttpError(404, 'Seller not found.');
  const { rows } = await db.query(
    `SELECT id, name, tag, role, status, created_at, verification_status FROM users WHERE id = $1`, [req.params.id]);
  const u = rows[0];
  if (!u || u.status !== 'active' || !['seller', 'admin'].includes(u.role)) throw new HttpError(404, 'Seller not found.');
  const [stats, resp] = await Promise.all([
    db.query(
      `SELECT
         (SELECT count(*)::int FROM listings WHERE seller_id = $1 AND status = 'active') AS listings,
         (SELECT count(*)::int FROM orders WHERE seller_id = $1 AND status = 'completed') AS sales,
         (SELECT count(*)::int FROM reviews WHERE seller_id = $1) AS reviews,
         (SELECT COALESCE(round(avg(rating)::numeric, 2), 0) FROM reviews WHERE seller_id = $1) AS rating,
         (SELECT count(*)::int FROM orders WHERE seller_id = $1 AND status IN ('refunded','cancelled','disputed')) AS problems`, [u.id]),
    // How long this seller usually takes to answer a first message.
    db.query(
      `SELECT avg(extract(epoch FROM (s.t - b.t))) AS secs, count(*)::int AS n FROM conversations c
         JOIN LATERAL (SELECT min(created_at) AS t FROM messages WHERE conversation_id = c.id AND sender_id = c.buyer_id) b ON true
         JOIN LATERAL (SELECT min(created_at) AS t FROM messages WHERE conversation_id = c.id AND sender_id = c.seller_id AND created_at > b.t) s ON s.t IS NOT NULL
        WHERE c.seller_id = $1 AND b.t IS NOT NULL`, [u.id]),
  ]);
  const s = stats.rows[0];
  const r = resp.rows[0];
  const { rows: items } = await db.query(`${listings.SELECT} WHERE l.seller_id = $1 AND l.status = 'active' ORDER BY l.created_at DESC LIMIT 48`, [u.id]);
  res.json({
    seller: {
      id: u.id, name: u.name, tag: u.tag, memberSince: u.created_at, verified: u.verification_status === 'approved',
      listingCount: s.listings, salesCount: s.sales, reviewCount: s.reviews, ratingAvg: Number(s.rating), problemOrders: s.problems,
      avgResponseMinutes: r.n >= 3 ? Math.max(1, Math.round(r.secs / 60)) : null,
    },
    listings: items.map((l) => listings.toApi(l)),
  });
});

// ------------------------------------------------------------ seller verification (ID check)

fs.mkdirSync(path.resolve(config.privateDir), { recursive: true });
const MIME_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const docUpload = multer({
  storage: multer.diskStorage({ destination: path.resolve(config.privateDir), filename: (req, file, cb) => cb(null, crypto.randomUUID() + MIME_EXT[file.mimetype]) }),
  limits: { fileSize: config.marketplace.limits.maxImageMB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (MIME_EXT[file.mimetype] ? cb(null, true) : cb(new HttpError(400, 'Upload a JPG, PNG or WebP photo of your ID.', { code: 'BAD_FILE' }))),
});

growth.get('/verification', async (req, res) => {
  const { rows } = await db.query('SELECT verification_status, verification_note, verified_seller_at FROM users WHERE id = $1', [req.user.id]);
  res.json({ status: rows[0].verification_status, note: rows[0].verification_note, verifiedAt: rows[0].verified_seller_at });
});

growth.post('/verification', docUpload.single('document'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Choose a photo of your ID.', { code: 'BAD_FILE' });
  const cur = await db.query('SELECT verification_status, verification_doc FROM users WHERE id = $1', [req.user.id]);
  if (['pending', 'approved'].includes(cur.rows[0].verification_status)) {
    fs.rmSync(req.file.path, { force: true });
    throw new HttpError(400, cur.rows[0].verification_status === 'approved' ? 'You are already verified.' : 'Your ID is already being reviewed.', { code: 'ALREADY' });
  }
  if (cur.rows[0].verification_doc) fs.rmSync(path.join(path.resolve(config.privateDir), cur.rows[0].verification_doc), { force: true });
  const note = z.string().trim().max(300).default('').parse(req.body.note || '');
  await db.query("UPDATE users SET verification_status = 'pending', verification_doc = $2, verification_note = NULL WHERE id = $1", [req.user.id, req.file.filename]);
  await notifyAdmins(db, { type: 'seller_verification', email: true, link: '/admin', title: 'Seller ID to review', body: `${req.user.name} submitted an ID for verification. ${note}`.trim() });
  res.status(201).json({ status: 'pending' });
});

// ------------------------------------------------------------ coupons (seller-funded)

const couponSchema = z.object({
  code: z.string().trim().min(3, 'At least 3 characters.').max(20).regex(/^[A-Za-z0-9_-]+$/, 'Letters, numbers, - and _ only.'),
  percentOff: z.coerce.number().int().min(1).max(90).optional(),
  amountOff: z.coerce.number().positive().optional(),
  minOrder: z.coerce.number().min(0).default(0),
  maxUses: z.coerce.number().int().positive().optional(),
  expiresAt: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
}).refine((d) => (d.percentOff !== undefined) !== (d.amountOff !== undefined), { message: 'Choose either a percentage or a fixed amount.', path: ['percentOff'] });

const couponToApi = (c) => ({
  id: c.id, code: c.code, percentOff: c.percent_off, amountOffMinor: c.amount_off_minor === null ? null : Number(c.amount_off_minor),
  minOrderMinor: Number(c.min_order_minor), maxUses: c.max_uses, usedCount: c.used_count, expiresAt: c.expires_at, active: c.active,
});

growth.get('/coupons', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM coupons WHERE seller_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json({ coupons: rows.map(couponToApi) });
});

growth.post('/coupons', async (req, res) => {
  const b = parse(couponSchema, req.body);
  try {
    const { rows } = await db.query(
      `INSERT INTO coupons (seller_id, code, percent_off, amount_off_minor, min_order_minor, max_uses, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.id, b.code.toUpperCase(), b.percentOff ?? null, b.amountOff ? toMinor(b.amountOff) : null, toMinor(b.minOrder), b.maxUses ?? null, b.expiresAt ?? null]);
    res.status(201).json({ coupon: couponToApi(rows[0]) });
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'That code is taken. Try another.', { code: 'CODE_TAKEN' });
    throw e;
  }
});

growth.patch('/coupons/:id', async (req, res) => {
  if (!UUID.test(req.params.id)) throw new HttpError(404, 'Coupon not found.');
  const { active } = parse(z.object({ active: z.boolean() }), req.body);
  const { rows } = await db.query('UPDATE coupons SET active = $3 WHERE id = $1 AND seller_id = $2 RETURNING *', [req.params.id, req.user.id, active]);
  if (!rows[0]) throw new HttpError(404, 'Coupon not found.');
  res.json({ coupon: couponToApi(rows[0]) });
});

// ------------------------------------------------------------ promoted listings

growth.get('/boost', (req, res) => res.json({ enabled: config.boost.priceMinor > 0, priceMinor: config.boost.priceMinor, days: config.boost.days }));

growth.post('/listings/:id/boost', async (req, res) => {
  if (!UUID.test(req.params.id)) throw new HttpError(404, 'Listing not found.');
  if (config.boost.priceMinor <= 0) throw new HttpError(400, 'Promotions are not available right now.', { code: 'BOOST_OFF' });
  const result = await db.tx(async (c) => {
    await c.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [req.user.id]); // one wallet change at a time
    const { rows } = await c.query("SELECT id, status, promoted_until FROM listings WHERE id = $1 AND seller_id = $2 AND status = 'active'", [req.params.id, req.user.id]);
    if (!rows[0]) throw new HttpError(404, 'Only your active listings can be promoted.');
    const bal = await c.query('SELECT COALESCE(sum(amount_minor),0) AS b FROM wallet_entries WHERE user_id = $1', [req.user.id]);
    if (Number(bal.rows[0].b) < config.boost.priceMinor) throw new HttpError(400, 'Not enough in your wallet. Earnings or a top-up are needed to promote.', { code: 'INSUFFICIENT_FUNDS' });
    await c.query("INSERT INTO wallet_entries (user_id, kind, amount_minor, note) VALUES ($1,'boost',$2,$3)", [req.user.id, -config.boost.priceMinor, `Promoted listing for ${config.boost.days} days`]);
    const up = await c.query(
      `UPDATE listings SET promoted_until = GREATEST(COALESCE(promoted_until, now()), now()) + make_interval(days => $2) WHERE id = $1 RETURNING promoted_until`,
      [req.params.id, config.boost.days]);
    return up.rows[0].promoted_until;
  });
  res.json({ promotedUntil: result });
});

// ------------------------------------------------------------ analytics

growth.get('/analytics', async (req, res) => {
  const [totals, top, daily] = await Promise.all([
    db.query(
      `SELECT COALESCE(sum(views),0)::int AS views,
              (SELECT count(*)::int FROM orders WHERE seller_id = $1 AND status = 'completed') AS sales,
              (SELECT COALESCE(sum(seller_earnings_minor),0) FROM orders WHERE seller_id = $1 AND status = 'completed') AS earned,
              (SELECT count(*)::int FROM wishlist w JOIN listings l2 ON l2.id = w.listing_id WHERE l2.seller_id = $1) AS saves
         FROM listings WHERE seller_id = $1 AND status <> 'deleted'`, [req.user.id]),
    db.query(
      `SELECT l.id, l.title, l.views, l.sold_count, (SELECT count(*)::int FROM wishlist w WHERE w.listing_id = l.id) AS saves
         FROM listings l WHERE l.seller_id = $1 AND l.status <> 'deleted' ORDER BY l.views DESC LIMIT 5`, [req.user.id]),
    db.query(
      `SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
              (SELECT count(*)::int FROM orders o WHERE o.seller_id = $1 AND o.created_at::date = d::date AND o.status NOT IN ('awaiting_payment','cancelled')) AS orders
         FROM generate_series(current_date - 13, current_date, '1 day') d ORDER BY d`, [req.user.id]),
  ]);
  const t = totals.rows[0];
  res.json({
    views: t.views, sales: t.sales, earnedMinor: Number(t.earned), saves: t.saves,
    conversionPct: t.views ? Math.round((t.sales / t.views) * 1000) / 10 : 0,
    topListings: top.rows.map((r) => ({ id: r.id, title: r.title, views: r.views, sold: r.sold_count, saves: r.saves })),
    daily: daily.rows,
  });
});

// ------------------------------------------------------------ CSV bulk upload

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') q = false; else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

const CSV_MAX_ROWS = 100;
growth.post('/listings/bulk', express.json({ limit: '500kb' }), async (req, res) => {
  const { csv } = parse(z.object({ csv: z.string().min(1).max(400_000) }), req.body);
  const table = parseCsv(csv.replace(/^﻿/, ''));
  const header = (table.shift() || []).map((h) => h.trim().toLowerCase());
  for (const need of ['type', 'category', 'title', 'price']) {
    if (!header.includes(need)) throw new HttpError(400, `The first row must include a "${need}" column.`, { code: 'BAD_CSV' });
  }
  if (!table.length) throw new HttpError(400, 'The file has no listings in it.', { code: 'BAD_CSV' });
  if (table.length > CSV_MAX_ROWS) throw new HttpError(400, `Upload at most ${CSV_MAX_ROWS} listings at a time.`, { code: 'BAD_CSV' });
  const created = [];
  const errors = [];
  for (let i = 0; i < table.length; i++) {
    const rec = Object.fromEntries(header.map((h, j) => [h, (table[i][j] ?? '').trim()]));
    try {
      const data = listings.toColumns(parse(listings.listingSchema, {
        type: rec.type, category: rec.category, title: rec.title, description: rec.description || '', price: rec.price,
        location: rec.location || '', stock: rec.stock, fulfillment: rec.fulfillment || (config.verticalOf(rec.type)?.commerce === 'product' ? 'physical' : undefined),
        deliveryDays: rec.deliverydays, shippingDays: rec.shippingdays, images: [], attributes: {},
      }));
      created.push(await listings.insertListing(req.user.id, data));
    } catch (e) {
      const msg = e instanceof HttpError ? (e.details?.[0] ? `${e.details[0].path}: ${e.details[0].message}` : e.message) : 'Could not read this row.';
      if (!(e instanceof HttpError)) console.error('[bulk]', e);
      errors.push({ row: i + 2, error: msg });
    }
  }
  res.status(created.length ? 201 : 400).json({ created: created.length, errors });
});

// ------------------------------------------------------------ admin: review verification

const admin = express.Router();
admin.use(requireAuth, requireRole('admin'));

admin.get('/verifications', async (req, res) => {
  const { rows } = await db.query("SELECT id, name, email, phone, created_at FROM users WHERE verification_status = 'pending' ORDER BY created_at");
  res.json({ sellers: rows.map((r) => ({ id: r.id, name: r.name, email: r.email, phone: r.phone, createdAt: r.created_at })) });
});

/** The ID photo is private: only an admin who is signed in can fetch it. */
admin.get('/verifications/:id/document', async (req, res) => {
  if (!UUID.test(req.params.id)) throw new HttpError(404, 'Not found.');
  const { rows } = await db.query('SELECT verification_doc FROM users WHERE id = $1', [req.params.id]);
  const f = rows[0]?.verification_doc;
  if (!f || !/^[a-f0-9-]{36}\.(jpg|png|webp)$/.test(f)) throw new HttpError(404, 'No document.');
  res.set('Cache-Control', 'private, no-store');
  res.sendFile(path.join(path.resolve(config.privateDir), f));
});

admin.post('/verifications/:id/decide', async (req, res) => {
  if (!UUID.test(req.params.id)) throw new HttpError(404, 'Not found.');
  const b = parse(z.object({ approve: z.boolean(), note: z.string().trim().max(300).optional() }), req.body);
  if (!b.approve && !b.note) throw new HttpError(400, 'Tell the seller why it was rejected.', { code: 'VALIDATION' });
  const { rows } = await db.query(
    `UPDATE users SET verification_status = $2, verified_seller_at = CASE WHEN $2 = 'approved' THEN now() END, verification_note = $3
      WHERE id = $1 AND verification_status = 'pending' RETURNING id, verification_doc`,
    [req.params.id, b.approve ? 'approved' : 'rejected', b.approve ? null : b.note]);
  if (!rows[0]) throw new HttpError(404, 'Nothing pending for that seller.');
  // Once decided, the ID photo is no longer needed. Keep as little personal data as possible.
  if (rows[0].verification_doc) fs.rmSync(path.join(path.resolve(config.privateDir), rows[0].verification_doc), { force: true });
  await db.query('UPDATE users SET verification_doc = NULL WHERE id = $1', [req.params.id]);
  await db.query('INSERT INTO admin_audit (admin_id, action, target, details) VALUES ($1,$2,$3,$4)', [req.user.id, b.approve ? 'seller.verify' : 'seller.verify_reject', req.params.id, JSON.stringify(b)]).catch(() => {});
  await notify(db, { userId: req.params.id, type: 'verification', link: '/seller', title: b.approve ? 'You are now a verified seller' : 'Verification not approved', body: b.approve ? 'Buyers will now see a verified badge on your listings.' : b.note });
  res.json({ ok: true });
});

module.exports = { sellers, growth, adminVerification: admin };
