// API base. In dev and in Docker the app and API share one origin (proxy), so '/api' just works.
// To point at a separately hosted API, set VITE_API_URL=https://api.example.com/api at build time.
const BASE = import.meta.env.VITE_API_URL || '/api';
const TOKEN_KEY = 'marketplace_token';

/** Origin of the API server when it is on another host (always true inside the mobile app), else '' (same origin). */
export const API_ORIGIN = /^https?:\/\//.test(BASE) ? new URL(BASE).origin : '';
/** Uploaded photos are served as '/uploads/...'. In the mobile app they must point at the API server. */
export const assetUrl = (u) => (u && u.startsWith('/uploads/') ? API_ORIGIN + u : u);

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => (onUnauthorized = fn);

export class ApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
  /** { fieldName: 'message' } for showing errors next to form inputs. */
  get fields() {
    return Object.fromEntries((this.details || []).map((d) => [d.path, d.message]));
  }
}

async function request(path, { method = 'GET', body, form } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(BASE + path, { method, headers, body: form || (body !== undefined ? JSON.stringify(body) : undefined) });
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection and try again.', { status: 0, code: 'NETWORK' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized();
    throw new ApiError(data.error || `Request failed (${res.status})`, { status: res.status, code: data.code, details: data.details });
  }
  return data;
}

export const api = {
  get: (p) => request(p),
  post: (p, body = {}) => request(p, { method: 'POST', body }),
  put: (p, body) => request(p, { method: 'PUT', body }),
  patch: (p, body) => request(p, { method: 'PATCH', body }),
  del: (p) => request(p, { method: 'DELETE' }),
  request: (method, p, body) => request(p, { method, body }),
  upload: (files) => {
    const form = new FormData();
    [...files].forEach((f) => form.append('images', f));
    return request('/uploads', { method: 'POST', form });
  },
};

export const qs = (obj) => {
  const p = new URLSearchParams();
  Object.entries(obj).forEach(([k, v]) => v !== undefined && v !== null && v !== '' && v !== 'all' && p.set(k, v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
