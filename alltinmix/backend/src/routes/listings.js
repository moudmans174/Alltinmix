const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const db = require('../db');
const config = require('../config');
const { HttpError, parse, toMinor, toMajor, paging, cleanAttributes } = require('../lib/util');
const { requireAuth, optionalAuth, requireRole, requireVerified } = require('../lib/auth');

const router = express.Router();
const uploads = express.Router();

// ------------------------------------------------------------ serialization

function toApi(r, { priv = false } = {}) {
  const vertical = config.verticalOf(r.type);
  return {
    id: r.id,
    sellerId: r.seller_id,
    sellerName: r.seller_name,
    sellerTag: r.seller_tag,
    type: r.type,
    mode: vertical ? vertical.mode : 'checkout',
    category: r.category,
    title: r.title,
    description: r.description,
    priceMinor: r.price_minor,
    currency: r.currency,
    status: r.status,
    location: r.location,
    attributes: r.attributes,
    images: r.images,
    deliveryDays: r.delivery_days,
    fulfillment: r.fulfillment,
    stock: r.stock,
    shippingDays: r.shipping_days,
    ratingAvg: Number(r.rating_avg),
    ratingCount: r.rating_count,
    soldCount: r.sold_count,
    sellerVerified: !!r.seller_verified,
    promoted: !!(r.promoted_until && new Date(r.promoted_until) > new Date()),
    ...(priv ? { views: r.views, promotedUntil: r.promoted_until } : {}),
    createdAt: r.created_at,
    // The digital delivery link is private to the seller until a buyer pays.
    ...(priv ? { deliveryUrl: r.delivery_url } : {}),
  };
}

const SELECT = `SELECT l.*, u.name AS seller_name, u.tag AS seller_tag, (u.verification_status = 'approved') AS seller_verified FROM listings l JOIN users u ON u.id = l.seller_id`;

// ------------------------------------------------------------ validation

const IMAGE_RE = /^\/uploads\/[a-f0-9-]{36}\.(jpg|png|webp)$/;
const optNum = (schema) => z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional());

const listingSchema = z.object({
  type: z.string().min(1),
  category: z.string().min(1),
  title: z.string().trim().min(3, 'Title is too short.').max(140),
  description: z.string().trim().max(5000).default(''),
  price: z.coerce.number({ error: 'Enter a price.' }).positive('Price must be greater than zero.').max(1_000_000_000),
  location: z.string().trim().max(120).default(''),
  images: z.array(z.string().regex(IMAGE_RE, 'Invalid image.')).max(config.marketplace.limits.maxImagesPerListing).default([]),
  attributes: z.record(z.string(), z.any()).default({}),
  deliveryDays: optNum(z.coerce.number().int().min(1).max(365)),
  fulfillment: optNum(z.enum(['physical', 'digital'])),
  stock: optNum(z.coerce.number().int().min(0).max(1_000_000)),
  shippingDays: optNum(z.coerce.number().int().min(1).max(90)),
  deliveryUrl: optNum(z.string().url().max(1000).refine((u) => u.startsWith('https://'), 'Use a secure https:// link.')),
});

/** Apply the rules of the listing's vertical (from the config) and return the DB columns. */
function toColumns(data) {
  const vertical = config.verticalOf(data.type);
  if (!vertical) throw new HttpError(400, 'Unknown listing type.', { code: 'VALIDATION', details: [{ path: 'type', message: 'Unknown listing type.' }] });
  if (!vertical.categories.includes(data.category)) throw new HttpError(400, 'Please choose a valid category.', { code: 'VALIDATION', details: [{ path: 'category', message: 'Choose a category from the list.' }] });
  const need = (cond, path, message) => {
    if (!cond) throw new HttpError(400, message, { code: 'VALIDATION', details: [{ path, message }] });
  };
  const cols = { delivery_days: null, fulfillment: null, stock: null, shipping_days: null, delivery_url: null };
  if (vertical.commerce === 'service') {
    need(data.deliveryDays, 'deliveryDays', 'Enter how many days delivery takes.');
    cols.delivery_days = data.deliveryDays;
  } else if (vertical.commerce === 'product') {
    need(data.fulfillment, 'fulfillment', 'Choose physical or digital.');
    need(config.allowDigital || data.fulfillment !== 'digital', 'fulfillment', 'Digital goods are not available on this marketplace.');
    cols.fulfillment = data.fulfillment;
    if (data.fulfillment === 'physical') {
      need(data.stock !== undefined, 'stock', 'Enter how many are in stock.');
      cols.stock = data.stock;
      cols.shipping_days = data.shippingDays || 3;
    } else {
      need(data.deliveryUrl, 'deliveryUrl', 'Add the private download link buyers receive after paying.');
      cols.delivery_url = data.deliveryUrl;
    }
  }
  return { ...cols, type: data.type, category: data.category, title: data.title, description: data.description, location: data.location, images: data.images, price_minor: toMinor(data.price), attributes: cleanAttributes(vertical.fields, data.attributes) };
}

// ------------------------------------------------------------ routes

router.get('/', optionalAuth, async (req, res) => {
  const q = req.query;
  const where = ["l.status = 'active'"];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replaceAll('?', `$${params.length}`)); // one value can fill several columns
  };
  if (q.type && q.type !== 'all') add('l.type = ?', String(q.type));
  if (q.category && q.category !== 'All') add('l.category = ?', String(q.category));
  if (q.q) add('(l.title ILIKE ? OR l.description ILIKE ? OR u.name ILIKE ?)', `%${String(q.q).slice(0, 80)}%`);
  if (q.location) add('l.location ILIKE ?', `%${String(q.location).slice(0, 80)}%`);
  if (q.minPrice && Number.isFinite(Number(q.minPrice))) add('l.price_minor >= ?', toMinor(q.minPrice));
  if (q.maxPrice && Number.isFinite(Number(q.maxPrice))) add('l.price_minor <= ?', toMinor(q.maxPrice));
  if (q.verified === '1') add("u.verification_status = 'approved' AND ?::int = 1", 1);
  if (q.seller) add('l.seller_id = ?', String(q.seller));
  if (req.user) add('l.seller_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)', req.user.id);
  const boosted = q.sort ? '' : '(l.promoted_until IS NOT NULL AND l.promoted_until > now()) DESC, ';
  const order = boosted + ({ price_asc: 'l.price_minor ASC', price_desc: 'l.price_minor DESC', rating: 'l.rating_avg DESC, l.rating_count DESC', popular: 'l.sold_count DESC' }[q.sort] || 'l.created_at DESC');
  const { limit, page, offset } = paging(q, { defaultLimit: 24, max: 48 });
  const sqlWhere = where.join(' AND ');
  const [{ rows }, { rows: total }] = await Promise.all([
    db.query(`${SELECT} WHERE ${sqlWhere} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, params),
    db.query(`SELECT count(*)::int AS n FROM listings l JOIN users u ON u.id = l.seller_id WHERE ${sqlWhere}`, params),
  ]);
  res.json({ listings: rows.map((r) => toApi(r)), total: total[0].n, page, pages: Math.max(1, Math.ceil(total[0].n / limit)) });
});

router.get('/mine', requireAuth, requireRole('seller', 'admin'), async (req, res) => {
  const { rows } = await db.query(`${SELECT} WHERE l.seller_id = $1 AND l.status <> 'deleted' ORDER BY l.created_at DESC`, [req.user.id]);
  res.json({ listings: rows.map((r) => toApi(r, { priv: true })) });
});

router.get('/:id', optionalAuth, async (req, res) => {
  if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw new HttpError(404, 'Listing not found.');
  const { rows } = await db.query(`${SELECT} WHERE l.id = $1`, [req.params.id]);
  const l = rows[0];
  const isOwner = l && req.user && (req.user.id === l.seller_id || req.user.role === 'admin');
  if (!l || l.status === 'deleted' || (l.status !== 'active' && !isOwner)) throw new HttpError(404, 'Listing not found.');
  if (!isOwner && l.status === 'active') db.query('UPDATE listings SET views = views + 1 WHERE id = $1', [l.id]).catch(() => {});
  const { rows: reviews } = await db.query(
    'SELECT r.rating, r.comment, r.images, r.created_at, u.name AS reviewer FROM reviews r JOIN users u ON u.id = r.reviewer_id WHERE r.listing_id = $1 ORDER BY r.created_at DESC LIMIT 10',
    [l.id]
  );
  res.json({ listing: toApi(l, { priv: isOwner }), reviews: reviews.map((r) => ({ rating: r.rating, comment: r.comment, reviewer: r.reviewer, images: r.images, createdAt: r.created_at })) });
});

async function insertListing(sellerId, data) {
  const { rows } = await db.query(
    `INSERT INTO listings (seller_id, type, category, title, description, price_minor, currency, location, attributes, images, delivery_days, fulfillment, stock, shipping_days, delivery_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [sellerId, data.type, data.category, data.title, data.description, data.price_minor, config.marketplace.currency.code, data.location, JSON.stringify(data.attributes), JSON.stringify(data.images), data.delivery_days, data.fulfillment, data.stock, data.shipping_days, data.delivery_url]
  );
  return rows[0].id;
}

router.post('/', requireAuth, requireRole('seller', 'admin'), requireVerified, async (req, res) => {
  const id = await insertListing(req.user.id, toColumns(parse(listingSchema, req.body)));
  const full = await db.query(`${SELECT} WHERE l.id = $1`, [id]);
  res.status(201).json({ listing: toApi(full.rows[0], { priv: true }) });
});

async function ownedListing(req) {
  const { rows } = await db.query('SELECT * FROM listings WHERE id = $1', [req.params.id]);
  const l = rows[0];
  if (!l || l.status === 'deleted') throw new HttpError(404, 'Listing not found.');
  if (l.seller_id !== req.user.id && req.user.role !== 'admin') throw new HttpError(403, 'This is not your listing.', { code: 'FORBIDDEN' });
  return l;
}

router.put('/:id', requireAuth, requireRole('seller', 'admin'), async (req, res) => {
  const l = await ownedListing(req);
  // Merge the stored listing with the changes, then validate the whole thing again.
  const current = {
    type: l.type, category: l.category, title: l.title, description: l.description, price: toMajor(l.price_minor), location: l.location,
    images: l.images, attributes: l.attributes, deliveryDays: l.delivery_days ?? undefined, fulfillment: l.fulfillment ?? undefined,
    stock: l.stock ?? undefined, shippingDays: l.shipping_days ?? undefined, deliveryUrl: l.delivery_url ?? undefined,
  };
  const data = toColumns(parse(listingSchema, { ...current, ...req.body, type: l.type }));
  await db.query(
    `UPDATE listings SET category=$2, title=$3, description=$4, price_minor=$5, location=$6, attributes=$7, images=$8,
       delivery_days=$9, fulfillment=$10, stock=$11, shipping_days=$12, delivery_url=$13, updated_at=now() WHERE id=$1`,
    [l.id, data.category, data.title, data.description, data.price_minor, data.location, JSON.stringify(data.attributes), JSON.stringify(data.images), data.delivery_days, data.fulfillment, data.stock, data.shipping_days, data.delivery_url]
  );
  const full = await db.query(`${SELECT} WHERE l.id = $1`, [l.id]);
  res.json({ listing: toApi(full.rows[0], { priv: true }) });
});

// Sellers can pause/resume/mark sold. "hidden" is an admin moderation state that sellers can't undo.
router.patch('/:id/status', requireAuth, requireRole('seller', 'admin'), async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['active', 'paused', 'sold']) }), req.body);
  const l = await ownedListing(req);
  if (l.status === 'hidden' && req.user.role !== 'admin') throw new HttpError(403, 'This listing was hidden by a moderator. Contact support.', { code: 'FORBIDDEN' });
  await db.query('UPDATE listings SET status = $2, updated_at = now() WHERE id = $1', [l.id, status]);
  res.json({ ok: true, status });
});

// Deleting hides the listing but keeps order history and conversations intact.
router.delete('/:id', requireAuth, requireRole('seller', 'admin'), async (req, res) => {
  const l = await ownedListing(req);
  await db.query("UPDATE listings SET status = 'deleted', updated_at = now() WHERE id = $1", [l.id]);
  res.json({ ok: true });
});

// ------------------------------------------------------------ image uploads

const MIME_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
fs.mkdirSync(path.resolve(config.uploadDir), { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: path.resolve(config.uploadDir),
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + MIME_EXT[file.mimetype]),
  }),
  limits: { fileSize: config.marketplace.limits.maxImageMB * 1024 * 1024, files: config.marketplace.limits.maxImagesPerListing },
  fileFilter: (req, file, cb) => (MIME_EXT[file.mimetype] ? cb(null, true) : cb(new HttpError(400, 'Only JPG, PNG or WebP images are allowed.', { code: 'BAD_FILE' }))),
});

/** The browser-reported MIME type can be faked, so check the file's real signature too. */
function looksLikeImage(file) {
  const fd = fs.openSync(file.path, 'r');
  const buf = Buffer.alloc(12);
  fs.readSync(fd, buf, 0, 12, 0);
  fs.closeSync(fd);
  if (file.mimetype === 'image/jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (file.mimetype === 'image/png') return buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (file.mimetype === 'image/webp') return buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
  return false;
}

function handleUpload(req, res) {
  const files = req.files || [];
  if (!files.length) throw new HttpError(400, 'Choose at least one image.', { code: 'BAD_FILE' });
  const urls = [];
  for (const f of files) {
    if (!looksLikeImage(f)) {
      files.forEach((x) => fs.rmSync(x.path, { force: true }));
      throw new HttpError(400, 'One of the files is not a valid image.', { code: 'BAD_FILE' });
    }
    urls.push('/uploads/' + f.filename);
  }
  res.status(201).json({ urls });
}
uploads.post('/', requireAuth, requireRole('seller', 'admin'), upload.array('images', config.marketplace.limits.maxImagesPerListing), handleUpload);
// Buyers can attach up to 3 photos to a review.
uploads.post('/review', requireAuth, requireVerified, upload.array('images', 3), handleUpload);

module.exports = { listings: router, uploads, toApi, SELECT, IMAGE_RE, insertListing, listingSchema, toColumns };
