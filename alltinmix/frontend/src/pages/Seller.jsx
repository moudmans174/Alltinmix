import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api, assetUrl } from '../api';
import { useAuth, useConfig, useToast } from '../context';
import { Alert, Empty, Field, Receipt, Spinner, StatusPill } from '../components/ui';

function SellerTabs() {
  const cls = ({ isActive }) => `tab-link ${isActive ? 'on' : ''}`;
  return (
    <div className="tabs">
      <NavLink className={cls} to="/seller/listings">My listings</NavLink>
      <NavLink className={cls} to="/seller/orders">Sales</NavLink>
      <NavLink className={cls} to="/seller/earnings">Earnings</NavLink>
    </div>
  );
}

export function SellerListings() {
  const { formatBase: formatMoney, vertical } = useConfig();
  const { user } = useAuth();
  const toast = useToast();
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api.get('/listings/mine').then((d) => setItems(d.listings)).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  const setStatus = async (l, status) => { try { await api.patch(`/listings/${l.id}/status`, { status }); load(); } catch (e) { toast(e.message, 'error'); } };
  const remove = async (l) => {
    if (!window.confirm(`Delete "${l.title}"? Past orders are not affected.`)) return;
    try { await api.del(`/listings/${l.id}`); toast('Listing deleted.'); load(); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div className="container page">
      <SellerTabs />
      <div className="row between"><h1>My listings</h1><Link to="/seller/listings/new" className="btn btn-accent"><Plus size={16} /> New listing</Link></div>
      {!user.emailVerified && <Alert kind="info">Confirm your email to publish listings.</Alert>}
      <Alert>{error}</Alert>
      {!items ? <Spinner /> : items.length === 0 ? <Empty title="You haven't listed anything yet">Create your first listing. It takes about two minutes.</Empty> : (
        <div className="card table-wrap" style={{ padding: 0 }}><table>
          <thead><tr><th>Listing</th><th>Type</th><th>Price</th><th>Status</th><th>Sold</th><th /></tr></thead>
          <tbody>{items.map((l) => (
            <tr key={l.id}>
              <td><Link to={`/listing/${l.id}`}><b>{l.title}</b></Link><div className="muted small">{l.category}{l.stock !== null && l.stock !== undefined ? ` · ${l.stock} in stock` : ''}</div></td>
              <td>{vertical(l.type)?.label || l.type}</td><td>{formatMoney(l.priceMinor)}</td><td><StatusPill status={l.status} /></td><td>{l.soldCount}</td>
              <td className="row" style={{ flexWrap: 'nowrap' }}>
                <Link className="btn btn-ghost btn-sm" to={`/seller/listings/${l.id}/edit`}>Edit</Link>
                {l.status === 'active' && <button className="btn btn-ghost btn-sm" onClick={() => setStatus(l, 'paused')}>Pause</button>}
                {l.status === 'paused' && <button className="btn btn-ghost btn-sm" onClick={() => setStatus(l, 'active')}>Resume</button>}
                {l.status === 'active' && l.mode === 'inquiry' && <button className="btn btn-ghost btn-sm" onClick={() => setStatus(l, 'sold')}>Mark sold</button>}
                <button className="btn btn-ghost btn-sm" onClick={() => remove(l)}>Delete</button>
              </td>
            </tr>))}</tbody>
        </table></div>
      )}
    </div>
  );
}

const EMPTY = { type: '', category: '', title: '', description: '', price: '', location: '', images: [], attributes: {}, deliveryDays: '', fulfillment: 'physical', stock: '', shippingDays: '', deliveryUrl: '' };

export function ListingForm() {
  const { id } = useParams();
  const { verticals, commissionPct, formatBase: formatMoney, currency, limits, allowDigital } = useConfig();
  const nav = useNavigate();
  const toast = useToast();
  const fileInput = useRef();
  const [v, setV] = useState({ ...EMPTY, type: verticals[0].key, category: verticals[0].categories[0] });
  const [loading, setLoading] = useState(!!id);
  const [error, setError] = useState('');
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!id) return;
    api.get(`/listings/${id}`).then(({ listing: l }) => {
      setV({
        type: l.type, category: l.category, title: l.title, description: l.description || '', price: String(l.priceMinor / 10 ** currency.decimals),
        location: l.location || '', images: l.images || [], attributes: l.attributes || {}, deliveryDays: l.deliveryDays ?? '',
        fulfillment: l.fulfillment || 'physical', stock: l.stock ?? '', shippingDays: l.shippingDays ?? '', deliveryUrl: l.deliveryUrl || '',
      });
    }).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [id, currency.decimals]);

  const vertical = verticals.find((x) => x.key === v.type);
  const set = (patch) => setV((p) => ({ ...p, ...patch }));
  const setAttr = (k, val) => setV((p) => ({ ...p, attributes: { ...p.attributes, [k]: val } }));
  const err = (k) => fields[k];
  const price = Number(v.price) || 0;
  const priceMinor = Math.round(price * 10 ** currency.decimals);
  const fee = Math.round(priceMinor * Math.round(commissionPct * 100) / 10000);

  const upload = async (files) => {
    if (!files.length) return;
    setUploading(true); setError('');
    try { const d = await api.upload(files); set({ images: [...v.images, ...d.urls].slice(0, limits.maxImagesPerListing) }); }
    catch (e) { setError(e.message); } finally { setUploading(false); if (fileInput.current) fileInput.current.value = ''; }
  };

  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError(''); setFields({});
    const body = { type: v.type, category: v.category, title: v.title, description: v.description, price: v.price, location: v.location, images: v.images, attributes: v.attributes };
    if (vertical.commerce === 'service') body.deliveryDays = v.deliveryDays;
    if (vertical.commerce === 'product') {
      body.fulfillment = v.fulfillment;
      if (v.fulfillment === 'physical') { body.stock = v.stock; body.shippingDays = v.shippingDays; } else body.deliveryUrl = v.deliveryUrl;
    }
    try {
      if (id) await api.put(`/listings/${id}`, body); else await api.post('/listings', body);
      toast(id ? 'Listing updated.' : 'Listing published!'); nav('/seller/listings');
    } catch (e2) { setError(e2.message); setFields(e2.fields || {}); window.scrollTo(0, 0); } finally { setBusy(false); }
  };

  if (loading) return <Spinner />;
  return (
    <div className="container page" style={{ maxWidth: 860 }}>
      <p className="small"><Link to="/seller/listings">← My listings</Link></p>
      <h1>{id ? 'Edit listing' : 'New listing'}</h1>
      <form className="grid grid-2" onSubmit={submit} style={{ alignItems: 'start' }}>
        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <Alert>{error}</Alert>
          <div className="grid grid-2">
            <Field label="What are you listing?" error={err('type')}>
              <select value={v.type} disabled={!!id} onChange={(e) => { const x = verticals.find((q) => q.key === e.target.value); set({ type: x.key, category: x.categories[0], attributes: {} }); }}>
                {verticals.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
              </select>
            </Field>
            <Field label="Category" error={err('category')}><select value={v.category} onChange={(e) => set({ category: e.target.value })}>{vertical.categories.map((c) => <option key={c}>{c}</option>)}</select></Field>
          </div>
          <Field label="Title" error={err('title')}><input value={v.title} onChange={(e) => set({ title: e.target.value })} maxLength={140} required /></Field>
          <Field label="Description" error={err('description')}><textarea value={v.description} onChange={(e) => set({ description: e.target.value })} /></Field>
          <div className="grid grid-2">
            <Field label={`Price (${currency.code})`} error={err('price')}><input type="number" step={currency.decimals ? '0.01' : '1'} min="0" value={v.price} onChange={(e) => set({ price: e.target.value })} required /></Field>
            <Field label="Location" error={err('location')}><input value={v.location} onChange={(e) => set({ location: e.target.value })} placeholder="e.g. Freetown, Aberdeen" /></Field>
          </div>
        </div>

        {vertical.fields.length > 0 && (
          <div className="card" style={{ gridColumn: '1 / -1' }}>
            <h3>{vertical.label} details</h3>
            <div className="grid grid-3">
              {vertical.fields.map((f) => (
                <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`} error={err(`attributes.${f.key}`)}>
                  {f.type === 'select' ? (
                    <select value={v.attributes[f.key] ?? ''} onChange={(e) => setAttr(f.key, e.target.value)}><option value="">Choose…</option>{f.options.map((o) => <option key={o}>{o}</option>)}</select>
                  ) : <input type={f.type === 'number' ? 'number' : 'text'} min={f.min} max={f.max} value={v.attributes[f.key] ?? ''} onChange={(e) => setAttr(f.key, e.target.value)} />}
                </Field>
              ))}
            </div>
          </div>
        )}

        <div className="card">
          <h3>{vertical.commerce === 'service' ? 'Delivery' : vertical.commerce === 'product' ? 'Fulfilment' : 'Photos'}</h3>
          {vertical.commerce === 'service' && <Field label="Delivery time (days)" error={err('deliveryDays')}><input type="number" min="1" value={v.deliveryDays} onChange={(e) => set({ deliveryDays: e.target.value })} /></Field>}
          {vertical.commerce === 'product' && <>
            <Field label="Type of product" error={err('fulfillment')}><select value={v.fulfillment} onChange={(e) => set({ fulfillment: e.target.value })}><option value="physical">Physical (shipped / handed over)</option>{allowDigital && <option value="digital">Digital download</option>}</select></Field>
            {v.fulfillment === 'physical' ? <div className="grid grid-2">
              <Field label="In stock" error={err('stock')}><input type="number" min="0" value={v.stock} onChange={(e) => set({ stock: e.target.value })} /></Field>
              <Field label="Ships in (days)" error={err('shippingDays')}><input type="number" min="1" value={v.shippingDays} onChange={(e) => set({ shippingDays: e.target.value })} /></Field></div>
              : <Field label="Private download link (https)" error={err('deliveryUrl')} hint="Only buyers who have paid will ever see this."><input type="url" value={v.deliveryUrl} onChange={(e) => set({ deliveryUrl: e.target.value })} /></Field>}
          </>}
          {vertical.commerce === 'classified' && <p className="muted">Buyers will contact you through messages. Add clear photos.</p>}
          <h3 style={{ marginTop: 14 }}>Photos</h3>
          <div className="dropzone">
            <div className="thumbs">{v.images.map((src) => <div key={src}><img src={assetUrl(src)} alt="" /><button type="button" aria-label="Remove photo" onClick={() => set({ images: v.images.filter((x) => x !== src) })}>×</button></div>)}</div>
            <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => upload(e.target.files)} />
            <button type="button" className="btn btn-ghost btn-sm" disabled={uploading || v.images.length >= limits.maxImagesPerListing} onClick={() => fileInput.current.click()}>{uploading ? 'Uploading…' : 'Add photos'}</button>
            <span className="muted small"> {v.images.length}/{limits.maxImagesPerListing} · JPG, PNG or WebP up to {limits.maxImageMB} MB</span>
            {err('images') && <div className="field-error">{err('images')}</div>}
          </div>
        </div>

        <div className="stack">
          {vertical.mode === 'checkout' && price > 0 && (
            <div className="card"><h3>What you'll receive</h3>
              <Receipt rows={[['Buyer pays', formatMoney(priceMinor)], [`Platform fee (${commissionPct}%)`, `− ${formatMoney(fee)}`, true]]} total={['You receive', formatMoney(priceMinor - fee)]} />
            </div>)}
          <button className="btn btn-accent btn-block" disabled={busy || uploading}>{busy ? 'Saving…' : id ? 'Save changes' : 'Publish listing'}</button>
        </div>
      </form>
    </div>
  );
}

export function Earnings() {
  const { formatBase: formatMoney, payoutMethods, minPayoutMinor, currency } = useConfig();
  const { user, setUser } = useAuth();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [fields, setFields] = useState({});
  const [pm, setPm] = useState({ payoutMethod: user.payoutMethod || '', payoutDetails: user.payoutDetails || '' });
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.get('/account/wallet').then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  const saveDetails = async (e) => {
    e.preventDefault(); setBusy(true); setError(''); setFields({});
    try { const d = await api.patch('/account/profile', pm); setUser(d.user); toast('Payout details saved.'); } catch (err) { setError(err.message); setFields(err.fields); } finally { setBusy(false); }
  };
  const withdraw = async (e) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await api.post('/account/wallet/payouts', amount ? { amount: Number(amount) } : {}); toast('Withdrawal requested. We will send it soon.'); setAmount(''); load(); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  if (!data) return error ? <div className="container page"><Alert>{error}</Alert></div> : <Spinner />;
  const w = data.wallet;
  return (
    <div className="container page">
      <SellerTabs />
      <h1>Earnings</h1>
      <div className="grid grid-4">
        <div className="stat"><small>Available to withdraw</small><b>{formatMoney(w.availableMinor)}</b></div>
        <div className="stat"><small>In progress (held)</small><b>{formatMoney(w.pendingMinor)}</b></div>
        <div className="stat"><small>Withdrawn</small><b>{formatMoney(w.withdrawnMinor)}</b></div>
        <div className="stat"><small>Lifetime earned</small><b>{formatMoney(w.lifetimeEarnedMinor)}</b></div>
      </div>
      <Alert>{error}</Alert>
      <div className="grid grid-2" style={{ marginTop: 20, alignItems: 'start' }}>
        <form className="card" onSubmit={saveDetails}>
          <h3>Payout details</h3>
          <Field label="Method"><select value={pm.payoutMethod} onChange={(e) => setPm({ ...pm, payoutMethod: e.target.value })} required><option value="">Choose…</option>{payoutMethods.map((m) => <option key={m}>{m}</option>)}</select></Field>
          <Field label="Number / account / email" error={fields.payoutDetails}><input value={pm.payoutDetails} onChange={(e) => setPm({ ...pm, payoutDetails: e.target.value })} required /></Field>
          <button className="btn btn-ghost" disabled={busy}>Save details</button>
        </form>
        <form className="card" onSubmit={withdraw}>
          <h3>Withdraw</h3>
          <p className="muted small">Minimum {formatMoney(minPayoutMinor)}. Leave the amount empty to withdraw everything available.</p>
          <Field label={`Amount (${currency.code})`}><input type="number" min="0" step={currency.decimals ? '0.01' : '1'} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={String(w.availableMinor / 10 ** currency.decimals)} /></Field>
          <button className="btn btn-accent" disabled={busy || w.availableMinor < minPayoutMinor}>Request withdrawal</button>
        </form>
      </div>
      <h2 style={{ marginTop: 28 }}>Withdrawal history</h2>
      {data.payouts.length === 0 ? <p className="muted">No withdrawals yet.</p> : (
        <div className="card table-wrap" style={{ padding: 0 }}><table><thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Status</th><th>Reference</th></tr></thead>
          <tbody>{data.payouts.map((p) => <tr key={p.id}><td>{new Date(p.createdAt).toLocaleDateString()}</td><td>{formatMoney(p.amountMinor)}</td><td>{p.method}<div className="muted small">{p.details}</div></td><td><StatusPill status={p.status === 'paid' ? 'paid' : p.status} /></td><td>{p.reference || p.adminNote || '—'}</td></tr>)}</tbody></table></div>
      )}
    </div>
  );
}
