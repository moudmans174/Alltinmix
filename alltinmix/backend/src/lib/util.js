const crypto = require('node:crypto');
const config = require('../config');

class HttpError extends Error {
  constructor(status, message, { code, details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Validate `data` with a zod schema; throws a 400 with per-field messages. */
function parse(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new HttpError(400, 'Please check the highlighted fields.', {
      code: 'VALIDATION',
      details: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

// ---- money (always integer minor units) ----
const factor = 10 ** config.marketplace.currency.decimals;
const toMinor = (major) => Math.round(Number(major) * factor);
const toMajor = (minor) => minor / factor;
/** Platform cut for a total, using integer basis points so there is no floating-point drift. */
const commissionMinor = (totalMinor, pct) => Math.round((totalMinor * Math.round(Number(pct) * 100)) / 10000);

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function paging(query, { defaultLimit = 20, max = 50 } = {}) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || defaultLimit, 1), max);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  return { limit, page, offset: (page - 1) * limit };
}

/** Validate a listing's custom attributes against the fields defined for its vertical in the config. */
function cleanAttributes(fields, input) {
  const out = {};
  const errors = [];
  for (const f of fields) {
    let v = input ? input[f.key] : undefined;
    const empty = v === undefined || v === null || v === '';
    if (empty) {
      if (f.required) errors.push({ path: `attributes.${f.key}`, message: `${f.label} is required.` });
      continue;
    }
    if (f.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) errors.push({ path: `attributes.${f.key}`, message: `${f.label} must be a number.` });
      else if ((f.min != null && n < f.min) || (f.max != null && n > f.max)) errors.push({ path: `attributes.${f.key}`, message: `${f.label} must be between ${f.min} and ${f.max}.` });
      else out[f.key] = n;
    } else if (f.type === 'select') {
      if (!f.options.includes(v)) errors.push({ path: `attributes.${f.key}`, message: `${f.label} must be one of: ${f.options.join(', ')}.` });
      else out[f.key] = v;
    } else {
      out[f.key] = String(v).trim().slice(0, f.maxLength || 200);
    }
  }
  if (errors.length) throw new HttpError(400, 'Please check the highlighted fields.', { code: 'VALIDATION', details: errors });
  return out;
}

module.exports = { HttpError, parse, sha256, randomToken, toMinor, toMajor, commissionMinor, escapeHtml, paging, cleanAttributes };
