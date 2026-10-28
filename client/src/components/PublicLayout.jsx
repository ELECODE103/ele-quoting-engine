import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../utils/authContext';
import Wordmark from './Wordmark';
import brand from '../brand';

const NAV = [
  { to: '/machining', label: 'Machining' },
  { to: '/routing', label: 'Routing' },
  { to: '/3d-printing', label: '3D Printing' },
  { to: '/materials', label: 'Materials' },
  { to: '/quality', label: 'Quality' },
  { to: '/about', label: 'About' },
];

/**
 * Shell for the public pages: nav + footer. Sets document.title per page.
 */
export default function PublicLayout({ title, description, children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { isAuthenticated, user } = useAuth();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    document.title = title ? `${title} · ${brand.name}` : `${brand.name} — Machined Plastics, CNC Routing & 3D Printing · ${brand.region}`;
    const meta = document.querySelector('meta[name="description"]');
    if (meta && description) meta.setAttribute('content', description);
    setOpen(false);
    window.scrollTo(0, 0);
  }, [title, description, location.pathname]);

  return (
    <div style={{ minHeight: '100vh', background: '#fff', display: 'flex', flexDirection: 'column' }}>
      <header style={{ borderBottom: '1px solid var(--border-subtle)', background: '#fff', position: 'sticky', top: 0, zIndex: 10 }}>
        <div className="pub-wrap">
          <nav className="pub-nav" aria-label="Main">
            <Wordmark size={19} />
            <div className={`pub-nav-links${open ? ' open' : ''}`}>
              {NAV.map((n) => (
                <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? 'active' : '')}>{n.label}</NavLink>
              ))}
              {isAuthenticated ? (
                <NavLink to={user?.role === 'admin' ? '/admin' : '/dashboard'}>{user?.role === 'admin' ? 'Admin' : 'My orders'}</NavLink>
              ) : (
                <NavLink to="/login">Sign in</NavLink>
              )}
              <button className="btn btn-primary" style={{ marginLeft: 8 }} onClick={() => navigate('/quote')}>
                Get an instant quote
              </button>
            </div>
            <button className="btn btn-ghost pub-nav-toggle" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              ☰
            </button>
          </nav>
        </div>
      </header>

      <main style={{ flex: 1 }}>{children}</main>

      <footer className="pub-footer">
        <div className="pub-wrap">
          <div className="cols">
            <div>
              <Wordmark size={15} showDescriptor={false} />
              <p style={{ marginTop: 12, maxWidth: 420, lineHeight: 1.6 }}>
                {brand.legalName}, a {brand.parentName} company. Machining in {brand.region} since {brand.foundedYear}.
              </p>
              <p style={{ marginTop: 10 }}>
                <a href={brand.phoneHref}>{brand.phone}</a> &nbsp;·&nbsp; <a href={`mailto:${brand.email}`}>{brand.email}</a>
              </p>
            </div>
            <div style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
              <b style={{ color: 'var(--text-primary)', fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' }}>Services</b>
              <Link to="/machining">CNC machining — plastics</Link>
              <Link to="/routing">CNC routing — sheet &amp; plate</Link>
              <Link to="/3d-printing">3D printing</Link>
              <Link to="/materials">Materials</Link>
            </div>
            <div style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
              <b style={{ color: 'var(--text-primary)', fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' }}>Company</b>
              <Link to="/quality">Quality</Link>
              <Link to="/about">About</Link>
              <Link to="/quote">Instant quote</Link>
              <a href={brand.parentUrl} target="_blank" rel="noreferrer">Erik Lutz Enterprise — fabrication &amp; vehicle upfitting</a>
            </div>
          </div>
          <div style={{ marginTop: 28, paddingTop: 16, borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, fontSize: 12, color: 'var(--text-dim)' }}>
            <span>&copy; {new Date().getFullYear()} {brand.legalName}. {brand.city}, {brand.state}.</span>
            <span>Your files stay private. NDA on request.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
