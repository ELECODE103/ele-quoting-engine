import { Link } from 'react-router-dom';
import PublicLayout from '../components/PublicLayout';
import ShopPhoto from '../components/ShopPhoto';
import ToleranceTable from '../components/ToleranceTable';
import brand from '../brand';
import { SERVICES } from '../data/services';

// Each service page opens the quote tool on its own process.
const QUOTE_PROCESS = { machining: 'cnc', routing: 'routing', '3d-printing': '3d-printing' };

/**
 * One component, three service pages. Copy lives in data/services.js; anything
 * owner-dependent there is already resolved against shared/shop-facts.json.
 */
export default function ServicePage({ slug }) {
  const s = SERVICES[slug];
  if (!s) return null;

  return (
    <PublicLayout>
      <section className="section" style={{ paddingTop: 48 }}>
        <div className="pub-wrap">
          <div className="hero-grid">
            <div>
              <div className="eyebrow" style={{ marginBottom: 14 }}>{s.eyebrow}</div>
              <h1 className="display" style={{ marginBottom: 18 }}>{s.h1}</h1>
              <p className="lede" style={{ marginBottom: 26, maxWidth: 540 }}>{s.lede}</p>
              <div className="cta-row">
                <Link className="btn btn-primary btn-lg" to={`/quote?process=${QUOTE_PROCESS[slug] || 'cnc'}`}>Get an instant quote</Link>
                <a className="btn btn-outline btn-lg" href={brand.phoneHref}>{brand.phone}</a>
              </div>
              <p className="next-note">{s.next} {s.phoneNote}</p>
            </div>
            <ShopPhoto id={s.hero} loading="eager" style={{ aspectRatio: '4 / 5', maxHeight: 520 }} />
          </div>
        </div>
      </section>

      {s.tolerance && (
        <section className="section-tight">
          <div className="pub-wrap">
            <h2 className="display h2-sm">What each plastic will hold here</h2>
            <ToleranceTable />
          </div>
        </section>
      )}

      <section className="section section-alt">
        <div className="pub-wrap">
          <div className="grid-3" style={{ alignItems: 'start' }}>
            {s.blocks.map((b) => (
              <div key={b.h}>
                <h2 className="display h3-like">{b.h}</h2>
                <ul className="checklist">{b.items.map((it) => <li key={it}>{it}</li>)}</ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {s.aside && (
        <section className="section">
          <div className="pub-wrap">
            <div className="split">
              <div>
                <h2 className="display h2-sm">{s.aside.h}</h2>
                <p className="body-copy" style={{ fontSize: 15 }}>{s.aside.intro}</p>
              </div>
              <ul className="checklist">{s.aside.items.map((it) => <li key={it}>{it}</li>)}</ul>
            </div>
          </div>
        </section>
      )}

      <section className={`section${s.aside ? ' section-alt' : ''}`}>
        <div className="pub-wrap">
          <div className="flex-between" style={{ flexWrap: 'wrap', gap: 12, marginBottom: 20, alignItems: 'flex-end' }}>
            <h2 className="display h2-sm" style={{ marginBottom: 0 }}>Materials priced online</h2>
            <Link to="/materials" style={{ fontSize: 13, color: 'var(--accent)' }}>Full material guide →</Link>
          </div>
          <div className="chips" style={{ marginBottom: 48 }}>{s.chips.map((c) => <span key={c} className="chip" style={{ fontSize: 13, padding: '6px 12px' }}>{c}</span>)}</div>

          <div className="photo-grid">
            {s.gallery.map((id) => <ShopPhoto key={id} id={id} sizes="(max-width: 720px) 100vw, (max-width: 900px) 50vw, 33vw" />)}
          </div>

          <div style={{ marginTop: 40, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {s.related.map((r) => <Link key={r.to} to={r.to} className="btn btn-ghost">{r.label} →</Link>)}
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
