import React, { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, setToken } from '../api';
import { useAuth, useConfig, useToast } from '../context';
import { Alert, Field, Spinner } from '../components/ui';

function useForm(initial) {
  const [values, setValues] = useState(initial);
  const [error, setError] = useState('');
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);
  const bind = (k) => ({ value: values[k], onChange: (e) => setValues({ ...values, [k]: e.target.value }) });
  const run = async (fn) => {
    setBusy(true); setError(''); setFields({});
    try { return await fn(); } catch (e) { setError(e.message); setFields(e.fields || {}); } finally { setBusy(false); }
  };
  return { values, setValues, bind, error, fields, busy, run };
}

export function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const f = useForm({ email: '', password: '' });
  const submit = (e) => { e.preventDefault(); f.run(async () => { await login(f.values.email, f.values.password); nav(loc.state?.from || '/', { replace: true }); }); };
  return (
    <div className="container"><form className="card auth-box" onSubmit={submit}>
      <h2>Welcome back</h2>
      <Alert>{f.error}</Alert>
      <Field label="Email"><input type="email" autoComplete="email" required {...f.bind('email')} /></Field>
      <Field label="Password"><input type="password" autoComplete="current-password" required {...f.bind('password')} /></Field>
      <button className="btn btn-primary btn-block" disabled={f.busy}>{f.busy ? 'Logging in…' : 'Log in'}</button>
      <p className="small" style={{ marginTop: 14 }}><Link to="/forgot-password">Forgot your password?</Link> · <Link to="/register">Create an account</Link></p>
    </form></div>
  );
}

export function Register() {
  const { register } = useAuth();
  const { brand } = useConfig();
  const nav = useNavigate();
  const toast = useToast();
  const f = useForm({ name: '', email: '', password: '', role: 'buyer', tag: '', phone: '' });
  const submit = (e) => {
    e.preventDefault();
    f.run(async () => {
      const { tag, phone, ...rest } = f.values;
      await register({ ...rest, ...(tag ? { tag } : {}), ...(phone ? { phone } : {}) });
      toast('Account created. Check your email to confirm your address.');
      nav(f.values.role === 'seller' ? '/seller/listings' : '/', { replace: true });
    });
  };
  return (
    <div className="container"><form className="card auth-box" onSubmit={submit}>
      <h2>Join {brand.name}</h2>
      <Alert>{f.error}</Alert>
      <div className="row" style={{ marginBottom: 14 }}>
        {[['buyer', 'I want to buy'], ['seller', 'I want to sell']].map(([k, label]) => (
          <button type="button" key={k} className={`chip ${f.values.role === k ? 'on' : ''}`} onClick={() => f.setValues({ ...f.values, role: k })}>{label}</button>
        ))}
      </div>
      <Field label="Full name" error={f.fields.name}><input required autoComplete="name" {...f.bind('name')} /></Field>
      <Field label="Email" error={f.fields.email}><input type="email" required autoComplete="email" {...f.bind('email')} /></Field>
      <Field label="Password" error={f.fields.password} hint="At least 8 characters."><input type="password" required autoComplete="new-password" {...f.bind('password')} /></Field>
      <Field label="Phone (optional)" error={f.fields.phone}><input inputMode="tel" autoComplete="tel" {...f.bind('phone')} /></Field>
      {f.values.role === 'seller' && <Field label="Short bio (shown on your listings)" error={f.fields.tag}><input placeholder="e.g. Licensed real estate agent" {...f.bind('tag')} /></Field>}
      <p className="muted small">By creating an account you agree to the <Link to="/terms">Terms</Link> and <Link to="/privacy">Privacy Policy</Link>.</p>
      <button className="btn btn-primary btn-block" disabled={f.busy}>{f.busy ? 'Creating…' : 'Create account'}</button>
      <p className="small" style={{ marginTop: 14 }}>Already have an account? <Link to="/login">Log in</Link></p>
    </form></div>
  );
}

export function Forgot() {
  const f = useForm({ email: '' });
  const [sent, setSent] = useState(false);
  const submit = (e) => { e.preventDefault(); f.run(async () => { await api.post('/auth/forgot-password', f.values); setSent(true); }); };
  return (
    <div className="container"><form className="card auth-box" onSubmit={submit}>
      <h2>Reset your password</h2>
      {sent ? <Alert kind="ok">If an account exists for that email, we've sent a reset link. It works for one hour.</Alert> : <>
        <Alert>{f.error}</Alert>
        <Field label="Email"><input type="email" required {...f.bind('email')} /></Field>
        <button className="btn btn-primary btn-block" disabled={f.busy}>Send reset link</button></>}
      <p className="small" style={{ marginTop: 14 }}><Link to="/login">Back to log in</Link></p>
    </form></div>
  );
}

export function Reset() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const f = useForm({ password: '' });
  const submit = (e) => { e.preventDefault(); f.run(async () => { await api.post('/auth/reset-password', { token: sp.get('token') || '', password: f.values.password }); toast('Password updated. Please log in.'); nav('/login'); }); };
  return (
    <div className="container"><form className="card auth-box" onSubmit={submit}>
      <h2>Choose a new password</h2>
      <Alert>{f.error}</Alert>
      <Field label="New password" error={f.fields.password} hint="At least 8 characters."><input type="password" required autoComplete="new-password" {...f.bind('password')} /></Field>
      <button className="btn btn-primary btn-block" disabled={f.busy}>Update password</button>
    </form></div>
  );
}

export function VerifyEmail() {
  const [sp] = useSearchParams();
  const { user, refresh } = useAuth();
  const [state, setState] = useState({ loading: true, error: '' });
  useEffect(() => {
    api.post('/auth/verify-email', { token: sp.get('token') || '' })
      .then(() => { setState({ loading: false, error: '' }); if (user) refresh(); })
      .catch((e) => setState({ loading: false, error: e.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (state.loading) return <Spinner />;
  return (
    <div className="container"><div className="card auth-box stack">
      {state.error ? <Alert>{state.error}</Alert> : <><h2>Email confirmed ✓</h2><p>Thanks! You can now buy, sell and message.</p></>}
      <Link to="/" className="btn btn-primary">Continue</Link>
    </div></div>
  );
}

function BlockedUsers() {
  const toast = useToast();
  const [list, setList] = useState(null);
  const load = () => api.get('/blocks').then((d) => setList(d.blocked)).catch(() => setList([]));
  useEffect(() => { load(); }, []);
  if (!list || list.length === 0) return null;
  return (
    <div className="card">
      <h2>Blocked users</h2>
      {list.map((u) => (
        <div className="row between" key={u.id} style={{ padding: '6px 0' }}>
          <span>{u.name}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => api.del(`/blocks/${u.id}`).then(() => { toast('Unblocked.'); load(); }).catch((e) => toast(e.message, 'error'))}>Unblock</button>
        </div>
      ))}
    </div>
  );
}

function DeleteAccount() {
  const { logout } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const f = useForm({ password: '' });
  const submit = (e) => {
    e.preventDefault();
    f.run(async () => {
      await api.request('DELETE', '/account', { password: f.values.password });
      toast('Your account has been deleted.');
      logout();
    });
  };
  return (
    <div className="card">
      <h2>Delete my account</h2>
      {!open ? (
        <>
          <p className="muted">This permanently removes your profile and listings. You can't undo it. Orders in progress and any money in your wallet must be settled first.</p>
          <button className="btn btn-danger" onClick={() => setOpen(true)}>Delete my account…</button>
        </>
      ) : (
        <form onSubmit={submit}>
          <Alert>{f.error}</Alert>
          <Field label="Enter your password to confirm"><input type="password" autoComplete="current-password" required {...f.bind('password')} /></Field>
          <div className="row"><button className="btn btn-danger" disabled={f.busy}>Yes, delete everything</button><button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button></div>
        </form>
      )}
    </div>
  );
}

export function Account() {
  const { user, setUser } = useAuth();
  const { payoutMethods } = useConfig();
  const toast = useToast();
  const seller = user.role !== 'buyer';
  const p = useForm({ name: user.name, tag: user.tag || '', phone: user.phone || '', payoutMethod: user.payoutMethod || '', payoutDetails: user.payoutDetails || '' });
  const pw = useForm({ currentPassword: '', newPassword: '' });

  const save = (e) => {
    e.preventDefault();
    p.run(async () => {
      const body = { name: p.values.name, tag: p.values.tag, phone: p.values.phone };
      if (seller && p.values.payoutMethod) { body.payoutMethod = p.values.payoutMethod; body.payoutDetails = p.values.payoutDetails; }
      const d = await api.patch('/account/profile', body);
      setUser(d.user); toast('Profile saved.');
    });
  };
  const changePw = (e) => {
    e.preventDefault();
    pw.run(async () => {
      const d = await api.post('/auth/change-password', pw.values);
      setToken(d.token); setUser(d.user); pw.setValues({ currentPassword: '', newPassword: '' }); toast('Password changed.');
    });
  };
  return (
    <div className="container page"><div className="grid grid-2">
      <form className="card" onSubmit={save}>
        <h2>Your profile</h2>
        <Alert>{p.error}</Alert>
        <p className="muted small">{user.email} · {user.role}</p>
        <Field label="Name" error={p.fields.name}><input {...p.bind('name')} /></Field>
        <Field label="Phone" error={p.fields.phone}><input {...p.bind('phone')} /></Field>
        {seller && <>
          <Field label="Seller bio" error={p.fields.tag}><input {...p.bind('tag')} /></Field>
          <h3>Where should we send your earnings?</h3>
          <Field label="Payout method"><select {...p.bind('payoutMethod')}><option value="">Choose…</option>{payoutMethods.map((m) => <option key={m}>{m}</option>)}</select></Field>
          <Field label="Number / account / email" error={p.fields.payoutDetails} hint="Mobile money number, bank account details or PayPal email."><input {...p.bind('payoutDetails')} /></Field>
        </>}
        <button className="btn btn-primary" disabled={p.busy}>Save changes</button>
      </form>
      <form className="card" onSubmit={changePw}>
        <h2>Change password</h2>
        <Alert>{pw.error}</Alert>
        <Field label="Current password"><input type="password" autoComplete="current-password" required {...pw.bind('currentPassword')} /></Field>
        <Field label="New password" error={pw.fields.newPassword}><input type="password" autoComplete="new-password" required {...pw.bind('newPassword')} /></Field>
        <button className="btn btn-primary" disabled={pw.busy}>Update password</button>
      </form>
      <BlockedUsers />
      <DeleteAccount />
    </div></div>
  );
}
