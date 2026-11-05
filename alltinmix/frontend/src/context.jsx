import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setToken, getToken, setUnauthorizedHandler } from './api';

/* ------------------------------------------------------------------ config (branding, verticals, payments) */

const ConfigCtx = createContext(null);

function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return 0;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const readableOn = (hex) => (luminance(hex) > 0.4 ? '#14181F' : '#FFFFFF');

/** Brand colors come from the server config; everything in styles.css uses these variables. */
function applyTheme(brand) {
  const root = document.documentElement.style;
  root.setProperty('--brand', brand.primaryColor);
  root.setProperty('--accent', brand.accentColor);
  root.setProperty('--on-brand', readableOn(brand.primaryColor));
  root.setProperty('--on-accent', readableOn(brand.accentColor));
  document.title = `${brand.name}: ${brand.tagline}`;
  if (brand.logoUrl) { // use the logo as the browser tab icon too
    let link = document.querySelector('link[rel="icon"]');
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
    link.href = brand.logoUrl;
  }
}

export function ConfigProvider({ children }) {
  const [config, setConfig] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    setError('');
    api.get('/config').then((c) => { applyTheme(c.brand); setConfig(c); }).catch((e) => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  // The currency prices are DISPLAYED in. Buyers can switch; sellers and admins always see the base currency (what is recorded).
  const [displayCode, setDisplayCode] = useState(() => { try { return localStorage.getItem('currency') || ''; } catch { return ''; } });
  const setDisplayCurrency = useCallback((code) => {
    setDisplayCode(code);
    try { localStorage.setItem('currency', code); } catch { /* private mode */ }
  }, []);

  const value = useMemo(() => {
    if (!config) return null;
    const currencies = config.currencies || [config.currency];
    const rates = config.rates || { [config.currency.code]: 1 };
    const baseCode = config.currency.code;
    const shown = currencies.find((c) => c.code === displayCode) || currencies[0];
    const fmt = (minor, cur) => {
      const gap = /[A-Za-z]$/.test(cur.symbol) ? ' ' : '';
      const f = 10 ** cur.decimals;
      return `${cur.symbol}${gap}${(minor / f).toLocaleString(undefined, { minimumFractionDigits: minor % f === 0 ? 0 : cur.decimals, maximumFractionDigits: cur.decimals })}`;
    };
    /** base-currency minor units -> minor units of another currency (rate = base units per 1 unit of it) */
    const convert = (baseMinor, code) => Math.round(baseMinor / (rates[code] || 1));
    const { decimals, symbol } = config.currency;
    const gap = /[A-Za-z]$/.test(symbol) ? ' ' : '';
    const formatMoney = (minor) => `${symbol}${gap}${(minor / 10 ** decimals).toLocaleString(undefined, { minimumFractionDigits: minor % 10 ** decimals === 0 ? 0 : decimals, maximumFractionDigits: decimals })}`;
    return {
      ...config, currencies, rates, baseCode,
      formatMoney: (baseMinor) => fmt(convert(baseMinor, shown.code), shown), // buyer-facing prices, in the chosen display currency
      formatBase: formatMoney, // exact amounts in the base currency (seller, admin, wallet)
      formatIn: (minor, code) => fmt(minor, currencies.find((c) => c.code === code) || config.currency),
      convert,
      displayCurrency: shown, setDisplayCurrency,
      vertical: (key) => config.verticals.find((v) => v.key === key),
    };
  }, [config, displayCode, setDisplayCurrency]);

  if (error) return <div className="boot"><p>We couldn't load the marketplace.</p><p className="muted">{error}</p><button className="btn btn-primary" onClick={load}>Try again</button></div>;
  if (!value) return <div className="boot"><div className="spinner" /></div>;
  return <ConfigCtx.Provider value={value}>{children}</ConfigCtx.Provider>;
}
export const useConfig = () => useContext(ConfigCtx);

/* ------------------------------------------------------------------ auth */

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(!getToken());

  useEffect(() => {
    setUnauthorizedHandler(() => { setToken(null); setUser(null); });
    if (getToken()) api.get('/auth/me').then((d) => setUser(d.user)).catch(() => setToken(null)).finally(() => setReady(true));
  }, []);

  const value = useMemo(() => ({
    user, ready, setUser,
    async login(email, password) { const d = await api.post('/auth/login', { email, password }); setToken(d.token); setUser(d.user); return d.user; },
    async register(payload) { const d = await api.post('/auth/register', payload); setToken(d.token); setUser(d.user); return d.user; },
    logout() { setToken(null); setUser(null); },
    async refresh() { const d = await api.get('/auth/me'); setUser(d.user); return d.user; },
  }), [user, ready]);

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
export const useAuth = () => useContext(AuthCtx);

/* ------------------------------------------------------------------ cart (kept in the browser until checkout) */

const CartCtx = createContext(null);
const CART_KEY = 'marketplace_cart';

export function CartProvider({ children }) {
  const [items, setItems] = useState(() => { try { return JSON.parse(localStorage.getItem(CART_KEY) || '[]'); } catch { return []; } });
  useEffect(() => { try { localStorage.setItem(CART_KEY, JSON.stringify(items)); } catch { /* private mode */ } }, [items]);

  const value = useMemo(() => ({
    items,
    count: items.reduce((n, i) => n + i.qty, 0),
    add(listing, qty = 1) {
      setItems((prev) => {
        const cap = listing.stock ?? 99;
        const unit = listing.type === 'service' || listing.fulfillment === 'digital' ? 1 : qty;
        const i = prev.findIndex((x) => x.listingId === listing.id);
        const snapshot = { id: listing.id, title: listing.title, priceMinor: listing.priceMinor, type: listing.type, fulfillment: listing.fulfillment, stock: listing.stock, sellerName: listing.sellerName, image: listing.images?.[0] || null };
        if (i >= 0) { const next = [...prev]; next[i] = { ...next[i], listing: snapshot, qty: Math.min(unit === 1 ? 1 : next[i].qty + unit, cap) }; return next; }
        return [...prev, { listingId: listing.id, qty: Math.min(unit, cap), listing: snapshot }];
      });
    },
    setQty: (id, qty) => setItems((p) => p.map((i) => (i.listingId === id ? { ...i, qty: Math.max(1, Math.min(qty, i.listing.stock ?? 99)) } : i))),
    remove: (id) => setItems((p) => p.filter((i) => i.listingId !== id)),
    clear: () => setItems([]),
  }), [items]);

  return <CartCtx.Provider value={value}>{children}</CartCtx.Provider>;
}
export const useCart = () => useContext(CartCtx);

/* ------------------------------------------------------------------ theme (light / dark) */

const ThemeCtx = createContext({ theme: 'light', toggle: () => {} });
const systemTheme = () => (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('theme') || systemTheme(); } catch { return systemTheme(); }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#0f1218' : '#14181F';
  }, [theme]);
  const value = useMemo(() => ({
    theme,
    toggle: () => setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('theme', next); } catch { /* private mode: still works for this visit */ }
      return next;
    }),
  }), [theme]);
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}
export const useTheme = () => useContext(ThemeCtx);

/* ------------------------------------------------------------------ toasts */

const ToastCtx = createContext(() => {});
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const toast = useCallback((message, kind = 'ok') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="toasts" role="status" aria-live="polite">{toasts.map((t) => <div key={t.id} className={`toast toast-${t.kind}`}>{t.message}</div>)}</div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);
