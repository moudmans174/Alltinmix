const express = require('express');
const { z } = require('zod');
const db = require('../db');
const config = require('../config');
const orders = require('../services/orders');
const payments = require('../payments');
const { HttpError, parse, paging } = require('../lib/util');
const { requireAuth, requireVerified } = require('../lib/auth');

const ordersRouter = express.Router();
const paymentsRouter = express.Router();
// Reject malformed ids with a 404 instead of a database error.
const badId = (req, res, next, id) => (/^[0-9a-f-]{36}$/.test(id) ? next() : res.status(404).json({ error: 'Not found.' }));
ordersRouter.param('id', badId);
paymentsRouter.param('id', badId);
const webhooksRouter = express.Router();

// ------------------------------------------------------------------ orders

ordersRouter.use(requireAuth);

ordersRouter.post('/checkout', requireVerified, async (req, res) => {
  const body = parse(z.object({
    items: z.array(z.object({ listingId: z.string().uuid(), qty: z.coerce.number().int().min(1).max(100).default(1) })).min(1, 'Your cart is empty.').max(30),
    method: z.string().min(1),
    currency: z.string().trim().length(3).optional(),
  }), req.body);
  res.status(201).json(await orders.checkout(req.user, body.items, body.method, body.currency));
});

async function list(req, res, column, forSeller) {
  const { limit, page, offset } = paging(req.query);
  const status = req.query.status ? String(req.query.status) : null;
  const params = [req.user.id];
  let where = `o.${column} = $1 AND o.status <> 'awaiting_payment'`;
  if (status) {
    params.push(status);
    where += ` AND o.status = $${params.length}`;
  }
  const { rows } = await db.query(`${orders.ORDER_SELECT} WHERE ${where} ORDER BY o.created_at DESC LIMIT ${limit} OFFSET ${offset}`, params);
  res.json({ orders: rows.map((r) => orders.orderToApi(r, { forSeller })), page });
}
ordersRouter.get('/mine', (req, res) => list(req, res, 'buyer_id', false));
ordersRouter.get('/selling', (req, res) => list(req, res, 'seller_id', true));

ordersRouter.get('/:id', async (req, res) => {
  if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw new HttpError(404, 'Order not found.');
  const { rows } = await db.query(`${orders.ORDER_SELECT} WHERE o.id = $1`, [req.params.id]);
  const r = rows[0];
  if (!r || (r.buyer_id !== req.user.id && r.seller_id !== req.user.id && req.user.role !== 'admin')) throw new HttpError(404, 'Order not found.');
  res.json({ order: orders.orderToApi(r, { forSeller: r.seller_id === req.user.id && r.buyer_id !== req.user.id }) });
});

for (const action of ['accept', 'deliver', 'confirm', 'cancel', 'dispute']) {
  ordersRouter.post(`/:id/${action}`, async (req, res) => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw new HttpError(404, 'Order not found.');
    const order = await orders.transition(req.user, req.params.id, action, req.body || {});
    res.json({ order });
  });
}

ordersRouter.post('/:id/review', async (req, res) => {
  const body = parse(z.object({ rating: z.coerce.number().int().min(1).max(5), comment: z.string().trim().max(1000).default('') }), req.body);
  res.status(201).json(await orders.createReview(req.user, req.params.id, body));
});

// ---------------------------------------------------------------- payments

paymentsRouter.use(requireAuth);

paymentsRouter.get('/:id', async (req, res) => {
  if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw new HttpError(404, 'Payment not found.');
  const { rows } = await db.query('SELECT * FROM payments WHERE id = $1', [req.params.id]);
  const p = rows[0];
  if (!p || (p.buyer_id !== req.user.id && req.user.role !== 'admin')) throw new HttpError(404, 'Payment not found.');
  const method = config.paymentMethods.find((m) => m.key === p.method);
  res.json({
    payment: {
      id: p.id, method: p.method, methodLabel: method ? method.label : p.method, status: p.status, amountMinor: p.amount_minor, currency: p.currency, baseAmountMinor: p.base_amount_minor, fxRate: Number(p.fx_rate),
      failureReason: p.failure_reason, createdAt: p.created_at,
      // Mobile money instructions: where to send the money and the reference to include.
      manual: p.provider === 'momo' && method ? { number: method.number, accountName: method.accountName, reference: p.provider_ref, proof: p.proof } : null,
    },
  });
});

// Called when the buyer comes back from the provider's page: confirms (and for PayPal, captures) the payment.
paymentsRouter.post('/:id/verify', async (req, res) => {
  res.json({ payment: await orders.verifyPayment(req.params.id, req.user) });
});

paymentsRouter.post('/:id/manual-proof', async (req, res) => {
  const body = parse(z.object({
    senderPhone: z.string().trim().min(6, 'Enter the phone number you paid from.').max(30),
    transactionId: z.string().trim().min(4, 'Enter the transaction ID from your confirmation SMS.').max(60),
  }), req.body);
  res.json(await orders.submitManualProof(req.user, req.params.id, body));
});

// Test-only provider: lets you click through checkout locally without real money.
paymentsRouter.post('/:id/mock-confirm', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM payments WHERE id = $1', [req.params.id]);
  const p = rows[0];
  if (!p || p.buyer_id !== req.user.id || p.provider !== 'mock') throw new HttpError(404, 'Payment not found.');
  if (!config.paymentMethods.some((m) => m.provider === 'mock')) throw new HttpError(403, 'Test payments are disabled.');
  await orders.markPaymentPaid(p.id, { providerTxnId: 'mock-' + p.id });
  res.json({ payment: { status: 'paid' } });
});

// ---------------------------------------------------------------- webhooks
// Mounted before the JSON body parser in app.js. Each provider verifies its own signature.

webhooksRouter.post('/stripe', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  if (!config.paymentMethods.some((m) => m.provider === 'stripe')) return res.status(404).end();
  let event;
  try {
    event = payments.providerByName('stripe').parseWebhook(req);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid signature' });
  }
  await orders.handleWebhook(event);
  res.json({ received: true });
});

webhooksRouter.post('/flutterwave', express.json({ limit: '1mb' }), async (req, res) => {
  if (!config.paymentMethods.some((m) => m.provider === 'flutterwave')) return res.status(404).end();
  let event;
  try {
    event = payments.providerByName('flutterwave').parseWebhook(req);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid signature' });
  }
  await orders.handleWebhook(event);
  res.json({ received: true });
});

webhooksRouter.post('/paypal', express.json({ limit: '1mb' }), async (req, res) => {
  if (!config.paymentMethods.some((m) => m.provider === 'paypal')) return res.status(404).end();
  let event;
  try {
    event = await payments.providerByName('paypal').parseWebhook(req);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid signature' });
  }
  await orders.handleWebhook(event);
  res.json({ received: true });
});

module.exports = { orders: ordersRouter, payments: paymentsRouter, webhooks: webhooksRouter };
