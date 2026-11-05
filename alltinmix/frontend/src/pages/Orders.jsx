import React, { useCallback, useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { api, assetUrl, qs } from '../api';
import { useConfig, useToast } from '../context';
import { Alert, Empty, Field, Receipt, Spinner, Stars, StatusPill } from '../components/ui';

function Modal({ title, children, onClose }) {
  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}><h3>{title}</h3>{children}</div>
    </div>
  );
}
export { Modal };

function DisputeModal({ order, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await api.post(`/orders/${order.id}/dispute`, { reason }); onDone('Dispute opened. Our team will review it.'); }
    catch (err) { setError(err.message); setBusy(false); }
  };
  return (
    <Modal title="Report a problem" onClose={onClose}>
      <p className="muted">Payment stays on hold while we review. Describe what went wrong.</p>
      <form onSubmit={submit}>
        <Alert>{error}</Alert>
        <Field label="What happened?"><textarea value={reason} onChange={(e) => setReason(e.target.value)} required minLength={10} /></Field>
        <div className="row"><button className="btn btn-danger" disabled={busy}>Open dispute</button><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button></div>
      </form>
    </Modal>
  );
}

function ReviewModal({ order, onClose, onDone }) {
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await api.post(`/orders/${order.id}/review`, { rating, comment }); onDone('Thanks for your review!'); }
    catch (err) { setError(err.message); setBusy(false); }
  };
  return (
    <Modal title={`Review: ${order.title}`} onClose={onClose}>
      <form onSubmit={submit}>
        <Alert>{error}</Alert>
        <div style={{ marginBottom: 12 }}><Stars value={rating} onChange={setRating} size={30} /></div>
        <Field label="Comment (optional)"><textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} /></Field>
        <div className="row"><button className="btn btn-primary" disabled={busy}>Submit review</button><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button></div>
      </form>
    </Modal>
  );
}

function OrderCard({ o, seller, act }) {
  const { formatBase: formatMoney, formatIn } = useConfig();
  const [modal, setModal] = useState(null);
  const [busy, setBusy] = useState('');
  const run = async (action, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(action);
    await act(o.id, action);
    setBusy('');
  };
  const btn = (action, label, cls = 'btn-primary', confirmText) => (
    <button className={`btn btn-sm ${cls}`} disabled={!!busy} onClick={() => run(action, confirmText)}>{busy === action ? '…' : label}</button>
  );
  const digital = o.fulfillment === 'digital';
  return (
    <div className="order">
      <div className="row between">
        <div><b>{o.title}</b> <span className="muted small">× {o.qty}</span><div className="muted small">{seller ? `Buyer: ${o.buyerName}` : `Seller: ${o.sellerName}`} · {new Date(o.createdAt).toLocaleDateString()}{o.paymentMethod ? ` · ${o.paymentMethod.replace('_', ' ')}` : ''}</div></div>
        <StatusPill status={o.status} />
      </div>
      {seller ? (
        <div style={{ margin: '12px 0', maxWidth: 360 }}><Receipt rows={[['Sale', formatMoney(o.totalMinor)], [`Platform fee (${o.commissionPct}%)`, `− ${formatMoney(o.commissionMinor)}`, true]]} total={['You receive', formatMoney(o.sellerEarningsMinor)]} /></div>
      ) : <p style={{ margin: '8px 0' }}><b>{formatMoney(o.totalMinor)}</b>{o.paidCurrency && o.paidCurrency !== o.currency && <span className="muted small"> · you paid {formatIn(o.paidMinor, o.paidCurrency)}</span>}</p>}
      {o.status === 'disputed' && <Alert kind="info">Dispute: {o.disputeReason}. Our team is reviewing.</Alert>}
      {o.status === 'refunded' && o.refundManual && !o.refundSettledAt && !seller && <Alert kind="info">Your refund is being sent by the marketplace to the number you paid from.</Alert>}
      {!seller && o.downloadUrl && <a className="btn btn-accent btn-sm" href={assetUrl(o.downloadUrl)} target="_blank" rel="noopener noreferrer"><Download size={14} /> Download</a>}
      <div className="row" style={{ marginTop: 10 }}>
        {seller && o.status === 'pending_acceptance' && <>{btn('accept', 'Accept order')}{btn('cancel', 'Decline & refund', 'btn-ghost', 'Decline this order? The buyer will be refunded.')}</>}
        {seller && o.status === 'in_progress' && <>{btn('deliver', digital ? 'Mark delivered' : 'Mark as shipped / delivered')}{btn('cancel', 'Cancel & refund', 'btn-ghost', 'Cancel this order? The buyer will be refunded.')}</>}
        {!seller && o.status === 'pending_acceptance' && btn('cancel', 'Cancel order', 'btn-ghost', 'Cancel this order and get a refund?')}
        {!seller && o.status === 'delivered' && <>{btn('confirm', 'Confirm — all good', 'btn-accent', 'Release the payment to the seller? You can’t undo this.')}<button className="btn btn-ghost btn-sm" onClick={() => setModal('dispute')}>Report a problem</button></>}
        {!seller && o.status === 'in_progress' && <button className="btn btn-ghost btn-sm" onClick={() => setModal('dispute')}>Report a problem</button>}
        {!seller && o.status === 'completed' && !o.reviewed && <button className="btn btn-primary btn-sm" onClick={() => setModal('review')}>Leave a review</button>}
      </div>
      {modal === 'dispute' && <DisputeModal order={o} onClose={() => setModal(null)} onDone={(m) => { setModal(null); act(o.id, null, m); }} />}
      {modal === 'review' && <ReviewModal order={o} onClose={() => setModal(null)} onDone={(m) => { setModal(null); act(o.id, null, m); }} />}
    </div>
  );
}

function OrderList({ endpoint, seller, title, emptyText }) {
  const toast = useToast();
  const [orders, setOrders] = useState(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => api.get(`/orders/${endpoint}${qs({ status })}`).then((d) => setOrders(d.orders)).catch((e) => setError(e.message)), [endpoint, status]);
  useEffect(() => { setOrders(null); load(); }, [load]);

  /** action null = just refresh and show a message (after a modal finished). */
  const act = async (id, action, message) => {
    try {
      if (action) await api.post(`/orders/${id}/${action}`);
      toast(message || 'Order updated.');
    } catch (e) { toast(e.message, 'error'); }
    load();
  };
  const statuses = ['', 'pending_acceptance', 'in_progress', 'delivered', 'completed', 'disputed', 'refunded', 'cancelled'];
  return (
    <div className="container page">
      <div className="row between"><h1>{title}</h1>
        <select className="input" style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          {statuses.map((s) => <option key={s} value={s}>{s ? s.replace('_', ' ') : 'All statuses'}</option>)}
        </select></div>
      <Alert>{error}</Alert>
      {!orders ? <Spinner /> : orders.length === 0 ? <Empty title="Nothing here yet">{emptyText}</Empty> : orders.map((o) => <OrderCard key={o.id} o={o} seller={seller} act={act} />)}
    </div>
  );
}

export const BuyerOrders = () => <OrderList endpoint="mine" seller={false} title="My orders" emptyText="Orders you place will show up here." />;
export const SellerOrders = () => <OrderList endpoint="selling" seller title="Sales" emptyText="When someone buys from you, the order appears here." />;
