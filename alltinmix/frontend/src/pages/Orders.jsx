import React, { useCallback, useEffect, useState } from 'react';
import { Download, MapPin, MessageCircle, Phone, Store } from 'lucide-react';
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
  const [photos, setPhotos] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await api.post(`/orders/${order.id}/review`, { rating, comment, images: photos }); onDone('Thanks for your review!'); }
    catch (err) { setError(err.message); setBusy(false); }
  };
  return (
    <Modal title={`Review: ${order.title}`} onClose={onClose}>
      <form onSubmit={submit}>
        <Alert>{error}</Alert>
        <div style={{ marginBottom: 12 }}><Stars value={rating} onChange={setRating} size={30} /></div>
        <Field label="Comment (optional)"><textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} /></Field>
        <div style={{ marginBottom: 12 }}>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {photos.map((src) => <img key={src} src={assetUrl(src)} alt="" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8 }} />)}
            {photos.length < 3 && <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>{uploading ? 'Uploading…' : '+ Add photos'}
              <input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden disabled={uploading} onChange={async (e) => {
                setUploading(true); setError('');
                try { const d = await api.upload([...e.target.files].slice(0, 3 - photos.length), '/uploads/review'); setPhotos((p) => [...p, ...d.urls].slice(0, 3)); } catch (err) { setError(err.message); }
                setUploading(false); e.target.value = '';
              }} /></label>}
          </div>
        </div>
        <div className="row"><button className="btn btn-primary" disabled={busy || uploading}>Submit review</button><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button></div>
      </form>
    </Modal>
  );
}

/** WhatsApp click-to-chat link (works without any API). The number must include the country code. */
const waLink = (phone, text) => `https://wa.me/${String(phone || '').replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;

function DeliveryInfo({ o, seller }) {
  if (!o.deliveryMethod) return null;
  const a = o.deliveryAddress || {};
  const contact = seller ? (o.buyerPhone || a.phone) : o.sellerPhone;
  const who = seller ? (a.name || o.buyerName) : o.sellerName;
  return (
    <div className="receipt" style={{ margin: '10px 0' }}>
      <div className="receipt-row"><span>{o.deliveryMethod === 'pickup' ? <><Store size={14} /> Pickup</> : <><MapPin size={14} /> Delivery{o.deliveryZone ? ` · ${o.deliveryZone}` : ''}</>}</span><b style={{ textAlign: 'right' }}>{o.deliveryMethod === 'ship' ? a.address : (a.pickupLocation || 'Seller will confirm the place')}</b></div>
      {seller && a.phone && <div className="receipt-row"><span>Buyer phone</span><b>{a.phone}</b></div>}
      {a.note && <div className="receipt-row"><span>Note</span><b style={{ textAlign: 'right' }}>{a.note}</b></div>}
      {contact && <div className="row" style={{ marginTop: 8 }}>
        <a className="btn btn-ghost btn-sm" href={`tel:${contact}`}><Phone size={14} /> Call {who}</a>
        <a className="btn btn-ghost btn-sm" href={waLink(contact, `Hello, about my order "${o.title}" on ALLTINMIX.`)} target="_blank" rel="noopener noreferrer"><MessageCircle size={14} /> WhatsApp</a>
      </div>}
    </div>
  );
}

const STEP_LABELS = {
  awaiting_payment: 'Order created, waiting for payment', pending_acceptance: 'Waiting for the seller to accept', in_progress: 'Seller accepted and is preparing it',
  delivered: 'Delivered', completed: 'Completed', disputed: 'Problem reported', refunded: 'Refunded', cancelled: 'Cancelled',
};
function Timeline({ id }) {
  const [events, setEvents] = useState(null);
  useEffect(() => { api.get(`/orders/${id}/events`).then((d) => setEvents(d.events)).catch(() => setEvents([])); }, [id]);
  if (!events) return <Spinner />;
  return (
    <ol className="timeline">
      {events.map((e, i) => <li key={i} className={i === events.length - 1 ? 'now' : ''}><b>{STEP_LABELS[e.status] || e.status}</b><span className="muted small">{new Date(e.at).toLocaleString()}</span></li>)}
    </ol>
  );
}

function OrderCard({ o, seller, act }) {
  const [track, setTrack] = useState(false);
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
        <div><b>{o.title}</b> <span className="muted small">× {o.qty}</span><div className="muted small">{seller ? `Buyer: ${o.buyerName}` : `Seller: ${o.sellerName}`} · {new Date(o.createdAt).toLocaleDateString()}{o.paymentMethod ? ` · ${o.paymentMethod === 'cod' ? 'cash on delivery' : o.paymentMethod.replace('_', ' ')}` : ''}</div></div>
        <div className="row" style={{ gap: 6 }}>{o.cod && <span className="pill pill-blue" title="Pay the seller in cash on delivery">Cash on delivery</span>}<StatusPill status={o.status} /></div>
      </div>
      {seller ? (
        <div style={{ margin: '12px 0', maxWidth: 360 }}><Receipt rows={[['Sale', formatMoney(o.totalMinor - (o.deliveryFeeMinor || 0))], ...(o.deliveryFeeMinor ? [['Delivery fee (yours)', formatMoney(o.deliveryFeeMinor)]] : []), [`Platform fee (${o.commissionPct}%)`, `− ${formatMoney(o.commissionMinor)}`, true]]} total={[o.cod ? 'Cash to collect' : 'You receive', o.cod ? formatMoney(o.totalMinor) : formatMoney(o.sellerEarningsMinor)]} /></div>
      ) : <p style={{ margin: '8px 0' }}><b>{formatMoney(o.totalMinor)}</b>{o.paidCurrency && o.paidCurrency !== o.currency && <span className="muted small"> · you paid {formatIn(o.paidMinor, o.paidCurrency)}</span>}</p>}
      {o.cod && seller && <Alert kind="info">Collect {formatMoney(o.totalMinor)} in cash. The platform fee of {formatMoney(o.commissionMinor)} is deducted from your balance when the order completes.</Alert>}
      {o.cod && !seller && ['pending_acceptance', 'in_progress'].includes(o.status) && <Alert kind="info">Have {formatMoney(o.totalMinor)} in cash ready for when it arrives.</Alert>}
      <DeliveryInfo o={o} seller={seller} />
      {o.status === 'disputed' && <Alert kind="info">Dispute: {o.disputeReason}. Our team is reviewing.</Alert>}
      {o.status === 'refunded' && o.refundManual && !o.refundSettledAt && !seller && <Alert kind="info">Your refund is being sent by the marketplace to the number you paid from.</Alert>}
      {!seller && o.downloadUrl && <a className="btn btn-accent btn-sm" href={assetUrl(o.downloadUrl)} target="_blank" rel="noopener noreferrer"><Download size={14} /> Download</a>}
      {track && <Timeline id={o.id} />}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => setTrack(!track)}>{track ? 'Hide timeline' : 'Track order'}</button>
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
