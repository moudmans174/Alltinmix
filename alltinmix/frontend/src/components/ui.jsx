import React, { useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ImageOff, ShieldCheck } from 'lucide-react';
import { useAuth, useConfig, useTheme } from '../context';
import { assetUrl } from '../api';

export const Spinner = () => <div className="spinner" aria-label="Loading" />;

export function Empty({ title, children }) {
  return <div className="empty"><h3>{title}</h3>{children && <p className="muted">{children}</p>}</div>;
}

export const Money = ({ minor }) => <>{useConfig().formatMoney(minor)}</>;

export function Field({ label, error, hint, children }) {
  return (
    <label className={`field ${error ? 'has-error' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export function Alert({ kind = 'error', children }) {
  if (!children) return null;
  return <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}

const STATUS = {
  pending_acceptance: ['Waiting for seller', 'amber'],
  in_progress: ['In progress', 'blue'],
  delivered: ['Delivered, please confirm', 'purple'],
  completed: ['Completed', 'green'],
  disputed: ['In dispute', 'red'],
  refunded: ['Refunded', 'grey'],
  cancelled: ['Cancelled', 'grey'],
  awaiting_payment: ['Awaiting payment', 'amber'],
  awaiting_confirmation: ['Checking payment', 'amber'],
  paid: ['Paid', 'green'],
  failed: ['Failed', 'red'],
  active: ['Active', 'green'],
  paused: ['Paused', 'grey'],
  sold: ['Sold', 'blue'],
  hidden: ['Hidden by moderator', 'red'],
  requested: ['Requested', 'amber'],
  rejected: ['Declined', 'red'],
  suspended: ['Suspended', 'red'],
};
export function StatusPill({ status }) {
  const [label, color] = STATUS[status] || [status, 'grey'];
  return <span className={`pill pill-${color}`}>{label}</span>;
}

export function Pagination({ page, pages, onChange }) {
  if (pages <= 1) return null;
  return (
    <nav className="pagination" aria-label="Pages">
      <button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => onChange(page - 1)}><ChevronLeft size={15} /> Previous</button>
      <span className="muted">Page {page} of {pages}</span>
      <button className="btn btn-ghost btn-sm" disabled={page >= pages} onClick={() => onChange(page + 1)}>Next <ChevronRight size={15} /></button>
    </nav>
  );
}

/** Wraps pages that need a logged-in user (and optionally a role). */
export function Protected({ roles, children }) {
  const { user, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <Spinner />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return children;
}

export function ImageGallery({ images, alt }) {
  const [i, setI] = useState(0);
  const [show, setShow] = useState(false);
  const { lowData } = useTheme();
  if (!images?.length) return <div className="gallery-empty"><ImageOff size={36} /><span>No photos yet</span></div>;
  if (lowData && !show) return <div className="gallery-empty"><ImageOff size={36} /><span>Low-data mode: {images.length} photo{images.length > 1 ? 's' : ''} hidden</span><button className="btn btn-ghost btn-sm" onClick={() => setShow(true)}>Show photos</button></div>;
  return (
    <div className="gallery">
      <img className="gallery-main" src={assetUrl(images[i])} alt={alt} />
      {images.length > 1 && (
        <div className="gallery-thumbs">
          {images.map((src, n) => <button key={src} className={n === i ? 'active' : ''} onClick={() => setI(n)} aria-label={`Photo ${n + 1}`}><img src={assetUrl(src)} alt="" /></button>)}
        </div>
      )}
    </div>
  );
}

/** Ledger-style breakdown, used for the cart total and for what a seller will receive. */
export function Receipt({ rows, total }) {
  return (
    <div className="receipt">
      <div className="receipt-body">
        {rows.map(([label, value, dim]) => <div key={label} className={`receipt-row ${dim ? 'dim' : ''}`}><span>{label}</span><span>{value}</span></div>)}
        {total && <><div className="receipt-rule" /><div className="receipt-row total"><span>{total[0]}</span><span>{total[1]}</span></div></>}
      </div>
    </div>
  );
}

export function Stars({ value, onChange, size = 18 }) {
  return (
    <span className="stars" role={onChange ? 'radiogroup' : 'img'} aria-label={`${value} out of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" disabled={!onChange} onClick={() => onChange?.(n)} className={n <= Math.round(value) ? 'on' : ''} style={{ fontSize: size }} aria-label={`${n} star`}>★</button>
      ))}
    </span>
  );
}

export function ErrorFields(err) {
  return err?.fields || {};
}

/** Short one-line summary of a listing's custom attributes, e.g. "4 bd · 3 ba · 320 m²". */
export function attributeSummary(listing, vertical, max = 4) {
  if (!vertical) return '';
  return vertical.fields
    .filter((f) => listing.attributes?.[f.key] !== undefined)
    .slice(0, max)
    .map((f) => {
      const v = listing.attributes[f.key];
      return f.type === 'number' && f.key !== 'year' ? `${Number(v).toLocaleString()}${f.suffix || ''}` : `${v}${f.suffix || ''}`;
    })
    .join(' · ');
}

export const LinkButton = ({ to, children, ...rest }) => <Link to={to} className="btn btn-primary" {...rest}>{children}</Link>;

/** Small green tick shown next to sellers whose ID was checked by the marketplace. */
export function VerifiedBadge({ label = true }) {
  return <span className="verified-badge" title="This seller's ID was checked by us"><ShieldCheck size={14} />{label && ' Verified'}</span>;
}
