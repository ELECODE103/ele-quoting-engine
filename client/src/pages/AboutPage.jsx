import { Link } from 'react-router-dom';
import PublicLayout from '../components/PublicLayout';
import ShopPhoto from '../components/ShopPhoto';
import brand from '../brand';
import { KerfMark } from '../components/Wordmark';
import { ok, fact, when, lines, QUALITY_LINE, HOLDS } from '../facts';

const LIMIT = brand.rfqQuantityThreshold;

// "Deals square", spelled out: each line is something a buyer can check on the
// site or on the order. Owner-dependent lines hang on shared/shop-facts.json.
const DEAL = lines([
  `The price is on the page. Upload a STEP file and see it; no account needed to look. Up to ${LIMIT} pieces checks out by card.`,
  HOLDS ? `Tolerances are stated by material, not as one number for every plastic: ${HOLDS}.` : null,
  'The limits are printed: the part sizes the quote tool takes, sheet thickness, corner radii, and what goes to a person before it can be bought.',
  { needs: 'finishes-sent-out', text: (v) => `What leaves the building is named. ${v}` },
  'Plastic first. 6061 and brass are priced online for the part that mates with your plastic one. For heavy aluminum production a metal shop will serve you better, and we will say so.',
]);

const PAPERWORK = lines([
  { needs: ['legal-name', 'parent-company'], text: (n) => `${n}, wholly owned by ${brand.parentName}.` },
  { needs: 'paperwork-packet' },
  'Card checkout on instant orders. No account needed until you pay.',
  { needs: 'net-terms' },
  { needs: 'sam-registered', text: 'Registered on SAM.gov.' },
  'A firm quote in writing for anything the quote tool sends to a person, with the price, the lead time and the date it holds until.',
  QUALITY_LINE || null,
  'Customer names and part numbers are never published. That includes yours.',
]);

export default function AboutPage() {
  return (
    <PublicLayout>
      <section className="section" style={{ paddingTop: 48 }}>
        <div className="pub-wrap">
          <div className="hero-grid" style={{ alignItems: 'start' }}>
            <div>
              <div className="eyebrow" style={{ marginBottom: 14 }}>About</div>
              <h1 className="display" style={{ marginBottom: 18 }}>A machine shop that deals square.</h1>
              <p className="lede" style={{ marginBottom: 18 }}>
                A straightedge is the reference a machinist checks everything else against. It is also what you call someone who
                deals square. We named the shop after both on purpose.
              </p>
              <p className="body-copy" style={{ fontSize: 15, marginBottom: 14 }}>
                {brand.name} is a plastics machine shop in {brand.city}, Illinois. We do one thing: machined plastic
                parts, cut from block{ok('turning') ? ', rod' : ''} and sheet, with 3D printing for the prototype that comes first.
                {when('owner-name', (n) => ` The shop is run by ${n}${when('engineer-title', (t) => `, a ${t}`)}.`)}
                {when('founded-year', (v) => ` ${v}`)}{when('about-origin', (v) => ` ${v}`)}
              </p>
              <p className="body-copy" style={{ fontSize: 15, marginBottom: 14 }}>
                The shop is engineer-led. {fact('engineer-led') || 'Call and you reach the engineer running your job.'} So
                a question about a wall, a bore or a tolerance goes straight to the engineer running your job, before the
                order and after it.
              </p>
              <p className="body-copy" style={{ fontSize: 15, marginBottom: 22 }}>
                Dealing square also means saying no early. If a part does not belong in this shop, or we cannot make your date,
                we say so before you order.{when('continuity-handover', ' Your program and setup notes are yours on request, so you are never locked to this shop.')}{' '}
                <Link to="/quality">What gets checked, and what paper comes with the order</Link>.
              </p>
              <div className="cta-row">
                <a className="btn btn-primary btn-lg" href={brand.phoneHref}>Call {brand.phone}</a>
                <Link className="btn btn-outline btn-lg" to="/quote">Get an instant quote</Link>
              </div>
              <p className="next-note">The number rings the shop, not a sales desk. Have a STEP file? The quote tool shows a price in a few seconds, no account needed.</p>
            </div>
            <div>
              <ShopPhoto id="disc-hand" loading="eager" style={{ aspectRatio: '4 / 5', maxHeight: 480 }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 20 }}>
                <KerfMark size={64} title="The Straightedge mark: a square of stock parted by one straight cut" />
                <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, margin: 0 }}>
                  The mark is a square of stock parted by one straight cut: a machined edge above, printed layers below.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section section-alt">
        <div className="pub-wrap">
          <div className="grid-3" style={{ alignItems: 'start' }}>
            <div>
              <h2 className="display h3-like">Who this shop is set up for</h2>
              <ul className="checklist">
                <li>An engineer with a STEP file who wants a price without a phone call.</li>
                <li>A buyer with a drawing and a quantity who wants a firm number and a direct line to the engineer running the job.</li>
                <li>Someone keeping a line running, holding a worn plastic part and no drawing.</li>
                <li>Lake County, the northern suburbs, Kenosha and Milwaukee are a drive. Everywhere else is a box.</li>
              </ul>
            </div>
            <div>
              <h2 className="display h3-like">How we deal</h2>
              <ul className="checklist">{DEAL.map((t) => <li key={t}>{t}</li>)}</ul>
            </div>
            <div>
              <h2 className="display h3-like">Paperwork</h2>
              <ul className="checklist">{PAPERWORK.map((t) => <li key={t}>{t}</li>)}</ul>
            </div>
          </div>
          {ok('under-one-roof') && (
            <p className="body-copy" style={{ fontSize: 15, marginTop: 36, maxWidth: 820 }}>
              <b>Also in the building:</b> {fact('under-one-roof')}
              {ok('parent-company') && <> Metal fabrication is quoted through <a href={brand.parentUrl} target="_blank" rel="noreferrer">Erik Lutz Enterprise</a>.</>}
            </p>
          )}
        </div>
      </section>

      <section className="section">
        <div className="pub-wrap" style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ maxWidth: 620 }}>
            <h2 className="display h2-sm" style={{ marginBottom: 6 }}>{ok('visits-welcome') ? 'Come see the shop.' : 'Ask the engineer.'}</h2>
            <p className="body-copy" style={{ fontSize: 15 }}>
              {brand.city}, Illinois. Central time.{when('shop-hours', (v) => ` ${v}`)}
              {when('visits-welcome', ' Call ahead so we are at the door and not at a machine.', ' A tolerance, a material, whether your part belongs here at all: call.')}
            </p>
          </div>
          <div className="cta-row">
            <a className="btn btn-outline btn-lg" href={brand.phoneHref}>{brand.phone}</a>
            <Link className="btn btn-ghost btn-lg" to="/rfq">Request a firm quote</Link>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
