// "Recently viewed": remembered on this device only (no account needed).
const KEY = 'recently_viewed';
export function getRecent() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}
export function pushRecent(l) {
  try {
    const item = { id: l.id, title: l.title, priceMinor: l.priceMinor, type: l.type, category: l.category, location: l.location || '', images: (l.images || []).slice(0, 1), ratingAvg: l.ratingAvg || 0, ratingCount: l.ratingCount || 0 };
    const next = [item, ...getRecent().filter((x) => x.id !== l.id)].slice(0, 12);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch { /* private mode */ }
}
