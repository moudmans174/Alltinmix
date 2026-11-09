import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Clock, MessageCircle, ShieldCheck, Star } from 'lucide-react';
import { api } from '../api';
import { Empty, Spinner, VerifiedBadge } from '../components/ui';
import { ListingCard } from './Shop';
import { Flag } from 'lucide-react';
import { ReportModal } from '../components/Report';

export function Store() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [reporting, setReporting] = useState(false);
  useEffect(() => { setData(null); api.get(`/sellers/${id}`).then(setData).catch((e) => setError(e.message)); }, [id]);
  if (error) return <div className="container page"><Empty title="Seller not found">{error}</Empty></div>;
  if (!data) return <div className="container page"><Spinner /></div>;
  const s = data.seller;
  const since = new Date(s.memberSince).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  return (
    <div className="container page">
      <div className="card stack">
        <div className="row between" style={{ alignItems: 'flex-start' }}>
          <div>
            <h1 style={{ margin: 0 }}>{s.name} {s.verified && <VerifiedBadge />}</h1>
            <p className="muted small" style={{ margin: '4px 0 0' }}>{s.tag ? `${s.tag} · ` : ''}Selling here since {since}</p>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => setReporting(true)}><Flag size={14} /> Report</button>
        </div>
        <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
          <span className="row" style={{ gap: 5 }}><Star size={15} fill="#f59e0b" stroke="#f59e0b" /> {s.reviewCount ? `${s.ratingAvg.toFixed(1)} (${s.reviewCount} reviews)` : 'No reviews yet'}</span>
          <span>{s.salesCount} completed {s.salesCount === 1 ? 'sale' : 'sales'}</span>
          <span className="row" style={{ gap: 5 }}><Clock size={15} /> {s.avgResponseMinutes ? `Replies in about ${s.avgResponseMinutes < 60 ? `${s.avgResponseMinutes} min` : s.avgResponseMinutes < 1440 ? `${Math.round(s.avgResponseMinutes / 60)} h` : `${Math.round(s.avgResponseMinutes / 1440)} days`}` : 'New to messaging'}</span>
        </div>
        <p className="muted small row" style={{ margin: 0, gap: 6 }}><ShieldCheck size={14} /> Every payment is protected. <Link to="/protection">How buyer protection works</Link></p>
      </div>
      {reporting && <ReportModal targetType="user" targetId={s.id} onClose={() => setReporting(false)} />}
      <h2>Listings ({s.listingCount})</h2>
      {data.listings.length === 0 ? <Empty title="No active listings">Check back soon.</Empty> : <div className="grid grid-listings">{data.listings.map((l) => <ListingCard key={l.id} l={l} />)}</div>}
    </div>
  );
}

export function Protection() {
  return (
    <div className="container page" style={{ maxWidth: 760 }}>
      <h1 className="row" style={{ gap: 8 }}><ShieldCheck /> Buyer protection</h1>
      <div className="card stack">
        <h3>Your money is held safe</h3>
        <p>When you pay online, we hold the money. The seller only gets it after you confirm that you received what you ordered.</p>
        <h3>If something is wrong</h3>
        <p>Open a dispute from your order. Our team looks at both sides and can refund you in full or in part. You can also message the seller first from the listing.</p>
        <h3>Cash on delivery</h3>
        <p>With cash on delivery you only pay when the item is in your hands. Check it before you pay.</p>
        <h3>Verified sellers</h3>
        <p>A green <b>Verified</b> badge means we checked the seller's government ID. It does not replace reading reviews, but it makes scams much harder. You can show only verified sellers in Browse.</p>
        <h3>Stay safe</h3>
        <p>Keep payments and chat inside the app. Never send money to a seller outside the marketplace. Report anything suspicious using the Report button on any listing, seller or message.</p>
      </div>
    </div>
  );
}
