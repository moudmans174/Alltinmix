const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const config = require('./config');
const { HttpError } = require('./lib/util');

function limiter(windowMinutes, max, message) {
  if (!config.rateLimitEnabled) return (req, res, next) => next();
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: message, code: 'RATE_LIMITED' }),
  });
}

function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } })); // images are loaded from the frontend's origin
  // The mobile app (Capacitor) runs the site from these local origins.
  const appOrigins = ['capacitor://localhost', 'https://localhost', 'http://localhost'];
  app.use(cors({ origin: [...new Set([...config.clientOrigins, ...appOrigins])] }));
  if (!config.isTest) app.use(morgan(config.isProd ? 'combined' : 'dev'));

  // Webhooks first: they need the raw request body, and they must not be rate limited.
  app.use('/api/webhooks', require('./routes/orders').webhooks);

  app.use('/api/seller/listings/bulk', express.json({ limit: '500kb' })); // CSV uploads are bigger than normal requests
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', limiter(15, 600, 'Too many requests. Please slow down.'));
  app.use('/api/auth/login', limiter(15, 20, 'Too many login attempts. Try again in 15 minutes.'));
  app.use('/api/auth/register', limiter(60, 20, 'Too many sign-ups from this network. Try again later.'));
  app.use('/api/auth/forgot-password', limiter(60, 10, 'Too many reset requests. Try again later.'));
  app.use('/api/conversations', limiter(1, 30, 'You are sending messages too quickly.'));
  app.use('/api/uploads', limiter(60, 60, 'Too many uploads. Try again later.'));

  app.use('/uploads', express.static(path.resolve(config.uploadDir), { maxAge: '7d', index: false, dotfiles: 'deny' }));

  const orderRoutes = require('./routes/orders');
  const listingRoutes = require('./routes/listings');
  const social = require('./routes/social');
  app.use('/api', require('./routes/public'));
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/listings', listingRoutes.listings);
  app.use('/api/uploads', listingRoutes.uploads);
  app.use('/api/orders', orderRoutes.orders);
  app.use('/api/payments', orderRoutes.payments);
  app.use('/api/conversations', social.conversations);
  app.use('/api/notifications', social.notifications);
  const safety = require('./routes/safety');
  app.use('/api/account', safety.account);
  app.use('/api/account', require('./routes/account'));
  const buyer = require('./routes/buyer');
  app.use('/api/wishlist', buyer.wishlist);
  app.use('/api/offers', buyer.offers);
  app.use('/api/reports', safety.reports);
  app.use('/api/blocks', safety.blocks);
  const growth = require('./routes/growth');
  app.use('/api/sellers', growth.sellers);
  app.use('/api/seller', growth.growth);
  app.use('/api/admin', growth.adminVerification);
  app.use('/api/admin', require('./routes/admin'));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `Each image must be under ${config.marketplace.limits.maxImageMB} MB.` : 'Upload failed. Check the number and size of your images.';
      return res.status(400).json({ error: msg, code: 'BAD_FILE' });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON in request.', code: 'BAD_JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
    console.error('[error]', req.method, req.originalUrl, err);
    res.status(500).json({ error: 'Something went wrong on our side. Please try again.', code: 'SERVER_ERROR' });
  });

  return app;
}

module.exports = { createApp };
