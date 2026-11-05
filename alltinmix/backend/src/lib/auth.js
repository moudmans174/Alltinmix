const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');
const { HttpError } = require('./util');

const hashPassword = (plain) => bcrypt.hash(plain, config.bcryptRounds);
const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);
// Compared against when an email is unknown, so login timing doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', config.bcryptRounds);

const signToken = (user) => jwt.sign({ sub: user.id, tv: user.token_version }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });

const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  tag: u.tag,
  phone: u.phone,
  emailVerified: !!u.email_verified_at,
  payoutMethod: u.payout_method,
  payoutDetails: u.payout_details,
});

async function loadUserFromRequest(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    throw new HttpError(401, 'Your session has expired. Please log in again.', { code: 'UNAUTHORIZED' });
  }
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [payload.sub]);
  const user = rows[0];
  // Checked against the database on every request so suspensions and password changes take effect immediately.
  if (!user || user.token_version !== payload.tv) throw new HttpError(401, 'Your session is no longer valid. Please log in again.', { code: 'UNAUTHORIZED' });
  if (user.status !== 'active') throw new HttpError(403, 'This account has been suspended. Contact support.', { code: 'SUSPENDED' });
  return { ...publicUser(user), status: user.status };
}

async function requireAuth(req, res, next) {
  const user = await loadUserFromRequest(req);
  if (!user) throw new HttpError(401, 'Please log in to continue.', { code: 'UNAUTHORIZED' });
  req.user = user;
  next();
}

async function optionalAuth(req, res, next) {
  req.user = (await loadUserFromRequest(req)) || null;
  next();
}

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) throw new HttpError(403, 'You do not have permission to do that.', { code: 'FORBIDDEN' });
  next();
};

const requireVerified = (req, res, next) => {
  if (config.requireEmailVerification && !req.user.emailVerified) {
    throw new HttpError(403, 'Please verify your email address to continue. Check your inbox for the link.', { code: 'EMAIL_NOT_VERIFIED' });
  }
  next();
};

module.exports = { hashPassword, verifyPassword, DUMMY_HASH, signToken, publicUser, requireAuth, optionalAuth, requireRole, requireVerified };
