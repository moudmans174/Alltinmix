const nodemailer = require('nodemailer');
const config = require('../config');
const db = require('../db');
const { escapeHtml } = require('./util');
const { enqueueSms } = require('./sms');

let transport; // undefined = not created yet, null = SMTP not configured
function getTransport() {
  if (transport !== undefined) return transport;
  const s = config.smtp;
  transport = s.host
    ? nodemailer.createTransport({ host: s.host, port: s.port, secure: s.secure, auth: s.user ? { user: s.user, pass: s.pass } : undefined })
    : null;
  return transport;
}

/** Branded HTML email shell. Brand name and colors come from config/marketplace.config.js. */
function layout({ title, bodyHtml, ctaUrl, ctaLabel }) {
  const b = config.marketplace.brand;
  const logoSrc = b.logoUrl && (b.logoUrl.startsWith('/') ? config.clientUrl + b.logoUrl : b.logoUrl);
  const logo = logoSrc
    ? `<img src="${escapeHtml(logoSrc)}" alt="" width="36" height="36" style="vertical-align:middle;border-radius:50%;border:0;margin-right:10px">${b.showName ? escapeHtml(b.name) : ''}`
    : escapeHtml(b.name);
  const cta = ctaUrl
    ? `<p style="margin:24px 0 0"><a href="${escapeHtml(ctaUrl)}" style="background:${b.accentColor};color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">${escapeHtml(ctaLabel || 'Open')}</a></p>`
    : '';
  return `<div style="font-family:Arial,Helvetica,sans-serif;background:#f4f4f2;padding:24px">
  <div style="max-width:540px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e3e1da">
    <div style="background:${b.primaryColor};color:#fff;padding:18px 24px;font-size:20px;font-weight:700">${logo}</div>
    <div style="padding:24px;color:#1c1f26;font-size:14px;line-height:1.6">
      <h2 style="margin:0 0 12px;font-size:18px">${escapeHtml(title)}</h2>${bodyHtml}${cta}
    </div>
    <div style="padding:14px 24px;background:#f4f4f2;color:#6b7280;font-size:11px">Automated message from ${escapeHtml(b.name)}. Questions? ${escapeHtml(b.supportEmail)}</div>
  </div></div>`;
}

async function enqueueEmail(q, { to, subject, html, text = '' }) {
  await q.query('INSERT INTO email_outbox (to_email, subject, html, text) VALUES ($1,$2,$3,$4)', [to, subject, html, text]);
}

/** Send due emails from the outbox. Failures retry with growing delays and give up after 6 attempts. */
async function processOutbox(limit = 20) {
  const t = getTransport();
  return db.tx(async (c) => {
    const { rows } = await c.query(
      'SELECT * FROM email_outbox WHERE sent_at IS NULL AND attempts < 6 AND next_attempt_at <= now() ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED',
      [limit]
    );
    let sent = 0;
    for (const m of rows) {
      try {
        if (t) {
          await t.sendMail({ from: config.emailFrom, to: m.to_email, subject: m.subject, html: m.html, text: m.text || undefined });
        } else if (!config.isProd) {
          console.log(`[email:dev] to=${m.to_email} subject="${m.subject}"`); // dev convenience when SMTP is not set
        } else {
          throw new Error('SMTP is not configured');
        }
        await c.query('UPDATE email_outbox SET sent_at = now(), attempts = attempts + 1 WHERE id = $1', [m.id]);
        sent++;
      } catch (err) {
        await c.query(
          `UPDATE email_outbox SET attempts = attempts + 1, last_error = $2,
           next_attempt_at = now() + (power(2, attempts + 1) * interval '1 minute') WHERE id = $1`,
          [m.id, String(err.message).slice(0, 300)]
        );
      }
    }
    return sent;
  });
}

/**
 * Create an in-app notification, and optionally email it too.
 * `q` is a pg client (inside a transaction) or the db module, so a notification is only
 * saved if the action that caused it actually committed.
 */
async function notify(q, { userId, type, title, body = '', link = null, email = false, sms = false }) {
  await q.query('INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1,$2,$3,$4,$5)', [userId, type, title, body, link]);
  if (sms) {
    const { rows } = await q.query('SELECT phone FROM users WHERE id = $1', [userId]);
    if (rows[0]?.phone) await enqueueSms(q, { phone: rows[0].phone, body: `${config.marketplace.brand.name}: ${title}. ${body}`.trim() });
  }
  if (email) {
    const { rows } = await q.query('SELECT email FROM users WHERE id = $1', [userId]);
    if (rows[0]) {
      await enqueueEmail(q, {
        to: rows[0].email,
        subject: title,
        html: layout({ title, bodyHtml: `<p>${escapeHtml(body)}</p>`, ctaUrl: link ? config.clientUrl + link : null, ctaLabel: 'View details' }),
        text: `${title}\n\n${body}${link ? `\n\n${config.clientUrl}${link}` : ''}`,
      });
    }
  }
}

async function notifyAdmins(q, payload) {
  const { rows } = await q.query("SELECT id FROM users WHERE role = 'admin' AND status = 'active'");
  for (const r of rows) await notify(q, { ...payload, userId: r.id });
}

module.exports = { layout, enqueueEmail, processOutbox, notify, notifyAdmins };
