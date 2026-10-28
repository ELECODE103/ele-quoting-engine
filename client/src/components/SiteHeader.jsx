import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../utils/authContext';
import Wordmark from './Wordmark';

export const NAV = [
  { to: '/machining', label: 'Machining' },
  { to: '/routing', label: 'Routing' },
  { to: '/3d-printing', label: '3D Printing' },
  { to: '/materials', label: 'Materials' },
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
      <div className="pub-wrap">
        <nav className="pub-nav" aria-label="Main">
          <Wordmark size={19} />
          <div id="site-nav-links" className={`pub-nav-links${open ? ' open' : ''}`}>
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? 'active' : '')}>{n.label}</NavLink>
            ))}
            {isAuthenticated ? (
              <>
                <NavLink to={user?.role === 'admin' ? '/admin' : '/dashboard'}>{user?.role === 'admin' ? 'Admin' : 'My orders'}</NavLink>
                <button type="button" className="linklike" onClick={() => { logout(); navigate('/'); }}>Sign out</button>
              </>
            ) : (
              <NavLink to="/login">Sign in</NavLink>
            )}
            {onQuote ? (
              <NavLink to="/quote" className="active">Instant quote</NavLink>
            ) : (
              <button type="button" className="btn btn-primary nav-cta" onClick={() => navigate('/quote')}>
                Get an instant quote
              </button>
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
