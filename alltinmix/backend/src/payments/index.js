/**
 * Payment layer. Buyers choose a payment METHOD (card, PayPal, Orange Money, Afrimoney, QMoney).
 * Each method is handled by a PROVIDER with the same small interface:
 *
 *   createCheckout({ payment, buyer, description, method }) -> { redirectUrl, providerRef }
 *   verify(payment)        -> { status: 'paid' | 'failed' | 'pending', providerTxnId? }
 *   parseWebhook(req)      -> { paymentId | providerRef, status, providerTxnId, needsVerify } | null
 *   refund(payment, minor) -> { ref, manual? }
 *
 * To add a provider (for example Orange Money Web Payment once your client has merchant credentials),
 * create a file next to stripe.js that implements those four functions, then register it below.
 */
const crypto = require('node:crypto');
const config = require('../config');
const { HttpError } = require('../lib/util');

const mock = {
  name: 'mock',
  async createCheckout({ payment }) {
    return { redirectUrl: `${config.clientUrl}/pay/mock/${payment.id}`, providerRef: payment.id };
  },
  async verify() {
    return { status: 'pending' };
  },
  parseWebhook() {
    return null;
  },
  async refund() {
    return { ref: 'mock-refund-' + crypto.randomUUID() };
  },
};

/**
 * Mobile money (Orange Money, Afrimoney, QMoney) with manual confirmation:
 * the buyer sends money to the merchant's wallet, submits the transaction ID from the confirmation SMS,
 * and an admin confirms it against the wallet statement. No operator API is needed.
 * Refunds are likewise sent by the merchant by hand; the order is flagged "refund due" for the admin.
 */
const momo = {
  name: 'momo',
  async createCheckout({ payment }) {
    const code = 'PAY-' + crypto.randomBytes(4).toString('hex').toUpperCase(); // reference the buyer writes in the transfer note
    return { redirectUrl: `${config.clientUrl}/pay/manual/${payment.id}`, providerRef: code };
  },
  async verify() {
    return { status: 'pending' };
  },
  parseWebhook() {
    return null;
  },
  async refund() {
    return { ref: 'manual', manual: true };
  },
};

const providers = {
  mock,
  momo,
  stripe: require('./stripe'),
  flutterwave: require('./flutterwave'),
  paypal: require('./paypal'),
};

/** A payment method the buyer can currently choose (must be enabled in config). */
function getMethod(key) {
  const m = config.paymentMethods.find((x) => x.key === key);
  if (!m) throw new HttpError(400, 'That payment method is not available.', { code: 'PAYMENT_METHOD_UNAVAILABLE' });
  return m;
}

/** A provider by name, used for refunds and webhooks even if the method was later disabled. */
function providerByName(name) {
  const p = providers[name];
  if (!p) throw new HttpError(500, `Unknown payment provider "${name}".`);
  return p;
}

/** Public description of the enabled methods (never includes secrets). */
function publicMethods() {
  return config.paymentMethods.map((m) => ({ key: m.key, label: m.label, kind: m.kind, currencies: m.currencies }));
}

module.exports = { getMethod, providerByName, publicMethods };
