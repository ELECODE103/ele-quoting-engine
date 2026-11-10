import { Link, useNavigate } from 'react-router-dom';
import PublicLayout from '../components/PublicLayout';
import Photo from '../components/Photo';
import brand from '../brand';
import { SERVICES } from '../data/services';

/**
 * One component, three service pages. Content lives in data/services.js so the
 * copy is in one place and easy to edit.
 */

export default function ServicePage({ slug }) {
  const s = SERVICES[slug];
  const navigate = useNavigate();
  if (!s) return null;

  return (
    <PublicLayout title={s.metaTitle} description={s.description}>
      <section className="section" style={{ paddingTop: 48 }}>
        <div className="pub-wrap">
          <div className="hero-grid">
            <div>
              <div className="eyebrow" style={{ marginBottom: 14 }}>{s.eyebrow}</div>
              <h1 className="display" style={{ marginBottom: 18 }}>{s.h1}</h1>
              <p className="lede" style={{ marginBottom: 28, maxWidth: 540 }}>{s.lede}</p>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <button className="btn btn-primary btn-lg" onClick={() => navigate('/quote')}>Get an instant quote</button>
                <a className="btn btn-outline btn-lg" href={brand.phoneHref} style={{ textDecoration: 'none' }}>{brand.phone}</a>
              </div>
            </div>
            <div className="photo-frame" style={{ aspectRatio: '4 / 5', maxHeight: 520 }}>
              <Photo src={s.hero.src} alt={s.hero.alt} loading="eager" />
              <div className="cap">{s.hero.cap}</div>
            </div>
          </div>
        </div>
      </section>

      <section className="section section-alt">
        <div className="pub-wrap">
          <div className="grid-3" style={{ alignItems: 'start' }}>
            {s.blocks.map((b) => (
              <div key={b.h}>
                <h3 className="display" style={{ marginBottom: 14 }}>{b.h}</h3>
                <ul className="checklist">{b.items.map((it) => <li key={it}>{it}</li>)}</ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="pub-wrap">
          <div className="flex-between" style={{ flexWrap: 'wrap', gap: 12, marginBottom: 20, alignItems: 'flex-end' }}>
            <h2 className="display" style={{ fontSize: 24 }}>Materials we quote online</h2>
            <Link to="/materials" style={{ fontSize: 13, color: 'var(--accent)' }}>Full material guide →</Link>
          </div>
          <div className="chips" style={{ marginBottom: 48 }}>{s.chips.map((c) => <span key={c} className="chip" style={{ fontSize: 13, padding: '6px 12px' }}>{c}</span>)}</div>

          <div className="photo-grid">
            {s.gallery.map((g) => (
              <div key={g.src + g.cap} className="photo-frame">
                <Photo src={g.src} alt={g.cap} loading="lazy" sizes="(max-width: 720px) 100vw, (max-width: 900px) 50vw, 33vw" />
                <div className="cap">{g.cap}</div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 40, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {s.related.map((r) => <Link key={r.to} to={r.to} className="btn btn-ghost">{r.label} →</Link>)}
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
