const config = require('../config');
const { toMajor } = require('../lib/util');

const base = () => (config.paypal.env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');
const money = (minor) => toMajor(minor).toFixed(config.marketplace.currency.decimals);

let tokenCache = { token: null, expiresAt: 0 };
async function accessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.token;
  const basic = Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString('base64');
  const res = await fetch(base() + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PayPal auth failed: ${json.error_description || res.status}`);
  tokenCache = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return tokenCache.token;
}

async function api(path, { method = 'GET', body, requestId } = {}) {
  const headers = { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' };
  if (requestId) headers['PayPal-Request-Id'] = requestId; // makes retries safe (no double capture)
  const res = await fetch(base() + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PayPal ${method} ${path} failed: ${json.message || res.status}`);
  return json;
}

const captureOf = (order) => order.purchase_units?.[0]?.payments?.captures?.[0];

module.exports = {
  name: 'paypal',

  async createCheckout({ payment, description }) {
    const order = await api('/v2/checkout/orders', {
      method: 'POST',
      requestId: `create-${payment.id}`,
      body: {
        intent: 'CAPTURE',
        purchase_units: [
          { reference_id: payment.id, custom_id: payment.id, description: description.slice(0, 120), amount: { currency_code: payment.currency, value: money(payment.amount_minor) } },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: config.marketplace.brand.name,
              user_action: 'PAY_NOW',
              return_url: `${config.clientUrl}/pay/return/${payment.id}`,
              cancel_url: `${config.clientUrl}/cart`,
            },
          },
        },
      },
    });
    const link = order.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve');
    if (!link) throw new Error('PayPal did not return an approval link');
    return { redirectUrl: link.href, providerRef: order.id };
  },

  /** Called when the buyer returns from PayPal: captures the approved order, or reports its state. */
  async verify(payment) {
    let order = await api(`/v2/checkout/orders/${payment.provider_ref}`);
    if (order.status === 'APPROVED') {
      order = await api(`/v2/checkout/orders/${payment.provider_ref}/capture`, { method: 'POST', requestId: `capture-${payment.id}`, body: {} });
    }
    if (order.status === 'COMPLETED') {
      const cap = captureOf(order);
      const paid = cap && cap.status === 'COMPLETED' && cap.amount.currency_code === payment.currency && cap.amount.value === money(payment.amount_minor);
      return paid ? { status: 'paid', providerTxnId: cap.id } : { status: 'failed' };
    }
    if (order.status === 'VOIDED') return { status: 'failed' };
    return { status: 'pending' };
  },

  async parseWebhook(req) {
    if (!config.paypal.webhookId) return null; // webhooks optional: the return flow already captures the payment
    const check = await api('/v1/notifications/verify-webhook-signature', {
      method: 'POST',
      body: {
        auth_algo: req.headers['paypal-auth-algo'],
        cert_url: req.headers['paypal-cert-url'],
        transmission_id: req.headers['paypal-transmission-id'],
        transmission_sig: req.headers['paypal-transmission-sig'],
        transmission_time: req.headers['paypal-transmission-time'],
        webhook_id: config.paypal.webhookId,
        webhook_event: req.body,
      },
    });
    if (check.verification_status !== 'SUCCESS') {
      const err = new Error('Invalid PayPal signature');
      err.status = 400;
      throw err;
    }
    const orderId = req.body?.resource?.supplementary_data?.related_ids?.order_id;
    if (req.body.event_type === 'PAYMENT.CAPTURE.COMPLETED' && orderId) return { providerRef: orderId, status: 'paid', needsVerify: true };
    return null;
  },

  async refund(payment, amountMinor) {
    const r = await api(`/v2/payments/captures/${payment.provider_txn_id}/refund`, {
      method: 'POST',
      requestId: `refund-${payment.id}-${amountMinor}-${Date.now()}`,
      body: { amount: { value: money(amountMinor), currency_code: payment.currency } },
    });
    return { ref: r.id };
  },
};
