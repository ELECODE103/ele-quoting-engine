import { Link, useNavigate } from 'react-router-dom';
import PublicLayout from '../components/PublicLayout';
import brand from '../brand';

const GALLERY = [
  { src: '/photos/tray-stack-router.jpg', cap: 'HDPE trays, 3/4" — router-cut, pocketed, 40 pcs' },
  { src: '/photos/acetal-clamps.jpg', cap: 'Black acetal clamps — milled, 5 pcs' },
  { src: '/photos/fourth-axis.jpg', cap: 'Acetal — 4th-axis milling, 35 pcs' },
  { src: '/photos/disc-stacks.jpg', cap: 'UHMW notched discs, 1/2" — nested from sheet' },
  { src: '/photos/uhmw-rack.jpg', cap: 'UHMW rack bar — milled profile' },
  { src: '/photos/brackets-inspection.jpg', cap: 'Acetal saddle brackets on the surface plate' },
];

export default function LandingPage() {
  const navigate = useNavigate();

  return (
    <PublicLayout
      description={`Machined plastic parts from ${brand.city}, Illinois. CNC milling, turning and routing in Delrin, UHMW, HDPE, nylon, PEEK and 6061, plus FDM and SLA printing. Instant online pricing; firm quotes in 24 hours.`}
    >
      {/* ─── Hero ─── */}
      <section className="section" style={{ paddingTop: 56 }}>
        <div className="pub-wrap">
          <div className="hero-grid">
            <div>
              <div className="eyebrow" style={{ marginBottom: 18 }}>{brand.region}</div>
              <h1 className="display" style={{ marginBottom: 20 }}>
                Machined plastic parts.<br />One to a few thousand.
              </h1>
              <p className="lede" style={{ maxWidth: 520, marginBottom: 30 }}>
                CNC milling, turning and routing in Delrin, UHMW, HDPE, nylon, PEEK and 6061.
                Upload a STEP or STL and get a price now. Over {brand.rfqQuantityThreshold} pieces, the
                person who will run the job quotes it within {brand.quoteTurnaroundHours} hours.
              </p>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 28 }}>
                <button className="btn btn-primary btn-lg" onClick={() => navigate('/quote')}>Upload a part</button>
                <a className="btn btn-outline btn-lg" href="#work" style={{ textDecoration: 'none' }}>See what we run</a>
              </div>
              <div className="chips">
                {['.step', '.stp', '.stl', '.iges', '.3mf'].map((f) => <span key={f} className="chip" style={{ fontFamily: 'var(--font-mono)' }}>{f}</span>)}
              </div>
            </div>
            <div className="photo-frame" style={{ aspectRatio: '4 / 5', maxHeight: 560 }}>
              <img className="photo" src="/photos/tray-stack-edge.jpg" alt="Stack of router-cut HDPE trays on the shop bench" loading="eager" />
              <div className="cap">HDPE, 3/4" — router-cut and pocketed. A production lot, not a prototype.</div>
            </div>
          </div>
        </div>
      </section>

      {/* ─── Facts ─── */}
      <section className="section-tight section-alt">
        <div className="pub-wrap">
          <div className="stat-row">
            <div className="stat"><b>Instant</b><span>price &amp; checkout to {brand.rfqQuantityThreshold} pcs</span></div>
            <div className="stat"><b>{brand.quoteTurnaroundHours} hr</b><span>firm quotes over {brand.rfqQuantityThreshold} pcs</span></div>
            <div className="stat"><b>13</b><span>engineering plastics quoted online</span></div>
            <div className="stat"><b>{brand.foundedYear}</b><span>machining in Lake County since</span></div>
            <div className="stat"><b>FAI</b><span>first-article report with every production order</span></div>
          </div>
        </div>
      </section>

      {/* ─── Processes ─── */}
      <section className="section">
        <div className="pub-wrap">
          <div style={{ maxWidth: 640, marginBottom: 36 }}>
            <div className="eyebrow" style={{ marginBottom: 10 }}>What we do</div>
            <h2 className="display">Three ways to make a plastic part. We'll tell you which one your part wants.</h2>
          </div>
          <div className="grid-3">
            <ProcessCard
              to="/machining"
              img="/photos/acetal-clamps.jpg"
              alt="Black acetal clamp blocks on a granite surface plate"
              title="CNC Machining"
              sub="Milling & turning"
              text="Blocks, brackets, bushings, rollers, spacers, housings. Tormach and Bridgeport mills with a 4th axis, lathes for round work. Plastics first; 6061 and brass when the job calls for it."
              chips={['Delrin', 'UHMW', 'Nylon', 'PEEK', 'Ultem', 'PTFE', '6061']}
            />
            <ProcessCard
              to="/routing"
              img="/photos/disc-stacks.jpg"
              alt="Two stacks of UHMW notched discs on the router bed"
              title="CNC Routing"
              sub="Sheet & plate"
              text="Flat parts nested from 4' × 8' sheet on a 59&quot; × 96&quot; router with a tool changer. Profiles, pockets, holes, chamfers. Where production plastic parts are cheapest to make."
              chips={['HDPE', 'UHMW', 'Acetal', 'Polycarbonate', 'Acrylic', 'G-10', 'Phenolic']}
            />
            <ProcessCard
              to="/3d-printing"
              img="/photos/fdm-print.jpg"
              alt="Large FDM print on the build plate"
              title="3D Printing"
              sub="FDM & SLA"
              text="Prototypes, fixtures, patterns and low-volume parts. Four FDM machines up to 12&quot; × 12&quot; × 24&quot;, SLA for fine detail. Print it this week, machine the production version next."
              chips={['PLA+', 'PETG', 'ABS', 'Nylon', 'TPU', 'SLA resin']}
            />
          </div>
        </div>
      </section>

      {/* ─── Work ─── */}
      <section id="work" className="section section-alt">
        <div className="pub-wrap">
          <div className="flex-between" style={{ alignItems: 'flex-end', marginBottom: 28, flexWrap: 'wrap', gap: 12 }}>
            <div style={{ maxWidth: 560 }}>
              <div className="eyebrow" style={{ marginBottom: 10 }}>Recent work</div>
              <h2 className="display">Parts off the machines in the last 60 days.</h2>
            </div>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Customer names and part numbers withheld. Yours will be too.</span>
          </div>
          <div className="photo-grid">
            {GALLERY.map((g) => (
              <div key={g.src} className="photo-frame">
                <img className="photo" src={g.src} alt={g.cap} loading="lazy" />
                <div className="cap">{g.cap}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── How ordering works ─── */}
      <section className="section">
        <div className="pub-wrap">
          <div style={{ maxWidth: 560, marginBottom: 36 }}>
            <div className="eyebrow" style={{ marginBottom: 10 }}>How it works</div>
            <h2 className="display">No sales call unless you want one.</h2>
          </div>
          <div className="grid-4">
            {[
              ['01', 'Upload', 'Drop in a STEP, STL or IGES. The geometry is read on our server; the file is encrypted at rest and purged on a schedule.'],
              ['02', 'Price & DFM', 'Pick process, material, finish and quantity. The price updates as you go, with a manufacturability check written for our machines, not a generic one.'],
              ['03', 'Order or RFQ', `Up to ${brand.rfqQuantityThreshold} pieces: check out with a card. More than that, an oversize part or anything the checker flags: a firm quote from us within ${brand.quoteTurnaroundHours} hours.`],
              ['04', 'First article, then ship', 'Production orders get a first-article inspection report and a certificate of conformance in the box. Reorders use the same program and fixture.'],
            ].map(([n, t, d]) => (
              <div key={n} className="card" style={{ padding: 24 }}>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 30, fontWeight: 700, color: 'var(--accent)', opacity: 0.35, marginBottom: 8 }}>{n}</div>
                <h3 className="display" style={{ fontSize: 17, marginBottom: 8 }}>{t}</h3>
                <p style={{ fontSize: 13.5, color: 'var(--text-muted)', lineHeight: 1.65 }}>{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── Quality + who ─── */}
      <section className="section section-alt">
        <div className="pub-wrap">
          <div className="hero-grid" style={{ gap: 48 }}>
            <div className="photo-frame" style={{ aspectRatio: '4 / 5', maxHeight: 520 }}>
              <img className="photo" src="/photos/brackets-inspection.jpg" alt="Acetal brackets being checked with a height gage on a granite surface plate" loading="lazy" />
              <div className="cap">Every production lot sees the surface plate before it sees a box.</div>
            </div>
            <div>
              <div className="eyebrow" style={{ marginBottom: 10 }}>Quality, plainly</div>
              <h2 className="display" style={{ marginBottom: 18 }}>Plastics move. We measure for it.</h2>
              <p className="lede" style={{ marginBottom: 18 }}>
                Acetal, nylon and UHMW grow with heat and moisture; a part that's right off the machine can be wrong on your bench.
                We machine to the print, let parts normalize, and inspect at 68 °F with gage pins, calipers, a height gage and a surface plate.
              </p>
              <ul className="checklist" style={{ marginBottom: 24 }}>
                <li>First-article inspection report and certificate of conformance with every production order; material certs passed through on request.</li>
                <li>Your drawing's critical dimensions are the ones we check and record, not a generic sample.</li>
                <li>Working toward ISO 9001 registration: documented inspection, traceability and corrective-action procedures now, the audit next.</li>
                <li>Reorders run on the saved program and fixture, so the hundredth part matches the first.</li>
              </ul>
              <Link to="/quality" className="btn btn-outline">How we inspect</Link>
            </div>
          </div>
        </div>
      </section>

      {/* ─── CTA ─── */}
      <section className="section section-dark">
        <div className="pub-wrap" style={{ textAlign: 'center' }}>
          <h2 className="display" style={{ color: '#F8FAFC', marginBottom: 12 }}>Have a print? Send it.</h2>
          <p style={{ color: '#94A3B8', fontSize: 16, maxWidth: 520, margin: '0 auto 28px', lineHeight: 1.6 }}>
            Instant price on the site, or call the shop. Either way you're talking to the person who runs the machine.
          </p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-primary btn-lg" onClick={() => navigate('/quote')}>Get an instant quote</button>
            <a className="btn btn-lg" href={brand.phoneHref} style={{ background: 'transparent', border: '2px solid #334155', color: '#E2E8F0', textDecoration: 'none' }}>{brand.phone}</a>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}

function ProcessCard({ to, img, alt, title, sub, text, chips }) {
  return (
    <Link to={to} className="card proc-card" style={{ textDecoration: 'none' }}>
      <div className="photo-frame"><img className="photo" src={img} alt={alt} loading="lazy" /></div>
      <div>
        <h3 className="display" style={{ marginBottom: 2 }}>{title}</h3>
        <div style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>{sub}</div>
      </div>
      <p style={{ fontSize: 13.5, color: 'var(--text-muted)', lineHeight: 1.65 }} dangerouslySetInnerHTML={{ __html: text }} />
      <div className="chips">{chips.map((c) => <span key={c} className="chip">{c}</span>)}</div>
    </Link>
  );
}
