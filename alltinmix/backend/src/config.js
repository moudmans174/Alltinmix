require('dotenv').config();
const { z } = require('zod');
const marketplace = require('../config/marketplace.config');

const bool = (def) => z.string().optional().transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/alltinmix'),
  DATABASE_SSL: bool(false),
  JWT_SECRET: z.string().default('dev-only-secret-change-me-dev-only-secret'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  BCRYPT_ROUNDS: z.coerce.number().default(12),
  CLIENT_URL: z.string().default('http://localhost:5173'),
  API_URL: z.string().default('http://localhost:4000'),
  TRUST_PROXY: z.string().default('0'),
  UPLOAD_DIR: z.string().default('./uploads'),
  PRIVATE_DIR: z.string().default('./private'),
  AUTO_MIGRATE: bool(true),
  RATE_LIMIT: bool(true),
  REQUIRE_EMAIL_VERIFICATION: z.string().optional(),

  // Which payment systems are switched on: any of  stripe, flutterwave, paypal, momo, mock
  PAYMENT_PROVIDERS: z.string().default('mock'),
  CARD_PROVIDER: z.string().optional(), // stripe | flutterwave (defaults to whichever is enabled)
  ALLOW_MOCK_PAYMENTS: bool(false),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  FLW_SECRET_KEY: z.string().optional(),
  FLW_WEBHOOK_HASH: z.string().optional(),
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  PAYPAL_ENV: z.enum(['sandbox', 'live']).default('sandbox'),

  // Mobile money (manual confirmation flow). A wallet is offered only if its number is set.
  MOMO_ACCOUNT_NAME: z.string().default(''),
  ORANGE_MONEY_NUMBER: z.string().optional(),
  AFRIMONEY_NUMBER: z.string().optional(),
  QMONEY_NUMBER: z.string().optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: bool(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().default('ALLTINMIX <no-reply@localhost>'),

  AUTO_COMPLETE_DAYS: z.coerce.number().default(7),
  PAYMENT_EXPIRY_MINUTES: z.coerce.number().default(30),
  ALLOW_DIGITAL_GOODS: bool(true),
  MIN_PAYOUT_MINOR: z.coerce.number().default(50000),

  // Local delivery and payment
  COD_ENABLED: bool(false),
  COD_MAX_MINOR: z.coerce.number().default(0),
  COD_SELLER_DEBT_LIMIT_MINOR: z.coerce.number().default(5000000),
  DELIVERY_ZONES: z.string().default(''),
  SMS_PROVIDER: z.enum(['none', 'twilio', 'webhook']).default('none'),
  SMS_CHANNEL: z.enum(['sms', 'whatsapp']).default('sms'),
  SMS_FROM: z.string().default(''),
  TWILIO_ACCOUNT_SID: z.string().default(''),
  TWILIO_AUTH_TOKEN: z.string().default(''),
  SMS_WEBHOOK_URL: z.string().default(''),
  SMS_WEBHOOK_TOKEN: z.string().default(''),
  BOOST_PRICE_MINOR: z.coerce.number().default(0),
  BOOST_DAYS: z.coerce.number().default(7),
  PHONE_COUNTRY_CODE: z.string().regex(/^\d{0,4}$/, 'digits only, e.g. 232').default(''),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:\n' + parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'));
  process.exit(1);
}
const e = parsed.data;
const isProd = e.NODE_ENV === 'production';
const isTest = e.NODE_ENV === 'test';

const providers = e.PAYMENT_PROVIDERS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const has = (name) => providers.includes(name);

const baseCode = marketplace.currency.code;
const listOf = (value, fallback) => (value || fallback).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const offered = marketplace.currencies.map((c) => c.code);

const stripeReady = !!(e.STRIPE_SECRET_KEY && e.STRIPE_WEBHOOK_SECRET);
const flwReady = !!(e.FLW_SECRET_KEY && e.FLW_WEBHOOK_HASH);
const paypalReady = !!(e.PAYPAL_CLIENT_ID && e.PAYPAL_CLIENT_SECRET);

/**
 * The payment METHODS buyers see at checkout. Each method is handled by one provider.
 *   kind 'redirect': buyer is sent to the provider's hosted page (card, PayPal)
 *   kind 'manual'  : buyer sends mobile money and submits the transaction ID; an admin confirms it
 */
const paymentMethods = [];
const cardProvider = e.CARD_PROVIDER || (has('stripe') ? 'stripe' : has('flutterwave') ? 'flutterwave' : null);
if (cardProvider === 'stripe' && has('stripe') && stripeReady) paymentMethods.push({ key: 'card', label: 'Credit / debit card', provider: 'stripe', kind: 'redirect', currencies: listOf(e.CARD_CURRENCIES, 'USD') });
if (cardProvider === 'flutterwave' && has('flutterwave') && flwReady) paymentMethods.push({ key: 'card', label: 'Credit / debit card', provider: 'flutterwave', kind: 'redirect', currencies: listOf(e.CARD_CURRENCIES, 'USD') });
if (has('paypal') && paypalReady) paymentMethods.push({ key: 'paypal', label: 'PayPal', provider: 'paypal', kind: 'redirect', currencies: listOf(e.PAYPAL_CURRENCIES, 'USD') });
if (has('momo')) {
  const wallets = [
    { key: 'orange_money', label: 'Orange Money', number: e.ORANGE_MONEY_NUMBER },
    { key: 'afrimoney', label: 'Afrimoney', number: e.AFRIMONEY_NUMBER },
    { key: 'qmoney', label: 'QMoney', number: e.QMONEY_NUMBER },
  ];
  for (const w of wallets) if (w.number) paymentMethods.push({ key: w.key, label: w.label, provider: 'momo', kind: 'manual', number: w.number, accountName: e.MOMO_ACCOUNT_NAME, currencies: listOf(e.MOMO_CURRENCIES, baseCode) });
}
if (e.COD_ENABLED) paymentMethods.push({ key: 'cod', label: 'Cash on delivery', provider: 'cod', kind: 'cod', currencies: [baseCode] });
if (has('mock') && (!isProd || e.ALLOW_MOCK_PAYMENTS)) paymentMethods.push({ key: 'test', label: 'Test payment (no real money)', provider: 'mock', kind: 'redirect', currencies: offered });

// A method only works in currencies the marketplace actually offers (base + FX_RATES). Drop methods with none, and say so.
for (let i = paymentMethods.length - 1; i >= 0; i--) {
  const m = paymentMethods[i];
  const wanted = m.currencies;
  m.currencies = wanted.filter((c) => offered.includes(c));
  if (!m.currencies.length) {
    console.warn(`[config] Payment method "${m.label}" is hidden: it accepts ${wanted.join(', ')} but the marketplace only offers ${offered.join(', ')}. Add the currency to FX_RATES.`);
    paymentMethods.splice(i, 1);
  }
}

// Refuse to boot in production with unsafe or incomplete settings.
if (isProd) {
  const problems = [];
  if (e.JWT_SECRET.length < 32 || e.JWT_SECRET.startsWith('dev-only')) problems.push('JWT_SECRET must be a random string of at least 32 characters.');
  if (!process.env.DATABASE_URL) problems.push('DATABASE_URL is required.');
  if (!process.env.CLIENT_URL || !process.env.API_URL) problems.push('CLIENT_URL and API_URL are required.');
  if (has('mock') && !e.ALLOW_MOCK_PAYMENTS) problems.push('The "mock" provider moves no real money. Remove it from PAYMENT_PROVIDERS (or set ALLOW_MOCK_PAYMENTS=true for a demo).');
  if (has('stripe') && !stripeReady) problems.push('Stripe needs STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.');
  if (has('flutterwave') && !flwReady) problems.push('Flutterwave needs FLW_SECRET_KEY and FLW_WEBHOOK_HASH.');
  if (has('paypal') && !paypalReady) problems.push('PayPal needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.');
  if (has('momo') && !(e.ORANGE_MONEY_NUMBER || e.AFRIMONEY_NUMBER || e.QMONEY_NUMBER)) problems.push('Mobile money needs at least one of ORANGE_MONEY_NUMBER, AFRIMONEY_NUMBER, QMONEY_NUMBER.');
  if (paymentMethods.length === 0) problems.push('No payment method is enabled. Set PAYMENT_PROVIDERS and the matching credentials.');
  const placeholder = /example\.(com|org)|yourdomain|localhost|change-me/i;
  for (const k of ['CLIENT_URL', 'API_URL', 'EMAIL_FROM', 'SUPPORT_EMAIL']) {
    const v = process.env[k];
    if (!v || placeholder.test(v)) problems.push(`${k} must be set to your real address (it is empty or still a placeholder).`);
  }
  if (/change-me/i.test(process.env.POSTGRES_PASSWORD || '')) problems.push('POSTGRES_PASSWORD is still the placeholder.');
  if (e.SMS_PROVIDER === 'twilio' && !(e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && e.SMS_FROM)) problems.push('Twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and SMS_FROM.');
  if (e.SMS_PROVIDER === 'webhook' && !e.SMS_WEBHOOK_URL) problems.push('SMS_PROVIDER=webhook needs SMS_WEBHOOK_URL.');
  if (!e.SMTP_HOST) problems.push('SMTP_HOST is required so verification and order emails can be delivered.');
  if (problems.length) {
    console.error('Refusing to start in production:\n' + problems.map((p) => '  - ' + p).join('\n'));
    process.exit(1);
  }
}

const verticals = marketplace.verticals;

module.exports = {
  env: e.NODE_ENV,
  isProd,
  isTest,
  port: e.PORT,
  databaseUrl: e.DATABASE_URL,
  databaseSsl: e.DATABASE_SSL,
  jwtSecret: e.JWT_SECRET,
  jwtExpiresIn: e.JWT_EXPIRES_IN,
  bcryptRounds: isTest ? 4 : e.BCRYPT_ROUNDS,
  clientUrl: e.CLIENT_URL.split(',')[0].trim().replace(/\/$/, ''),
  clientOrigins: e.CLIENT_URL.split(',').map((s) => s.trim().replace(/\/$/, '')),
  apiUrl: e.API_URL.replace(/\/$/, ''),
  trustProxy: e.TRUST_PROXY === 'true' ? true : Number.isNaN(Number(e.TRUST_PROXY)) ? e.TRUST_PROXY : Number(e.TRUST_PROXY),
  uploadDir: e.UPLOAD_DIR,
  privateDir: e.PRIVATE_DIR,
  autoMigrate: e.AUTO_MIGRATE,
  rateLimitEnabled: e.RATE_LIMIT && !isTest,
  requireEmailVerification: e.REQUIRE_EMAIL_VERIFICATION === undefined ? isProd : e.REQUIRE_EMAIL_VERIFICATION === 'true',

  paymentMethods,
  stripe: { secretKey: e.STRIPE_SECRET_KEY, webhookSecret: e.STRIPE_WEBHOOK_SECRET },
  flutterwave: { secretKey: e.FLW_SECRET_KEY, webhookHash: e.FLW_WEBHOOK_HASH },
  paypal: { clientId: e.PAYPAL_CLIENT_ID, clientSecret: e.PAYPAL_CLIENT_SECRET, webhookId: e.PAYPAL_WEBHOOK_ID, env: e.PAYPAL_ENV },

  smtp: { host: e.SMTP_HOST, port: e.SMTP_PORT, secure: e.SMTP_SECURE, user: e.SMTP_USER, pass: e.SMTP_PASS },
  emailFrom: e.EMAIL_FROM,

  autoCompleteDays: e.AUTO_COMPLETE_DAYS,
  paymentExpiryMinutes: e.PAYMENT_EXPIRY_MINUTES,
  minPayoutMinor: e.MIN_PAYOUT_MINOR,
  allowDigital: e.ALLOW_DIGITAL_GOODS,
  boost: { priceMinor: e.BOOST_PRICE_MINOR, days: e.BOOST_DAYS },
  cod: { enabled: e.COD_ENABLED, maxMinor: e.COD_MAX_MINOR, sellerDebtLimitMinor: e.COD_SELLER_DEBT_LIMIT_MINOR },
  deliveryZonesDefault: e.DELIVERY_ZONES.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.lastIndexOf(':');
    const fee = i > 0 ? Number(s.slice(i + 1)) : NaN;
    return Number.isFinite(fee) && fee >= 0 ? { name: s.slice(0, i).trim(), feeMinor: Math.round(fee * 10 ** marketplace.currency.decimals) } : null;
  }).filter(Boolean),
  sms: { provider: e.SMS_PROVIDER, channel: e.SMS_CHANNEL, from: e.SMS_FROM, twilioSid: e.TWILIO_ACCOUNT_SID, twilioToken: e.TWILIO_AUTH_TOKEN, webhookUrl: e.SMS_WEBHOOK_URL, webhookToken: e.SMS_WEBHOOK_TOKEN, countryCode: e.PHONE_COUNTRY_CODE },

  baseCurrency: baseCode,
  currencies: marketplace.currencies,
  currencyOf: (code) => marketplace.currencies.find((c) => c.code === code),
  marketplace,
  verticals,
  verticalOf: (type) => verticals.find((v) => v.key === type),
};
