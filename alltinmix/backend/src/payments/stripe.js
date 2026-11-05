const config = require('../config');

let client;
const stripe = () => (client ||= new (require('stripe'))(config.stripe.secretKey));

module.exports = {
  name: 'stripe',

  async createCheckout({ payment, buyer, description }) {
    const session = await stripe().checkout.sessions.create({
      mode: 'payment',
      client_reference_id: payment.id,
      customer_email: buyer.email,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: payment.currency.toLowerCase(),
            unit_amount: payment.amount_minor, // Stripe uses the same minor units as we store
            product_data: { name: description },
          },
        },
      ],
      metadata: { paymentId: payment.id },
      payment_intent_data: { metadata: { paymentId: payment.id } },
      success_url: `${config.clientUrl}/pay/return/${payment.id}`,
      cancel_url: `${config.clientUrl}/cart`,
      expires_at: Math.floor(Date.now() / 1000) + Math.max(30, config.paymentExpiryMinutes) * 60 + 60,
    });
    return { redirectUrl: session.url, providerRef: session.id };
  },

  async verify(payment) {
    const s = await stripe().checkout.sessions.retrieve(payment.provider_ref);
    if (s.payment_status === 'paid') {
      const pi = typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id;
      return { status: 'paid', providerTxnId: pi };
    }
    if (s.status === 'expired') return { status: 'failed' };
    return { status: 'pending' };
  },

  /** `req.body` must be the raw Buffer (the webhook route uses express.raw). Throws if the signature is invalid. */
  parseWebhook(req) {
    const event = stripe().webhooks.constructEvent(req.body, req.headers['stripe-signature'], config.stripe.webhookSecret);
    const s = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        if (s.payment_status !== 'paid') return null;
        return { paymentId: s.metadata?.paymentId, status: 'paid', providerTxnId: typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id };
      case 'checkout.session.expired':
      case 'checkout.session.async_payment_failed':
        return { paymentId: s.metadata?.paymentId, status: 'failed' };
      default:
        return null;
    }
  },

  async refund(payment, amountMinor) {
    const r = await stripe().refunds.create({ payment_intent: payment.provider_txn_id, amount: amountMinor });
    return { ref: r.id };
  },
};
