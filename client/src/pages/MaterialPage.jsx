import { Link, useParams } from 'react-router-dom';
import PublicLayout from '../components/PublicLayout';
import NotFoundPage from './NotFoundPage';
import brand from '../brand';
import { TYPICAL_VALUES_NOTE, FOOD_CONTACT_GENERAL } from '../data/materialPages';
import { getMaterialPage, getMaterialPages, buildFaqs, quoteHref, thicknessRange } from '../data/materials';
import { when, gradeLabel, MILLING } from '../facts';

/**
 * /materials/:slug - one page per engineering plastic in the catalog.
 * All copy and numbers come from data/materialPages.js; stock forms, grades
 * and thicknesses come from the generated catalog. Nothing is hard-coded here.
 */
const ROWS = [
  ['density', 'Density'],
  ['tensile', 'Tensile strength'],
  ['serviceTemp', 'Max service temperature (air)'],
  ['waterAbsorption', 'Water absorption'],
  ['friction', 'Coefficient of friction'],
];

export default function MaterialPage() {
  const { slug } = useParams();
  const page = getMaterialPage(slug);
  if (!page) return <NotFoundPage />;

  const faqs = buildFaqs(page);
  const others = getMaterialPages().filter((p) => p.slug !== page.slug);
  const primary = page.cnc ? quoteHref('cnc', page.cnc.slug) : quoteHref('routing', page.routing.slug);

  return (
    <PublicLayout>
      <section className="section" style={{ paddingTop: 40, paddingBottom: 48 }}>
        <div className="pub-wrap">
          <nav aria-label="Breadcrumb" className="crumbs">
            <Link to="/">Home</Link><span aria-hidden="true">/</span>
            <Link to="/materials">Materials</Link><span aria-hidden="true">/</span>
            <span aria-current="page">{page.name}</span>
          </nav>

          <div style={{ maxWidth: 760 }}>
            <div className="eyebrow" style={{ marginBottom: 14 }}>Material</div>
            <h1 className="display" style={{ marginBottom: 16 }}>{page.h1}</h1>
            <p className="lede" style={{ marginBottom: 26 }}>{page.summary}</p>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <Link className="btn btn-primary btn-lg" to={primary}>Price this part in {page.shortName}</Link>
              <Link className="btn btn-outline btn-lg" to="/rfq">Request a firm quote</Link>
            </div>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 12, maxWidth: 620, lineHeight: 1.6 }}>
              Upload a STEP or STL and the price shows in a few seconds; no account needed. Up to {brand.rfqQuantityThreshold} pieces checks out by card. Above that a person quotes it{when('quote-turnaround', (v) => ` within ${v}`)}. Questions: <a href={brand.phoneHref} style={{ color: 'var(--accent)' }}>{brand.phone}</a> rings the shop.
            </p>
          </div>
        </div>
      </section>

      <section className="section section-alt" style={{ padding: '48px 0' }}>
        <div className="pub-wrap">
          <div className="mat-cols">
            <div>
              <h2 className="display h2-sm">What {page.shortName} is used for</h2>
              <ul className="checklist">{page.uses.map((u) => <li key={u}>{u}</li>)}</ul>
            </div>
            <div>
              <h2 className="display h2-sm">How it is priced here</h2>
              <ul className="checklist">
                {page.cnc && (
                  <li>
                    <span>
                      <Link to="/machining">CNC {MILLING}</Link> from {(page.cnc.stockForms || []).join(' and ') || 'stock'}.
                      {' '}Grades quoted online: {page.cnc.grades.map((g) => gradeLabel(g.name)).join('; ')}.
                    </span>
                  </li>
                )}
                {page.routing && (
                  <li>
                    <span>
                      <Link to="/routing">CNC routing</Link> from sheet, {thicknessRange(page.routing)} thick
                      {' '}({page.routing.thicknesses.map((t) => t.label).join(', ')}).
                      {' '}Sheet grades quoted online: {page.routing.grades.map((g) => gradeLabel(g.name)).join('; ')}.
                    </span>
                  </li>
                )}
                {!page.routing && (
                  <li><span>Not quoted online as routed sheet. Ask on a <Link to="/rfq">firm quote</Link> if you need flat parts from sheet.</span></li>
                )}
                <li><span>Size limits and design rules are on the <Link to="/machining">machining</Link> and <Link to="/routing">routing</Link> pages.</span></li>
              </ul>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 18 }}>
                {page.cnc && <Link className="btn btn-ghost" to={quoteHref('cnc', page.cnc.slug)}>Quote a machined part →</Link>}
                {page.routing && <Link className="btn btn-ghost" to={quoteHref('routing', page.routing.slug)}>Quote a routed part →</Link>}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section" style={{ padding: '56px 0' }}>
        <div className="pub-wrap">
          <h2 className="display h2-sm">Typical properties</h2>
          <div className="card" style={{ overflowX: 'auto' }}>
            <table className="prop-table">
              <thead>
                <tr>
                  <th scope="col">Property</th>
                  {page.datasheets.map((d) => <th scope="col" key={d.column}>{d.column}</th>)}
                </tr>
              </thead>
              <tbody>
                {ROWS.map(([key, label]) => (
                  <tr key={key}>
                    <th scope="row">{label}</th>
                    {page.datasheets.map((d) => <td key={d.column}>{d[key] || 'Not listed on the datasheet'}</td>)}
                  </tr>
                ))}
                <tr>
                  <th scope="row">Source</th>
                  {page.datasheets.map((d) => (
                    <td key={d.column}>
                      <a href={d.source.url} target="_blank" rel="noopener noreferrer nofollow">{d.source.maker} {d.source.product}</a>
                      <span style={{ color: 'var(--text-dim)' }}> (datasheet values, retrieved {d.source.retrieved})</span>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <p className="fineprint">{TYPICAL_VALUES_NOTE}</p>

          <div className="mat-cols" style={{ marginTop: 40 }}>
            <div>
              <h3 className="display" style={{ marginBottom: 10 }}>Wear and friction</h3>
              <p className="body-copy">{page.wear}</p>
            </div>
            <div>
              <h3 className="display" style={{ marginBottom: 10 }}>Food contact</h3>
              <p className="body-copy">{page.foodContact}</p>
              <p className="body-copy" style={{ marginTop: 10 }}>{FOOD_CONTACT_GENERAL} <Link to="/food-contact">More on food-contact plastics</Link>.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="section section-alt" style={{ padding: '56px 0' }}>
        <div className="pub-wrap" style={{ maxWidth: 860 }}>
          <h2 className="display h2-sm">Machining notes</h2>
          <ul className="checklist">{page.machining.map((n) => <li key={n}>{n}</li>)}</ul>
        </div>
      </section>

      <section className="section" style={{ padding: '56px 0' }}>
        <div className="pub-wrap" style={{ maxWidth: 860 }}>
          <h2 className="display h2-sm">Common questions</h2>
          <dl className="faq">
            {faqs.map((f) => (
              <div key={f.q}>
                <dt>{f.q}</dt>
                <dd>{f.a}</dd>
              </div>
            ))}
          </dl>

          <div className="card" style={{ marginTop: 40, padding: 28, display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
            <div>
              <h3 className="display" style={{ marginBottom: 6 }}>Price your {page.shortName} part now</h3>
              <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>Upload a STEP or STL with {page.name} already selected. No account needed to see a price.</p>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Link className="btn btn-primary" to={primary}>Price this part</Link>
              <a className="btn btn-ghost" href={brand.phoneHref}>{brand.phone}</a>
            </div>
          </div>

          <h3 className="display" style={{ margin: '44px 0 12px' }}>Other materials</h3>
          <div className="chips">
            {others.map((o) => <Link key={o.slug} to={`/materials/${o.slug}`} className="chip chip-link">{o.name}</Link>)}
            <Link to="/materials" className="chip chip-link">All materials →</Link>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
