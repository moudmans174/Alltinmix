import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Flag, MapPin, Share2, Star } from 'lucide-react';
import { ReportModal } from '../components/Report';
import { shareLink } from '../native';
import { api, assetUrl, qs } from '../api';
import { useAuth, useCart, useConfig, useToast } from '../context';
import { Icon, categoryIconName } from '../icons';
import { Alert, Empty, Field, ImageGallery, Pagination, Spinner, Stars, attributeSummary } from '../components/ui';

export function ListingCard({ l }) {
  const { formatMoney, vertical } = useConfig();
  const v = vertical(l.type);
  const summary = attributeSummary(l, v, 3);
  return (
    <Link to={`/listing/${l.id}`} className="listing-card">
      <div className="thumb">
        {l.images?.[0] ? <img src={assetUrl(l.images[0])} alt="" loading="lazy" /> : <span className="thumb-empty"><Icon name={categoryIconName(v, l.category)} size={56} strokeWidth={1.25} /></span>}
        <span className="tag"><Icon name={v?.icon} size={12} /> {v?.label || l.type}</span>
      </div>
      <div className="body">
        <span className="title">{l.title}</span>
        <span className="price">{formatMoney(l.priceMinor)}{v?.commerce === 'service' ? <small className="muted"> / order</small> : ''}</span>
        {summary && <span className="muted small">{summary}</span>}
        <span className="muted small row" style={{ gap: 6, marginTop: 'auto' }}>
          {l.location && <><MapPin size={12} />{l.location}</>}
          {l.ratingCount > 0 && <span className="row" style={{ gap: 3, marginLeft: 'auto' }}><Star size={12} fill="#f59e0b" stroke="#f59e0b" />{l.ratingAvg.toFixed(1)} ({l.ratingCount})</span>}
        </span>
      </div>
    </Link>
  );
}

export function Home() {
  const { brand, verticals } = useConfig();
  const [items, setItems] = useState(null);
  useEffect(() => { api.get('/listings?limit=8&sort=popular').then((d) => setItems(d.listings)).catch(() => setItems([])); }, []);
  return (
    <>
      <section className="hero"><div className="container hero-grid"><div>
        <h1>{brand.tagline}</h1>
        <p>Buy and sell products, services, property and vehicles in one trusted place. Your payment is held safely until you confirm delivery.</p>
        <div className="row"><Link to="/browse" className="btn btn-accent">Start browsing</Link><Link to="/register" className="btn btn-ghost" style={{ color: 'inherit', borderColor: 'rgba(255,255,255,.4)' }}>Sell with us</Link></div>
      </div>{brand.logoUrl && <img className="hero-logo" src={brand.logoUrl} alt="" />}</div></section>
      <div className="container page stack">
        <h2>What are you looking for?</h2>
        <div className="vertical-tiles">
          {verticals.map((v) => (
            <Link key={v.key} className="tile" to={`/browse?type=${v.key}`}><span className="tile-icon"><Icon name={v.icon} size={26} /></span><b>{v.label}</b><span className="muted small">{v.categories.slice(0, 3).join(', ')}…</span></Link>
          ))}
        </div>
        <h2 style={{ marginTop: 32 }}>Popular right now</h2>
        {items === null ? <Spinner /> : items.length === 0 ? <Empty title="No listings yet">Be the first to post something.</Empty> : <div className="grid grid-listings">{items.map((l) => <ListingCard key={l.id} l={l} />)}</div>}
      </div>
    </>
  );
}

export function Browse() {
  const { verticals } = useConfig();
  const [sp, setSp] = useSearchParams();
  const type = sp.get('type') || 'all';
  const category = sp.get('category') || 'All';
  const page = Number(sp.get('page') || 1);
  const q = sp.get('q') || '';
  const sort = sp.get('sort') || '';
  const [form, setForm] = useState({ location: sp.get('location') || '', minPrice: sp.get('minPrice') || '', maxPrice: sp.get('maxPrice') || '' });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const query = sp.toString();
  useEffect(() => {
    setData(null); setError('');
    api.get(`/listings${qs({ q, type, category, sort, page, location: sp.get('location'), minPrice: sp.get('minPrice'), maxPrice: sp.get('maxPrice') })}`)
      .then(setData).catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const set = (patch) => {
    const next = new URLSearchParams(sp);
    Object.entries(patch).forEach(([k, v]) => (v === '' || v === null || v === 'all' || v === 'All' ? next.delete(k) : next.set(k, v)));
    if (!('page' in patch)) next.delete('page');
    setSp(next);
  };
  const vertical = verticals.find((v) => v.key === type);

  return (
    <div className="container page">
      <div className="filters">
        <aside className="stack">
          <div className="card flat">
            <h3>Type</h3>
            <div className="chips">
              <button className={`chip ${type === 'all' ? 'on' : ''}`} onClick={() => set({ type: 'all', category: '' })}><Icon name="Layers" size={14} /> All</button>
              {verticals.map((v) => <button key={v.key} className={`chip ${type === v.key ? 'on' : ''}`} onClick={() => set({ type: v.key, category: '' })}><Icon name={v.icon} size={14} /> {v.label}</button>)}
            </div>
            {vertical && <>
              <h3 style={{ marginTop: 18 }}>Category</h3>
              <div className="chips">
                <button className={`chip ${category === 'All' ? 'on' : ''}`} onClick={() => set({ category: '' })}>All</button>
                {vertical.categories.map((c) => <button key={c} className={`chip ${category === c ? 'on' : ''}`} onClick={() => set({ category: c })}><Icon name={categoryIconName(vertical, c)} size={14} /> {c}</button>)}
              </div>
            </>}
          </div>
          <form className="card flat" onSubmit={(e) => { e.preventDefault(); set(form); }}>
            <Field label="Location"><input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="e.g. Freetown" /></Field>
            <div className="row"><Field label="Min price"><input type="number" min="0" value={form.minPrice} onChange={(e) => setForm({ ...form, minPrice: e.target.value })} /></Field>
              <Field label="Max price"><input type="number" min="0" value={form.maxPrice} onChange={(e) => setForm({ ...form, maxPrice: e.target.value })} /></Field></div>
            <button className="btn btn-primary btn-block">Apply filters</button>
          </form>
        </aside>
        <section>
          <div className="row between" style={{ marginBottom: 16 }}>
            <h2 style={{ margin: 0 }}>{q ? `Results for "${q}"` : vertical ? vertical.label : 'Browse everything'}</h2>
            <select className="input" style={{ width: 'auto' }} value={sort} onChange={(e) => set({ sort: e.target.value })} aria-label="Sort">
              <option value="">Newest</option><option value="popular">Most popular</option><option value="rating">Top rated</option>
              <option value="price_asc">Price: low to high</option><option value="price_desc">Price: high to low</option>
            </select>
          </div>
          <Alert>{error}</Alert>
          {!data && !error ? <Spinner /> : data && (data.listings.length === 0 ? <Empty title="Nothing matches yet">Try removing a filter or searching for something else.</Empty> : (
            <>
              <p className="muted small">{data.total} {data.total === 1 ? 'listing' : 'listings'}</p>
              <div className="grid grid-listings">{data.listings.map((l) => <ListingCard key={l.id} l={l} />)}</div>
              <Pagination page={data.page} pages={data.pages} onChange={(p) => set({ page: p })} />
            </>
          ))}
        </section>
      </div>
    </div>
  );
}

function InquiryBox({ listing }) {
  const { user } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [message, setMessage] = useState(`Hi, I'm interested in "${listing.title}". Is it still available?`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!user) return <Link className="btn btn-primary btn-block" to="/login" state={{ from: `/listing/${listing.id}` }}>Log in to contact the seller</Link>;
  if (user.id === listing.sellerId) return <p className="muted">This is your listing.</p>;
  const send = async (e) => {
    e.preventDefault(); setBusy(true); setError('');
    try { const d = await api.post('/conversations', { listingId: listing.id, message }); toast('Message sent.'); nav(`/messages/${d.conversationId}`); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={send}>
      <Alert>{error}</Alert>
      <Field label="Message the seller"><textarea value={message} onChange={(e) => setMessage(e.target.value)} /></Field>
      <button className="btn btn-accent btn-block" disabled={busy || !message.trim()}>{busy ? 'Sending…' : 'Send message'}</button>
    </form>
  );
}

export function ListingDetail() {
  const { id } = useParams();
  const { formatMoney, vertical: vertOf } = useConfig();
  const { user } = useAuth();
  const cart = useCart();
  const toast = useToast();
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [qty, setQty] = useState(1);
  const [reporting, setReporting] = useState(false);

  useEffect(() => { setData(null); api.get(`/listings/${id}`).then(setData).catch((e) => setError(e.message)); }, [id]);
  if (error) return <div className="container page"><Empty title="Listing not found">{error}</Empty></div>;
  if (!data) return <Spinner />;

  const l = data.listing;
  const v = vertOf(l.type);
  const isOwner = user?.id === l.sellerId;
  const digital = l.fulfillment === 'digital';
  const single = v?.commerce === 'service' || digital;
  const soldOut = l.stock !== null && l.stock !== undefined && l.stock <= 0;
  const attrs = (v?.fields || []).filter((f) => l.attributes?.[f.key] !== undefined && l.attributes[f.key] !== '');
  const add = () => { cart.add(l, qty); toast('Added to your cart.'); };

  return (
    <div className="container page">
      <p className="muted small"><Link to="/browse">Browse</Link> / <Link to={`/browse?type=${l.type}`}>{v?.label}</Link> / {l.category}</p>
      <div className="detail">
        <div className="stack">
          <ImageGallery images={l.images} alt={l.title} />
          <div className="card flat"><h3>Description</h3><p style={{ whiteSpace: 'pre-wrap' }}>{l.description || 'No description provided.'}</p></div>
          {attrs.length > 0 && <div className="card flat"><h3>Details</h3><div className="attrs">{attrs.map((f) => <div className="attr" key={f.key}><small>{f.label.replace(/\s*\(.*\)/, '')}</small><b>{typeof l.attributes[f.key] === 'number' ? l.attributes[f.key].toLocaleString() : l.attributes[f.key]}{f.suffix || ''}</b></div>)}</div></div>}
          <div className="card flat">
            <h3>Reviews {l.ratingCount > 0 && <small className="muted">({l.ratingAvg.toFixed(1)} from {l.ratingCount})</small>}</h3>
            {data.reviews.length === 0 ? <p className="muted">No reviews yet.</p> : data.reviews.map((r, i) => (
              <div key={i} style={{ padding: '10px 0', borderTop: i ? '1px solid var(--line)' : 0 }}>
                <Stars value={r.rating} size={15} /> <b className="small">{r.reviewer}</b>
                {r.comment && <p style={{ margin: '4px 0 0' }}>{r.comment}</p>}
              </div>
            ))}
          </div>
        </div>
        <aside className="card stack" style={{ position: 'sticky', top: 80 }}>
          <span className="pill pill-grey row" style={{ alignSelf: 'flex-start', gap: 6, display: 'inline-flex' }}><Icon name={categoryIconName(v, l.category)} size={13} /> {l.category}</span>
          <h1 style={{ fontSize: '1.6rem', margin: 0 }}>{l.title}</h1>
          <div className="price" style={{ fontSize: '1.9rem' }}>{formatMoney(l.priceMinor)}</div>
          <p className="muted small" style={{ margin: 0 }}>Sold by <b>{l.sellerName}</b>{l.sellerTag ? ` · ${l.sellerTag}` : ''}{l.location ? ` · ${l.location}` : ''}</p>
          {l.mode === 'inquiry' ? <InquiryBox listing={l} /> : isOwner ? (
            <div className="stack"><p className="muted">This is your listing.</p><Link className="btn btn-ghost btn-block" to={`/seller/listings/${l.id}/edit`}>Edit listing</Link></div>
          ) : (
            <>
              <ul className="muted small" style={{ paddingLeft: 18, margin: 0 }}>
                {v?.commerce === 'service' && <li>Delivered in about {l.deliveryDays} day{l.deliveryDays === 1 ? '' : 's'} after the seller accepts</li>}
                {v?.commerce === 'product' && !digital && <li>Ships in about {l.shippingDays} day{l.shippingDays === 1 ? '' : 's'}{l.stock !== null ? ` · ${l.stock} in stock` : ''}</li>}
                {digital && <li>Instant digital download after payment</li>}
                <li>Money is held until you confirm you're happy</li>
              </ul>
              {!single && !soldOut && (
                <div className="row"><span className="small">Quantity</span><div className="qty"><button onClick={() => setQty(Math.max(1, qty - 1))} aria-label="Less">−</button><span>{qty}</span><button onClick={() => setQty(Math.min(l.stock ?? 99, qty + 1))} aria-label="More">+</button></div></div>
              )}
              {soldOut ? <button className="btn btn-primary btn-block" disabled>Out of stock</button> : (
                <div className="stack">
                  <button className="btn btn-accent btn-block" onClick={() => { add(); nav('/cart'); }}>{v?.commerce === 'service' ? 'Order now' : 'Buy now'}</button>
                  <button className="btn btn-ghost btn-block" onClick={add}>Add to cart</button>
                </div>
              )}
            </>
          )}
          <button className="link-btn small" style={{ alignSelf: 'flex-start' }} onClick={async () => (await shareLink({ title: l.title, text: l.title, path: `/listing/${l.id}` })) === 'copied' && toast('Link copied.')}><Share2 size={13} /> Share</button>
          {user && !isOwner && <button className="link-btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setReporting(true)}><Flag size={13} /> Report this listing</button>}
          {reporting && <ReportModal targetType="listing" targetId={l.id} onClose={() => setReporting(false)} />}
        </aside>
      </div>
    </div>
  );
}
