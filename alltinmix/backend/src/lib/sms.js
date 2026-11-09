/**
 * Text-message (SMS / WhatsApp) alerts. Messages go through an outbox like emails, so a failing gateway never blocks an order.
 *   SMS_PROVIDER=none      (default) nothing is sent
 *   SMS_PROVIDER=twilio    Twilio SMS, or WhatsApp when SMS_CHANNEL=whatsapp (needs approved WhatsApp templates outside a 24h chat window)
 *   SMS_PROVIDER=webhook   POST {to, message, channel} as JSON to SMS_WEBHOOK_URL, so any local gateway can be plugged in
 */
const config = require('../config');
const db = require('../db');

/** Turn a typed number into +international form. Returns null if it can't be done safely. */
function normalizePhone(raw) {
  let p = String(raw || '').replace(/[\s().-]/g, '');
  if (!p) return null;
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (!p.startsWith('+')) {
    const cc = config.sms.countryCode;
    if (!cc) return null;
    p = '+' + cc + p.replace(/^0+/, '');
  }
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
}

const enabled = () => config.sms.provider !== 'none';

async function enqueueSms(q, { phone, body }) {
  if (!enabled()) return false;
  const to = normalizePhone(phone);
  if (!to) return false;
  await q.query('INSERT INTO sms_outbox (to_phone, body) VALUES ($1,$2)', [to, String(body).slice(0, 320)]);
  return true;
}

async function sendOne(m) {
  const s = config.sms;
  if (s.provider === 'twilio') {
    const wa = s.channel === 'whatsapp';
    const form = new URLSearchParams({ To: (wa ? 'whatsapp:' : '') + m.to_phone, From: (wa && !s.from.startsWith('whatsapp:') ? 'whatsapp:' : '') + s.from, Body: m.body });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${s.twilioSid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${s.twilioSid}:${s.twilioToken}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 160)}`);
  } else if (s.provider === 'webhook') {
    const res = await fetch(s.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(s.webhookToken ? { Authorization: `Bearer ${s.webhookToken}` } : {}) },
      body: JSON.stringify({ to: m.to_phone, message: m.body, channel: s.channel }),
    });
    if (!res.ok) throw new Error(`Webhook ${res.status}`);
  }
}

async function processSmsOutbox(limit = 20) {
  if (!enabled()) return 0;
  return db.tx(async (c) => {
    const { rows } = await c.query('SELECT * FROM sms_outbox WHERE sent_at IS NULL AND attempts < 5 AND next_attempt_at <= now() ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED', [limit]);
    let sent = 0;
    for (const m of rows) {
      try {
        await sendOne(m);
        await c.query('UPDATE sms_outbox SET sent_at = now(), attempts = attempts + 1 WHERE id = $1', [m.id]);
        sent++;
      } catch (err) {
        await c.query("UPDATE sms_outbox SET attempts = attempts + 1, last_error = $2, next_attempt_at = now() + (power(2, attempts + 1) * interval '1 minute') WHERE id = $1", [m.id, String(err.message).slice(0, 300)]);
      }
    }
    return sent;
  });
}

module.exports = { normalizePhone, enqueueSms, processSmsOutbox };
