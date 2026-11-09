import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { useConfig, useToast } from '../context';
import { Alert, Field, Spinner, VerifiedBadge } from '../components/ui';
import { SellerTabs } from './Seller';

function Verification() {
  const toast = useToast();
  const [v, setV] = useState(null);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get('/seller/verification').then(setV).catch(() => setV({ status: 'none' })), []);
  useEffect(() => { load(); }, [load]);
  if (!v) return <Spinner />;
  const send = async (e) => {
    e.preventDefault();
    if (!file) return toast('Choose a photo of your ID first.', 'error');
    setBusy(true);
    try {
      const form = new FormData();
      form.append('document', file);
      const token = localStorage.getItem('marketplace_token');
      const base = import.meta.env.VITE_API_URL || '/api';
      const res = await fetch(`${base}/seller/verification`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Upload failed.');
      toast('Sent. We will review it soon.'); setFile(null); load();
    } catch (err) { toast(err.message, 'error'); }
    setBusy(false);
  };
  return (
    <div className="card stack">
      <h3 className="row" style={{ gap: 8, margin: 0 }}><ShieldCheck size={18} /> Verified seller badge</h3>
      {v.status === 'approved' && <p style={{ margin: 0 }}><VerifiedBadge /> Your listings show the verified badge, and buyers can filter for verified sellers.</p>}
      {v.status === 'pending' && <Alert kind="info">Your ID is being reviewed. We will notify you.</Alert>}
      {(v.status === 'none' || v.status === 'rejected') && (
        <form className="stack" onSubmit={send}>
          {v.status === 'rejected' && <Alert>Not approved: {v.note}. You can send a new photo.</Alert>}
          <p className="muted small" style={{ margin: 0 }}>Send a clear photo of a government ID (national ID, passport or driver's licence). Only our admins can see it, and it is deleted as soon as we decide. Verified sellers get a badge and more trust from buyers.</p>
          <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files[0] || null)} />
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Sending…' : 'Submit for verification'}</button>
        </form>
      )}
    </div>
  );
}

function Coupons() {
  const { formatBase } = useConfig();
  const toast = useToast();
  const [list, setList] = useState(null);
  const [f, setF] = useState({ code: '', kind: 'percent', value: '', minOrder: '', maxUses: '' });
  const load = useCallback(() => api.get('/seller/coupons').then((d) => setList(d.coupons)).catch(() => setList([])), []);
  useEffect(() => { load(); }, [load]);
  const create = async (e) => {
    e.preventDefault();
    try {
      await api.post('/seller/coupons', {
        code: f.code, ...(f.kind === 'percent' ? { percentOff: f.value } : { amountOff: f.value }),
        ...(f.minOrder ? { minOrder: f.minOrder } : {}), ...(f.maxUses ? { maxUses: f.maxUses } : {}),
      });
      setF({ code: '', kind: 'percent', value: '', minOrder: '', maxUses: '' }); toast('Coupon created.'); load();
    } catch (err) { toast(err.fields?.code || err.fields?.percentOff || err.message, 'error'); }
  };
  const toggle = async (c) => { try { await api.patch(`/seller/coupons/${c.id}`, { active: !c.active }); load(); } catch (err) { toast(err.message, 'error'); } };
  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>Discount coupons</h3>
      <p className="muted small" style={{ margin: 0 }}>You pay for the discount, it only applies to your items, and each buyer can use a code once.</p>
      <form className="stack" onSubmit={create}>
        <div className="row">
          <Field label="Code"><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} placeholder="WELCOME10" maxLength={20} required /></Field>
          <Field label="Type"><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="percent">% off</option><option value="amount">Fixed amount off</option></select></Field>
          <Field label={f.kind === 'percent' ? 'Percent (1-90)' : 'Amount'}><input type="number" min="1" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} required /></Field>
        </div>
        <div className="row">
          <Field label="Minimum order (optional)"><input type="number" min="0" value={f.minOrder} onChange={(e) => setF({ ...f, minOrder: e.target.value })} /></Field>
          <Field label="Max uses (optional)"><input type="number" min="1" value={f.maxUses} onChange={(e) => setF({ ...f, maxUses: e.target.value })} /></Field>
        </div>
        <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }}>Create coupon</button>
      </form>
      {list && list.length > 0 && (
        <div className="table-wrap"><table><thead><tr><th>Code</th><th>Discount</th><th>Used</th><th /></tr></thead><tbody>
          {list.map((c) => (
            <tr key={c.id}><td><b>{c.code}</b></td>
              <td>{c.percentOff ? `${c.percentOff}% off` : `${formatBase(c.amountOffMinor)} off`}{c.minOrderMinor > 0 ? ` · min ${formatBase(c.minOrderMinor)}` : ''}</td>
              <td>{c.usedCount}{c.maxUses ? ` / ${c.maxUses}` : ''}</td>
              <td><button className="btn btn-ghost btn-sm" onClick={() => toggle(c)}>{c.active ? 'Turn off' : 'Turn on'}</button></td></tr>))}
        </tbody></table></div>
      )}
    </div>
  );
}

function Promote() {
  const { formatBase } = useConfig();
  const toast = useToast();
  const [boost, setBoost] = useState(null);
  const [items, setItems] = useState([]);
  const load = useCallback(() => {
    api.get('/seller/boost').then(setBoost).catch(() => setBoost({ enabled: false }));
    api.get('/listings/mine').then((d) => setItems(d.listings.filter((l) => l.status === 'active'))).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);
  if (!boost || !boost.enabled) return null;
  const go = async (l) => {
    if (!window.confirm(`Promote "${l.title}" for ${boost.days} days? ${formatBase(boost.priceMinor)} will be taken from your wallet.`)) return;
    try { await api.post(`/seller/listings/${l.id}/boost`); toast('Promoted.'); load(); } catch (err) { toast(err.message, 'error'); }
  };
  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>Promote a listing</h3>
      <p className="muted small" style={{ margin: 0 }}>Promoted listings appear first in browse for {boost.days} days. Cost: {formatBase(boost.priceMinor)}, from your wallet balance.</p>
      {items.length === 0 ? <p className="muted">No active listings.</p> : items.map((l) => (
        <div key={l.id} className="row between"><span>{l.title}{l.promoted && <span className="pill pill-green" style={{ marginLeft: 8 }}>Promoted until {new Date(l.promotedUntil).toLocaleDateString()}</span>}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => go(l)}>{l.promoted ? 'Extend' : 'Promote'}</button></div>
      ))}
    </div>
  );
}

function Analytics() {
  const { formatBase } = useConfig();
  const [a, setA] = useState(null);
  useEffect(() => { api.get('/seller/analytics').then(setA).catch(() => {}); }, []);
  if (!a) return <Spinner />;
  const max = Math.max(1, ...a.daily.map((d) => d.orders));
  const Stat = ({ label, value }) => <div className="card flat" style={{ flex: 1, minWidth: 110 }}><div className="muted small">{label}</div><div style={{ fontSize: '1.4rem', fontWeight: 700 }}>{value}</div></div>;
  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>How your shop is doing</h3>
      <div className="row" style={{ gap: 10 }}>
        <Stat label="Views" value={a.views} /><Stat label="Saves" value={a.saves} /><Stat label="Sales" value={a.sales} /><Stat label="Earned" value={formatBase(a.earnedMinor)} /><Stat label="Views to sale" value={`${a.conversionPct}%`} />
      </div>
      <div>
        <div className="muted small" style={{ marginBottom: 6 }}>Orders, last 14 days</div>
        <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 60 }} role="img" aria-label="Orders per day, last 14 days">
          {a.daily.map((d) => <div key={d.day} title={`${d.day}: ${d.orders}`} style={{ flex: 1, height: `${Math.max(4, (d.orders / max) * 100)}%`, background: d.orders ? 'var(--accent, #0a7)' : 'var(--border, #ddd)', borderRadius: 2 }} />)}
        </div>
      </div>
      {a.topListings.length > 0 && <div className="table-wrap"><table><thead><tr><th>Top listings</th><th>Views</th><th>Saves</th><th>Sold</th></tr></thead><tbody>
        {a.topListings.map((t) => <tr key={t.id}><td><Link to={`/listing/${t.id}`}>{t.title}</Link></td><td>{t.views}</td><td>{t.saves}</td><td>{t.sold}</td></tr>)}
      </tbody></table></div>}
    </div>
  );
}

const CSV_EXAMPLE = 'type,category,title,description,price,stock,location\nproduct,Electronics,Phone charger,Fast charger,15,20,Freetown\n';

function BulkUpload() {
  const toast = useToast();
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const pick = async (e) => { const f = e.target.files[0]; if (f) setCsv(await f.text()); };
  const send = async () => {
    setBusy(true); setResult(null);
    try { const d = await api.post('/seller/listings/bulk', { csv }); setResult(d); toast(`${d.created} listing${d.created === 1 ? '' : 's'} created.`); }
    catch (err) { if (err.details) setResult(err.details); else setResult({ created: 0, errors: [{ row: 1, error: err.message }] }); toast(err.message, 'error'); }
    setBusy(false);
  };
  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>Add many listings with a spreadsheet</h3>
      <p className="muted small" style={{ margin: 0 }}>Save your sheet as CSV. Required columns: <b>type, category, title, price</b>. Optional: description, stock, location, fulfillment, deliveryDays, shippingDays. Up to 100 rows. Add photos afterwards by editing each listing.</p>
      <pre className="small" style={{ overflow: 'auto', margin: 0 }}>{CSV_EXAMPLE}</pre>
      <input type="file" accept=".csv,text/csv" onChange={pick} />
      <textarea className="input" rows={4} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="…or paste CSV text here" />
      <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} disabled={busy || !csv.trim()} onClick={send}>{busy ? 'Uploading…' : 'Upload'}</button>
      {result && <div>
        <p style={{ margin: 0 }}><b>{result.created || 0}</b> created.</p>
        {(result.errors || []).map((e) => <p key={e.row} className="muted small" style={{ margin: '2px 0' }}>Row {e.row}: {e.error}</p>)}
      </div>}
    </div>
  );
}

export function SellerGrowth() {
  return (
    <div className="container page">
      <SellerTabs />
      <h1>Grow your shop</h1>
      <div className="stack" style={{ gap: 16 }}>
        <Analytics />
        <Verification />
        <Coupons />
        <Promote />
        <BulkUpload />
      </div>
    </div>
  );
}
