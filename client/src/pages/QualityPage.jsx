import { Link } from 'react-router-dom';
import PublicLayout from '../components/PublicLayout';
import ShopPhoto from '../components/ShopPhoto';
import brand from '../brand';
import { ok, fact, when, lines } from '../facts';

const TOOLS = ['insp-surface-plate', 'insp-height-gage', 'insp-gage-pins', 'insp-calipers', 'insp-micrometers', 'insp-bore-gages', 'insp-thread-gages', 'insp-3d-scanner']
  .map((id) => fact(id)).filter(Boolean);

const CHECKED = lines([
  'The dimensions you call out. The firm-quote form has a field for the two or three that have to be right; those are the ones that get measured.',
  { needs: 'practice-rest', text: 'Parts sit before I measure them. Plastic relaxes after the cut, and a part measured warm off the machine reads differently the next morning.',
    or: 'Plastic relaxes after the cut, and a part measured warm off the machine reads differently the next morning. Ask when your parts were measured.' },
  { needs: 'inspect-68f', text: 'Measured at 68 °F.' },
  'Everything is measured by hand. There is no CMM in this shop.' + (TOOLS.length ? ` What is here: ${TOOLS.join(', ').toLowerCase()}.` : ''),
  'If your print needs a CMM report or a calibrated-gage record, say so before you order and I will tell you whether I can meet it.',
]);

const WITH_ORDER = lines([
  { needs: 'fai-coc', text: (v) => `A first-article inspection report against your print and a certificate of conformance with the material lot, with ${v}.` },
  { needs: 'material-certs', text: 'The stock maker\'s or distributor\'s material cert, passed through when you ask for it.' },
  { needs: 'traveler', text: 'A traveler on every job that ties the stock lot and the program revision to your order.' },
]);

const DIFFERENT = lines([
  'It expands five to ten times as much as steel for the same temperature change. A two-foot polyethylene part cannot hold the tolerance a two-foot steel part can.',
  'Nylon takes on water and grows, up to about 2% in length when saturated. A nylon tolerance needs a stated condition.',
  'Clamping distorts it. A part that measures right in the vise can spring when it is let go.',
  { needs: 'practice-air-blast' },
  'So every tolerance here carries a material. If your print asks for something the material will not keep, you hear that before anything is cut, with what I would do instead.',
]);

const WRONG = lines([
  `Call ${brand.phone}. It rings the person who cut the part, not a ticket queue.`,
  { needs: 'warranty' },
  'If the fault is in the drawing or the material and not in the cut, I will say that too, with what I would change.',
  { needs: 'corrective-action', text: 'A corrective-action note goes in the job file so the reorder does not repeat it.' },
  'Sooner is better. Send the print with the request, call out what matters, and I will flag the features I am unsure about before cutting.',
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
                A buyer's real question isn't "can you make it," it's "what happens when it's wrong." This page answers that,
                starting with the thing most likely to rule this shop out.
              </p>
              <div className="plain-box" style={{ maxWidth: 540 }}>
                <h2 className="display h3-like" style={{ marginBottom: 8 }}>Not ISO 9001 certified.</h2>
                <p className="body-copy">
                  If your supplier approval requires the certificate, this is not your shop yet, and it is better you know that now.
                  {when(['fai-coc', 'traveler', 'corrective-action'], ' If it requires traceability, a first-article report and a corrective-action record, those come with the job.')}
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
              <h2 className="display h2-sm">The one-person question</h2>
              <p className="body-copy" style={{ fontSize: 15, marginBottom: 12 }}>
                This is a one-person shop, and one person is a risk. Here is how I manage it.
                {when('continuity-handover', ' Your program, setup notes and first-article report are yours on request, so another shop can pick the part up where I left it and you are never locked to this one.')}
                {' '}I do not take a job I cannot finish by the date on the quote, and if something changes you hear it from me that day.
              </p>
              <p className="body-copy" style={{ fontSize: 15 }}>
                For a part your line cannot run without, keep a second source or a shelf of spares. I would tell you that even if I had fifty people.
                {when('capacity', (v) => ` What one person can run: ${v}`)}
              </p>
            </div>
            <div>
              <h2 className="display h2-sm">Paperwork with the order</h2>
              {WITH_ORDER.length > 0
                ? <ul className="checklist">{WITH_ORDER.map((t) => <li key={t}>{t}</li>)}</ul>
                : (
                  <p className="body-copy" style={{ fontSize: 15 }}>
                    Say what your receiving inspection needs when you ask for the quote: a first-article report, a certificate of
                    conformance, a material cert. The quote will state in writing which of them come with the job, before you order.
                  </p>
                )}
              <p className="body-copy" style={{ fontSize: 15, marginTop: 12 }}>
                {when('paperwork-packet', (v) => `Supplier forms: ${v}`, 'Supplier forms: send yours with the request and it comes back filled in, or with the line I cannot sign marked.')}
                {' '}Part touches food? Read <Link to="/food-contact">what a machine shop can and cannot certify</Link>.
              </p>
            </div>
          </div>
          <div className="cta-row" style={{ marginTop: 40 }}>
            <Link className="btn btn-primary btn-lg" to="/rfq">Request a firm quote</Link>
            <a className="btn btn-outline btn-lg" href={brand.phoneHref}>{brand.phone}</a>
          </div>
          <p className="next-note">
            The form takes a drawing, your quantities and the dimensions that matter. The person who will cut the part reads it and
            replies{when('quote-turnaround', (v) => ` within ${v}`)}. Have a STEP file and under {brand.rfqQuantityThreshold} pieces?{' '}
            <Link to="/quote">See the price now</Link>.
          </p>
        </div>
      </section>
    </PublicLayout>
  );
}
