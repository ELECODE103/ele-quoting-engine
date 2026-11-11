import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import SiteHeader from './SiteHeader';
import Wordmark from './Wordmark';
import brand from '../brand';
import { ok, fact, when } from '../facts';

// Engineer-led, in the owner's approved words; no statement of shop size anywhere on the site.
const ENGINEER_LED = fact('engineer-led') || 'Call and you reach the engineer running your job.';
// Footer bar line: true on every page and of every order, whatever the customer asked for.
// (Inspection paperwork is an option, so it is not said here: owner, 2026-11-11.)
const FOOT_LINE = 'Customer names and part numbers are never published.';

/**
 * Shell for the public pages: nav + footer.
 *
 * <title>, meta description, canonical and JSON-LD are NOT set here any more:
 * they come from seo/routes.js (server-rendered into the HTML, and kept in
 * sync on navigation by seo/useHeadSync.js in App). The `title` and
 * `description` props are kept so existing pages do not change, but the route
 * map is the source of truth - edit titles and descriptions there.
 */
export default function PublicLayout({ children }) {
  const location = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

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
                Plastics machine shop in {brand.city}, {brand.region}. {ENGINEER_LED}
                {when('legal-name', (v) => ` ${v}`)}{when(['legal-name', 'parent-company'], `, a ${brand.parentName} company`)}{when('legal-name', '.')}
              </p>
              <p style={{ marginTop: 10 }}>
                <a href={brand.phoneHref}>{brand.phone}</a> &nbsp;·&nbsp; <a href={`mailto:${brand.email}`}>{brand.email}</a>
              </p>
            </div>
            <div style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
              <b className="foot-h">Services</b>
              <Link to="/machining">CNC machining</Link>
              <Link to="/routing">CNC routing</Link>
              <Link to="/3d-printing">3D printing</Link>
              <Link to="/replacement-parts">Replacement parts, no drawing</Link>
              <Link to="/materials">Materials</Link>
              <Link to="/parts">Parts by type</Link>
              <Link to="/food-contact">Food-contact plastics</Link>
            </div>
            <div style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
              <b className="foot-h">Shop</b>
              <Link to="/quality">Quality</Link>
              <Link to="/about">About</Link>
              <Link to="/quote">Instant quote</Link>
              <Link to="/rfq">Request a firm quote</Link>
              {ok('parent-company') && <a href={brand.parentUrl} target="_blank" rel="noreferrer">Metal fabrication: Erik Lutz Enterprise</a>}
            </div>
          </div>
          <div style={{ marginTop: 28, paddingTop: 16, borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, fontSize: 12, color: 'var(--text-muted)' }}>
            <span>&copy; {new Date().getFullYear()} {fact('legal-name') || brand.name}. {brand.city}, {brand.state}.</span>
            <span>{FOOT_LINE}{when('paperwork-packet', ' NDA on request.')}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
