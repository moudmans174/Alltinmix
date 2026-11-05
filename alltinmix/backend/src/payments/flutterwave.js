const config = require('../config');
const { toMajor } = require('../lib/util');

const BASE = 'https://api.flutterwave.com/v3';

async function flw(path, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${config.flutterwave.secretKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.status === 'error') throw new Error(`Flutterwave ${method} ${path} failed: ${json.message || res.status}`);
  return json;
}

module.exports = {
  name: 'flutterwave',

  async createCheckout({ payment, buyer, description }) {
    const json = await flw('/payments', {
      method: 'POST',
      body: {
        tx_ref: payment.id,
        amount: toMajor(payment.amount_minor),
        currency: payment.currency,
        redirect_url: `${config.clientUrl}/pay/return/${payment.id}`,
        customer: { email: buyer.email, name: buyer.name, phonenumber: buyer.phone || undefined },
        customizations: { title: config.marketplace.brand.name, description },
      },
    });
    return { redirectUrl: json.data.link, providerRef: payment.id };
  },

  async verify(payment) {
    const json = await flw(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(payment.id)}`);
    const d = json.data;
    if (!d) return { status: 'pending' };
    if (d.status === 'successful') {
      // Never trust the status alone: the amount and currency must also match what we asked for.
      const amountOk = Math.round(Number(d.amount) * 10 ** config.marketplace.currency.decimals) >= payment.amount_minor;
      if (amountOk && d.currency === payment.currency) return { status: 'paid', providerTxnId: String(d.id) };
      return { status: 'failed' };
    }
    if (d.status === 'failed') return { status: 'failed' };
    return { status: 'pending' };
  },

  parseWebhook(req) {
    if (!config.flutterwave.webhookHash || req.headers['verif-hash'] !== config.flutterwave.webhookHash) {
      const err = new Error('Invalid Flutterwave signature');
      err.status = 400;
      throw err;
    }
    const d = req.body?.data;
    if (!d?.tx_ref) return null;
    // The handler re-verifies with the API before marking paid.
    return { paymentId: d.tx_ref, status: d.status === 'successful' ? 'paid' : 'failed', needsVerify: true };
  },

  async refund(payment, amountMinor) {
    const json = await flw(`/transactions/${payment.provider_txn_id}/refund`, { method: 'POST', body: { amount: toMajor(amountMinor) } });
    return { ref: String(json.data?.id || 'flutterwave-refund') };
  },
};
