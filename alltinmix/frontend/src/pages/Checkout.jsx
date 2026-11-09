import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Trash2 } from 'lucide-react';
import { api, assetUrl } from '../api';
import { useAuth, useCart, useConfig, useTheme, useToast } from '../context';
import { openPayment } from '../native';
import { Alert, Empty, Field, Receipt, Spinner } from '../components/ui';

export function Cart() {
  const { items, setQty, remove, clear } = useCart();
  const toast = useToast();
  const { lowData } = useTheme();
  const { formatIn, convert, currencies, rates, baseCode, displayCurrency, paymentMethods, brand, delivery: deliveryCfg } = useConfig();
  const { user } = useAuth();
  const nav = useNavigate();
  // The buyer picks the currency to pay in; only payment methods that accept that currency are listed.
  const available = [...new Set(paymentMethods.flatMap((m) => m.currencies))];
  const payOptions = currencies.filter((c) => available.includes(c.code));
  const [payCode, setPayCode] = useState(payOptions.find((c) => c.code === displayCurrency.code)?.code || payOptions[0]?.code || baseCode);
  const physical = items.filter((i) => i.listing.fulfillment === 'physical');
  const allPhysical = items.length > 0 && physical.length === items.length;
  const zones = deliveryCfg?.zones || [];
  const [dv, setDv] = useState({ method: 'ship', zone: '', name: user?.name || '', phone: user?.phone || '', address: '', note: '' });
  const setD = (k) => (e) => setDv((d) => ({ ...d, [k]: e.target.value }));
  const sellerCount = new Set(physical.map((i) => i.listing.sellerId || i.listing.sellerName)).size;
  const zone = zones.find((z) => z.name === dv.zone);
  const feeBase = physical.length && dv.method === 'ship' && zone ? zone.feeMinor * sellerCount : 0;
  // Cash on delivery only makes sense when everything in the cart is a physical item.
  const methods = paymentMethods.filter((m) => m.currencies.includes(payCode) && (m.kind !== 'cod' || allPhysical));
  const [method, setMethod] = useState(methods[0]?.key || '');
  useEffect(() => { if (!methods.some((m) => m.key === method)) setMethod(methods[0]?.key || ''); }, [payCode]); // eslint-disable-line react-hooks/exhaustive-deps
  const pay = (baseMinor) => formatIn(convert(baseMinor, payCode), payCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [coupon, setCoupon] = useState('');

  const total = items.reduce((s, i) => s + i.listing.priceMinor * i.qty, 0) + feeBase;

  const checkout = async () => {
    setBusy(true); setError('');
    try {
      const body = { items: items.map((i) => ({ listingId: i.listingId, qty: i.qty, ...(i.offerId ? { offerId: i.offerId } : {}) })), method, currency: payCode, ...(coupon.trim() ? { couponCode: coupon.trim() } : {}) };
      if (physical.length) body.delivery = dv.method === 'pickup' ? { method: 'pickup', name: dv.name, phone: dv.phone, note: dv.note } : { ...dv, zone: dv.zone || undefined };
      const d = await api.post('/orders/checkout', body);
      clear();
      if (d.kind === 'cod') { toast('Order placed. Pay in cash when it arrives.'); nav('/orders'); return; }
      if (/^https?:\/\//.test(d.redirectUrl)) { // card / PayPal hosted page (an in-app browser inside the phone app)
        await openPayment(d.redirectUrl, () => nav(`/pay/return/${d.paymentId}`));
        setBusy(false);
      }
      else nav(new URL(d.redirectUrl, window.location.origin).pathname); // our own pages (manual / mock)
    } catch (e) {
      setError(e.message);
      if (e.code === 'EMAIL_NOT_VERIFIED') setError('Please confirm your email address first. Check your inbox for the link.');
      setBusy(false);
    }
  };

  if (items.length === 0) return <div className="container page"><Empty title="Your cart is empty"><Link to="/browse">Find something you like</Link></Empty></div>;
  return (
    <div className="container page">
      <h1>Your cart</h1>
      <div className="detail" style={{ gridTemplateColumns: '1.4fr 1fr' }}>
        <div className="card">
          {items.map(({ listingId, qty, listing }) => {
            const single = listing.type === 'service' || listing.fulfillment === 'digital' || !!listing.offerId;
            return (
              <div className="cart-line" key={listingId}>
                {listing.image && !lowData ? <img src={assetUrl(listing.image)} alt="" /> : <div className="ph" />}
                <div><Link to={`/listing/${listingId}`}><b>{listing.title}</b></Link><div className="muted small">{listing.sellerName} · {pay(listing.priceMinor)} each{listing.offerId && <span className="pill pill-green" style={{ marginLeft: 6 }}>Agreed price × {qty}</span>}</div>
                  {!single && <div className="qty" style={{ marginTop: 6 }}><button onClick={() => setQty(listingId, qty - 1)} aria-label="Less">−</button><span>{qty}</span><button onClick={() => setQty(listingId, qty + 1)} aria-label="More">+</button></div>}
                </div>
                <div className="right"><b>{pay(listing.priceMinor * qty)}</b><br /><button className="link-btn small" onClick={() => remove(listingId)} aria-label="Remove"><Trash2 size={14} /></button></div>
              </div>
            );
          })}
        </div>
        <div className="card stack">
          <Receipt rows={[['Items', pay(total - feeBase)], ...(physical.length ? [['Delivery', dv.method === 'pickup' ? 'Free (pickup)' : zone ? pay(feeBase) : 'Arranged with seller']] : []), ['Buyer fees', pay(0), true]]} total={['Total', pay(total)]} />
          {!user ? <Link className="btn btn-accent btn-block" to="/login" state={{ from: '/cart' }}>Log in to check out</Link> : (
            <>
              {physical.length > 0 && (
                <div className="stack">
                  <h3>How do you want to get it?</h3>
                  <div className="chips">
                    <button type="button" className={`chip ${dv.method === 'ship' ? 'on' : ''}`} onClick={() => setDv({ ...dv, method: 'ship' })}>Delivery</button>
                    <button type="button" className={`chip ${dv.method === 'pickup' ? 'on' : ''}`} onClick={() => setDv({ ...dv, method: 'pickup' })}>Pickup</button>
                  </div>
                  <Field label="Your name"><input value={dv.name} onChange={setD('name')} autoComplete="name" /></Field>
                  <Field label="Phone number the seller can call"><input value={dv.phone} onChange={setD('phone')} inputMode="tel" autoComplete="tel" placeholder="+232 …" /></Field>
                  {dv.method === 'ship' ? (
                    <>
                      {zones.length > 0 && <Field label="Delivery area"><select value={dv.zone} onChange={setD('zone')}><option value="">Choose your area…</option>{zones.map((z) => <option key={z.name} value={z.name}>{z.name} ({formatIn(convert(z.feeMinor, payCode), payCode)})</option>)}</select></Field>}
                      <Field label="Address"><textarea value={dv.address} onChange={setD('address')} placeholder="Street, landmark, house number" /></Field>
                      {sellerCount > 1 && zones.length > 0 && <p className="muted small">Your cart has items from {sellerCount} sellers, so the delivery fee is charged once per seller.</p>}
                    </>
                  ) : <p className="muted small">You collect it from the seller. They will contact you with the exact place and time{physical.length === 1 && physical[0].listing.location ? ` (listed location: ${physical[0].listing.location})` : ''}.</p>}
                  <Field label="Note for the seller (optional)"><input value={dv.note} onChange={setD('note')} maxLength={300} /></Field>
                </div>
              )}
              <div>
                {payOptions.length > 1 && (
                  <div style={{ marginBottom: 14 }}>
                    <h3>Pay in</h3>
                    <div className="chips">{payOptions.map((c) => <button key={c.code} type="button" className={`chip ${payCode === c.code ? 'on' : ''}`} onClick={() => setPayCode(c.code)}>{c.symbol} {c.code}</button>)}</div>
                    {payCode !== baseCode && <p className="muted small" style={{ marginTop: 8 }}>Prices are set in {baseCode}. You will be charged in {payCode} at today's rate: 1 {payCode} = {currencies.find((c) => c.code === baseCode).symbol} {rates[payCode]}.</p>}
                  </div>
                )}
                <h3>Pay with</h3>
                {methods.length === 0 && <Alert>No payment methods are set up yet. Please contact the marketplace owner.</Alert>}
                {methods.map((m) => (
                  <label key={m.key} className={`method ${method === m.key ? 'on' : ''}`}>
                    <input type="radio" name="method" checked={method === m.key} onChange={() => setMethod(m.key)} />
                    <span><b>{m.label}</b>{m.kind === 'manual' && <span className="muted small"><br />Send from your phone, then enter the transaction ID</span>}{m.kind === 'cod' && <span className="muted small"><br />Pay the seller in cash when you receive it</span>}</span>
                  </label>
                ))}
              </div>
              <Field label="Coupon code (optional)" hint="The discount is worked out when you pay."><input value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} maxLength={20} /></Field>
              <Alert>{error}</Alert>
              <button className="btn btn-accent btn-block" disabled={busy || !method} onClick={checkout}>{busy ? 'Please wait…' : methods.find((m) => m.key === method)?.kind === 'cod' ? `Place order · ${pay(total)} on delivery` : `Pay ${pay(total)}`}</button>
              <p className="muted small">{methods.find((m) => m.key === method)?.kind === 'cod' ? 'Pay in cash only when you have the item in your hands.' : `Your money is held by ${brand.name} and only released to the seller once you confirm everything is as described.`}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Where the buyer lands after paying on Stripe / Flutterwave / PayPal. We ask the server to confirm and then wait for the result. */
export function PayReturn() {
  const { id } = useParams();
  const { user, ready } = useAuth();
  const [payment, setPayment] = useState(null);
  const [error, setError] = useState('');
  const tries = useRef(0);

  const check = useCallback(async () => {
    if (!user) return 'anonymous';
    try {
      const d = await api.post(`/payments/${id}/verify`);
      setPayment(d.payment);
      return d.payment.status;
    } catch (e) { setError(e.message); return 'error'; }
  }, [id, user]);

  useEffect(() => {
    let timer;
    const loop = async () => {
      const s = await check();
      // Card payments can take a few seconds to be confirmed; keep checking for about a minute.
      if (['pending', 'awaiting_confirmation'].includes(s) && tries.current++ < 20) timer = setTimeout(loop, 3000);
    };
    loop();
    return () => clearTimeout(timer);
  }, [check]);

  // The payment provider sends the buyer to this address. Inside the phone app's payment window nobody is signed in,
  // so we just ask them to close it; the app confirms the payment itself.
  if (ready && !user) return <div className="container page"><div className="card auth-box stack" style={{ textAlign: 'center' }}><h2>Almost done</h2><p>If you paid in the app, close this window to go back. Otherwise log in to see your order.</p><Link to="/login" state={{ from: `/pay/return/${id}` }} className="btn btn-primary">Log in</Link></div></div>;
  if (error) return <div className="container page"><div className="card auth-box"><Alert>{error}</Alert><Link to="/orders" className="btn btn-primary">View my orders</Link></div></div>;
  if (!payment) return <Spinner />;
  const paid = payment.status === 'paid';
  const failed = ['failed', 'refunded'].includes(payment.status);
  return (
    <div className="container page"><div className="card auth-box stack" style={{ textAlign: 'center' }}>
      {paid ? <><h2>Payment received 🎉</h2><p>Your money is held safely until you confirm delivery.</p><Link to="/orders" className="btn btn-accent">Go to my orders</Link></>
        : failed ? <><h2>Payment didn't go through</h2><p className="muted">{payment.failureReason || 'You have not been charged.'}</p><Link to="/cart" className="btn btn-primary">Back to cart</Link></>
          : <><Spinner /><h3>Confirming your payment…</h3><p className="muted">This usually takes a few seconds. You can safely wait here.</p></>}
    </div></div>
  );
}

/** Orange Money / Afrimoney / QMoney: the buyer sends money to the merchant number, then submits the transaction ID. */
export function PayManual() {
  const { id } = useParams();
  const { formatIn } = useConfig();
  const toast = useToast();
  const [p, setP] = useState(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ senderPhone: '', transactionId: '' });
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.get(`/payments/${id}`).then((d) => setP(d.payment)).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { // pick up the admin's confirmation without a refresh
    if (p?.status !== 'awaiting_confirmation') return;
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [p?.status, load]);

  if (error) return <div className="container page"><Alert>{error}</Alert></div>;
  if (!p) return <Spinner />;

  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError(''); setFields({});
    try { await api.post(`/payments/${id}/manual-proof`, form); toast('Thanks! We are checking your payment.'); await load(); }
    catch (err) { setError(err.message); setFields(err.fields); } finally { setBusy(false); }
  };

  return (
    <div className="container page"><div className="card auth-box stack" style={{ width: 'min(560px,100%)' }}>
      <h2>{p.methodLabel}</h2>
      {p.status === 'paid' && <><Alert kind="ok">Payment confirmed. Thank you!</Alert><Link to="/orders" className="btn btn-accent">Go to my orders</Link></>}
      {p.status === 'failed' && <><Alert>{p.failureReason || 'This payment was cancelled or declined.'}</Alert><Link to="/cart" className="btn btn-primary">Back to cart</Link></>}
      {['pending', 'awaiting_confirmation'].includes(p.status) && p.manual && (
        <>
          <ol style={{ paddingLeft: 20 }} className="stack">
            <li>Open {p.methodLabel} on your phone and send <b>{formatIn(p.amountMinor, p.currency)}</b> to:
              <div className="receipt" style={{ marginTop: 8 }}>
                <div className="receipt-row"><span>Number</span><b>{p.manual.number}</b></div>
                {p.manual.accountName && <div className="receipt-row"><span>Name</span><b>{p.manual.accountName}</b></div>}
                <div className="receipt-row"><span>Reference / note</span><b>{p.manual.reference}</b></div>
              </div></li>
            <li>Put the reference above in the payment note so we can match it.</li>
            <li>Enter the transaction ID from your confirmation SMS below.</li>
          </ol>
          {p.status === 'awaiting_confirmation' ? (
            <Alert kind="info">We received your details (transaction {p.manual.proof?.transactionId}). We'll confirm the payment shortly and you'll get a notification. This page updates automatically.</Alert>
          ) : (
            <form onSubmit={submit}>
              <Alert>{error}</Alert>
              <Field label="Phone number you paid from" error={fields.senderPhone}><input value={form.senderPhone} onChange={(e) => setForm({ ...form, senderPhone: e.target.value })} inputMode="tel" placeholder="+232 …" /></Field>
              <Field label="Transaction ID" error={fields.transactionId}><input value={form.transactionId} onChange={(e) => setForm({ ...form, transactionId: e.target.value })} /></Field>
              <button className="btn btn-accent btn-block" disabled={busy}>{busy ? 'Submitting…' : "I've paid"}</button>
            </form>
          )}
        </>
      )}
    </div></div>
  );
}

/** Development-only "payment" page, hidden in production unless explicitly allowed. */
export function PayMock() {
  const { id } = useParams();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pay = async () => {
    setBusy(true);
    try { await api.post(`/payments/${id}/mock-confirm`); nav(`/pay/return/${id}`); } catch (e) { setError(e.message); setBusy(false); }
  };
  return (
    <div className="container page"><div className="card auth-box stack">
      <h2>Test payment</h2><p className="muted">This is a simulated checkout. No real money moves.</p>
      <Alert>{error}</Alert>
      <button className="btn btn-accent" onClick={pay} disabled={busy}>Simulate successful payment</button>
      <Link to="/cart" className="btn btn-ghost">Cancel</Link>
    </div></div>
  );
}
