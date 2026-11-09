const express = require('express');
const db = require('../db');
const config = require('../config');
const { getCommissionPct, getRates, getDeliveryZones } = require('../services/orders');
const { publicMethods } = require('../payments');

const router = express.Router();

/** Everything the frontend needs to brand and configure itself. No secrets. */
router.get('/config', async (req, res) => {
  const m = config.marketplace;
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    brand: m.brand,
    currency: m.currency,
    currencies: m.currencies,
    rates: await getRates(), // base units per 1 unit of each currency (base = 1)
    commissionPct: await getCommissionPct(),
    limits: m.limits,
    verticals: m.verticals.map((v) => ({ key: v.key, label: v.label, icon: v.icon, categoryIcons: v.categoryIcons || {}, commerce: v.commerce, mode: v.mode, categories: config.allowDigital ? v.categories : v.categories.filter((c) => c !== 'Digital Downloads'), fields: v.fields })),
    paymentMethods: publicMethods(),
    payoutMethods: ['Orange Money', 'Afrimoney', 'QMoney', 'Bank transfer', 'PayPal'],
    requireEmailVerification: config.requireEmailVerification,
    autoCompleteDays: config.autoCompleteDays,
    minPayoutMinor: config.minPayoutMinor,
    allowDigital: config.allowDigital,
    delivery: { zones: await getDeliveryZones(), codEnabled: config.cod.enabled, smsEnabled: config.sms.provider !== 'none' },
  });
});

router.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

module.exports = router;
