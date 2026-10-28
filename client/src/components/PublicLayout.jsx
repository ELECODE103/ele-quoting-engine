import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import SiteHeader from './SiteHeader';
import Wordmark from './Wordmark';
import brand from '../brand';

/**
 * Shell for the public pages: nav + footer. Sets document.title per page.
 */
export default function PublicLayout({ title, description, children }) {
  const location = useLocation();

  useEffect(() => {
    document.title = title ? `${title} · ${brand.name}` : `${brand.name} — Machined Plastics, CNC Routing & 3D Printing · ${brand.region}`;
    const meta = document.querySelector('meta[name="description"]');
    if (meta && description) meta.setAttribute('content', description);
    window.scrollTo(0, 0);
  }, [title, description, location.pathname]);

  return (
    <div style={{ minHeight: '100vh', background: '#fff', display: 'flex', flexDirection: 'column' }}>
      <SiteHeader />

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
              <Link to="/rfq">Request a firm quote</Link>
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
