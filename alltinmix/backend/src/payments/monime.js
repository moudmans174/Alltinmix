/**
 * Monime (Sierra Leone): Orange Money, Afrimoney and other wallets, plus bank and card, on one hosted checkout page.
 * https://docs.monime.io  (API version "caph")
 *
 * Flow: we create a Checkout Session -> the buyer is sent to Monime's page -> they pay -> Monime sends them back to
 * /pay/return/:id and calls our webhook. We NEVER trust the webhook or the return page on their own. Every "paid" decision
 * is made by asking Monime's API for the session (verify below), so a forged webhook cannot mark anything paid.
 * A background job also checks pending Monime payments, so orders still complete if a webhook is missed.
 */
const config = require('../config');

const BASE = 'https://api.monime.io';

// Statuses Monime reports for a checkout session. Anything we do not recognise is treated as "still pending"
// (never as paid), and logged so it can be added here.
const PAID = new Set(['completed', 'complete', 'paid', 'successful', 'succeeded']);
const DEAD = new Set(['expired', 'cancelled', 'canceled', 'failed']);

async function monime(path, { method = 'GET', body, idempotencyKey } = {}) {
  const m = config.monime;
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${m.accessToken}`,
      'Monime-Space-Id': m.spaceId,
      'Monime-Version': m.version,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const why = json.error?.message || json.messages?.[0]?.message || json.message || res.status;
    throw new Error(`Monime ${method} ${path} failed (${res.status}): ${why}`);
  }
  return json.result ?? json;
}

/** Monime amounts are whole numbers. Our amounts are already integer minor units, which is what Monime expects. */
const toMonimeValue = (amountMinor) => (config.monime.amountUnit === 'major' ? amountMinor / 10 ** config.marketplace.currency.decimals : amountMinor);
const fromMonimeValue = (v) => (config.monime.amountUnit === 'major' ? Math.round(Number(v) * 10 ** config.marketplace.currency.decimals) : Math.round(Number(v)));

module.exports = {
  name: 'monime',
  monime, // used by the "check credentials" command

  async createCheckout({ payment, description }) {
    const back = `${config.clientUrl}/pay/return/${payment.id}`;
    const s = await monime('/v1/checkout-sessions', {
      method: 'POST',
      idempotencyKey: payment.id, // a retry of the same payment can never create a second session
      body: {
        name: config.marketplace.brand.name.slice(0, 150),
        description: (description || '').slice(0, 1000),
        reference: payment.id,
        callbackState: payment.id,
        successUrl: back,
        cancelUrl: back,
        lineItems: [{ type: 'custom', name: (description || 'Order').slice(0, 150), price: { currency: payment.currency, value: toMonimeValue(payment.amount_minor) }, quantity: 1, reference: payment.id }],
        metadata: { paymentId: payment.id },
      },
    });
    if (!s.redirectUrl || !s.id) throw new Error('Monime did not return a checkout link.');
    return { redirectUrl: s.redirectUrl, providerRef: s.id };
  },

  async verify(payment) {
    if (!payment.provider_ref) return { status: 'pending' };
    const s = await monime(`/v1/checkout-sessions/${encodeURIComponent(payment.provider_ref)}`);
    // The session must be the one we made for this payment.
    if (s.reference && s.reference !== payment.id) return { status: 'pending' };
    const status = String(s.status || '').toLowerCase();
    if (PAID.has(status)) {
      // Defence in depth: if Monime echoes the price, it has to match what we asked for.
      const item = s.lineItems?.data?.[0] || s.lineItems?.[0];
      if (item?.price && (item.price.currency !== payment.currency || fromMonimeValue(item.price.value) !== Number(payment.amount_minor))) {
        console.error(`[monime] amount mismatch on payment ${payment.id}: expected ${payment.amount_minor} ${payment.currency}, got ${item.price.value} ${item.price.currency}`);
        return { status: 'pending' };
      }
      return { status: 'paid', providerTxnId: s.id };
    }
    if (DEAD.has(status)) return { status: 'failed' };
    if (status !== 'pending') console.warn(`[monime] unrecognised checkout status "${s.status}" for payment ${payment.id}; treating as pending`);
    return { status: 'pending' };
  },

  /**
   * The webhook body only tells us WHICH payment to look at. We find our payment id (or the Monime session id) anywhere in
   * the payload, then the handler re-checks with Monime's API (needsVerify) before changing anything.
   */
  parseWebhook(req) {
    const ids = new Set();
    const walk = (v, depth = 0) => {
      if (depth > 6 || v == null) return;
      if (typeof v === 'string') { if (/^sps-[\w-]+$/i.test(v) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) ids.add(v); return; }
      if (Array.isArray(v)) return v.slice(0, 50).forEach((x) => walk(x, depth + 1));
      if (typeof v === 'object') Object.values(v).slice(0, 80).forEach((x) => walk(x, depth + 1));
    };
    walk(req.body);
    if (!ids.size) return null;
    return { candidates: [...ids], status: 'paid', needsVerify: true };
  },

  // Monime's API has no documented refund call, so refunds are sent by hand from your Monime dashboard and recorded in
  // Admin > Refunds due, exactly like manual mobile money.
  async refund() {
    return { ref: 'manual', manual: true };
  },
};
