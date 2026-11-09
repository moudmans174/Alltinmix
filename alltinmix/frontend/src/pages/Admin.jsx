import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useConfig, useToast } from '../context';
import { Alert, Empty, Field, Spinner, StatusPill } from '../components/ui';
import { Modal } from './Orders';

function useLoad(path) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api.get(path).then(setData).catch((e) => setError(e.message)), [path]);
  useEffect(() => { setData(null); load(); }, [load]);
  return { data, error, reload: load };
}

function useAction(reload) {
  const toast = useToast();
  return async (fn, message = 'Done.') => {
    try { await fn(); toast(message); reload(); } catch (e) { toast(e.message, 'error'); }
  };
}

function FxRates() {
  const { currencies, baseCode, formatIn } = useConfig();
  const toast = useToast();
  const others = currencies.filter((c) => c.code !== baseCode);
  const { data, reload } = useLoad('/admin/settings/fx-rates');
  const [vals, setVals] = useState({});
  useEffect(() => { if (data) setVals(Object.fromEntries(others.map((c) => [c.code, String(data.rates[c.code])]))); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!others.length || !data) return null;
  const base = currencies.find((c) => c.code === baseCode);
  const save = async (e) => {
    e.preventDefault();
    try { await api.patch('/admin/settings/fx-rates', { rates: Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, Number(v)])) }); toast('Exchange rates updated for new payments.'); reload(); }
    catch (err) { toast(err.message, 'error'); }
  };
  return (
    <form className="card" onSubmit={save} style={{ maxWidth: 520 }}>
      <h3>Exchange rates</h3>
      <p className="muted small">Prices are set in {baseCode}. Buyers can pay in other currencies at these rates. Changes apply to new payments only. Set them to match your real exchange or mobile-money rate.</p>
      {others.map((c) => (
        <Field key={c.code} label={`1 ${c.code} = ${base.symbol} …`} hint={`Example: a ${formatIn(100000, baseCode)} item costs ${formatIn(Math.round(100000 / (Number(vals[c.code]) || 1)), c.code)}`}>
          <input type="number" step="any" min="0" value={vals[c.code] ?? ''} onChange={(e) => setVals({ ...vals, [c.code]: e.target.value })} />
        </Field>
      ))}
      <button className="btn btn-primary">Save rates</button>
    </form>
  );
}

function DeliveryZones() {
  const { currency } = useConfig();
  const toast = useToast();
  const { data, reload } = useLoad('/admin/settings/delivery-zones');
  const [rows, setRows] = useState(null);
  useEffect(() => { if (data) setRows(data.zones.map((z) => ({ name: z.name, fee: String(z.feeMinor / 10 ** currency.decimals) }))); }, [data, currency.decimals]);
  if (!rows) return <Spinner />;
  const set = (i, k, v) => setRows((r) => r.map((x, n) => (n === i ? { ...x, [k]: v } : x)));
  const save = async (e) => {
    e.preventDefault();
    try { await api.put('/admin/settings/delivery-zones', { zones: rows.filter((r) => r.name.trim()).map((r) => ({ name: r.name.trim(), feeMinor: Math.round(Number(r.fee || 0) * 10 ** currency.decimals) })) }); toast('Delivery areas saved.'); reload(); }
    catch (err) { toast(err.message, 'error'); }
  };
  return (
    <form className="card" onSubmit={save}>
      <h3>Delivery areas and fees</h3>
      <p className="muted small">Buyers pick an area when they want delivery; the fee is added once per seller and goes to the seller. Leave the list empty if sellers arrange delivery cost themselves. Fees are in {currency.code}.</p>
      {rows.map((r, i) => (
        <div className="row" key={i} style={{ marginBottom: 8 }}>
          <input placeholder="Area name (e.g. Freetown Central)" value={r.name} onChange={(e) => set(i, 'name', e.target.value)} />
          <input type="number" min="0" step="any" style={{ maxWidth: 140 }} placeholder="Fee" value={r.fee} onChange={(e) => set(i, 'fee', e.target.value)} />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRows((x) => x.filter((_, n) => n !== i))} aria-label="Remove">✕</button>
        </div>
      ))}
      <div className="row"><button type="button" className="btn btn-ghost btn-sm" onClick={() => setRows((x) => [...x, { name: '', fee: '' }])}>+ Add area</button><button className="btn btn-primary btn-sm">Save</button></div>
    </form>
  );
}

function CodBalances() {
  const { formatBase: formatMoney, currency } = useConfig();
  const toast = useToast();
  const { data, reload } = useLoad('/admin/cod-balances');
  if (!data) return null;
  const record = async (s) => {
    const v = window.prompt(`How much did ${s.name} pay (${currency.code})? They owe ${formatMoney(s.owedMinor)}.`, String(s.owedMinor / 10 ** currency.decimals));
    if (!v) return;
    const note = window.prompt('Note (how they paid, reference):', 'Paid platform fees');
    if (!note) return;
    try { await api.post(`/admin/users/${s.id}/wallet-adjustment`, { amountMinor: Math.round(Number(v) * 10 ** currency.decimals), note }); toast('Payment recorded.'); reload(); }
    catch (err) { toast(err.message, 'error'); }
  };
  return (
    <div className="card">
      <h3>Sellers who owe platform fees (cash on delivery)</h3>
      {data.sellers.length === 0 ? <p className="muted">Nobody owes anything.</p> : data.sellers.map((s) => (
        <div className="receipt-row" key={s.id}><span>{s.name}<span className="muted small"> · {s.phone || s.email}</span></span><span className="row"><b>{formatMoney(s.owedMinor)}</b><button className="btn btn-ghost btn-sm" onClick={() => record(s)}>Record payment</button></span></div>
      ))}
    </div>
  );
}

function Overview() {
  const { formatBase: formatMoney, vertical } = useConfig();
  const toast = useToast();
  const { data, error, reload } = useLoad('/admin/stats');
  const [pct, setPct] = useState('');
  useEffect(() => { if (data) setPct(String(data.commissionPct)); }, [data]);
  if (!data) return error ? <Alert>{error}</Alert> : <Spinner />;
  const save = async (e) => { e.preventDefault(); try { await api.patch('/admin/settings/commission', { commissionPct: Number(pct) }); toast('Commission updated for new orders.'); reload(); } catch (err) { toast(err.message, 'error'); } };
  const S = ({ label, value }) => <div className="stat"><small>{label}</small><b>{value}</b></div>;
  return (
    <div className="stack">
      <div className="grid grid-4">
        <S label="Sales volume" value={formatMoney(data.gmvMinor)} /><S label="Commission earned" value={formatMoney(data.commissionEarnedMinor)} />
        <S label="Commission pending" value={formatMoney(data.commissionPendingMinor)} /><S label="Orders" value={`${data.completedOrders} / ${data.totalOrders} completed`} />
        <S label="Users" value={data.users} /><S label="Active listings" value={data.activeListings} />
        <S label="Open disputes" value={data.openDisputes} /><S label="Refunds to send" value={data.refundsDue} />
      </div>
      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <form className="card" onSubmit={save}>
          <h3>Commission rate</h3>
          <p className="muted small">Applies to new orders. Existing orders keep the rate they were placed with.</p>
          <Field label="Percent taken from every sale"><input type="number" min="0" max="50" step="0.1" value={pct} onChange={(e) => setPct(e.target.value)} /></Field>
          <button className="btn btn-primary">Save</button>
        </form>
        <div className="card"><h3>Revenue by type</h3>
          {data.revenueByType.length === 0 ? <p className="muted">No sales yet.</p> : data.revenueByType.map((r) => <div className="receipt-row" key={r.type}><span>{vertical(r.type)?.label || r.type} <span className="muted small">({r.orders})</span></span><b>{formatMoney(r.revenueMinor)}</b></div>)}
        </div>
      </div>
      <FxRates />
      <div className="grid grid-2" style={{ alignItems: 'start' }}><DeliveryZones /><CodBalances /></div>
    </div>
  );
}

function RejectModal({ title, onClose, onSubmit }) {
  const [note, setNote] = useState('');
  return (
    <Modal title={title} onClose={onClose}>
      <Field label="Note to the user (optional)"><textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
      <div className="row"><button className="btn btn-danger" onClick={() => onSubmit(note)}>Confirm</button><button className="btn btn-ghost" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

function Payments() {
  const { formatIn: formatMoney } = useConfig();  // payments are shown in the currency the buyer was charged
  const { data, error, reload } = useLoad('/admin/payments');
  const run = useAction(reload);
  const [rej, setRej] = useState(null);
  if (!data) return error ? <Alert>{error}</Alert> : <Spinner />;
  if (!data.payments.length) return <Empty title="Nothing to confirm">Mobile money payments appear here after buyers submit their transaction ID.</Empty>;
  return (
    <div className="stack">
      <Alert kind="info">Check your {`Orange Money / Afrimoney / QMoney`} account for the transaction ID and amount before confirming.</Alert>
      {data.payments.map((p) => (
        <div className="order" key={p.id}>
          <div className="row between"><b>{formatMoney(p.amountMinor)} via {p.method.replace('_', ' ')}</b><span className="muted small">{new Date(p.createdAt).toLocaleString()}</span></div>
          <p className="muted small" style={{ margin: '4px 0' }}>{p.buyerName} ({p.buyerEmail}) · {p.titles}</p>
          <div className="receipt"><div className="receipt-row"><span>Reference</span><b>{p.reference}</b></div><div className="receipt-row"><span>Sent from</span><b>{p.proof?.senderPhone}</b></div><div className="receipt-row"><span>Transaction ID</span><b>{p.proof?.transactionId}</b></div></div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn btn-accent btn-sm" onClick={() => window.confirm(`Confirm you received ${formatMoney(p.amountMinor)}?`) && run(() => api.post(`/admin/payments/${p.id}/confirm`), 'Payment confirmed. Orders released to sellers.')}>I received it — confirm</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setRej(p)}>Not received — reject</button>
          </div>
        </div>
      ))}
      {rej && <RejectModal title="Reject this payment?" onClose={() => setRej(null)} onSubmit={(note) => { const p = rej; setRej(null); run(() => api.post(`/admin/payments/${p.id}/reject`, { note }), 'Payment rejected.'); }} />}
    </div>
  );
}

function Disputes() {
  const { formatBase: formatMoney } = useConfig();
  const { data, error, reload } = useLoad('/admin/orders?status=disputed');
  const run = useAction(reload);
  const [note, setNote] = useState({});
  if (!data) return error ? <Alert>{error}</Alert> : <Spinner />;
  const list = data.orders.filter((o) => o.status === 'disputed');
  if (!list.length) return <Empty title="No open disputes" />;
  return list.map((o) => (
    <div className="order" key={o.id}>
      <div className="row between"><b>{o.title}</b><b>{formatMoney(o.totalMinor)}</b></div>
      <p className="muted small">Buyer {o.buyerName} vs seller {o.sellerName}</p>
      <Alert kind="info">“{o.disputeReason}”</Alert>
      <Field label="Note to both parties (optional)"><input value={note[o.id] || ''} onChange={(e) => setNote({ ...note, [o.id]: e.target.value })} /></Field>
      <div className="row">
        <button className="btn btn-primary btn-sm" onClick={() => window.confirm('Release the payment to the seller?') && run(() => api.post(`/admin/orders/${o.id}/resolve`, { resolution: 'release', note: note[o.id] || '' }), 'Released to seller.')}>Release to seller</button>
        <button className="btn btn-danger btn-sm" onClick={() => window.confirm('Refund the buyer?') && run(() => api.post(`/admin/orders/${o.id}/resolve`, { resolution: 'refund', note: note[o.id] || '' }), 'Buyer refunded.')}>Refund buyer</button>
      </div>
    </div>
  ));
}

function Payouts() {
  const { formatBase: formatMoney } = useConfig();
  const { data, error, reload } = useLoad('/admin/payouts');
  const run = useAction(reload);
  const [ref, setRef] = useState({});
  const [rej, setRej] = useState(null);
  if (!data) return error ? <Alert>{error}</Alert> : <Spinner />;
  if (!data.payouts.length) return <Empty title="No withdrawal requests" />;
  return (
    <>
      {data.payouts.map((p) => (
        <div className="order" key={p.id}>
          <div className="row between"><b>{formatMoney(p.amountMinor)} → {p.userName}</b><span className="muted small">{new Date(p.createdAt).toLocaleDateString()}</span></div>
          <div className="receipt" style={{ margin: '8px 0' }}><div className="receipt-row"><span>Method</span><b>{p.method}</b></div><div className="receipt-row"><span>Send to</span><b>{p.details}</b></div></div>
          <div className="row">
            <input className="input" style={{ maxWidth: 260 }} placeholder="Transaction reference" value={ref[p.id] || ''} onChange={(e) => setRef({ ...ref, [p.id]: e.target.value })} aria-label="Reference" />
            <button className="btn btn-accent btn-sm" onClick={() => run(() => api.post(`/admin/payouts/${p.id}/pay`, { reference: ref[p.id] || '' }), 'Marked as paid.')}>I sent it — mark paid</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setRej(p)}>Decline</button>
          </div>
        </div>
      ))}
      {rej && <RejectModal title="Decline this withdrawal? The money returns to their balance." onClose={() => setRej(null)} onSubmit={(note) => { const p = rej; setRej(null); run(() => api.post(`/admin/payouts/${p.id}/reject`, { note }), 'Declined. Balance returned.'); }} />}
    </>
  );
}

function Refunds() {
  const { formatBase: formatMoney } = useConfig();
  const { data, error, reload } = useLoad('/admin/refunds-due');
  const run = useAction(reload);
  if (!data) return error ? <Alert>{error}</Alert> : <Spinner />;
  if (!data.orders.length) return <Empty title="No manual refunds to send">Card and PayPal refunds happen automatically. Mobile money refunds appear here.</Empty>;
  return (
    <div className="stack">
      <Alert kind="info">Mobile money can't be refunded automatically. Send the money back from your wallet, then mark it done.</Alert>
      {data.orders.map((o) => (
        <div className="order" key={o.id}>
          <div className="row between"><div><b>{o.title}</b><div className="muted small">Refund {formatMoney(o.totalMinor)} to {o.buyerName} via {o.paymentMethod?.replace('_', ' ')}</div></div>
            <button className="btn btn-accent btn-sm" onClick={() => run(() => api.post(`/admin/orders/${o.id}/refund-settled`), 'Marked as refunded.')}>I sent the refund</button></div>
        </div>
      ))}
    </div>
  );
}

function Users() {
  const { data, error, reload } = useLoad('/admin/users');
  const run = useAction(reload);
  if (!data) return error ? <Alert>{error}</Alert> : <Spinner />;
  return (
    <div className="card table-wrap" style={{ padding: 0 }}><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th /></tr></thead>
      <tbody>{data.users.map((u) => (
        <tr key={u.id}><td>{u.name}</td><td>{u.email}{!u.emailVerified && <span className="muted small"> (unverified)</span>}</td><td>{u.role}</td><td><StatusPill status={u.status} /></td>
          <td>{u.role !== 'admin' && (u.status === 'active'
            ? <button className="btn btn-ghost btn-sm" onClick={() => window.confirm(`Suspend ${u.name}? They are logged out immediately.`) && run(() => api.patch(`/admin/users/${u.id}`, { status: 'suspended' }), 'User suspended.')}>Suspend</button>
            : <button className="btn btn-ghost btn-sm" onClick={() => run(() => api.patch(`/admin/users/${u.id}`, { status: 'active' }), 'User reactivated.')}>Reactivate</button>)}</td></tr>))}</tbody></table></div>
  );
}

function Listings() {
  const { formatBase: formatMoney } = useConfig();
  const { data, error, reload } = useLoad('/admin/listings');
  const run = useAction(reload);
  if (!data) return error ? <Alert>{error}</Alert> : <Spinner />;
  return (
    <div className="card table-wrap" style={{ padding: 0 }}><table><thead><tr><th>Listing</th><th>Seller</th><th>Price</th><th>Status</th><th /></tr></thead>
      <tbody>{data.listings.map((l) => (
        <tr key={l.id}><td><a href={`/listing/${l.id}`} target="_blank" rel="noreferrer"><b>{l.title}</b></a><div className="muted small">{l.type} · {l.category}</div></td><td>{l.sellerName}</td><td>{formatMoney(l.priceMinor)}</td><td><StatusPill status={l.status} /></td>
          <td>{l.status === 'hidden'
            ? <button className="btn btn-ghost btn-sm" onClick={() => run(() => api.patch(`/admin/listings/${l.id}`, { status: 'active' }), 'Listing restored.')}>Restore</button>
            : <button className="btn btn-ghost btn-sm" onClick={() => window.confirm('Hide this listing and notify the seller?') && run(() => api.patch(`/admin/listings/${l.id}`, { status: 'hidden' }), 'Listing hidden.')}>Hide</button>}</td></tr>))}</tbody></table></div>
  );
}

function Verifications() {
  const { data, error, reload } = useLoad('/admin/verifications');
  const run = useAction(reload);
  const [img, setImg] = useState(null);
  const toast = useToast();
  if (!data) return error ? <Alert>{error}</Alert> : <Spinner />;
  const view = async (s) => {
    try {
      const base = import.meta.env.VITE_API_URL || '/api';
      const res = await fetch(`${base}/admin/verifications/${s.id}/document`, { headers: { Authorization: `Bearer ${localStorage.getItem('marketplace_token')}` } });
      if (!res.ok) throw new Error('Could not load the photo.');
      setImg(URL.createObjectURL(await res.blob()));
    } catch (e) { toast(e.message, 'error'); }
  };
  const decide = (s, approve) => {
    const note = approve ? undefined : window.prompt('Why is it rejected? The seller will see this.');
    if (!approve && !note) return;
    run(() => api.post(`/admin/verifications/${s.id}/decide`, { approve, note }), approve ? 'Seller verified.' : 'Rejected.');
    setImg(null);
  };
  return (
    <>
      {data.sellers.length === 0 ? <Empty title="Nothing to review">No sellers are waiting for ID verification.</Empty> : (
        <div className="card table-wrap" style={{ padding: 0 }}><table><thead><tr><th>Seller</th><th>Sent</th><th /></tr></thead><tbody>
          {data.sellers.map((s) => (
            <tr key={s.id}><td><b>{s.name}</b><div className="muted small">{s.email}{s.phone ? ` · ${s.phone}` : ''}</div></td><td>{new Date(s.createdAt).toLocaleDateString()}</td>
              <td className="row"><button className="btn btn-ghost btn-sm" onClick={() => view(s)}>View ID</button>
                <button className="btn btn-primary btn-sm" onClick={() => decide(s, true)}>Approve</button>
                <button className="btn btn-ghost btn-sm" onClick={() => decide(s, false)}>Reject</button></td></tr>))}
        </tbody></table></div>
      )}
      {img && <div className="card" style={{ marginTop: 12 }}><img src={img} alt="Seller ID" style={{ maxWidth: '100%', maxHeight: 420 }} /><div><button className="btn btn-ghost btn-sm" onClick={() => { URL.revokeObjectURL(img); setImg(null); }}>Hide photo</button></div></div>}
    </>
  );
}

function Reports() {
  const [status, setStatus] = useState('open');
  const { data, error, reload } = useLoad(`/admin/reports?status=${status}`);
  const run = useAction(reload);
  if (!data) return error ? <Alert>{error}</Alert> : <Spinner />;
  const resolve = (r, action, msg) => run(() => api.post(`/admin/reports/${r.id}/resolve`, { action }), msg);
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        {['open', 'actioned', 'dismissed'].map((s) => <button key={s} className={`chip ${status === s ? 'on' : ''}`} onClick={() => setStatus(s)}>{s}</button>)}
      </div>
      {data.reports.length === 0 ? <Empty title="No reports here">Nothing to review.</Empty> : (
        <div className="card table-wrap" style={{ padding: 0 }}><table><thead><tr><th>What</th><th>Reason</th><th>Reported by</th><th /></tr></thead>
          <tbody>{data.reports.map((r) => (
            <tr key={r.id}>
              <td><b>{r.targetType}</b>: {r.targetType === 'listing' ? <a href={`/listing/${r.targetId}`} target="_blank" rel="noreferrer">{r.targetLabel || 'removed'}</a> : (r.targetLabel || 'removed')}{r.details && <div className="muted small">“{r.details}”</div>}</td>
              <td>{r.reason.replace('_', ' ')}</td><td>{r.reporterName}<div className="muted small">{new Date(r.createdAt).toLocaleDateString()}</div></td>
              <td>{r.status === 'open' && <div className="row">
                {r.targetType === 'listing' && <button className="btn btn-ghost btn-sm" onClick={() => resolve(r, 'hide_listing', 'Listing hidden.')}>Hide listing</button>}
                <button className="btn btn-ghost btn-sm" onClick={() => window.confirm('Suspend this user? They are logged out immediately.') && resolve(r, 'suspend_user', 'User suspended.')}>Suspend user</button>
                <button className="btn btn-ghost btn-sm" onClick={() => resolve(r, 'dismiss', 'Report dismissed.')}>Dismiss</button></div>}</td>
            </tr>))}</tbody></table></div>
      )}
    </>
  );
}

export function Admin() {
  const [tab, setTab] = useState('overview');
  const { data } = useLoad('/admin/stats');
  const badge = (n) => (n > 0 ? <span className="badge" style={{ marginLeft: 6 }}>{n}</span> : null);
  const tabs = [
    ['overview', 'Overview'], ['payments', <>Payments to confirm{badge(data?.paymentsToConfirm)}</>], ['disputes', <>Disputes{badge(data?.openDisputes)}</>],
    ['payouts', <>Withdrawals{badge(data?.payoutsRequested)}</>], ['refunds', <>Refunds due{badge(data?.refundsDue)}</>], ['users', 'Users'], ['listings', 'Listings'], ['reports', <>Reports{badge(data?.reportsOpen)}</>], ['verification', 'Seller ID'],
  ];
  const View = { overview: Overview, payments: Payments, disputes: Disputes, payouts: Payouts, refunds: Refunds, users: Users, listings: Listings, reports: Reports, verification: Verifications }[tab];
  return (
    <div className="container page">
      <h1>Admin</h1>
      <div className="tabs">{tabs.map(([k, label]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>)}</div>
      <View />
    </div>
  );
}
