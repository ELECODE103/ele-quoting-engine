import { Link } from 'react-router-dom';
import PublicLayout from '../components/PublicLayout';
import ShopPhoto from '../components/ShopPhoto';
import Photo from '../components/Photo';
import brand from '../brand';
import { ok, fact, when, lines, MACHINED } from '../facts';
import { shopPhoto } from '../data/shopPhotos';

const LIMIT = brand.rfqQuantityThreshold;
const GALLERY = ['tray-stack-router', 'acetal-clamps', 'fourth-axis', 'disc-stacks', 'uhmw-rack', 'brackets-inspection'];
const captioned = GALLERY.some((id) => shopPhoto(id).cap);
const within = when('quote-turnaround', (v) => ` within ${v}`);

// Four facts, each one checkable. A stat that depends on the owner falls back
// to one the software proves.
const STATS = [
  ['Price now', `to ${LIMIT} pieces, by card`],
  when('tol-acetal', (t) => [t.standard, 'standard on acetal'], ['No account', 'needed to see a price']),
  when('router-bed', (b) => [b, 'router bed'], ['59" × 96"', 'largest flat part priced online']),
  ['One person', 'quotes it, cuts it, answers the phone'],
];

const DOORS = [
  {
    h: 'I have a CAD file',
    p: `Upload a STEP or STL and the price is on the screen in a few seconds. Up to ${LIMIT} pieces you can pay by card.`,
    to: '/quote', cta: 'Get an instant quote',
  },
  {
    h: 'I have a drawing and a quantity',
    p: `Over ${LIMIT} pieces, or a print with no model. Send the drawing and the quantities you would buy. A person prices it${within}.`,
    to: '/rfq', cta: 'Request a firm quote',
  },
  {
    h: 'I have a worn part and no drawing',
    p: 'You do not need a drawing to ask. Send a photo with a tape measure in it and say what machine it came off.',
    to: '/replacement-parts', cta: 'No CAD? Send a photo',
  },
];

const STEPS = [
  ['01', 'Upload', 'Drop in a STEP, STL, IGES or 3MF. No account is needed to see a price. '
    + when('file-encryption', 'The file is encrypted at rest and ', 'The file is ')
    + when('file-retention', (v) => `deleted after ${v} unless you order.`, 'purged on a schedule if you do not order.')],
  ['02', 'Price and DFM', 'Pick process, material, finish and quantity. The price updates as you go, with a manufacturability check against the limits printed on this site.'],
  ['03', 'Check out, or get a firm quote', `Up to ${LIMIT} pieces: check out with a card. More than that, an oversize part or anything the check fails: a firm quote from a person${within}.`],
  when('fai-coc',
    (v) => ['04', 'First article, then ship', `A first-article inspection report and a certificate of conformance come with ${v}.`],
    ['04', 'Made, then shipped', `Your order page shows where the job stands. Questions go to ${brand.phone}, which rings the person making the part.`]),
];

const MOVES = lines([
  'Plastic expands five to ten times as much as steel for the same temperature change. A long HDPE or UHMW part is a different length on a warm line than in a cold shop.',
  'Nylon takes on water and grows, up to about 2% in length when saturated.',
  'Most plastics relax after they are cut. A part measured warm off the machine can read differently the next morning.',
  { needs: 'practice-rest' },
  'So tell us where the part lives, and put the tight tolerance only on the feature that needs it.',
]);

export default function LandingPage() {

  return (
    <PublicLayout>
      {/* ─── Hero ─── */}
      <section className="section" style={{ paddingTop: 56 }}>
        <div className="pub-wrap">
          <div className="hero-grid">
            <div>
              <div className="eyebrow" style={{ marginBottom: 18 }}>Plastics machine shop</div>
              <h1 className="display" style={{ marginBottom: 20 }}>
                Machined plastic parts.<br className="br-wide" /> Price now, made in {brand.city}, Illinois.
              </h1>
              <p className="lede" style={{ maxWidth: 530, marginBottom: 28 }}>
                {MACHINED.charAt(0).toUpperCase() + MACHINED.slice(1)} from Delrin, UHMW, HDPE, nylon and PEEK.
                Upload a STEP file and see the price; no account, no call. Over {LIMIT} pieces, or no CAD at all,
                the person who will cut the part quotes it{within}.
              </p>
              <div className="cta-row">
                <Link className="btn btn-primary btn-lg" to="/quote">Get an instant quote</Link>
                <Link className="btn btn-outline btn-lg" to="/replacement-parts">No CAD? Send a photo</Link>
              </div>
              <p className="next-note">
                Or call <a href={brand.phoneHref}>{brand.phone}</a>. It rings the person who runs the machines.
              </p>
              <div className="chips" style={{ marginTop: 20 }}>
                {['.step', '.stp', '.stl', '.iges', '.3mf', '.dxf'].map((f) => <span key={f} className="chip" style={{ fontFamily: 'var(--font-mono)' }}>{f}</span>)}
              </div>
            </div>
            <ShopPhoto id="tray-stack-edge" loading="eager" style={{ aspectRatio: '4 / 5', maxHeight: 560 }} />
          </div>
        </div>
      </section>

      {/* ─── Facts ─── */}
      <section className="section-tight section-alt">
        <div className="pub-wrap">
          <div className="stat-row stat-row-4">
            {STATS.map(([b, s]) => <div key={b} className="stat"><b>{b}</b><span>{s}</span></div>)}
          </div>
        </div>
      </section>

      {/* ─── Three doors ─── */}
      <section className="section">
        <div className="pub-wrap">
          <div style={{ maxWidth: 640, marginBottom: 32 }}>
            <div className="eyebrow" style={{ marginBottom: 10 }}>Start here</div>
            <h2 className="display">Three ways in. Pick the one that matches what is in your hand.</h2>
          </div>
          <div className="grid-3">
            {DOORS.map((d) => (
              <Link key={d.to} to={d.to} className="card door">
                <h3 className="display">{d.h}</h3>
                <p>{d.p}</p>
                <span className="door-cta">{d.cta} →</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* ─── Processes ─── */}
      <section className="section section-alt">
        <div className="pub-wrap">
          <div style={{ maxWidth: 640, marginBottom: 36 }}>
            <div className="eyebrow" style={{ marginBottom: 10 }}>What we do</div>
            <h2 className="display">Three ways to make a plastic part. The quote tool prices all three.</h2>
          </div>
          <div className="grid-3">
            <ProcessCard
              to="/machining"
              photo="acetal-clamps"
              title="CNC Machining"
              sub={ok('turning') ? 'Milling and turning' : 'Milling'}
              text={'Blocks, brackets, housings, wear pads and guides. '
                + when(['mill-tormach', 'mill-bridgeport'], (a, b) => `${a} and a ${b}. `)
                + 'Parts up to 18" × 9.5" × 12" price online. Plastics first; 6061 and brass for the part that mates with yours.'}
              chips={['Delrin', 'UHMW', 'Nylon', 'PEEK', 'Ultem', 'PTFE', '6061']}
            />
            <ProcessCard
              to="/routing"
              photo="disc-stacks"
              title="CNC Routing"
              sub="Sheet and plate"
              text={'Flat parts cut from 4\' × 8\' sheet, with pockets, holes and counterbores in the same setup. Usually the cheapest way to make a flat plastic part in quantity.'}
              chips={['HDPE', 'UHMW', 'Acetal', 'Polycarbonate', 'Acrylic', 'G-10', 'Phenolic']}
            />
            <ProcessCard
              to="/3d-printing"
              photo="fdm-print"
              title="3D Printing"
              sub="FDM and SLA"
              text="Prototypes, fixtures and short runs. Print the fit check first, then machine the production part from the same file."
              chips={['PLA', 'PETG', 'ABS', 'Nylon', 'TPU', 'SLA resin']}
            />
          </div>
          <p className="next-note" style={{ marginTop: 24 }}>
            Not sure which process, or which plastic? <Link to="/parts">Parts by type</Link> says what each kind of part is usually made from.
          </p>
        </div>
      </section>

      {/* ─── Work ─── */}
      <section id="work" className="section">
        <div className="pub-wrap">
          <div className="flex-between" style={{ alignItems: 'flex-end', marginBottom: 28, flexWrap: 'wrap', gap: 12 }}>
            <div style={{ maxWidth: 600 }}>
              <div className="eyebrow" style={{ marginBottom: 10 }}>{captioned ? 'Recent work' : 'From the shop'}</div>
              <h2 className="display">{captioned ? 'Recent work. Material, thickness and quantity under each.' : 'Milled, routed and printed plastic.'}</h2>
            </div>
            <span style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 300 }}>Customer names and part numbers are never shown. Yours will not be either.</span>
          </div>
          <div className="photo-grid">
            {GALLERY.map((id) => <ShopPhoto key={id} id={id} sizes="(max-width: 720px) 100vw, (max-width: 900px) 50vw, 33vw" />)}
          </div>
        </div>
      </section>

      {/* ─── Worked price example (owner approves the numbers first) ─── */}
      {ok('price-example') && (
        <section className="section-tight section-alt">
          <div className="pub-wrap" style={{ maxWidth: 860 }}>
            <div className="eyebrow" style={{ marginBottom: 10 }}>A real price</div>
            <p className="lede">{fact('price-example')}</p>
          </div>
        </section>
      )}

      {/* ─── How ordering works ─── */}
      <section className="section section-alt">
        <div className="pub-wrap">
          <div style={{ maxWidth: 560, marginBottom: 36 }}>
            <div className="eyebrow" style={{ marginBottom: 10 }}>How it works</div>
            <h2 className="display">No sales call unless you want one.</h2>
          </div>
          <div className="grid-4">
            {STEPS.map(([n, t, d]) => (
              <div key={n} className="card" style={{ padding: 24 }}>
                <div aria-hidden="true" style={{ fontFamily: 'var(--font-display)', fontSize: 30, fontWeight: 700, color: 'var(--accent)', opacity: 0.35, marginBottom: 8 }}>{n}</div>
                <h3 className="display" style={{ fontSize: 17, marginBottom: 8 }}>{t}</h3>
                <p style={{ fontSize: 13.5, color: 'var(--text-muted)', lineHeight: 1.65 }}>{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── Plastics move ─── */}
      <section className="section">
        <div className="pub-wrap">
          <div className="hero-grid" style={{ gap: 48 }}>
            <ShopPhoto id="brackets-inspection" style={{ aspectRatio: '4 / 5', maxHeight: 520 }} />
            <div>
              <div className="eyebrow" style={{ marginBottom: 10 }}>What plastic will hold</div>
              <h2 className="display" style={{ marginBottom: 18 }}>{ok('practice-rest') ? 'Plastics move. We measure for it.' : 'Plastics move. Buy the part with that in mind.'}</h2>
              <ul className="checklist" style={{ marginBottom: 20 }}>{MOVES.map((m) => <li key={m}>{m}</li>)}</ul>
              <p className="body-copy" style={{ marginBottom: 24 }}>
                This shop is not ISO 9001 certified. If your supplier approval requires the certificate, it is better you know that now.
              </p>
              <Link to="/quality" className="btn btn-outline">What gets checked, and how</Link>
            </div>
          </div>
        </div>
      </section>

      {/* ─── Where ─── */}
      <section className="section-tight section-alt">
        <div className="pub-wrap">
          <div className="split">
            <div>
              <div className="eyebrow" style={{ marginBottom: 10 }}>Where</div>
              <h2 className="display h2-sm" style={{ marginBottom: 0 }}>{brand.city}, {brand.region}.</h2>
            </div>
            <p className="body-copy" style={{ fontSize: 15 }}>
              Lake County, the northern suburbs, Kenosha and Milwaukee are a drive. Everywhere else is a box.
              {when('drive-times', (v) => ` ${v}`)}
              {when('visits-welcome', ' Drop a part off or pick an order up; call ahead.')}
              {when('shop-hours', (v) => ` ${v}`)}
              {' '}Central time. <a href={brand.phoneHref}>{brand.phone}</a>
            </p>
          </div>
        </div>
      </section>

      {/* ─── CTA ─── */}
      <section className="section section-dark">
        <div className="pub-wrap" style={{ textAlign: 'center' }}>
          <h2 className="display" style={{ color: '#F8FAFC', marginBottom: 12 }}>Have a print? Send it.</h2>
          <p style={{ color: '#CBD5E1', fontSize: 16, maxWidth: 540, margin: '0 auto 28px', lineHeight: 1.6 }}>
            No print? <Link to="/replacement-parts" style={{ color: '#fff' }}>Send a photo.</Link> Either way you are talking to the person who runs the machine.
          </p>
          <div className="cta-row" style={{ justifyContent: 'center' }}>
            <Link className="btn btn-primary btn-lg btn-on-dark" to="/quote">Get an instant quote</Link>
            <a className="btn btn-lg btn-dark-outline" href={brand.phoneHref}>{brand.phone}</a>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}

function ProcessCard({ to, photo, title, sub, text, chips }) {
  const p = shopPhoto(photo);
  return (
    <Link to={to} className="card proc-card" style={{ textDecoration: 'none' }}>
      <div className="photo-frame"><Photo src={p.src} alt={p.alt} loading="lazy" sizes="(max-width: 768px) 100vw, 33vw" /></div>
      <div>
        <h3 className="display" style={{ marginBottom: 2 }}>{title}</h3>
        <div style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>{sub}</div>
      </div>
      <p style={{ fontSize: 13.5, color: 'var(--text-muted)', lineHeight: 1.65 }}>{text}</p>
      <div className="chips">{chips.map((c) => <span key={c} className="chip">{c}</span>)}</div>
    </Link>
  );
}
