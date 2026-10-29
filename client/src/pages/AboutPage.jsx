import { useNavigate } from 'react-router-dom';
import PublicLayout from '../components/PublicLayout';
import brand from '../brand';
import { KerfMark } from '../components/Wordmark';

export default function AboutPage() {
  const navigate = useNavigate();
  return (
    <PublicLayout
      title="About"
      description={`${brand.name} is the plastics machining division of ${brand.parentName}, a fabrication and engineering shop in ${brand.city}, Illinois, running since ${brand.foundedYear}.`}
    >
      <section className="section" style={{ paddingTop: 48 }}>
        <div className="pub-wrap">
          <div className="hero-grid">
            <div>
              <div className="eyebrow" style={{ marginBottom: 14 }}>About</div>
              <h1 className="display" style={{ marginBottom: 18 }}>A machine shop that deals square.</h1>
              <p className="lede" style={{ marginBottom: 16 }}>
                A straightedge is the tool a machinist trusts everything else against. It's also what you call a person who
                doesn't cut corners. We named the shop after both on purpose.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 18, margin: '4px 0 20px' }}>
                <KerfMark size={96} title="The Straightedge mark: a square of stock parted by one true cut" />
                <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, maxWidth: 360, margin: 0 }}>
                  The mark is a square of stock parted by one straightedge. The upper half is machined — its face is the true
                  edge. The lower half is printed — its face is the stair of the layers. The light between them is the kerf.
                  Both halves still make a square.
                </p>
              </div>
              <p style={{ fontSize: 15, color: 'var(--text-muted)', lineHeight: 1.7, marginBottom: 16 }}>
                {brand.name} is the plastics machining division of {brand.parentName}, a fabrication and engineering shop in{' '}
                {brand.city}, Illinois that has been building custom equipment, vehicle upfits and one-off machines since {brand.foundedYear}.
                Plastics became its own business because the work kept coming — guides, wear parts, trays, fixtures, replacement
                parts for machines nobody supports anymore — and because most machine shops don't want it.
              </p>
              <p style={{ fontSize: 15, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                The shop is run by a mechanical engineer who programs the machines, runs them, and answers the phone. That's
                small, and we don't pretend otherwise. It also means the DFM note on your quote came from the person who will
                hold your part, and the price you see is the price we'll build it for.
              </p>
            </div>
            <div className="photo-frame" style={{ aspectRatio: '4 / 5', maxHeight: 520 }}>
              <img className="photo" src="/photos/disc-hand.jpg" alt="Router-cut UHMW disc held in front of the CNC router" loading="eager" />
              <div className="cap">UHMW, 1/2" — one of a sheet's worth, off the router.</div>
            </div>
          </div>
        </div>
      </section>

      <section className="section section-alt">
        <div className="pub-wrap">
          <div className="grid-3" style={{ alignItems: 'start' }}>
            <div>
              <h3 className="display" style={{ marginBottom: 12 }}>Under one roof</h3>
              <p style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                Design and engineering, 3D scanning and printing, CNC milling and routing, plasma and laser cutting, press-brake
                forming, TIG/MIG/laser welding, paint and powder. If your plastic part bolts to a bracket we can make the bracket.
                Metal fabrication and vehicle work are quoted through{' '}
                <a href={brand.parentUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>Erik Lutz Enterprise</a>.
              </p>
            </div>
            <div>
              <h3 className="display" style={{ marginBottom: 12 }}>Who we work with</h3>
              <p style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                Packaging and food-equipment OEMs, automation integrators, maintenance departments that need the part the OEM
                stopped making, labs and medical-device teams that need fixtures and carts, and engineers who want a prototype
                this week. Lake County, the northern suburbs, Kenosha and Milwaukee are a drive; everywhere else is a box.
              </p>
            </div>
            <div>
              <h3 className="display" style={{ marginBottom: 12 }}>Paperwork</h3>
              <ul className="checklist">
                <li>{brand.legalName}, an Illinois LLC wholly owned by {brand.parentName}</li>
                <li>W-9, certificate of insurance and NDA on request, within a business day</li>
                <li>Net terms for approved accounts; card checkout for everything else</li>
                <li>Registered on SAM.gov for federal work</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="pub-wrap" style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 className="display" style={{ fontSize: 26, marginBottom: 6 }}>Come see the shop.</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 15 }}>{brand.city}, Illinois. Call ahead — the person you want is probably at a machine.</p>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <a className="btn btn-outline btn-lg" href={brand.phoneHref} style={{ textDecoration: 'none' }}>{brand.phone}</a>
            <button className="btn btn-primary btn-lg" onClick={() => navigate('/quote')}>Get an instant quote</button>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
