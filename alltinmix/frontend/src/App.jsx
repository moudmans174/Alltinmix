import React, { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Bell, Heart, Home as HomeIcon, Menu, MessageSquare, Moon, PlusCircle, Zap, Search, ShoppingCart, Sun, User, X } from 'lucide-react';
import { api } from './api';
import { useAuth, useCart, useConfig, useTheme, useToast } from './context';
import { Protected } from './components/ui';
import { Home, Browse, ListingDetail } from './pages/Shop';
import { Cart, PayReturn, PayManual, PayMock } from './pages/Checkout';
import { Login, Register, Forgot, Reset, VerifyEmail, Account } from './pages/Auth';
import { BuyerOrders, SellerOrders } from './pages/Orders';
import { Inbox, Thread } from './pages/Messages';
import { SellerListings, ListingForm, Earnings } from './pages/Seller';
import { Admin } from './pages/Admin';
import { Privacy, Terms } from './pages/Legal';
import { Store, Protection } from './pages/Store';
import { SellerGrowth } from './pages/Growth';
import { MyOffers, SellerOffers, Wishlist } from './pages/Buyer';
import { initNative, setStatusBar } from './native';

function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState({ unread: 0, notifications: [] });
  const nav = useNavigate();
  const ref = useRef();

  const load = () => api.get('/notifications').then(setData).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, []);
  useEffect(() => {
    const close = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const go = async (n) => {
    setOpen(false);
    if (!n.read) { await api.post(`/notifications/${n.id}/read`).catch(() => {}); load(); }
    if (n.link) nav(n.link);
  };
  return (
    <span ref={ref} style={{ position: 'relative' }}>
      <button className="nav-btn" aria-label="Notifications" onClick={() => { setOpen(!open); if (!open) load(); }}>
        <Bell size={18} />{data.unread > 0 && <span className="badge">{data.unread}</span>}
      </button>
      {open && (
        <div className="dropdown">
          <div className="dropdown-head">Notifications
            {data.unread > 0 && <button className="link-btn small" onClick={async () => { await api.post('/notifications/read-all'); load(); }}>Mark all read</button>}
          </div>
          <div className="notif-list">
            {data.notifications.length === 0 && <p className="muted" style={{ padding: 16 }}>You're all caught up.</p>}
            {data.notifications.map((n) => (
              <button key={n.id} className={`notif ${n.read ? '' : 'unread'}`} onClick={() => go(n)}><b>{n.title}</b><span>{n.body}</span></button>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}

function Header() {
  const { brand } = useConfig();
  const { user, logout } = useAuth();
  const { count } = useCart();
  const { theme, toggle, lowData, toggleLowData } = useTheme();
  const { currencies, displayCurrency, setDisplayCurrency } = useConfig();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const nav = useNavigate();
  const location = useLocation();
  useEffect(() => { setOpen(false); }, [location.pathname]);

  const submit = (e) => { e.preventDefault(); nav(`/browse${q ? `?q=${encodeURIComponent(q)}` : ''}`); };
  const seller = user && (user.role === 'seller' || user.role === 'admin');

  return (
    <header className={`header ${open ? 'open' : ''}`}>
      <div className="container">
        <Link to="/" className="brand">{brand.logoUrl ? <><img className={brand.logoPlate ? 'plate' : ''} src={brand.logoUrl} alt={brand.showName ? '' : brand.name} />{brand.showName && <span className="brand-name">{brand.name}</span>}</> : <><span className="dot" />{brand.name}</>}</Link>
        <form className="searchbar" onSubmit={submit} role="search">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search everything…" aria-label="Search" />
          <button aria-label="Search"><Search size={16} /></button>
        </form>
        <button className="menu-toggle" onClick={() => setOpen(!open)} aria-label="Menu">{open ? <X /> : <Menu />}</button>
        <nav className="nav">
          <NavLink to="/browse">Browse</NavLink>
          {user ? (
            <>
              <NavLink to="/orders">My orders</NavLink>
              <NavLink to="/offers">Offers</NavLink>
              <NavLink to="/wishlist" aria-label="Saved items"><Heart size={18} /></NavLink>
              {seller && <NavLink to="/seller/listings">Sell</NavLink>}
              {seller && <NavLink to="/seller/orders">Sales</NavLink>}
              {user.role === 'admin' && <NavLink to="/admin">Admin</NavLink>}
              <NavLink to="/messages" aria-label="Messages"><MessageSquare size={18} /></NavLink>
              <NotificationBell />
              <NavLink to="/account">{user.name.split(' ')[0]}</NavLink>
              <button className="nav-btn" onClick={logout}>Log out</button>
            </>
          ) : (
            <>
              <NavLink to="/login">Log in</NavLink>
              <Link to="/register" className="btn btn-accent btn-sm">Sign up</Link>
            </>
          )}
          {currencies.length > 1 && (
            <select className="currency-select" value={displayCurrency.code} onChange={(e) => setDisplayCurrency(e.target.value)} aria-label="Currency">
              {currencies.map((c) => <option key={c.code} value={c.code}>{c.symbol} {c.code}</option>)}
            </select>
          )}
          <button className={`theme-toggle ${lowData ? 'on' : ''}`} onClick={toggleLowData} aria-pressed={lowData} aria-label="Low-data mode" title={lowData ? 'Low-data mode is on: photos are hidden until you tap them' : 'Low-data mode: save mobile data'}><Zap size={18} /></button>
          <button className="theme-toggle" onClick={toggle} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} title={theme === 'dark' ? 'Light theme' : 'Dark theme'}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button>
          <NavLink to="/cart" aria-label="Cart"><ShoppingCart size={18} />{count > 0 && <span className="badge">{count}</span>}</NavLink>
        </nav>
      </div>
    </header>
  );
}

function VerifyBanner() {
  const { user } = useAuth();
  const { requireEmailVerification } = useConfig();
  const toast = useToast();
  const [sent, setSent] = useState(false);
  if (!user || user.emailVerified || !requireEmailVerification) return null;
  return (
    <div className="banner"><div className="container">
      <span>Please confirm your email address ({user.email}) to buy, sell or message.</span>
      <button className="link-btn" disabled={sent} onClick={() => api.post('/auth/resend-verification').then(() => { setSent(true); toast('Verification email sent.'); }).catch((e) => toast(e.message, 'error'))}>
        {sent ? 'Email sent' : 'Resend email'}
      </button>
    </div></div>
  );
}

function Footer() {
  const { brand } = useConfig();
  return (
    <footer className="footer"><div className="container row between">
      <span>© {new Date().getFullYear()} {brand.name}. Payments are held safely until you confirm delivery.</span>
      <span className="row"><Link to="/terms">Terms</Link><Link to="/privacy">Privacy</Link>{brand.supportEmail && <a href={`mailto:${brand.supportEmail}`}>{brand.supportEmail}</a>}</span>
    </div></footer>
  );
}

/** Bottom navigation, shown on phones (and in the mobile app) instead of the top menu. */
function TabBar() {
  const { user } = useAuth();
  const { count } = useCart();
  const seller = user && (user.role === 'seller' || user.role === 'admin');
  const tab = (to, icon, label, extra) => <NavLink to={to} end={to === '/'} className="tab">{icon}<span>{label}</span>{extra}</NavLink>;
  return (
    <nav className="tabbar" aria-label="Main">
      {tab('/', <HomeIcon size={22} />, 'Home')}
      {tab('/browse', <Search size={22} />, 'Browse')}
      {seller ? tab('/seller/listings', <PlusCircle size={22} />, 'Sell') : tab('/cart', <ShoppingCart size={22} />, 'Cart', count > 0 && <span className="badge">{count}</span>)}
      {tab(user ? '/messages' : '/login', <MessageSquare size={22} />, user ? 'Messages' : 'Log in')}
      {tab(user ? '/account' : '/register', <User size={22} />, user ? 'Account' : 'Sign up')}
    </nav>
  );
}

function NotFound() {
  return <div className="container page"><div className="empty"><h2>Page not found</h2><Link className="btn btn-primary" to="/">Go home</Link></div></div>;
}

export default function App() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { theme } = useTheme();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  useEffect(() => initNative(navigate), [navigate]);
  useEffect(() => { setStatusBar(theme); }, [theme]);
  const P = ({ children, roles }) => <Protected roles={roles}>{children}</Protected>;
  const seller = ['seller', 'admin'];
  return (
    <>
      <Header />
      <VerifyBanner />
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/browse" element={<Browse />} />
          <Route path="/listing/:id" element={<ListingDetail />} />
          <Route path="/cart" element={<Cart />} />
          <Route path="/pay/return/:id" element={<PayReturn />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/pay/manual/:id" element={<P><PayManual /></P>} />
          <Route path="/pay/mock/:id" element={<P><PayMock /></P>} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/forgot-password" element={<Forgot />} />
          <Route path="/reset-password" element={<Reset />} />
          <Route path="/verify-email" element={<VerifyEmail />} />
          <Route path="/account" element={<P><Account /></P>} />
          <Route path="/store/:id" element={<Store />} />
          <Route path="/protection" element={<Protection />} />
          <Route path="/seller/growth" element={<P roles={seller}><SellerGrowth /></P>} />
          <Route path="/wishlist" element={<P><Wishlist /></P>} />
          <Route path="/offers" element={<P><MyOffers /></P>} />
          <Route path="/seller/offers" element={<P roles={seller}><SellerOffers /></P>} />
          <Route path="/orders" element={<P><BuyerOrders /></P>} />
          <Route path="/seller/orders" element={<P roles={seller}><SellerOrders /></P>} />
          <Route path="/seller/listings" element={<P roles={seller}><SellerListings /></P>} />
          <Route path="/seller/listings/new" element={<P roles={seller}><ListingForm /></P>} />
          <Route path="/seller/listings/:id/edit" element={<P roles={seller}><ListingForm /></P>} />
          <Route path="/seller/earnings" element={<P roles={seller}><Earnings /></P>} />
          <Route path="/messages" element={<P><Inbox /></P>} />
          <Route path="/messages/:id" element={<P><Thread /></P>} />
          <Route path="/admin" element={<P roles={['admin']}><Admin /></P>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <Footer />
      <TabBar />
    </>
  );
}
