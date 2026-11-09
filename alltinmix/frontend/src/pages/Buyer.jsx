import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth, useCart, useConfig, useToast } from '../context';
import { Alert, Empty, Field, Spinner } from '../components/ui';
import { Modal } from './Orders';

/** Buyer proposes a lower price. The seller can accept, decline or counter; the buyer then checks out at the agreed price. */
export function OfferModal({ listing, qtyHint = 1, onClose }) {
  const { formatMoney, currency } = useConfig();
  const { user } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const single = listing.type === 'service' || listing.fulfillment === 'digital';
  const [amount, setAmount] = useState('');
  const [qty, setQty] = useState(single ? 1 : qtyHint);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!user) { nav('/login'); return; }
    setBusy(true); setError('');
    try { await api.post('/offers', { listingId: listing.id, amount: Number(amount), qty, message }); toast('Offer sent. The seller has 48 hours to reply.'); onClose(); nav('/offers'); }
    catch (err) { setError(err.message); setBusy(false); }
  };
  const min = Math.ceil(listing.priceMinor / 2) / 10 ** currency.decimals;
  return (
    <Modal title="Make an offer" onClose={onClose}>
      <p className="muted">Listed at <b>{formatMoney(listing.priceMinor)}</b>. Offer at least {formatMoney(Math.ceil(listing.priceMinor / 2))}. If the seller agrees you have 48 hours to buy at that price.</p>
      <form onSubmit={submit}>
        <Alert>{error}</Alert>
        <Field label={`Your price per item (${currency.code})`}><input type="number" min={min} step="any" required value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></Field>
        {!single && <Field label="Quantity"><input type="number" min="1" max={listing.stock ?? 99} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))} /></Field>}
        <Field label="Message (optional)"><input maxLength={300} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Why this price? Paying today, collecting myself…" /></Field>
        <div className="row"><button className="btn btn-accent" disabled={busy}>Send offer</button><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button></div>
      </form>
    </Modal>
  );
}

const STATUS = {
  pending: ['Waiting for seller', 'pill-amber'], countered: ['Counter-offer', 'pill-blue'], accepted: ['Agreed', 'pill-green'],
  declined: ['Declined', 'pill-grey'], withdrawn: ['Withdrawn', 'pill-grey'], expired: ['Expired', 'pill-grey'], used: ['Bought', 'pill-green'],
};
const Pill = ({ status }) => <span className={`pill ${STATUS[status]?.[1] || 'pill-grey'}`}>{STATUS[status]?.[0] || status}</span>;
const left = (iso) => { const h = Math.max(0, Math.round((new Date(iso) - Date.now()) / 36e5)); return h >= 1 ? `${h}h left` : 'under 1h left'; };

/** The buyer's offers. */
export function MyOffers() {
  const { formatBase: money } = useConfig();
  const toast = useToast();
  const cart = useCart();
  const nav = useNavigate();
  const [offers, setOffers] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api.get('/offers/mine').then((d) => setOffers(d.offers)).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const act = async (id, action) => { try { await api.post(`/offers/${id}/buyer`, { action }); toast(action === 'accept' ? 'Counter-offer accepted.' : 'Offer withdrawn.'); load(); } catch (e) { toast(e.message, 'error'); } };
  const buy = async (o) => {
    try { const d = await api.get(`/listings/${o.listingId}`); cart.addOffer(d.listing, o); nav('/cart'); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div className="container page">
      <h1>My offers</h1>
      <Alert>{error}</Alert>
      {!offers ? <Spinner /> : offers.length === 0 ? <Empty title="No offers yet">On any product page, tap <b>Make an offer</b> to propose your price. <Link to="/browse">Browse</Link></Empty> : offers.map((o) => (
        <div className="order" key={o.id}>
          <div className="row between"><div><Link to={`/listing/${o.listingId}`}><b>{o.title}</b></Link> <span className="muted small">× {o.qty}</span><div className="muted small">Listed {money(o.listPriceMinor)} · you offered {money(o.amountMinor)}{o.counterMinor ? ` · counter ${money(o.counterMinor)}` : ''}</div></div><Pill status={o.status} /></div>
          {o.status === 'accepted' && <p style={{ margin: '8px 0' }}>Agreed price <b>{money(o.agreedMinor)}</b> each. <span className="muted small">{left(o.expiresAt)}</span></p>}
          {o.status === 'countered' && <p style={{ margin: '8px 0' }}>The seller counters at <b>{money(o.counterMinor)}</b> each. <span className="muted small">{left(o.expiresAt)}</span></p>}
          <div className="row" style={{ marginTop: 8 }}>
            {o.status === 'accepted' && <button className="btn btn-accent btn-sm" onClick={() => buy(o)}>Buy at {money(o.agreedMinor)}</button>}
            {o.status === 'countered' && <button className="btn btn-accent btn-sm" onClick={() => act(o.id, 'accept')}>Accept {money(o.counterMinor)}</button>}
            {['pending', 'countered', 'accepted'].includes(o.status) && <button className="btn btn-ghost btn-sm" onClick={() => act(o.id, 'withdraw')}>Withdraw</button>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Offers the seller has received. */
export function SellerOffers() {
  const { formatBase: money, currency } = useConfig();
  const toast = useToast();
  const [offers, setOffers] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api.get('/offers/received').then((d) => setOffers(d.offers)).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const respond = async (id, action, counter) => { try { await api.post(`/offers/${id}/respond`, { action, counter }); toast('Done.'); load(); } catch (e) { toast(e.message, 'error'); } };
  const counter = (o) => {
    const v = window.prompt(`Counter-offer per item (${currency.code}). Between ${money(o.amountMinor)} and ${money(o.listPriceMinor)}:`);
    if (v) respond(o.id, 'counter', Number(v));
  };
  return (
    <div className="container page">
      <h1>Offers received</h1>
      <Alert>{error}</Alert>
      {!offers ? <Spinner /> : offers.length === 0 ? <Empty title="No offers yet">When a buyer proposes a price, it shows up here and you have 48 hours to reply.</Empty> : offers.map((o) => (
        <div className="order" key={o.id}>
          <div className="row between"><div><Link to={`/listing/${o.listingId}`}><b>{o.title}</b></Link> <span className="muted small">× {o.qty}</span><div className="muted small">{o.buyerName} offers {money(o.amountMinor)} each · listed {money(o.listPriceMinor)}</div></div><Pill status={o.status} /></div>
          {o.message && <p className="muted" style={{ margin: '6px 0' }}>“{o.message}”</p>}
          {o.status === 'pending' && <div className="row" style={{ marginTop: 8 }}>
            <button className="btn btn-accent btn-sm" onClick={() => respond(o.id, 'accept')}>Accept {money(o.amountMinor)}</button>
            <button className="btn btn-ghost btn-sm" onClick={() => counter(o)}>Counter</button>
            <button className="btn btn-ghost btn-sm" onClick={() => respond(o.id, 'decline')}>Decline</button>
            <span className="muted small">{left(o.expiresAt)}</span>
          </div>}
        </div>
      ))}
    </div>
  );
}

export function Wishlist() {
  const [items, setItems] = useState(null);
  useEffect(() => { api.get('/wishlist').then((d) => setItems(d.listings)).catch(() => setItems([])); }, []);
  const { ListingCard } = require_shop();
  return (
    <div className="container page">
      <h1>Saved items</h1>
      {!items ? <Spinner /> : items.length === 0 ? <Empty title="Nothing saved yet">Tap the heart on any listing to keep it here. <Link to="/browse">Browse</Link></Empty> : <div className="grid grid-listings">{items.map((l) => <ListingCard key={l.id} l={l} />)}</div>}
    </div>
  );
}
// ListingCard lives in Shop.jsx, which imports this file; resolve it lazily to avoid a circular import at load time.
let shopModule;
export const registerShop = (m) => { shopModule = m; };
const require_shop = () => shopModule;
