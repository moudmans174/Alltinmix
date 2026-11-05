const express = require('express');
const { z } = require('zod');
const db = require('../db');
const config = require('../config');
const { HttpError, parse, sha256, randomToken } = require('../lib/util');
const { hashPassword, verifyPassword, DUMMY_HASH, signToken, publicUser, requireAuth } = require('../lib/auth');
const { layout, enqueueEmail } = require('../lib/notify');

const router = express.Router();

const password = z.string().min(8, 'Use at least 8 characters.').max(72, 'Use at most 72 characters.');
const email = z.string().trim().toLowerCase().email('Enter a valid email address.').max(254);

async function issueToken(q, userId, kind, hours) {
  const raw = randomToken(32);
  await q.query("UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND kind = $2 AND used_at IS NULL", [userId, kind]); // invalidate older links
  await q.query("INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at) VALUES ($1,$2,$3, now() + make_interval(hours => $4))", [userId, kind, sha256(raw), hours]);
  return raw;
}

async function sendVerificationEmail(q, user) {
  const token = await issueToken(q, user.id, 'verify_email', 48);
  const url = `${config.clientUrl}/verify-email?token=${token}`;
  await enqueueEmail(q, {
    to: user.email,
    subject: `Confirm your email for ${config.marketplace.brand.name}`,
    html: layout({ title: `Welcome, ${user.name}!`, bodyHtml: '<p>Please confirm your email address to start buying and selling. This link works for 48 hours.</p>', ctaUrl: url, ctaLabel: 'Confirm email' }),
    text: `Welcome ${user.name}! Confirm your email: ${url}`,
  });
}

router.post('/register', async (req, res) => {
  const body = parse(z.object({
    name: z.string().trim().min(2, 'Enter your name.').max(80),
    email,
    password,
    role: z.enum(['buyer', 'seller']),
    tag: z.string().trim().max(60).optional(),
    phone: z.string().trim().max(30).optional(),
  }), req.body);

  const user = await db.tx(async (c) => {
    const exists = await c.query('SELECT 1 FROM users WHERE lower(email) = $1', [body.email]);
    if (exists.rowCount) throw new HttpError(409, 'An account with this email already exists. Try logging in.', { code: 'EMAIL_TAKEN' });
    const { rows } = await c.query(
      'INSERT INTO users (name, email, password_hash, role, tag, phone) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [body.name, body.email, await hashPassword(body.password), body.role, body.tag || (body.role === 'seller' ? 'Seller' : ''), body.phone || null]
    );
    await sendVerificationEmail(c, rows[0]);
    return rows[0];
  });
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

router.post('/login', async (req, res) => {
  const body = parse(z.object({ email, password: z.string().min(1).max(200) }), req.body);
  const { rows } = await db.query('SELECT * FROM users WHERE lower(email) = $1', [body.email]);
  const user = rows[0];
  const ok = await verifyPassword(body.password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'Incorrect email or password.', { code: 'BAD_CREDENTIALS' });
  if (user.status !== 'active') throw new HttpError(403, 'This account has been suspended. Contact support.', { code: 'SUSPENDED' });
  res.json({ token: signToken(user), user: publicUser(user) });
});

router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

router.post('/verify-email', async (req, res) => {
  const { token } = parse(z.object({ token: z.string().min(10).max(200) }), req.body);
  await db.tx(async (c) => {
    const { rows } = await c.query("SELECT * FROM auth_tokens WHERE token_hash = $1 AND kind = 'verify_email' FOR UPDATE", [sha256(token)]);
    const t = rows[0];
    if (!t || t.used_at || new Date(t.expires_at) < new Date()) throw new HttpError(400, 'This verification link is invalid or has expired. Request a new one.', { code: 'BAD_TOKEN' });
    await c.query('UPDATE auth_tokens SET used_at = now() WHERE id = $1', [t.id]);
    await c.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1', [t.user_id]);
  });
  res.json({ ok: true });
});

router.post('/resend-verification', requireAuth, async (req, res) => {
  if (req.user.emailVerified) return res.json({ ok: true });
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  await db.tx((c) => sendVerificationEmail(c, rows[0]));
  res.json({ ok: true });
});

// Always answers the same way, so it can't be used to discover which emails have accounts.
router.post('/forgot-password', async (req, res) => {
  const body = parse(z.object({ email }), req.body);
  const { rows } = await db.query("SELECT * FROM users WHERE lower(email) = $1 AND status = 'active'", [body.email]);
  if (rows[0]) {
    await db.tx(async (c) => {
      const token = await issueToken(c, rows[0].id, 'reset_password', 1);
      const url = `${config.clientUrl}/reset-password?token=${token}`;
      await enqueueEmail(c, {
        to: rows[0].email,
        subject: `Reset your ${config.marketplace.brand.name} password`,
        html: layout({ title: 'Reset your password', bodyHtml: "<p>Use the button below to choose a new password. The link works for 1 hour. If you didn't ask for this, you can ignore this email.</p>", ctaUrl: url, ctaLabel: 'Choose a new password' }),
        text: `Reset your password: ${url}`,
      });
    });
  }
  res.json({ ok: true });
});

router.post('/reset-password', async (req, res) => {
  const body = parse(z.object({ token: z.string().min(10).max(200), password }), req.body);
  await db.tx(async (c) => {
    const { rows } = await c.query("SELECT * FROM auth_tokens WHERE token_hash = $1 AND kind = 'reset_password' FOR UPDATE", [sha256(body.token)]);
    const t = rows[0];
    if (!t || t.used_at || new Date(t.expires_at) < new Date()) throw new HttpError(400, 'This reset link is invalid or has expired. Request a new one.', { code: 'BAD_TOKEN' });
    await c.query('UPDATE auth_tokens SET used_at = now() WHERE id = $1', [t.id]);
    // Bumping token_version signs the user out everywhere, including any thief holding the old password.
    await c.query('UPDATE users SET password_hash = $2, token_version = token_version + 1, email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1', [t.user_id, await hashPassword(body.password)]);
  });
  res.json({ ok: true });
});

router.post('/change-password', requireAuth, async (req, res) => {
  const body = parse(z.object({ currentPassword: z.string().min(1), newPassword: password }), req.body);
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  if (!(await verifyPassword(body.currentPassword, rows[0].password_hash))) throw new HttpError(400, 'Your current password is incorrect.', { code: 'BAD_CREDENTIALS' });
  const { rows: upd } = await db.query('UPDATE users SET password_hash = $2, token_version = token_version + 1, updated_at = now() WHERE id = $1 RETURNING *', [req.user.id, await hashPassword(body.newPassword)]);
  res.json({ token: signToken(upd[0]), user: publicUser(upd[0]) });
});

module.exports = router;
