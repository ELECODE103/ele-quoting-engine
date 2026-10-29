import { Link, useNavigate } from 'react-router-dom';
import PublicLayout from '../components/PublicLayout';
import brand from '../brand';

/**
 * One component, three service pages. Content lives in SERVICES below so the
 * copy is in one place and easy to edit.
 */
const SERVICES = {
  machining: {
    title: 'CNC Machining — Plastics',
    metaTitle: 'CNC Machining of Plastics',
    description: `CNC milling and turning of Delrin, UHMW, HDPE, nylon, PEEK, Ultem, PTFE and 6061 in ${brand.city}, Illinois. Instant online pricing to ${brand.rfqQuantityThreshold} pieces; production quotes in ${brand.quoteTurnaroundHours} hours.`,
    eyebrow: 'Milling & turning',
    h1: 'CNC machining, plastics first.',
    lede: 'Most machine shops treat plastic as the job they take when the aluminum runs out. We set the shop up around it: sharp tooling, light engagement, parts left to normalize before inspection, and programs saved for the reorder.',
    hero: { src: '/photos/fourth-axis.jpg', alt: 'Acetal part on the 4th-axis rotary of a CNC mill', cap: 'Acetal on the 4th axis — 35 pieces, one setup.' },
    blocks: [
      {
        h: 'What runs well here',
        items: [
          'Blocks, brackets, clamps, saddles, wear pads and guides in acetal, UHMW and nylon.',
          'Bushings, rollers, spacers, sleeves and shafts turned from rod — acetal, nylon, PTFE, PEEK.',
          'Housings and manifolds in acetal, polycarbonate, PVC and PP, including multi-face work on the 4th axis.',
          'PEEK and Ultem for heat, chemical or electrical duty; G-10 and phenolic when you need stiff and insulating.',
          '6061 and brass when the mating part is metal. We machine both; we just lead with plastic.',
        ],
      },
      {
        h: 'Machines and limits',
        items: [
          'Tormach PCNC 1100 and a CNC Bridgeport — 3-axis with 4th-axis indexing. Work envelope 18" × 9.5" × 12" (457 × 241 × 300 mm).',
          'Lathes for round work to Ø10" × 24". Larger or longer turned parts go out as an RFQ.',
          'Standard tolerance ±0.005" (±0.13 mm) on plastics, ±0.002" on called-out features. Metals ±0.002" standard.',
          'Threads tapped or thread-milled; inserts installed on request. Press fits sized for the material, not the chart.',
        ],
      },
      {
        h: 'Design notes that save you money',
        items: [
          'Inside corners carry a tool radius — 1/16" minimum, 1/8" is cheaper. Square corners mean a broach or an EDM job somewhere else.',
          'Walls under 0.060" in acetal and nylon chatter; 0.090" and up machines cleanly.',
          'Call out the few dimensions that matter. We hold those tight and run the rest at standard, which is where the price comes from.',
          'If a part is really a flat profile under 1" thick, routing will usually beat milling on price. The quote tool will tell you.',
        ],
      },
    ],
    chips: ['Delrin / acetal', 'UHMW', 'HDPE', 'Nylon 6/6 & cast', 'PEEK', 'Ultem (PEI)', 'PTFE', 'Polycarbonate', 'Acrylic', 'PVC', 'Polypropylene', 'G-10 / FR-4', 'Phenolic', '6061-T6', 'Brass 360'],
    gallery: [
      { src: '/photos/acetal-clamps.jpg', cap: 'Black acetal clamp blocks' },
      { src: '/photos/dish-part.jpg', cap: 'Turned and milled acetal dish' },
      { src: '/photos/cups-lot.jpg', cap: 'UHMW cups — 11 pcs' },
    ],
    related: [{ to: '/routing', label: 'Flat part? See CNC routing' }, { to: '/materials', label: 'Material guide' }],
  },
  routing: {
    title: 'CNC Routing — Sheet & Plate Plastics',
    metaTitle: 'CNC Routing of Plastic Sheet and Plate',
    description: `Production CNC routing of HDPE, UHMW, acetal, polycarbonate, acrylic, G-10 and phenolic sheet on a 59" × 96" router in ${brand.city}, Illinois. Nested runs from 10 to thousands of parts.`,
    eyebrow: 'Sheet & plate',
    h1: 'Flat plastic parts, nested and cut by the sheet.',
    lede: 'A router with a tool changer, a vacuum table and a 4\' × 8\' sheet is the cheapest way there is to make a flat plastic part in quantity. Trays, guards, guides, wear strips, spacers, templates, panels — profiles, pockets, holes and chamfers in one setup.',
    hero: { src: '/photos/tray-stack-router.jpg', alt: 'Stack of router-cut HDPE trays on the router bed', cap: 'HDPE trays, 3/4" thick — pocketed, nested, 40 to the run.' },
    blocks: [
      {
        h: 'What runs well here',
        items: [
          'Conveyor and packaging wear parts: guides, rails, lane dividers, wear strips, star wheels and change parts in UHMW and acetal.',
          'Trays, nests and totes in HDPE and marine board, pocketed and drilled.',
          'Machine guards, windows and covers in polycarbonate and acrylic, with polished edges when they show.',
          'Gaskets, spacers, templates and fixtures in PVC, PP, G-10 and phenolic.',
          '6061 plate to 1/2" when the flat part has to be metal.',
        ],
      },
      {
        h: 'Machine and limits',
        items: [
          'Techno HD-II: 59" × 96" bed, 12" under the gantry, 12-position tool changer, 5 hp spindle.',
          'Stock from 1/16" to 1" in plastics; 1/2" in aluminum. Full 48" × 96" sheets; oversize on request.',
          'Profile tolerance ±0.005" (±0.13 mm) typical. Large HDPE and UHMW parts move with temperature — we cut, let them relax, and measure at 68 °F.',
          'Inside corners carry the tool radius: 1/8" standard, 1/16" on request, 1/32" on thin stock. Dog-bones or overcuts where a square corner must fit.',
        ],
      },
      {
        h: 'Design notes that save you money',
        items: [
          'Keep webs over 0.100" in plastic. Thinner ones flex under the cutter and tear.',
          'Holes 1/8" and up are interpolated to size; smaller ones are drilled. Tell us the thread and we tap offline.',
          'Parts under 1.5" need tabs or an onion skin — expect a small witness mark on one edge. Say which face matters.',
          'Quantities that fill whole sheets price best. The DFM panel tells you how many of your part fit on a sheet.',
        ],
      },
    ],
    chips: ['HDPE', 'UHMW', 'Acetal / Delrin', 'Nylon', 'Polycarbonate', 'Acrylic (cast)', 'PVC & expanded PVC', 'Polypropylene', 'G-10 / FR-4', 'Phenolic', '6061 plate'],
    gallery: [
      { src: '/photos/disc-router-bed.jpg', cap: 'UHMW discs on the router bed' },
      { src: '/photos/disc-stacks.jpg', cap: 'Two stacks, one sheet' },
      { src: '/photos/hdpe-plate.jpg', cap: 'HDPE plate, drilled pattern' },
    ],
    related: [{ to: '/machining', label: 'Not flat? See CNC machining' }, { to: '/materials', label: 'Material guide' }],
  },
  '3d-printing': {
    title: '3D Printing — FDM & SLA',
    metaTitle: '3D Printing',
    description: `FDM and SLA 3D printing in ${brand.city}, Illinois. Prototypes, fixtures, patterns and low-volume parts with instant online pricing.`,
    eyebrow: 'Additive',
    h1: 'Print the prototype. Machine the part.',
    lede: 'Printing is how we get a fit check in your hands in days, make the fixture that holds the production part, or make ten of something that doesn\'t justify a program. Same shop, same person, so the print and the machined part agree.',
    hero: { src: '/photos/fdm-print.jpg', alt: 'Large FDM print in progress', cap: 'FDM on a 350 × 350 mm bed. Up to 12" × 12" × 24" on the Raise3D.' },
    blocks: [
      {
        h: 'What runs well here',
        items: [
          'Fit and form prototypes before cutting plastic or aluminum — print it, hold it, change it.',
          'Jigs, fixtures, soft jaws, drill guides and go/no-go gages for your floor or ours.',
          'Patterns and masters for casting and thermoforming.',
          'Low-volume end-use parts in PETG, ABS, nylon and TPU where printed is good enough.',
          'Fine-detail parts in SLA resin — small housings, snap fits, cosmetic models.',
        ],
      },
      {
        h: 'Machines and limits',
        items: [
          'Raise3D N2 Plus, 12" × 12" × 24" dual-extruder. Three Creality K2 Plus at ~12" × 12" × 14" for parallel runs. Large-format FDM for oversize.',
          'Formlabs SLA for engineering resins, ~6" × 6" × 7".',
          'Layer heights from 0.1 to 0.3 mm. Typical FDM accuracy ±0.2 mm; SLA ±0.1 mm.',
          'Supports removed, surfaces sanded or vapor-smoothed on request. Painting and dyeing available.',
        ],
      },
      {
        h: 'When not to print',
        items: [
          'If it needs a real bearing surface, a tight press fit, or will see 150 °F in service, it wants to be machined from acetal or nylon. We\'ll say so on the quote.',
          'Over about 50 pieces of a simple flat part, routing from sheet is usually cheaper and the parts are stronger.',
        ],
      },
    ],
    chips: ['PLA+', 'PETG', 'ABS', 'ASA', 'Nylon', 'TPU', 'Standard resin', 'Tough resin', 'Flexible resin'],
    gallery: [
      { src: '/photos/phenolic-prototype.jpg', cap: 'SLA housing with machined phenolic and acetal plates — one assembly, three processes' },
      { src: '/photos/fdm-print.jpg', cap: 'Large FDM pattern' },
      { src: '/photos/acetal-clamps.jpg', cap: 'The machined version of a printed prototype' },
    ],
    related: [{ to: '/machining', label: 'Ready for production? CNC machining' }, { to: '/routing', label: 'Flat parts: CNC routing' }],
  },
};

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
              <img className="photo" src={s.hero.src} alt={s.hero.alt} loading="eager" />
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
                <img className="photo" src={g.src} alt={g.cap} loading="lazy" />
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
