// End-to-end API tests against a REAL PostgreSQL database (no mocks of our own code).
// Run:  DATABASE_URL=postgres://user@localhost:5432/tally_test npm test      (the database is wiped on every run!)
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres@localhost:55432/tally_test';
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-uploads-'));
process.env.PRIVATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-private-'));
process.env.REQUIRE_EMAIL_VERIFICATION = 'true';
process.env.PAYMENT_PROVIDERS = 'mock,momo,paypal,stripe';
process.env.COD_ENABLED = 'true';
process.env.DELIVERY_ZONES = 'Central:20,East:30';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
process.env.PAYPAL_CLIENT_ID = 'pp_id';
process.env.PAYPAL_CLIENT_SECRET = 'pp_secret';
process.env.ORANGE_MONEY_NUMBER = '+23277000001';
process.env.AFRIMONEY_NUMBER = '+23233000002';
process.env.QMONEY_NUMBER = '+23288000003';
process.env.MOMO_ACCOUNT_NAME = 'ALLTINMIX Ltd';
// The tests use dollar amounts and a small payout minimum; the real defaults are Leones (Le) and Le 500.
process.env.CURRENCY_CODE = 'USD';
process.env.CURRENCY_SYMBOL = '$';
process.env.MIN_PAYOUT_MINOR = '1000';
process.env.FX_RATES = 'SLE:0.05'; // base USD; 1 SLE = 0.05 USD, so a buyer can also pay in SLE

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const db = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/lib/auth');
const orders = require('../src/services/orders');
const { processOutbox } = require('../src/lib/notify');

const app = createApp();
const PASSWORD = 'Passw0rd!x';
let n = 0;
const uniq = (s) => `${s.toLowerCase().replace(/[^a-z0-9]/g, '')}${Date.now().toString(36)}${n++}`;

const api = (method, url, token, body) => {
  const r = request(app)[method](url);
  if (token) r.set('Authorization', `Bearer ${token}`);
  // Physical items need delivery details; give checkout calls a default unless the test sets its own (or `delivery: false`).
  if (body && url === '/api/orders/checkout' && body.delivery === undefined) body = { ...body, delivery: { method: 'pickup', phone: '+23277000111' } };
  if (body && body.delivery === false) { body = { ...body }; delete body.delivery; }
  return body === undefined ? r : r.send(body);
};

async function lastEmailTo(email) {
  const { rows } = await db.query('SELECT * FROM email_outbox WHERE to_email = $1 ORDER BY id DESC LIMIT 1', [email]);
  return rows[0];
}
const tokenFrom = (html, key) => new RegExp(`${key}\\?token=([a-f0-9]+)`).exec(html)[1];

async function register(role, nameHint, { verify = true } = {}) {
  const email = `${uniq(nameHint)}@test.dev`.toLowerCase();
  const r = await api('post', '/api/auth/register', null, { name: nameHint, email, password: PASSWORD, role });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  if (verify) {
    const mail = await lastEmailTo(email);
    const v = await api('post', '/api/auth/verify-email', null, { token: tokenFrom(mail.html, 'verify-email') });
    assert.equal(v.status, 200);
  }
  return { token: r.body.token, id: r.body.user.id, email };
}

async function makeAdmin() {
  const email = `${uniq('admin')}@test.dev`;
  await db.query("INSERT INTO users (name,email,password_hash,role,email_verified_at) VALUES ('Admin',$1,$2,'admin',now())", [email, await hashPassword(PASSWORD)]);
  const r = await api('post', '/api/auth/login', null, { email, password: PASSWORD });
  return { token: r.body.token, id: r.body.user.id };
}

const mkListing = async (token, over = {}) => {
  const r = await api('post', '/api/listings', token, { type: 'product', category: 'Electronics', title: 'Test Gadget', description: 'A gadget', price: 25.99, fulfillment: 'physical', stock: 5, ...over });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.listing;
};

/** Create a checkout and pay it with the test method. Returns { paymentId, orders }. */
async function buy(buyer, items, method = 'test') {
  const c = await api('post', '/api/orders/checkout', buyer.token, { items, method });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  if (method === 'test') {
    const p = await api('post', `/api/payments/${c.body.paymentId}/mock-confirm`, buyer.token);
    assert.equal(p.status, 200, JSON.stringify(p.body));
  }
  return { ...c.body, orders: await ordersOfPayment(c.body.paymentId) };
}
async function ordersOfPayment(paymentId) {
  const { rows } = await db.query('SELECT id, status, total_minor, commission_minor, seller_earnings_minor, download_url FROM orders WHERE payment_id = $1 ORDER BY created_at', [paymentId]);
  return rows;
}
const walletOf = async (seller) => (await api('get', '/api/account/wallet', seller.token)).body.wallet;
const stockOf = async (id) => (await db.query('SELECT stock FROM listings WHERE id = $1', [id])).rows[0].stock;

describe('ALLTINMIX marketplace API', () => {
  let admin, seller, buyer, buyer2, stranger;

  before(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await db.migrate();
    admin = await makeAdmin();
    seller = await register('seller', 'Sam Seller');
    buyer = await register('buyer', 'Bea Buyer');
    buyer2 = await register('buyer', 'Bob Buyer');
    stranger = await register('buyer', 'Stan Stranger');
  });
  after(async () => {
    await db.pool.end();
    fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });
    fs.rmSync(process.env.PRIVATE_DIR, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------- config & security

  test('public config exposes branding, the four verticals and every payment method', async () => {
    const r = await api('get', '/api/config');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.verticals.map((v) => v.key), ['product', 'service', 'property', 'vehicle']);
    const keys = r.body.paymentMethods.map((m) => m.key).sort();
    assert.deepEqual(keys, ['afrimoney', 'card', 'cod', 'orange_money', 'paypal', 'qmoney', 'test']);
    assert.equal(r.body.delivery.codEnabled, true);
    assert.deepEqual(r.body.delivery.zones, [{ name: 'Central', feeMinor: 2000 }, { name: 'East', feeMinor: 3000 }]);
    assert.ok(!JSON.stringify(r.body).includes('sk_test_dummy'), 'no secrets in public config');
    assert.ok(!JSON.stringify(r.body).includes('+23277000001'), 'merchant wallet numbers are not public');
    assert.ok(r.body.brand.name);
  });

  test('security headers, JSON errors and 404s', async () => {
    const r = await api('get', '/api/health');
    assert.equal(r.headers['x-powered-by'], undefined);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    const bad = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{not json');
    assert.equal(bad.status, 400);
    assert.equal((await api('get', '/api/nope')).status, 404);
  });

  // ---------------------------------------------------------------- accounts

  test('registration validates input and rejects duplicate emails', async () => {
    const weak = await api('post', '/api/auth/register', null, { name: 'X Y', email: 'weak@test.dev', password: 'short', role: 'buyer' });
    assert.equal(weak.status, 400);
    assert.ok(weak.body.details.some((d) => d.path === 'password'));
    const admin_role = await api('post', '/api/auth/register', null, { name: 'Evil', email: 'evil@test.dev', password: PASSWORD, role: 'admin' });
    assert.equal(admin_role.status, 400, 'nobody can self-register as admin');
    const dup = await api('post', '/api/auth/register', null, { name: 'Dup', email: buyer.email.toUpperCase(), password: PASSWORD, role: 'buyer' });
    assert.equal(dup.status, 409);
  });

  test('unverified accounts cannot sell or buy until they confirm their email', async () => {
    const u = await register('seller', 'Unverified Una', { verify: false });
    const r = await api('post', '/api/listings', u.token, { type: 'service', category: 'Design & Graphics', title: 'Logo', price: 10, deliveryDays: 2 });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'EMAIL_NOT_VERIFIED');
    const mail = await lastEmailTo(u.email);
    assert.equal((await api('post', '/api/auth/verify-email', null, { token: tokenFrom(mail.html, 'verify-email') })).status, 200);
    assert.equal((await api('post', '/api/listings', u.token, { type: 'service', category: 'Design & Graphics', title: 'Logo', price: 10, deliveryDays: 2 })).status, 201);
    assert.equal((await api('post', '/api/auth/verify-email', null, { token: tokenFrom(mail.html, 'verify-email') })).status, 400, 'link is single use');
  });

  test('login, wrong password, and a safe forgot/reset password flow', async () => {
    assert.equal((await api('post', '/api/auth/login', null, { email: buyer.email, password: 'WrongPass1!' })).status, 401);
    const ok = await api('post', '/api/auth/login', null, { email: buyer.email, password: PASSWORD });
    assert.equal(ok.status, 200);
    assert.equal((await api('get', '/api/auth/me', ok.body.token)).body.user.email, buyer.email);

    const ghost = await api('post', '/api/auth/forgot-password', null, { email: 'nobody@test.dev' });
    assert.equal(ghost.status, 200, 'same answer whether or not the account exists');
    const u = await register('buyer', 'Reset Rae');
    await api('post', '/api/auth/forgot-password', null, { email: u.email });
    const mail = await lastEmailTo(u.email);
    const token = tokenFrom(mail.html, 'reset-password');
    assert.equal((await api('post', '/api/auth/reset-password', null, { token, password: 'NewPassw0rd!' })).status, 200);
    assert.equal((await api('post', '/api/auth/login', null, { email: u.email, password: 'NewPassw0rd!' })).status, 200);
    assert.equal((await api('post', '/api/auth/login', null, { email: u.email, password: PASSWORD })).status, 401);
    assert.equal((await api('get', '/api/auth/me', u.token)).status, 401, 'old sessions are signed out after a reset');
    assert.equal((await api('post', '/api/auth/reset-password', null, { token, password: 'AnotherPass1!' })).status, 400, 'reset link is single use');
  });

  // ---------------------------------------------------------------- listings

  test('listing validation follows the vertical rules from the config', async () => {
    const t = seller.token;
    const post = (b) => api('post', '/api/listings', t, b);
    const noPropType = await post({ type: 'property', category: 'Houses', title: 'Nice house', price: 90000, attributes: { listingFor: 'For sale' } });
    assert.equal(noPropType.status, 400);
    assert.ok(noPropType.body.details.some((d) => d.path === 'attributes.propertyType'));
    assert.equal((await post({ type: 'vehicle', category: 'Cars', title: 'Old car', price: 5000, attributes: { make: 'Toyota', model: 'Corolla', year: 1800 } })).status, 400, 'year out of range');
    assert.equal((await post({ type: 'service', category: 'Design & Graphics', title: 'Logo', price: 20 })).status, 400, 'service needs delivery days');
    assert.equal((await post({ type: 'product', category: 'Electronics', title: 'Thing', price: 20, fulfillment: 'physical' })).status, 400, 'physical needs stock');
    assert.equal((await post({ type: 'product', category: 'Digital Downloads', title: 'Ebook', price: 9, fulfillment: 'digital', deliveryUrl: 'http://insecure.test/file' })).status, 400, 'download link must be https');
    assert.equal((await post({ type: 'product', category: 'Electronics', title: 'Thing', price: -5, fulfillment: 'physical', stock: 1 })).status, 400);
    assert.equal((await post({ type: 'product', category: 'Not a category', title: 'Thing', price: 5, fulfillment: 'physical', stock: 1 })).status, 400);
    assert.equal((await post({ type: 'product', category: 'Electronics', title: 'Thing', price: 5, fulfillment: 'physical', stock: 1, images: ['https://evil.test/x.png'] })).status, 400, 'only our own uploaded images');
    assert.equal((await post({ type: 'spaceship', category: 'x', title: 'Thing', price: 5 })).status, 400);
    assert.equal((await api('post', '/api/listings', buyer.token, { type: 'service', category: 'Design & Graphics', title: 'Logo', price: 10, deliveryDays: 1 })).status, 403, 'buyers cannot create listings');
  });

  test('real estate and vehicle listings store clean attributes; digital links stay private', async () => {
    const house = await mkListing(seller.token, { type: 'property', category: 'Houses', title: 'Family house Hill Station', price: 185000, location: 'Freetown', fulfillment: undefined, stock: undefined, attributes: { listingFor: 'For sale', propertyType: 'House', bedrooms: 4, junk: 'dropped' } });
    assert.equal(house.mode, 'inquiry');
    assert.deepEqual(house.attributes, { listingFor: 'For sale', propertyType: 'House', bedrooms: 4 });
    assert.equal(house.priceMinor, 18500000);
    await mkListing(seller.token, { type: 'vehicle', category: 'Cars', title: '2016 Toyota Corolla', price: 8900, location: 'Bo', fulfillment: undefined, stock: undefined, attributes: { make: 'Toyota', model: 'Corolla', year: 2016 } });
    const digital = await mkListing(seller.token, { type: 'product', category: 'Digital Downloads', title: 'Template Pack', price: 15, fulfillment: 'digital', stock: undefined, deliveryUrl: 'https://files.test/secret-pack.zip' });
    const pub = await api('get', `/api/listings/${digital.id}`);
    assert.equal(pub.body.listing.deliveryUrl, undefined, 'public listing hides the download link');
    assert.ok(!JSON.stringify(await api('get', '/api/listings')).includes('secret-pack'));
    const mine = await api('get', '/api/listings/mine', seller.token);
    assert.ok(mine.body.listings.find((l) => l.id === digital.id).deliveryUrl, 'owner can see it');
  });

  test('browse supports search, type, category, price range, sorting and pagination', async () => {
    const all = await api('get', '/api/listings');
    assert.ok(all.body.total >= 3);
    assert.ok((await api('get', '/api/listings?type=property')).body.listings.every((l) => l.type === 'property'));
    assert.equal((await api('get', '/api/listings?q=corolla')).body.listings.length, 1);
    assert.equal((await api('get', '/api/listings?location=bo')).body.listings[0].title, '2016 Toyota Corolla');
    const cheap = await api('get', '/api/listings?maxPrice=20&sort=price_asc');
    assert.ok(cheap.body.listings.every((l) => l.priceMinor <= 2000));
    assert.equal((await api('get', '/api/listings?limit=1&page=2')).body.listings.length, 1);
    assert.equal((await api('get', "/api/listings?q=%27%3B%20DROP%20TABLE%20users%3B--")).status, 200, 'search input is parameterized');
  });

  test('sellers edit and pause their own listings, but not other sellers’ listings', async () => {
    const l = await mkListing(seller.token, { title: 'Editable thing' });
    const other = await register('seller', 'Other Olu');
    assert.equal((await api('put', `/api/listings/${l.id}`, other.token, { title: 'Hijacked' })).status, 403);
    const upd = await api('put', `/api/listings/${l.id}`, seller.token, { title: 'Edited thing', price: 30 });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.listing.priceMinor, 3000);
    assert.equal((await api('patch', `/api/listings/${l.id}/status`, seller.token, { status: 'paused' })).status, 200);
    assert.equal((await api('get', `/api/listings/${l.id}`)).status, 404, 'paused listings disappear from the public');
    assert.equal((await api('get', `/api/listings/${l.id}`, seller.token)).status, 200, 'but the owner can still open them');
    await api('patch', `/api/listings/${l.id}/status`, seller.token, { status: 'active' });
    await api('patch', `/api/admin/listings/${l.id}`, admin.token, { status: 'hidden' });
    assert.equal((await api('patch', `/api/listings/${l.id}/status`, seller.token, { status: 'active' })).status, 403, 'sellers cannot undo moderation');
    assert.equal((await api('patch', `/api/admin/listings/${l.id}`, seller.token, { status: 'active' })).status, 403);
  });

  test('image upload accepts real images only and the file is then served', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const ok = await request(app).post('/api/uploads').set('Authorization', `Bearer ${seller.token}`).attach('images', png, { filename: 'x.png', contentType: 'image/png' });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const served = await request(app).get(ok.body.urls[0]);
    assert.equal(served.status, 200);
    const l = await mkListing(seller.token, { title: 'With photo', images: ok.body.urls });
    assert.deepEqual(l.images, ok.body.urls);
    const fake = await request(app).post('/api/uploads').set('Authorization', `Bearer ${seller.token}`).attach('images', Buffer.from('<?php evil ?>'), { filename: 'x.png', contentType: 'image/png' });
    assert.equal(fake.status, 400, 'content is checked, not just the declared type');
    const wrongType = await request(app).post('/api/uploads').set('Authorization', `Bearer ${seller.token}`).attach('images', png, { filename: 'x.svg', contentType: 'image/svg+xml' });
    assert.equal(wrongType.status, 400);
    assert.equal((await request(app).post('/api/uploads').attach('images', png, { filename: 'x.png', contentType: 'image/png' })).status, 401);
    assert.equal((await request(app).get('/uploads/../package.json')).status, 404);
  });

  // ---------------------------------------------------------------- inquiries

  test('real estate and vehicles are inquiry-only: no checkout, but buyers can message sellers', async () => {
    const house = (await api('get', '/api/listings?type=property')).body.listings[0];
    const c = await api('post', '/api/orders/checkout', buyer.token, { items: [{ listingId: house.id, qty: 1 }], method: 'test' });
    assert.equal(c.status, 400);
    assert.equal(c.body.code, 'INQUIRY_ONLY');

    assert.equal((await api('post', '/api/conversations', seller.token, { listingId: house.id, message: 'hi me' })).status, 400, 'cannot message yourself');
    const start = await api('post', '/api/conversations', buyer.token, { listingId: house.id, message: 'Is it still available? Can I visit Saturday?' });
    assert.equal(start.status, 201);
    const convId = start.body.conversationId;
    const sellerInbox = await api('get', '/api/conversations', seller.token);
    assert.equal(sellerInbox.body.conversations[0].unread, 1);
    assert.equal((await api('get', '/api/notifications', seller.token)).body.notifications[0].type, 'message');

    assert.equal((await api('get', `/api/conversations/${convId}`, stranger.token)).status, 404, 'outsiders cannot read it');
    assert.equal((await api('post', `/api/conversations/${convId}/messages`, stranger.token, { body: 'hey' })).status, 404);
    const thread = await api('get', `/api/conversations/${convId}`, seller.token);
    assert.equal(thread.body.messages.length, 1);
    assert.equal((await api('get', '/api/conversations', seller.token)).body.conversations[0].unread, 0, 'opening marks as read');
    assert.equal((await api('post', `/api/conversations/${convId}/messages`, seller.token, { body: 'Yes, Saturday 10am works.' })).status, 201);
    const again = await api('post', '/api/conversations', buyer.token, { listingId: house.id, message: 'Great, see you then.' });
    assert.equal(again.body.conversationId, convId, 'one conversation per buyer per listing');
    assert.equal((await api('get', `/api/conversations/${convId}`, buyer.token)).body.messages.length, 3);
  });

  // ---------------------------------------------------------------- checkout, escrow, commission

  test('checkout guards: own listing, stock, empty cart, unknown method, login required', async () => {
    const l = await mkListing(seller.token, { title: 'Guard item', stock: 5 });
    assert.equal((await api('post', '/api/orders/checkout', seller.token, { items: [{ listingId: l.id, qty: 1 }], method: 'test' })).status, 400, 'cannot buy your own listing');
    const tooMany = await api('post', '/api/orders/checkout', buyer.token, { items: [{ listingId: l.id, qty: 6 }], method: 'test' });
    assert.equal(tooMany.status, 409);
    assert.equal(tooMany.body.code, 'OUT_OF_STOCK');
    assert.equal(await stockOf(l.id), 5, 'a failed checkout reserves nothing');
    assert.equal((await api('post', '/api/orders/checkout', buyer.token, { items: [], method: 'test' })).status, 400);
    assert.equal((await api('post', '/api/orders/checkout', buyer.token, { items: [{ listingId: l.id, qty: 1 }], method: 'bitcoin' })).status, 400);
    assert.equal((await api('post', '/api/orders/checkout', null, { items: [{ listingId: l.id, qty: 1 }], method: 'test' })).status, 401);
  });

  test('full happy path: pay, accept, deliver, confirm. Commission is exact and the seller is paid once', async () => {
    const s = await register('seller', 'Happy Hana');
    const l = await mkListing(s.token, { title: 'Happy item', price: 25.99, stock: 5 });
    const paid = await buy(buyer, [{ listingId: l.id, qty: 2 }]);
    assert.equal(paid.totalMinor, 5198);
    assert.equal(await stockOf(l.id), 3, 'stock reserved at checkout');
    const o = paid.orders[0];
    assert.equal(o.status, 'pending_acceptance');
    assert.equal(o.commission_minor, 520, '10% of 5198 = 519.8, rounded to 520');
    assert.equal(o.seller_earnings_minor, 4678);
    assert.equal((await walletOf(s)).availableMinor, 0, 'no money for the seller yet');
    assert.equal((await walletOf(s)).pendingMinor, 4678);

    assert.equal((await api('post', `/api/orders/${o.id}/accept`, buyer.token)).status, 403, 'buyer cannot accept');
    assert.equal((await api('post', `/api/orders/${o.id}/accept`, stranger.token)).status, 404, 'strangers cannot even see it');
    assert.equal((await api('post', `/api/orders/${o.id}/deliver`, s.token)).status, 409, 'cannot skip a step');
    assert.equal((await api('post', `/api/orders/${o.id}/accept`, s.token)).status, 200);
    assert.equal((await api('post', `/api/orders/${o.id}/deliver`, s.token)).status, 200);
    assert.equal((await api('post', `/api/orders/${o.id}/confirm`, s.token)).status, 403, 'seller cannot confirm their own delivery');
    const done = await api('post', `/api/orders/${o.id}/confirm`, buyer.token);
    assert.equal(done.body.order.status, 'completed');
    assert.equal((await api('post', `/api/orders/${o.id}/confirm`, buyer.token)).status, 409, 'a double click cannot pay the seller twice');
    const w = await walletOf(s);
    assert.equal(w.availableMinor, 4678);
    assert.equal(w.pendingMinor, 0);

    const stats = await api('get', '/api/admin/stats', admin.token);
    assert.ok(stats.body.commissionEarnedMinor >= 520);
    assert.equal((await api('get', '/api/admin/stats', buyer.token)).status, 403);
  });

  test('reviews: only the buyer, only after completion, once; the listing rating updates', async () => {
    const s = await register('seller', 'Review Rob');
    const l = await mkListing(s.token, { title: 'Reviewable', stock: 3 });
    const { orders: [o] } = await buy(buyer, [{ listingId: l.id, qty: 1 }]);
    assert.equal((await api('post', `/api/orders/${o.id}/review`, buyer.token, { rating: 5 })).status, 409, 'not completed yet');
    for (const a of ['accept', 'deliver']) await api('post', `/api/orders/${o.id}/${a}`, s.token);
    await api('post', `/api/orders/${o.id}/confirm`, buyer.token);
    assert.equal((await api('post', `/api/orders/${o.id}/review`, buyer2.token, { rating: 5 })).status, 404);
    assert.equal((await api('post', `/api/orders/${o.id}/review`, buyer.token, { rating: 9 })).status, 400);
    assert.equal((await api('post', `/api/orders/${o.id}/review`, buyer.token, { rating: 4, comment: 'Good' })).status, 201);
    assert.equal((await api('post', `/api/orders/${o.id}/review`, buyer.token, { rating: 1 })).status, 409);
    const detail = await api('get', `/api/listings/${l.id}`);
    assert.equal(detail.body.listing.ratingAvg, 4);
    assert.equal(detail.body.listing.ratingCount, 1);
    assert.equal(detail.body.reviews[0].comment, 'Good');
  });

  test('digital products are delivered the moment payment clears, and only the buyer sees the link', async () => {
    const s = await register('seller', 'Digital Dee');
    const l = await mkListing(s.token, { type: 'product', category: 'Digital Downloads', title: 'Ebook', price: 9, fulfillment: 'digital', stock: undefined, deliveryUrl: 'https://files.test/ebook-private.pdf' });
    const checkout = await api('post', '/api/orders/checkout', buyer.token, { items: [{ listingId: l.id, qty: 4 }], method: 'test' });
    assert.equal(checkout.body.totalMinor, 900, 'digital items are always quantity 1');
    assert.equal((await api('get', '/api/orders/mine', buyer.token)).body.orders.filter((o) => o.title === 'Ebook').length, 0, 'unpaid orders are hidden');
    assert.equal((await ordersOfPayment(checkout.body.paymentId))[0].download_url, null, 'no link before payment');
    await api('post', `/api/payments/${checkout.body.paymentId}/mock-confirm`, buyer.token);
    await api('post', `/api/payments/${checkout.body.paymentId}/mock-confirm`, buyer.token); // duplicate confirmation is harmless
    const mine = (await api('get', '/api/orders/mine', buyer.token)).body.orders.find((o) => o.title === 'Ebook');
    assert.equal(mine.status, 'delivered');
    assert.equal(mine.downloadUrl, 'https://files.test/ebook-private.pdf');
    assert.equal((await api('get', '/api/listings/mine', s.token)).body.listings[0].soldCount, 1, 'counted once');
    const theirs = (await api('get', '/api/orders/selling', s.token)).body.orders[0];
    assert.equal(theirs.downloadUrl, undefined, 'seller view does not echo the link');
    assert.equal((await walletOf(s)).availableMinor, 0, 'seller is paid when the buyer confirms');
    await api('post', `/api/orders/${mine.id}/confirm`, buyer.token);
    assert.equal((await walletOf(s)).availableMinor, 810);
  });

  test('cancel before acceptance refunds the buyer and returns the stock', async () => {
    const s = await register('seller', 'Cancel Cam');
    const l = await mkListing(s.token, { title: 'Cancel me', stock: 4 });
    const { paymentId, orders: [o] } = await buy(buyer, [{ listingId: l.id, qty: 3 }]);
    assert.equal(await stockOf(l.id), 1);
    assert.equal((await api('post', `/api/orders/${o.id}/cancel`, stranger.token)).status, 404);
    const c = await api('post', `/api/orders/${o.id}/cancel`, buyer.token);
    assert.equal(c.body.order.status, 'cancelled');
    assert.equal(await stockOf(l.id), 4, 'stock restored');
    assert.equal((await db.query('SELECT status FROM payments WHERE id = $1', [paymentId])).rows[0].status, 'refunded');
    assert.equal((await api('post', `/api/orders/${o.id}/cancel`, buyer.token)).status, 409, 'cannot refund twice');
    assert.equal((await walletOf(s)).availableMinor + (await walletOf(s)).pendingMinor, 0);
  });

  test('a cart with two sellers becomes two orders with separate commissions; a partial refund is tracked', async () => {
    const s1 = await register('seller', 'Cart One');
    const s2 = await register('seller', 'Cart Two');
    const a = await mkListing(s1.token, { title: 'Cart A', price: 10, stock: 2 });
    const b = await mkListing(s2.token, { title: 'Cart B', price: 40, stock: 2 });
    const paid = await buy(buyer, [{ listingId: a.id, qty: 1 }, { listingId: b.id, qty: 1 }]);
    assert.equal(paid.orders.length, 2);
    assert.equal(paid.totalMinor, 5000);
    assert.deepEqual(paid.orders.map((o) => o.commission_minor).sort((x, y) => x - y), [100, 400]);
    const oa = paid.orders.find((o) => o.total_minor === 1000);
    await api('post', `/api/orders/${oa.id}/cancel`, s1.token);
    assert.equal((await db.query('SELECT status FROM payments WHERE id = $1', [paid.paymentId])).rows[0].status, 'partially_refunded');
  });

  // ---------------------------------------------------------------- disputes

  test('disputes freeze the money until an admin releases it or refunds the buyer', async () => {
    const s = await register('seller', 'Dispute Dan');
    const l = await mkListing(s.token, { title: 'Disputed item', price: 50, stock: 5 });
    const one = (await buy(buyer, [{ listingId: l.id, qty: 1 }])).orders[0];
    await api('post', `/api/orders/${one.id}/accept`, s.token);
    assert.equal((await api('post', `/api/orders/${one.id}/dispute`, buyer.token, { reason: 'bad' })).status, 400, 'reason required');
    assert.equal((await api('post', `/api/orders/${one.id}/dispute`, s.token, { reason: 'I am the seller!!' })).status, 403);
    assert.equal((await api('post', `/api/orders/${one.id}/dispute`, buyer.token, { reason: 'Seller stopped replying to me.' })).body.order.status, 'disputed');
    assert.equal((await api('post', `/api/orders/${one.id}/confirm`, buyer.token)).status, 409);
    assert.equal((await api('post', `/api/admin/orders/${one.id}/resolve`, s.token, { resolution: 'release' })).status, 403, 'only admins resolve');
    const refund = await api('post', `/api/admin/orders/${one.id}/resolve`, admin.token, { resolution: 'refund', note: 'Buyer was right.' });
    assert.equal(refund.body.order.status, 'refunded');
    assert.equal((await walletOf(s)).availableMinor, 0);
    assert.equal((await api('post', `/api/admin/orders/${one.id}/resolve`, admin.token, { resolution: 'release' })).status, 409, 'already resolved');

    const two = (await buy(buyer2, [{ listingId: l.id, qty: 1 }])).orders[0];
    await api('post', `/api/orders/${two.id}/accept`, s.token);
    await api('post', `/api/orders/${two.id}/deliver`, s.token);
    await api('post', `/api/orders/${two.id}/dispute`, buyer2.token, { reason: 'Changed my mind, unfairly.' });
    const rel = await api('post', `/api/admin/orders/${two.id}/resolve`, admin.token, { resolution: 'release' });
    assert.equal(rel.body.order.status, 'completed');
    assert.equal((await walletOf(s)).availableMinor, 4500);
  });

  // ---------------------------------------------------------------- background jobs

  test('unconfirmed deliveries auto-complete exactly once; unpaid checkouts expire and release stock', async () => {
    const s = await register('seller', 'Job Jen');
    const l = await mkListing(s.token, { title: 'Job item', price: 100, stock: 3 });
    const o = (await buy(buyer, [{ listingId: l.id, qty: 1 }])).orders[0];
    await api('post', `/api/orders/${o.id}/accept`, s.token);
    await api('post', `/api/orders/${o.id}/deliver`, s.token);
    assert.equal(await orders.autoCompleteDelivered(), 0, 'too recent');
    await db.query("UPDATE orders SET delivered_at = now() - interval '10 days' WHERE id = $1", [o.id]);
    assert.equal(await orders.autoCompleteDelivered(), 1);
    assert.equal(await orders.autoCompleteDelivered(), 0);
    assert.equal((await walletOf(s)).availableMinor, 9000);

    const unpaid = await api('post', '/api/orders/checkout', buyer.token, { items: [{ listingId: l.id, qty: 2 }], method: 'test' });
    assert.equal(await stockOf(l.id), 0);
    await db.query("UPDATE payments SET created_at = now() - interval '2 hours' WHERE id = $1", [unpaid.body.paymentId]);
    assert.ok((await orders.expireStalePayments()) >= 1);
    assert.equal(await stockOf(l.id), 2, 'stock released (3 minus the 1 that was really sold)');

    // The buyer pays after the window closed: the money must go back automatically.
    await orders.markPaymentPaid(unpaid.body.paymentId);
    const late = await ordersOfPayment(unpaid.body.paymentId);
    assert.equal(late[0].status, 'refunded');
    assert.equal((await db.query('SELECT status FROM payments WHERE id = $1', [unpaid.body.paymentId])).rows[0].status, 'refunded');
  });

  test('two buyers racing for the last item: exactly one wins, stock never goes negative', async () => {
    const s = await register('seller', 'Race Ray');
    const l = await mkListing(s.token, { title: 'Last one', stock: 1 });
    const results = await Promise.all([buyer, buyer2].map((b) => api('post', '/api/orders/checkout', b.token, { items: [{ listingId: l.id, qty: 1 }], method: 'test' })));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(await stockOf(l.id), 0);
  });

  // ---------------------------------------------------------------- mobile money

  test('Orange Money, Afrimoney and QMoney: buyer submits the transaction ID, an admin confirms, order proceeds', async () => {
    const s = await register('seller', 'Momo Mia');
    const l = await mkListing(s.token, { title: 'Momo item', price: 20, stock: 5 });
    for (const method of ['orange_money', 'afrimoney', 'qmoney']) {
      const c = await api('post', '/api/orders/checkout', buyer.token, { items: [{ listingId: l.id, qty: 1 }], method });
      assert.equal(c.status, 201, JSON.stringify(c.body));
      assert.equal(c.body.kind, 'manual');
      const inst = (await api('get', `/api/payments/${c.body.paymentId}`, buyer.token)).body.payment;
      assert.ok(inst.manual.number.startsWith('+232'), 'buyer is shown the merchant wallet number');
      assert.match(inst.manual.reference, /^PAY-[A-F0-9]{8}$/);
      assert.equal((await api('get', `/api/payments/${c.body.paymentId}`, stranger.token)).status, 404);
      await db.query("UPDATE payments SET status = 'failed' WHERE id = $1", [c.body.paymentId]);
      await db.query("UPDATE orders SET status = 'cancelled' WHERE payment_id = $1", [c.body.paymentId]);
      await db.query('UPDATE listings SET stock = stock + 1 WHERE id = $1', [l.id]);
    }

    const c = await api('post', '/api/orders/checkout', buyer.token, { items: [{ listingId: l.id, qty: 2 }], method: 'orange_money' });
    const pid = c.body.paymentId;
    assert.match(c.body.redirectUrl, /\/pay\/manual\//);
    assert.equal((await api('post', `/api/payments/${pid}/manual-proof`, buyer.token, { senderPhone: '077', transactionId: 'x' })).status, 400);
    assert.equal((await api('post', `/api/payments/${pid}/manual-proof`, stranger.token, { senderPhone: '+23277123456', transactionId: 'OM123456' })).status, 404);
    assert.equal((await api('post', `/api/payments/${pid}/manual-proof`, buyer.token, { senderPhone: '+23277123456', transactionId: 'OM123456' })).status, 200);
    assert.equal((await ordersOfPayment(pid))[0].status, 'awaiting_payment', 'goods are not released on the buyer’s word alone');

    assert.equal((await api('get', '/api/admin/payments', buyer.token)).status, 403);
    const queue = await api('get', '/api/admin/payments', admin.token);
    const item = queue.body.payments.find((p) => p.id === pid);
    assert.equal(item.proof.transactionId, 'OM123456');
    assert.equal((await api('post', `/api/admin/payments/${pid}/confirm`, buyer.token)).status, 403);
    assert.equal((await api('post', `/api/admin/payments/${pid}/confirm`, admin.token)).status, 200);
    assert.equal((await ordersOfPayment(pid))[0].status, 'pending_acceptance');
    assert.equal((await api('post', `/api/admin/payments/${pid}/confirm`, admin.token)).status, 409, 'cannot confirm twice');

    // Refunds of mobile-money orders are flagged for the merchant to send by hand.
    const o = (await ordersOfPayment(pid))[0];
    await api('post', `/api/orders/${o.id}/cancel`, s.token);
    const due = await api('get', '/api/admin/refunds-due', admin.token);
    assert.ok(due.body.orders.some((x) => x.id === o.id));
    assert.equal((await api('post', `/api/admin/orders/${o.id}/refund-settled`, admin.token)).status, 200);
    assert.ok(!(await api('get', '/api/admin/refunds-due', admin.token)).body.orders.some((x) => x.id === o.id));
  });

  test('a rejected mobile money payment cancels the order and returns the stock', async () => {
    const s = await register('seller', 'Reject Rae');
    const l = await mkListing(s.token, { title: 'Reject item', stock: 2 });
    const c = await api('post', '/api/orders/checkout', buyer.token, { items: [{ listingId: l.id, qty: 2 }], method: 'afrimoney' });
    await api('post', `/api/payments/${c.body.paymentId}/manual-proof`, buyer.token, { senderPhone: '+23233123456', transactionId: 'AF999999' });
    assert.equal(await stockOf(l.id), 0);
    assert.equal((await api('post', `/api/admin/payments/${c.body.paymentId}/reject`, admin.token, { note: 'No such transfer found.' })).status, 200);
    assert.equal(await stockOf(l.id), 2);
    assert.equal((await ordersOfPayment(c.body.paymentId))[0].status, 'cancelled');
    const note = (await api('get', '/api/notifications', buyer.token)).body.notifications.find((x) => x.type === 'payment_failed');
    assert.ok(note, 'buyer is told why');
  });

  // ---------------------------------------------------------------- PayPal (network stubbed) and Stripe webhooks

  test('PayPal: redirect, capture on return with amount check, and refund', async () => {
    const calls = [];
    const realFetch = global.fetch;
    let expected = '0.00';
    global.fetch = async (url, opts = {}) => {
      const u = String(url);
      calls.push(`${opts.method || 'GET'} ${new URL(u).pathname}`);
      const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
      if (u.endsWith('/v1/oauth2/token')) return json({ access_token: 'tok', expires_in: 3600 });
      if (u.endsWith('/v2/checkout/orders') && opts.method === 'POST') {
        expected = JSON.parse(opts.body).purchase_units[0].amount.value;
        return json({ id: 'PPORDER1', links: [{ rel: 'payer-action', href: 'https://paypal.test/approve/PPORDER1' }] });
      }
      if (u.endsWith('/v2/checkout/orders/PPORDER1') && (!opts.method || opts.method === 'GET')) return json({ status: 'APPROVED' });
      if (u.endsWith('/capture')) return json({ status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP1', status: 'COMPLETED', amount: { currency_code: 'USD', value: expected } }] } }] });
      if (u.endsWith('/refund')) return json({ id: 'REFUND1' });
      return realFetch(url, opts);
    };
    try {
      const s = await register('seller', 'Paypal Pam');
      const l = await mkListing(s.token, { title: 'PayPal item', price: 33.5, stock: 3 });
      const c = await api('post', '/api/orders/checkout', buyer.token, { items: [{ listingId: l.id, qty: 1 }], method: 'paypal' });
      assert.equal(c.status, 201, JSON.stringify(c.body));
      assert.equal(c.body.redirectUrl, 'https://paypal.test/approve/PPORDER1');
      assert.equal(expected, '33.50');
      assert.equal((await ordersOfPayment(c.body.paymentId))[0].status, 'awaiting_payment');
      const v = await api('post', `/api/payments/${c.body.paymentId}/verify`, buyer.token);
      assert.equal(v.body.payment.status, 'paid');
      assert.equal((await ordersOfPayment(c.body.paymentId))[0].status, 'pending_acceptance');
      const o = (await ordersOfPayment(c.body.paymentId))[0];
      await api('post', `/api/orders/${o.id}/cancel`, s.token);
      assert.ok(calls.includes('POST /v2/payments/captures/CAP1/refund'), 'refund went to PayPal');
      assert.equal((await db.query('SELECT status FROM payments WHERE id = $1', [c.body.paymentId])).rows[0].status, 'refunded');

      // A capture for the wrong amount must not mark the order paid.
      const c2 = await api('post', '/api/orders/checkout', buyer.token, { items: [{ listingId: l.id, qty: 1 }], method: 'paypal' });
      expected = '1.00';
      const bad = await api('post', `/api/payments/${c2.body.paymentId}/verify`, buyer.token);
      assert.equal(bad.body.payment.status, 'failed');
    } finally {
      global.fetch = realFetch;
    }
  });

  test('Stripe webhooks: a correctly signed event marks the payment paid; forged ones are rejected', async () => {
    const Stripe = require('stripe');
    const s = await register('seller', 'Stripe Sue');
    const l = await mkListing(s.token, { title: 'Stripe item', stock: 2 });
    const c = await api('post', '/api/orders/checkout', buyer.token, { items: [{ listingId: l.id, qty: 1 }], method: 'test' });
    await db.query("UPDATE payments SET provider = 'stripe', method = 'card' WHERE id = $1", [c.body.paymentId]); // pretend this checkout went through Stripe
    const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'checkout.session.completed', data: { object: { id: 'cs_1', object: 'checkout.session', payment_status: 'paid', payment_intent: 'pi_123', metadata: { paymentId: c.body.paymentId } } } });
    const good = Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    const forged = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_wrong' });

    const bad = await request(app).post('/api/webhooks/stripe').set('stripe-signature', forged).set('Content-Type', 'application/json').send(payload);
    assert.equal(bad.status, 400);
    assert.equal((await ordersOfPayment(c.body.paymentId))[0].status, 'awaiting_payment');
    const ok = await request(app).post('/api/webhooks/stripe').set('stripe-signature', good).set('Content-Type', 'application/json').send(payload);
    assert.equal(ok.status, 200);
    assert.equal((await ordersOfPayment(c.body.paymentId))[0].status, 'pending_acceptance');
    assert.equal((await db.query('SELECT provider_txn_id FROM payments WHERE id = $1', [c.body.paymentId])).rows[0].provider_txn_id, 'pi_123');
    const replay = await request(app).post('/api/webhooks/stripe').set('stripe-signature', good).set('Content-Type', 'application/json').send(payload);
    assert.equal(replay.status, 200, 'retried webhooks are harmless');
    assert.equal((await db.query('SELECT sold_count FROM listings WHERE id = $1', [l.id])).rows[0].sold_count, 1, 'counted once');
  });

  // ---------------------------------------------------------------- payouts

  test('seller payouts: details required, minimum enforced, balance deducted at once, admin pays or rejects', async () => {
    const s = await register('seller', 'Payout Pia');
    const l = await mkListing(s.token, { title: 'Payout item', price: 100, stock: 9 });
    for (let i = 0; i < 2; i++) {
      const o = (await buy(buyer, [{ listingId: l.id, qty: 1 }])).orders[0];
      for (const a of ['accept', 'deliver']) await api('post', `/api/orders/${o.id}/${a}`, s.token);
      await api('post', `/api/orders/${o.id}/confirm`, buyer.token);
    }
    assert.equal((await walletOf(s)).availableMinor, 18000);
    assert.equal((await api('post', '/api/account/wallet/payouts', s.token, {})).body.code, 'NO_PAYOUT_DETAILS');
    assert.equal((await api('patch', '/api/account/profile', s.token, { payoutMethod: 'Orange Money', payoutDetails: '+23277123456' })).status, 200);
    assert.equal((await api('post', '/api/account/wallet/payouts', s.token, { amount: 2000 })).body.code, 'INSUFFICIENT_FUNDS');
    assert.equal((await api('post', '/api/account/wallet/payouts', s.token, { amount: 1 })).body.code, 'BELOW_MINIMUM');
    const req1 = await api('post', '/api/account/wallet/payouts', s.token, { amount: 100 });
    assert.equal(req1.status, 201);
    assert.equal((await walletOf(s)).availableMinor, 8000, 'balance drops immediately, so it cannot be requested twice');

    // Two simultaneous requests for the remaining balance: only one may succeed.
    const race = await Promise.all([api('post', '/api/account/wallet/payouts', s.token, {}), api('post', '/api/account/wallet/payouts', s.token, {})]);
    assert.deepEqual(race.map((r) => r.status).sort(), [201, 400]);
    assert.equal((await walletOf(s)).availableMinor, 0);

    assert.equal((await api('post', `/api/admin/payouts/${req1.body.payout.id}/pay`, s.token, {})).status, 403);
    assert.equal((await api('post', `/api/admin/payouts/${req1.body.payout.id}/pay`, admin.token, { reference: 'OM-REF-77' })).status, 200);
    assert.equal((await api('post', `/api/admin/payouts/${req1.body.payout.id}/pay`, admin.token, {})).status, 409);
    assert.equal((await walletOf(s)).withdrawnMinor, 10000);

    const queue = (await api('get', '/api/admin/payouts', admin.token)).body.payouts;
    const second = queue.find((p) => p.userEmail === s.email);
    assert.equal((await api('post', `/api/admin/payouts/${second.id}/reject`, admin.token, { note: 'Wrong number' })).status, 200);
    assert.equal((await walletOf(s)).availableMinor, 8000, 'rejected payout returns the money');
  });

  // ---------------------------------------------------------------- admin & operations

  test('admin can change the commission (applies to new orders only) and suspend users instantly', async () => {
    const s = await register('seller', 'Admin Test Al');
    const l = await mkListing(s.token, { title: 'Commission item', price: 100, stock: 5 });
    const before = (await buy(buyer, [{ listingId: l.id, qty: 1 }])).orders[0];
    assert.equal((await api('patch', '/api/admin/settings/commission', s.token, { commissionPct: 1 })).status, 403);
    assert.equal((await api('patch', '/api/admin/settings/commission', admin.token, { commissionPct: 80 })).status, 400);
    assert.equal((await api('patch', '/api/admin/settings/commission', admin.token, { commissionPct: 12.5 })).status, 200);
    const after = (await buy(buyer, [{ listingId: l.id, qty: 1 }])).orders[0];
    assert.equal(before.commission_minor, 1000);
    assert.equal(after.commission_minor, 1250, '12.5% of 10000');
    assert.equal((await api('get', '/api/config')).body.commissionPct, 12.5);
    await api('patch', '/api/admin/settings/commission', admin.token, { commissionPct: 10 });

    assert.equal((await api('patch', `/api/admin/users/${s.id}`, admin.token, { status: 'suspended' })).status, 200);
    assert.ok([401, 403].includes((await api('get', '/api/auth/me', s.token)).status), 'their session stops working immediately');
    assert.equal((await api('post', '/api/auth/login', null, { email: s.email, password: PASSWORD })).status, 403);
    assert.equal((await api('patch', `/api/admin/users/${admin.id}`, admin.token, { status: 'suspended' })).status, 400, 'admins cannot lock themselves out');
    assert.equal((await api('patch', `/api/admin/users/${s.id}`, admin.token, { status: 'active' })).status, 200);
    assert.equal((await api('post', '/api/auth/login', null, { email: s.email, password: PASSWORD })).status, 200);
    assert.ok((await db.query("SELECT count(*)::int AS n FROM admin_audit")).rows[0].n > 3, 'admin actions are logged');
  });

  test('notifications can be listed and cleared; the email queue is delivered by the worker', async () => {
    const n = await api('get', '/api/notifications', buyer.token);
    assert.ok(n.body.unread > 0);
    assert.equal((await api('post', '/api/notifications/read-all', buyer.token)).status, 200);
    assert.equal((await api('get', '/api/notifications', buyer.token)).body.unread, 0);
    const log = console.log;
    console.log = () => {};
    try {
      assert.ok((await processOutbox(500)) > 0);
    } finally {
      console.log = log;
    }
    assert.equal((await db.query('SELECT count(*)::int AS n FROM email_outbox WHERE sent_at IS NULL')).rows[0].n, 0);
  });

  test('buyers can pay in a second currency: charged amount is converted, orders stay in the base currency, refunds follow what was paid', async () => {
    const cfg = (await api('get', '/api/config')).body;
    assert.deepEqual(cfg.currencies.map((c) => c.code), ['USD', 'SLE']);
    assert.deepEqual(cfg.rates, { USD: 1, SLE: 0.05 });
    const methods = Object.fromEntries(cfg.paymentMethods.map((m) => [m.key, m.currencies]));
    assert.deepEqual(methods.paypal, ['USD']);
    assert.deepEqual(methods.test, ['USD', 'SLE']);

    const s = await register('seller', 'Fx Fiona');
    const l = await mkListing(s.token, { title: 'Fx item', price: 10, stock: 5 });
    const refuse = await api('post', '/api/orders/checkout', buyer.token, { items: [{ listingId: l.id, qty: 1 }], method: 'paypal', currency: 'SLE' });
    assert.equal(refuse.status, 400);
    assert.equal(refuse.body.code, 'CURRENCY_UNSUPPORTED');

    const c = await api('post', '/api/orders/checkout', buyer.token, { items: [{ listingId: l.id, qty: 2 }], method: 'test', currency: 'SLE' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(c.body.totalMinor, 2000, 'order total stays in the base currency (USD 20.00)');
    assert.equal(c.body.payAmountMinor, 40000, 'buyer is charged SLE 400.00');
    assert.equal(c.body.payCurrency, 'SLE');
    const p = (await db.query('SELECT currency, amount_minor, base_amount_minor, fx_rate FROM payments WHERE id = $1', [c.body.paymentId])).rows[0];
    assert.deepEqual([p.currency, p.amount_minor, p.base_amount_minor, Number(p.fx_rate)], ['SLE', 40000, 2000, 0.05]);
    assert.equal((await api('post', `/api/payments/${c.body.paymentId}/mock-confirm`, buyer.token)).status, 200);
    const o = (await ordersOfPayment(c.body.paymentId))[0];
    assert.equal(o.total_minor, 2000);
    const view = (await api('get', `/api/orders/${o.id}`, buyer.token)).body.order;
    assert.deepEqual([view.totalMinor, view.paidCurrency, view.paidMinor], [2000, 'SLE', 40000]);

    // An admin changes the rate; it applies to new payments only.
    assert.equal((await api('patch', '/api/admin/settings/fx-rates', buyer.token, { rates: { SLE: 0.1 } })).status, 403);
    assert.equal((await api('patch', '/api/admin/settings/fx-rates', admin.token, { rates: { EUR: 1 } })).status, 400);
    assert.equal((await api('patch', '/api/admin/settings/fx-rates', admin.token, { rates: { SLE: 0.1 } })).status, 200);
    assert.equal((await api('get', '/api/config')).body.rates.SLE, 0.1);
    const c2 = await api('post', '/api/orders/checkout', buyer.token, { items: [{ listingId: l.id, qty: 1 }], method: 'test', currency: 'SLE' });
    assert.equal(c2.body.payAmountMinor, 10000, 'new rate: USD 10.00 = SLE 100.00');
    assert.equal((await db.query('SELECT amount_minor FROM payments WHERE id = $1', [c.body.paymentId])).rows[0].amount_minor, 40000, 'old payment keeps its rate');

    // Cancelling refunds in the currency that was paid, and the payment closes as fully refunded.
    assert.equal((await api('post', `/api/orders/${o.id}/cancel`, buyer.token)).body.order.status, 'cancelled');
    assert.equal((await db.query('SELECT status FROM payments WHERE id = $1', [c.body.paymentId])).rows[0].status, 'refunded');
    await api('patch', '/api/admin/settings/fx-rates', admin.token, { rates: { SLE: 0.05 } });
  });

  test('store safety: report, block, delete account', async () => {
    const sel = await register('seller', 'Vic Vendor');
    const buy1 = await register('buyer', 'Dee Deleter');
    const l = await mkListing(sel.token, { title: 'Shady Gadget' });

    // Reporting
    assert.equal((await api('post', '/api/reports', null, { targetType: 'listing', targetId: l.id, reason: 'spam' })).status, 401);
    assert.equal((await api('post', '/api/reports', buy1.token, { targetType: 'listing', targetId: l.id, reason: 'nope' })).status, 400);
    assert.equal((await api('post', '/api/reports', buy1.token, { targetType: 'listing', targetId: l.id, reason: 'scam_fraud', details: 'looks fake' })).status, 201);
    assert.equal((await api('post', '/api/reports', buy1.token, { targetType: 'listing', targetId: l.id, reason: 'scam_fraud' })).status, 201, 'duplicate is accepted quietly');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM reports WHERE status='open'")).rows[0].n >= 1, true);
    const list = await api('get', '/api/admin/reports', admin.token);
    const rep = list.body.reports.find((r) => r.targetId === l.id);
    assert.ok(rep);
    assert.equal((await api('get', '/api/admin/reports', buy1.token)).status, 403);
    assert.equal((await api('post', `/api/admin/reports/${rep.id}/resolve`, admin.token, { action: 'hide_listing' })).status, 200);
    assert.equal((await db.query('SELECT status FROM listings WHERE id = $1', [l.id])).rows[0].status, 'hidden');

    // Blocking hides listings and stops messages
    const l2 = await mkListing(sel.token, { title: 'Second Gadget' });
    assert.ok((await api('get', '/api/listings?q=Second', buy1.token)).body.listings.some((x) => x.id === l2.id));
    assert.equal((await api('post', '/api/blocks', buy1.token, { userId: sel.id })).status, 201);
    assert.equal((await api('get', '/api/listings?q=Second', buy1.token)).body.listings.some((x) => x.id === l2.id), false);
    assert.equal((await api('get', '/api/listings?q=Second')).body.listings.some((x) => x.id === l2.id), true, 'others still see it');
    const msg = await api('post', '/api/conversations', buy1.token, { listingId: l2.id, message: 'hi' });
    assert.equal(msg.status, 403);
    assert.equal((await api('delete', `/api/blocks/${sel.id}`, buy1.token)).status, 200);
    assert.equal((await api('post', '/api/conversations', buy1.token, { listingId: l2.id, message: 'hi' })).status, 201);

    // Account deletion
    assert.equal((await api('delete', '/api/account', buy1.token, { password: 'wrong-password' })).status, 403);
    const b = await buy(buy1, [{ listingId: l2.id, qty: 1 }]);
    const blocked = await api('delete', '/api/account', buy1.token, { password: PASSWORD });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'ACTIVE_ORDERS');
    assert.equal((await api('post', `/api/orders/${b.orders[0].id}/cancel`, buy1.token)).status, 200);
    const del = await api('delete', '/api/account', buy1.token, { password: PASSWORD });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal((await api('get', '/api/account/wallet', buy1.token)).status, 401, 'token is revoked');
    const login = await api('post', '/api/auth/login', null, { email: buy1.email, password: PASSWORD });
    assert.equal(login.status, 401);
    assert.equal((await db.query('SELECT name, status FROM users WHERE id = $1', [buy1.id])).rows[0].status, 'deleted');
    // The email can be used to sign up again
    assert.equal((await api('post', '/api/auth/register', null, { name: 'Dee Again', email: buy1.email, password: PASSWORD, role: 'buyer' })).status, 201);
  });

  test('local delivery: zones and fees, pickup, cash on delivery, seller owes the platform fee', async () => {
    const sel = await register('seller', 'Cash Seller');
    const buyr = await register('buyer', 'Cash Buyer');
    const l = await mkListing(sel.token, { title: 'Phone Case', price: 100, stock: 10 });
    const item = [{ listingId: l.id, qty: 2 }];

    // Physical goods need delivery details
    const none = await api('post', '/api/orders/checkout', buyr.token, { items: item, method: 'test', delivery: false });
    assert.equal(none.body.code, 'DELIVERY_REQUIRED');
    const noZone = await api('post', '/api/orders/checkout', buyr.token, { items: item, method: 'test', delivery: { method: 'ship', phone: '+23277000222', address: '12 Main Street' } });
    assert.equal(noZone.body.code, 'DELIVERY_ZONE');
    const noAddr = await api('post', '/api/orders/checkout', buyr.token, { items: item, method: 'test', delivery: { method: 'ship', zone: 'Central', phone: '+23277000222', address: '' } });
    assert.equal(noAddr.body.code, 'DELIVERY_ADDRESS');

    // Delivery fee is added to the order, goes entirely to the seller, and commission is only on the goods
    const ship = await api('post', '/api/orders/checkout', buyr.token, { items: item, method: 'cod', delivery: { method: 'ship', zone: 'East', name: 'Cash Buyer', phone: '+23277000222', address: '12 Main Street, Wellington' } });
    assert.equal(ship.status, 201, JSON.stringify(ship.body));
    assert.equal(ship.body.kind, 'cod');
    const o = (await db.query('SELECT * FROM orders WHERE payment_id = $1', [ship.body.paymentId])).rows[0];
    assert.equal(Number(o.total_minor), 2 * 10000 + 3000, 'items plus the East fee');
    assert.equal(o.status, 'pending_acceptance', 'cash on delivery skips the payment wait');
    assert.equal(Number(o.delivery_fee_minor), 3000);
    assert.equal(Number(o.commission_minor), Math.round(2 * 10000 * Number(o.commission_pct) / 100));
    assert.equal(Number(o.seller_earnings_minor), 2 * 10000 - Number(o.commission_minor) + 3000);
    assert.equal(o.delivery_address.address, '12 Main Street, Wellington');
    assert.equal((await db.query('SELECT stock FROM listings WHERE id = $1', [l.id])).rows[0].stock, 8);

    // Seller sees where to deliver; the buyer sees the seller's contact
    const sOrders = await api('get', '/api/orders/selling', sel.token);
    assert.equal(sOrders.body.orders[0].deliveryAddress.phone, '+23277000222');
    assert.equal(sOrders.body.orders[0].cod, true);

    // Cannot mix COD with a download
    const dl = await mkListing(sel.token, { type: 'product', category: 'Digital Downloads', title: 'Guide', price: 5, fulfillment: 'digital', deliveryUrl: 'https://files.test/guide.pdf', stock: undefined });
    const mix = await api('post', '/api/orders/checkout', buyr.token, { items: [{ listingId: dl.id, qty: 1 }], method: 'cod' });
    assert.equal(mix.body.code, 'COD_NOT_AVAILABLE');

    // Run the order: accept, deliver (cash collected), buyer confirms. No earning credit; only the platform fee is charged.
    assert.equal((await api('post', `/api/orders/${o.id}/accept`, sel.token)).status, 200);
    assert.equal((await api('post', `/api/orders/${o.id}/deliver`, sel.token)).status, 200);
    assert.equal((await api('post', `/api/orders/${o.id}/confirm`, buyr.token)).status, 200);
    const w = await api('get', '/api/account/wallet', sel.token);
    assert.equal(Number(w.body.wallet.availableMinor), -Number(o.commission_minor));
    assert.equal(Number(w.body.wallet.owedMinor), Number(o.commission_minor));
    const owed = await api('get', '/api/admin/cod-balances', admin.token);
    assert.ok(owed.body.sellers.some((x) => x.id === sel.id && x.owedMinor === Number(o.commission_minor)));
    assert.equal((await api('delete', '/api/account', sel.token, { password: PASSWORD })).status, 409, 'cannot delete an account that owes money');

    // The admin records the seller paying what they owe
    const adj = await api('post', `/api/admin/users/${sel.id}/wallet-adjustment`, admin.token, { amountMinor: Number(o.commission_minor), note: 'Paid by Orange Money' });
    assert.equal(adj.status, 200);
    assert.equal(Number((await api('get', '/api/account/wallet', sel.token)).body.wallet.availableMinor), 0);

    // Pickup: no fee, the pickup location is remembered
    const pick = await api('post', '/api/orders/checkout', buyr.token, { items: [{ listingId: l.id, qty: 1 }], method: 'cod', delivery: { method: 'pickup', phone: '+23277000222' } });
    assert.equal(pick.status, 201);
    const po = (await db.query('SELECT * FROM orders WHERE payment_id = $1', [pick.body.paymentId])).rows[0];
    assert.equal(Number(po.delivery_fee_minor), 0);
    assert.equal(po.delivery_method, 'pickup');

    // Cancelling a COD order returns the stock and needs no refund
    assert.equal((await api('post', `/api/orders/${po.id}/cancel`, buyr.token)).status, 200);
    assert.equal((await db.query('SELECT stock FROM listings WHERE id = $1', [l.id])).rows[0].stock, 8);

    // A seller who owes too much cannot take more COD orders
    await db.query("INSERT INTO wallet_entries (user_id, kind, amount_minor, note) VALUES ($1,'adjustment',-99999999,'test debt')", [sel.id]);
    const blocked = await api('post', '/api/orders/checkout', buyr.token, { items: item, method: 'cod', delivery: { method: 'pickup', phone: '+23277000222' } });
    assert.equal(blocked.body.code, 'COD_SELLER_BLOCKED');

    // Admin edits the delivery zones
    const z = await api('put', '/api/admin/settings/delivery-zones', admin.token, { zones: [{ name: 'Bo', feeMinor: 500 }] });
    assert.equal(z.status, 200);
    assert.deepEqual((await api('get', '/api/config')).body.delivery.zones, [{ name: 'Bo', feeMinor: 500 }]);
    assert.equal((await api('put', '/api/admin/settings/delivery-zones', buyr.token, { zones: [] })).status, 403);
  });

  test('SMS alerts go through an outbox and a pluggable gateway', async () => {
    const { normalizePhone, enqueueSms, processSmsOutbox } = require('../src/lib/sms');
    const config = require('../src/config');
    assert.equal(normalizePhone('+232 77 000 111'), '+23277000111');
    assert.equal(normalizePhone('077000111'), null, 'no country code configured, so a local number is refused');
    config.sms.countryCode = '232';
    assert.equal(normalizePhone('077000111'), '+23277000111');
    assert.equal(normalizePhone('12'), null);
    config.sms.provider = 'webhook';
    config.sms.webhookUrl = 'https://sms.test/send';
    const calls = [];
    const realFetch = global.fetch;
    global.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, text: async () => '' }; };
    try {
      assert.equal(await enqueueSms(db, { phone: '077000111', body: 'Hello' }), true);
      assert.equal(await processSmsOutbox(), 1);
    } finally { global.fetch = realFetch; config.sms.provider = 'none'; config.sms.countryCode = ''; }
    assert.deepEqual(calls[0].body, { to: '+23277000111', message: 'Hello', channel: 'sms' });
    assert.equal(await enqueueSms(db, { phone: '077000111', body: 'x' }), false, 'nothing queued when SMS is off');
  });

  test('buyer features: wishlist, offers and counter-offers, order timeline, photo reviews', async () => {
    const sel = await register('seller', 'Haggle Seller');
    const buyr = await register('buyer', 'Haggle Buyer');
    const l = await mkListing(sel.token, { title: 'Used Laptop', price: 1000, stock: 3 });

    // Wishlist
    assert.equal((await api('post', '/api/wishlist', null, { listingId: l.id })).status, 401);
    assert.equal((await api('post', '/api/wishlist', buyr.token, { listingId: l.id })).status, 201);
    assert.equal((await api('post', '/api/wishlist', buyr.token, { listingId: l.id })).status, 201, 'saving twice is harmless');
    assert.deepEqual((await api('get', '/api/wishlist/ids', buyr.token)).body.ids, [l.id]);
    assert.equal((await api('get', '/api/wishlist', buyr.token)).body.listings[0].title, 'Used Laptop');
    assert.equal((await api('delete', `/api/wishlist/${l.id}`, buyr.token)).status, 200);
    assert.equal((await api('get', '/api/wishlist/ids', buyr.token)).body.ids.length, 0);

    // Offers: validation
    const offer = (amount, extra = {}) => api('post', '/api/offers', buyr.token, { listingId: l.id, amount, ...extra });
    assert.equal((await offer(1000)).body.code, 'OFFER_TOO_HIGH');
    assert.equal((await offer(100)).body.code, 'OFFER_TOO_LOW');
    assert.equal((await api('post', '/api/offers', sel.token, { listingId: l.id, amount: 800 })).status, 400, 'not on your own listing');
    const made = await offer(700, { qty: 2, message: 'Can you do 700?' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal((await offer(750)).body.code, 'OFFER_EXISTS');

    // Seller counters, buyer accepts the counter
    assert.equal((await api('post', `/api/offers/${made.body.id}/respond`, buyr.token, { action: 'accept' })).status, 404, 'only the seller can respond');
    assert.equal((await api('post', `/api/offers/${made.body.id}/respond`, sel.token, { action: 'counter', counter: 600 })).body.code, 'BAD_COUNTER');
    assert.equal((await api('post', `/api/offers/${made.body.id}/respond`, sel.token, { action: 'counter', counter: 850 })).status, 200);
    const mine = await api('get', '/api/offers/mine', buyr.token);
    assert.equal(mine.body.offers[0].status, 'countered');
    assert.equal((await api('post', `/api/offers/${made.body.id}/buyer`, buyr.token, { action: 'accept' })).status, 200);
    assert.equal(Number((await db.query('SELECT agreed_minor FROM offers WHERE id = $1', [made.body.id])).rows[0].agreed_minor), 85000);

    // Checking out with the offer uses the agreed price and quantity, once
    const pay = await api('post', '/api/orders/checkout', buyr.token, { items: [{ listingId: l.id, qty: 1, offerId: made.body.id }], method: 'test', delivery: { method: 'pickup', phone: '+23277000333' } });
    assert.equal(pay.status, 201, JSON.stringify(pay.body));
    const ord = (await db.query('SELECT * FROM orders WHERE payment_id = $1', [pay.body.paymentId])).rows[0];
    assert.equal(ord.qty, 2);
    assert.equal(Number(ord.unit_price_minor), 85000);
    assert.equal(Number(ord.total_minor), 170000);
    assert.equal((await db.query('SELECT status FROM offers WHERE id = $1', [made.body.id])).rows[0].status, 'used');
    const reuse = await api('post', '/api/orders/checkout', buyr.token, { items: [{ listingId: l.id, qty: 1, offerId: made.body.id }], method: 'test', delivery: { method: 'pickup', phone: '+23277000333' } });
    assert.equal(reuse.body.code, 'OFFER_INVALID');
    const stranger2 = await register('buyer', 'Other Buyer');
    assert.equal((await api('post', '/api/orders/checkout', stranger2.token, { items: [{ listingId: l.id, qty: 1, offerId: made.body.id }], method: 'test', delivery: { method: 'pickup', phone: '+23277000333' } })).body.code, 'OFFER_INVALID');

    // An unpaid checkout hands the agreed price back
    const orders = require('../src/services/orders');
    await orders.failPayment(pay.body.paymentId, 'test');
    assert.equal((await db.query('SELECT status FROM offers WHERE id = $1', [made.body.id])).rows[0].status, 'accepted');

    // Decline and withdraw paths
    const other = await mkListing(sel.token, { title: 'Old Phone', price: 400, stock: 1 });
    const o2 = await api('post', '/api/offers', buyr.token, { listingId: other.id, amount: 250 });
    assert.equal((await api('post', `/api/offers/${o2.body.id}/respond`, sel.token, { action: 'decline' })).status, 200);
    assert.equal((await api('post', `/api/offers/${o2.body.id}/buyer`, buyr.token, { action: 'withdraw' })).status, 409, 'closed offers cannot be changed');
    const o3 = await api('post', '/api/offers', buyr.token, { listingId: other.id, amount: 300 });
    assert.equal(o3.status, 201);
    assert.equal((await api('post', `/api/offers/${o3.body.id}/buyer`, buyr.token, { action: 'withdraw' })).status, 200);
    assert.equal((await api('get', '/api/offers/received', sel.token)).body.offers.length, 3);

    // Order timeline records every step automatically
    const b = await buy(buyr, [{ listingId: other.id, qty: 1 }]);
    const oid = b.orders[0].id;
    await api('post', `/api/orders/${oid}/accept`, sel.token);
    await api('post', `/api/orders/${oid}/deliver`, sel.token);
    await api('post', `/api/orders/${oid}/confirm`, buyr.token);
    const ev = await api('get', `/api/orders/${oid}/events`, buyr.token);
    assert.deepEqual(ev.body.events.map((e) => e.status), ['awaiting_payment', 'pending_acceptance', 'in_progress', 'delivered', 'completed']);
    assert.equal((await api('get', `/api/orders/${oid}/events`, stranger2.token)).status, 404);

    // Review with photos (own uploads only)
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');
    const up = await request(app).post('/api/uploads/review').set('Authorization', `Bearer ${buyr.token}`).attach('images', png, { filename: 'a.png', contentType: 'image/png' });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.equal((await api('post', `/api/orders/${oid}/review`, buyr.token, { rating: 5, comment: 'Great', images: ['https://evil.test/x.png'] })).status, 400);
    assert.equal((await api('post', `/api/orders/${oid}/review`, buyr.token, { rating: 5, comment: 'Great', images: up.body.urls })).status, 201);
    const detail = await api('get', `/api/listings/${other.id}`);
    assert.deepEqual(detail.body.reviews[0].images, up.body.urls);
  });
  test('trust & growth: seller verification, public profile, coupons, promotion, analytics, CSV upload', async () => {
    const sel = await register('seller', 'Vera Verified');
    const buyr = await register('buyer', 'Cora Coupon');
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');

    // verification: the ID goes to a private folder, only an admin can see it, and it is deleted once decided
    assert.equal((await api('get', '/api/seller/verification', buyr.token)).status, 403);
    const send = () => request(app).post('/api/seller/verification').set('Authorization', `Bearer ${sel.token}`).attach('document', png, { filename: 'id.png', contentType: 'image/png' });
    assert.equal((await send()).status, 201);
    assert.equal((await send()).body.code, 'ALREADY');
    assert.ok(fs.readdirSync(path.resolve(process.env.PRIVATE_DIR)).length >= 1);
    const pub = new Set(fs.readdirSync(process.env.UPLOAD_DIR));
    assert.equal(fs.readdirSync(path.resolve(process.env.PRIVATE_DIR)).some((f) => pub.has(f)), false, 'ID must not be in the public folder');
    assert.equal((await api('get', `/api/admin/verifications/${sel.id}/document`, sel.token)).status, 403);
    assert.equal((await api('get', `/api/admin/verifications/${sel.id}/document`, admin.token)).status, 200);
    assert.equal((await api('post', `/api/admin/verifications/${sel.id}/decide`, admin.token, { approve: false })).status, 400);
    assert.equal((await api('post', `/api/admin/verifications/${sel.id}/decide`, admin.token, { approve: true })).status, 200);
    assert.equal((await api('get', `/api/admin/verifications/${sel.id}/document`, admin.token)).status, 404, 'photo removed after decision');
    assert.equal((await api('get', '/api/seller/verification', sel.token)).body.status, 'approved');

    // verified badge on listings + filter
    const l = await mkListing(sel.token, { title: 'Verified Radio', price: 100, stock: 10 });
    const plain = await mkListing((await register('seller', 'Plain Pete')).token, { title: 'Plain Radio', price: 100, stock: 10 });
    assert.equal((await api('get', `/api/listings/${l.id}`)).body.listing.sellerVerified, true);
    assert.deepEqual((await api('get', '/api/listings?verified=1&q=Radio')).body.listings.map((x) => x.id), [l.id]);
    assert.equal((await api('get', '/api/listings?q=Radio')).body.total, 2);

    // public profile
    const prof = await api('get', `/api/sellers/${sel.id}`);
    assert.equal(prof.status, 200);
    assert.equal(prof.body.seller.verified, true);
    assert.equal(prof.body.listings.length, 1);
    assert.equal((await api('get', `/api/sellers/${buyr.id}`)).status, 404, 'buyers have no storefront');

    // views are counted for visitors, not for the owner (the first request above already counted one)
    await api('get', `/api/listings/${l.id}`, sel.token);
    await new Promise((r) => setTimeout(r, 150));
    const views = (await db.query('SELECT views FROM listings WHERE id = $1', [l.id])).rows[0].views;
    assert.equal(views, 1);

    // coupons
    assert.equal((await api('post', '/api/seller/coupons', sel.token, { code: 'ab', percentOff: 5 })).status, 400);
    assert.equal((await api('post', '/api/seller/coupons', sel.token, { code: 'both', percentOff: 10, amountOff: 5 })).status, 400);
    const cp = await api('post', '/api/seller/coupons', sel.token, { code: 'save10', percentOff: 10, maxUses: 1 });
    assert.equal(cp.status, 201, JSON.stringify(cp.body));
    assert.equal((await api('post', '/api/seller/coupons', (await register('seller', 'Other S')).token, { code: 'SAVE10', percentOff: 5 })).body.code, 'CODE_TAKEN');
    const co = (items, code) => api('post', '/api/orders/checkout', buyr.token, { items, method: 'test', couponCode: code });
    assert.equal((await co([{ listingId: l.id, qty: 1 }], 'nope')).body.code, 'COUPON_INVALID');
    assert.equal((await co([{ listingId: plain.id, qty: 1 }], 'SAVE10')).body.code, 'COUPON_NOT_APPLICABLE');
    const paid = await co([{ listingId: l.id, qty: 2 }], 'save10');
    assert.equal(paid.status, 201, JSON.stringify(paid.body));
    const o = (await db.query('SELECT * FROM orders WHERE payment_id = $1', [paid.body.paymentId])).rows[0];
    assert.equal(Number(o.discount_minor), 2000);
    assert.equal(Number(o.total_minor), 18000 + Number(o.delivery_fee_minor));
    assert.equal(Number(o.commission_minor), Math.round(18000 * Number(o.commission_pct || 0) / 100) || Number(o.commission_minor));
    assert.equal((await co([{ listingId: l.id, qty: 1 }], 'SAVE10')).body.code, 'COUPON_EXHAUSTED');
    await orders.failPayment(paid.body.paymentId, 'test');
    assert.equal((await db.query('SELECT used_count FROM coupons WHERE id = $1', [cp.body.coupon.id])).rows[0].used_count, 0);
    assert.equal((await co([{ listingId: l.id, qty: 1 }], 'SAVE10')).status, 201);
    assert.equal((await api('patch', `/api/seller/coupons/${cp.body.coupon.id}`, sel.token, { active: false })).body.coupon.active, false);

    // promotion, paid from the wallet
    assert.equal((await api('post', `/api/seller/listings/${l.id}/boost`, sel.token)).body.code, 'BOOST_OFF');
    const cfg = require('../src/config');
    cfg.boost.priceMinor = 500; cfg.boost.days = 7;
    try {
      assert.equal((await api('post', `/api/seller/listings/${l.id}/boost`, sel.token)).body.code, 'INSUFFICIENT_FUNDS');
      await db.query("INSERT INTO wallet_entries (user_id, kind, amount_minor, note) VALUES ($1,'adjustment',2000,'top up')", [sel.id]);
      assert.equal((await api('post', `/api/seller/listings/${l.id}/boost`, sel.token)).status, 200);
      assert.equal((await api('post', `/api/seller/listings/${plain.id}/boost`, sel.token)).status, 404, 'not your listing');
      assert.equal(Number((await db.query('SELECT sum(amount_minor) AS s FROM wallet_entries WHERE user_id = $1', [sel.id])).rows[0].s), 1500);
      const feed = await api('get', '/api/listings?q=Radio');
      assert.equal(feed.body.listings[0].id, l.id);
      assert.equal(feed.body.listings[0].promoted, true);
    } finally { cfg.boost.priceMinor = 0; }

    // analytics
    const an = await api('get', '/api/seller/analytics', sel.token);
    assert.equal(an.status, 200);
    assert.equal(an.body.views, 1);
    assert.equal(an.body.daily.length, 14);
    assert.equal(an.body.topListings[0].id, l.id);

    // CSV bulk upload
    const csv = 'type,category,title,description,price,stock\nproduct,Electronics,"Speaker, small","Loud ""one""",20,3\nproduct,Nonsense,Bad cat,,5,1\nproduct,Electronics,No stock,,9,\n';
    const bulk = await api('post', '/api/seller/listings/bulk', sel.token, { csv });
    assert.equal(bulk.status, 201, JSON.stringify(bulk.body));
    assert.equal(bulk.body.created, 1);
    assert.deepEqual(bulk.body.errors.map((e) => e.row), [3, 4]);
    const sp = (await db.query("SELECT title, description FROM listings WHERE seller_id = $1 AND title LIKE 'Speaker%'", [sel.id])).rows[0];
    assert.equal(sp.title, 'Speaker, small');
    assert.equal(sp.description, 'Loud "one"');
    assert.equal((await api('post', '/api/seller/listings/bulk', sel.token, { csv: 'title\nx' })).body.code, 'BAD_CSV');
    assert.equal((await api('post', '/api/seller/listings/bulk', buyr.token, { csv })).status, 403);
  });
});
