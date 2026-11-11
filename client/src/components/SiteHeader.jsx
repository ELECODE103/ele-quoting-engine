import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../utils/authContext';
import Wordmark from './Wordmark';
import brand from '../brand';

export const NAV = [
  { to: '/machining', label: 'Machining' },
  { to: '/routing', label: 'Routing' },
  { to: '/3d-printing', label: '3D Printing' },
  { to: '/materials', label: 'Materials' },
  { to: '/replacement-parts', label: 'Replacement parts' },
  { to: '/quality', label: 'Quality' },
  { to: '/about', label: 'About' },
];

/**
 * One header for every page: public pages, the quote builder, checkout,
 * orders and admin. Same links, same CTA, same mobile menu, so a buyer never
 * lands in a different-looking app when they click "Get an instant quote".
 */
export default function SiteHeader() {
  const navigate = useNavigate();
  const location = useLocation();
  const { isAuthenticated, user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const onQuote = location.pathname === '/quote';

  useEffect(() => { setOpen(false); }, [location.pathname]);

  return (
    <header style={{ borderBottom: '1px solid var(--border-subtle)', background: '#fff', position: 'sticky', top: 0, zIndex: 10 }}>
      <div className="util-bar">
        <div className="pub-wrap">
          <span className="util-where">Plastics machine shop · {brand.city}, Illinois</span>
          <span className="util-right">
            <a href={brand.phoneHref} className="util-phone">{brand.phone}</a>
            {isAuthenticated ? (
              <>
                <NavLink className="util-account" to={user?.role === 'admin' ? '/admin' : '/dashboard'}>{user?.role === 'admin' ? 'Admin' : 'My orders'}</NavLink>
                <button type="button" className="util-account util-btn" onClick={() => { logout(); navigate('/'); }}>Sign out</button>
              </>
            ) : (
              <NavLink className="util-account" to="/login">Sign in</NavLink>
            )}
          </span>
        </div>
      </div>
      <div className="pub-wrap">
        <nav className="pub-nav" aria-label="Main">
          <Wordmark size={27} />
          <div id="site-nav-links" className={`pub-nav-links${open ? ' open' : ''}`}>
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? 'active' : '')}>{n.label}</NavLink>
            ))}
            {isAuthenticated ? (
              <>
                <NavLink className="nav-account" to={user?.role === 'admin' ? '/admin' : '/dashboard'}>{user?.role === 'admin' ? 'Admin' : 'My orders'}</NavLink>
                <button type="button" className="linklike nav-account" onClick={() => { logout(); navigate('/'); }}>Sign out</button>
              </>
            ) : (
              <NavLink className="nav-account" to="/login">Sign in</NavLink>
            )}
            {onQuote ? (
              <NavLink to="/quote" className="active">Instant quote</NavLink>
            ) : (
              <Link className="btn btn-primary nav-cta" to="/quote">
                Get an instant quote
              </Link>
            )}
          </div>
          <button
            type="button"
            className="btn btn-ghost pub-nav-toggle"
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            aria-controls="site-nav-links"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? '✕' : '☰'}
          </button>
        </nav>
      </div>
    </header>
  );
}
