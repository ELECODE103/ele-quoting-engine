import { Link } from 'react-router-dom';
import PublicLayout from '../components/PublicLayout';
import ShopPhoto from '../components/ShopPhoto';
import brand from '../brand';
import { fact, when, lines, QUALITY_LINE } from '../facts';

// The page says what is inspected and what is documented. Every practice is the
// owner's (shared/shop-facts.json); the rest is how plastic behaves or what the
// quote tool and the order system do.
const TOOLS = ['insp-surface-plate', 'insp-height-gage', 'insp-gage-pins', 'insp-calipers', 'insp-micrometers', 'insp-bore-gages', 'insp-thread-gages', 'insp-3d-scanner']
  .map((id) => fact(id)).filter(Boolean);

const CHECKED = lines([
  { needs: 'fai-coc', text: 'The first article. On a production order the first part is measured against your print.' },
  'The dimensions you call out. The firm-quote form has a field for the two or three that have to be right; those are the ones that get measured.',
  { needs: 'practice-rest', text: 'Parts sit before we measure them. Plastic relaxes after the cut, and a part measured warm off the machine reads differently the next morning.',
    or: 'Plastic relaxes after the cut, and a part measured warm off the machine reads differently the next morning. Ask when your parts were measured.' },
  { needs: 'inspect-68f', text: 'Measured at 68 °F.' },
  TOOLS.length ? `Measured with: ${TOOLS.join(', ').toLowerCase()}.` : null,
  'The model, before anything is cut. The quote tool checks walls, inside corners, hole depth and part size against the limits printed on the service pages, and a part that fails goes to a person before it can be bought.',
  'If your receiving inspection needs a particular report or gage record, say so in the request. The quote states what comes with the job before you order.',
]);

const WITH_ORDER = lines([
  { needs: 'fai-coc', text: 'A certificate of conformance. It lists each part with its revision, material and quantity, states that the parts were made and inspected to your drawing and purchase order, and is signed.' },
  { needs: 'lot-traceability', text: 'The material lot, written on the certificate against each line, so a part can be traced back to the stock it was cut from.' },
  { needs: 'material-certs', text: 'The stock maker\'s or distributor\'s material cert, passed through when you ask for it.' },
  { needs: 'traveler', text: 'A traveler on every job that ties the stock lot and the program revision to your order.' },
  { needs: 'continuity-handover', text: 'Your program and setup notes, on request. They are yours.' },
]);

const DIFFERENT = lines([
  'It expands five to ten times as much as steel for the same temperature change. A two-foot polyethylene part cannot hold the tolerance a two-foot steel part can.',
  'Nylon takes on water and grows, up to about 2% in length when saturated. A nylon tolerance needs a stated condition.',
  'Clamping distorts it. A part that measures right in the vise can spring when it is let go.',
  { needs: 'practice-air-blast' },
  'So every tolerance here carries a material. If your print asks for something the material will not keep, you hear that before anything is cut, with what we would do instead.',
]);

const WRONG = lines([
  `Call ${brand.phone}. You reach the engineer who ran the job, not a ticket queue.`,
  { needs: 'warranty' },
  'If the fault is in the drawing or the material and not in the cut, we say that too, with what we would change.',
  { needs: 'corrective-action', text: 'A corrective-action note goes in the job file so the reorder does not repeat it.' },
  'Or reply to any order email and say which dimension is off. It comes to the same place.',
  'Sooner is better. Send the print with the request, call out what matters, and we flag the features we are unsure about before cutting.',
]);

// Dates and status: what the order system does, plus the lead times and
// finishing facts the owner confirmed.
const ON_THE_ORDER = lines([
  { needs: ['lead-standard', 'lead-expedited'], text: (std, exp) => `Standard lead time is ${std}; expedited is ${exp}. The ship-by date shows at checkout before you pay.`,
    or: 'The ship-by date shows at checkout before you pay.' },
  'The same date is on the order confirmation, and your order page shows where the job stands.',
  'A drawing sent with an order is reviewed before cutting. If it changes the price, you hear from us before work starts.',
  { needs: 'finishes-sent-out', text: (v) => `${v} Parts with a sent-out finish ship on the standard lead time.` },
  'When the order ships you get an email, with the carrier and tracking number when there is one.',
]);

export default function QualityPage() {
  return (
    <PublicLayout>
      <section className="section" style={{ paddingTop: 48 }}>
        <div className="pub-wrap">
          <div className="hero-grid">
            <div>
              <div className="eyebrow" style={{ marginBottom: 14 }}>Quality</div>
              <h1 className="display" style={{ marginBottom: 18 }}>What's in the box besides the parts.</h1>
              <p className="lede" style={{ maxWidth: 540, marginBottom: 20 }}>
                A buyer's real question is not "can you make it." It is what gets checked, what paper comes with the parts,
                and what happens when one is wrong. This page answers all three.
              </p>
              <div className="plain-box" style={{ maxWidth: 540 }}>
                <h2 className="display h3-like" style={{ marginBottom: 8 }}>{QUALITY_LINE ? 'With every production order' : 'Say what your receiving inspection needs'}</h2>
                <p className="body-copy">
                  {QUALITY_LINE
                    || 'A first-article inspection, a certificate of conformance, a material cert: name what you need when you ask for the quote. The quote states which of them come with the job, before you order.'}
                  {when('written-procedures', ' The procedures for inspection, traceability and corrective action are written down, and you can read them.')}
                </p>
              </div>
            </div>
            <ShopPhoto id="brackets-inspection" loading="eager" style={{ aspectRatio: '4 / 5', maxHeight: 480 }} />
          </div>
        </div>
      </section>

      <section className="section section-alt">
        <div className="pub-wrap">
          <div className="grid-3" style={{ alignItems: 'start' }}>
            <div>
              <h2 className="display h3-like">What gets checked, and how</h2>
              <ul className="checklist">{CHECKED.map((t) => <li key={t}>{t}</li>)}</ul>
            </div>
            <div>
              <h2 className="display h3-like">How plastic is different</h2>
              <ul className="checklist">{DIFFERENT.map((t) => <li key={t}>{t}</li>)}</ul>
            </div>
            <div>
              <h2 className="display h3-like">When something is wrong</h2>
              <ul className="checklist">{WRONG.map((t) => <li key={t}>{t}</li>)}</ul>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="pub-wrap">
          <div className="grid-2" style={{ gap: 40, alignItems: 'start' }}>
            <div>
              <h2 className="display h2-sm">Paperwork with the order</h2>
              {WITH_ORDER.length > 0
                ? <ul className="checklist">{WITH_ORDER.map((t) => <li key={t}>{t}</li>)}</ul>
                : (
                  <p className="body-copy" style={{ fontSize: 15 }}>
                    Say what your receiving inspection needs when you ask for the quote: a first-article inspection, a certificate of
                    conformance, a material cert. The quote will state in writing which of them come with the job, before you order.
                  </p>
                )}
              <p className="body-copy" style={{ fontSize: 15, marginTop: 12 }}>
                {when('paperwork-packet', (v) => `Supplier forms: ${v}`, 'Supplier forms: send yours with the request and it comes back filled in, or with the line we cannot sign marked.')}
                {' '}Part touches food? Read <Link to="/food-contact">what a machine shop can and cannot certify</Link>.
              </p>
            </div>
            <div>
              <h2 className="display h2-sm">Dates and status, in writing</h2>
              <ul className="checklist">{ON_THE_ORDER.map((t) => <li key={t}>{t}</li>)}</ul>
            </div>
          </div>
          <div className="cta-row" style={{ marginTop: 40 }}>
            <Link className="btn btn-primary btn-lg" to="/rfq">Request a firm quote</Link>
            <a className="btn btn-outline btn-lg" href={brand.phoneHref}>{brand.phone}</a>
          </div>
          <p className="next-note">
            The form takes a drawing, your quantities and the dimensions that matter. The engineer who will run the job reads it and
            replies{when('quote-turnaround', (v) => ` within ${v}`)}. Have a STEP file and under {brand.rfqQuantityThreshold} pieces?{' '}
            <Link to="/quote">See the price now</Link>.
          </p>
        </div>
      </section>
    </PublicLayout>
  );
}
