import { Link } from 'react-router-dom';
import PublicLayout from '../components/PublicLayout';
import brand from '../brand';
import { ok } from '../facts';
import { quoteHref } from '../data/materials';

const turned = ok('turning');

// A guide from part type to material and process. It describes what suits
// each kind of part; it is not a list of jobs or customers.
const PARTS = [
  { part: 'Wear strips and guide rails', mat: 'UHMW', why: 'Slippery and very hard to wear out. Cheap enough to replace.', how: 'Routed from sheet', to: quoteHref('routing', 'rt-uhmw'), page: '/materials/uhmw' },
  { part: 'Guides and lane dividers with a bore or a fit', mat: 'Acetal (Delrin)', why: 'Holds size where UHMW will not, and still slides.', how: 'Routed or milled', to: quoteHref('cnc', 'cnc-delrin'), page: '/materials/acetal-delrin' },
  { part: 'Bushings and sleeves', mat: 'Acetal, nylon, PTFE', why: 'Acetal for a fit that has to stay put, oil-filled nylon to run dry, PTFE for chemicals.', how: turned ? 'Turned from rod' : 'Machined from rod', to: quoteHref('cnc', 'cnc-delrin'), page: '/materials/acetal-delrin' },
  { part: 'Rollers and wheels', mat: 'Nylon, acetal, UHMW', why: 'Nylon carries load and takes a hit. Acetal if it runs wet.', how: turned ? 'Turned from rod' : 'Machined from rod', to: quoteHref('cnc', 'cnc-nylon'), page: '/materials/nylon' },
  { part: 'Spacers, standoffs and insulators', mat: 'Acetal, nylon, G-10, phenolic', why: 'G-10 and phenolic when it has to be stiff and must not conduct.', how: 'Milled, or routed if flat', to: quoteHref('cnc', 'cnc-delrin'), page: '/materials' },
  { part: 'Trays, nests and panels', mat: 'HDPE', why: 'Cheap, tough, shrugs off most chemicals. Pockets cut in the same setup as the outline.', how: 'Routed from sheet', to: quoteHref('routing', 'rt-hdpe'), page: '/materials/hdpe' },
  { part: 'Machine guards and windows', mat: 'Polycarbonate, acrylic', why: 'Polycarbonate will not shatter. Acrylic is clearer and scratches less, but it is brittle.', how: 'Routed from sheet', to: quoteHref('routing', 'rt-polycarbonate'), page: '/materials/polycarbonate' },
  { part: 'Manifolds and housings', mat: 'Acetal, PVC, polypropylene, polycarbonate', why: 'PVC and polypropylene for chemical service. Polycarbonate when you need to see in.', how: 'Milled from block', to: quoteHref('cnc', 'cnc-delrin'), page: '/materials' },
  { part: 'Seals, seats and slide pads', mat: 'PTFE, PEEK', why: 'PTFE for chemicals and low friction. PEEK when it is hot or loaded.', how: turned ? 'Milled or turned' : 'Milled', to: quoteHref('cnc', 'cnc-ptfe'), page: '/materials/ptfe' },
  { part: 'Fixtures, jigs and soft jaws', mat: 'Printed PETG or nylon; acetal', why: 'Print it if it only has to locate a part. Machine it from acetal if it gets clamped on all day.', how: '3D printed or milled', to: '/quote?process=3d-printing', page: '/3d-printing' },
];

export default function PartsPage() {
  return (
    <PublicLayout>
      <section className="section" style={{ paddingTop: 48 }}>
        <div className="pub-wrap">
          <div style={{ maxWidth: 720, marginBottom: 32 }}>
            <div className="eyebrow" style={{ marginBottom: 14 }}>Parts by type</div>
            <h1 className="display" style={{ marginBottom: 16 }}>Plastic machine parts: what each is usually made from, and how.</h1>
            <p className="lede">
              Start from the part, not the catalog. Each row names the plastic that kind of part is usually made from, why,
              and which process cuts it. This is a guide to what suits the part. It is not a list of jobs or customers;
              those are never published here.
            </p>
          </div>

          <div className="card" style={{ overflowX: 'auto' }}>
            <table className="mat-table parts-table">
              <thead>
                <tr><th>Part</th><th>Usual material</th><th>Why</th><th>How it is cut</th><th><span className="sr-only">Price</span></th></tr>
              </thead>
              <tbody>
                {PARTS.map((p) => (
                  <tr key={p.part}>
                    <td style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{p.part}</td>
                    <td data-label="Usual material"><Link className="mat-link" to={p.page}>{p.mat}</Link></td>
                    <td data-label="Why" style={{ minWidth: 240 }}>{p.why}</td>
                    <td data-label="How it is cut" style={{ whiteSpace: 'nowrap' }}>{p.how}</td>
                    <td style={{ whiteSpace: 'nowrap' }}><Link to={p.to} style={{ color: 'var(--accent)', fontWeight: 600 }}>Price one →</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid-3" style={{ marginTop: 40 }}>
            <div className="plain-box">
              <h2 className="display h3-like" style={{ marginBottom: 8 }}>Dimension matters, or wear matters?</h2>
              <p className="body-copy">Pick acetal when a dimension has to hold. Pick UHMW when the part has to last against something rubbing on it. Few plastics do both well.</p>
            </div>
            <div className="plain-box">
              <h2 className="display h3-like" style={{ marginBottom: 8 }}>Hot, wet or washed down?</h2>
              <p className="body-copy">Say so. Nylon grows when it is wet, polyethylene grows when it is warm, and some cleaners crack polycarbonate. The right material fixes what a tighter tolerance cannot.</p>
            </div>
            <div className="plain-box">
              <h2 className="display h3-like" style={{ marginBottom: 8 }}>Touches food?</h2>
              <p className="body-copy">Compliance belongs to a maker's grade, not to a plastic. <Link to="/food-contact">What a machine shop can and cannot certify</Link>.</p>
            </div>
          </div>

          <div className="cta-row" style={{ marginTop: 40 }}>
            <Link className="btn btn-primary btn-lg" to="/quote">Get an instant quote</Link>
            <Link className="btn btn-outline btn-lg" to="/replacement-parts">No CAD? Send a photo</Link>
          </div>
          <p className="next-note">
            "Price one" opens the quote tool with that material already picked; upload a STEP or STL and the price shows in a few seconds.
            Part not on the list? Call <a href={brand.phoneHref}>{brand.phone}</a>. If it does not belong in this shop, you will hear that too.
          </p>
        </div>
      </section>
    </PublicLayout>
  );
}
