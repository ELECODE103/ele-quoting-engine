import { Link } from 'react-router-dom';
import PublicLayout from '../components/PublicLayout';
import ShopPhoto from '../components/ShopPhoto';
import brand from '../brand';
import { ok, when, lines } from '../facts';

// Replacement parts are quoted from the physical part, not from a photo
// (owner, 2026-11-11). The ship-to street address is never on this page: it
// comes back from the server after a request is sent, and in the email.
// Whether the original is returned, drop-off, and how soon a price follows
// are the owner's to state (part-return, visits-welcome, part-quote-time).
const REQUEST = '/rfq?nocad=1';
const RETURN_NOTE = when('part-return', (v) => v, 'Tell us in the request if you need the original back.');

const STEPS = [
  ['Tell us about the part',
    'A short request: what the part is and what it does, the machine it came off, the material if you know it, how many you need and how soon. No drawing and no photo.'],
  ['Send us the part',
    'When the request goes in you get a reference and the address to ship to, on the screen and by email. Write the reference on the box.'
    + when('visits-welcome', ` Or drop the part off in ${brand.city}; call ahead.`)
    + ` ${RETURN_NOTE}`],
  when('no-cad-drawing',
    (v) => ['We measure it and draw it', `${v} Where the part is worn, we ask what it runs against and draw it the way it started out.`],
    ['We measure it and send a price', 'The part is measured in the shop. Where it is worn, we ask what it runs against, so the new one is made the way the old one started out.'
      + when('part-quote-time', (v) => ` ${v}`) + ' You get a price before anything is cut.']),
  ['Try the fit first, if the fit matters', 'A 3D printed copy can come first, so you can try it on the machine before the real material is cut.'],
  ['Then it is machined', 'Usually from UHMW or acetal, which is what most guides, wear strips and bushings are made of.'],
];

const SEND = lines([
  'What the part is and what it does.',
  'The machine it came off: make and model if you have it.',
  'What it rides on or runs against, and where it is worn.',
  'The material, if you know it. If not, say what it looks and feels like.',
  'How many you need now, and how soon.',
  ok('part-return') ? null : 'Whether you need the original back.',
]);

const WHY = lines([
  'A photo does not show a worn dimension, a bore or how thick the part is. The part does.',
  'With the part on the bench, the features that have to fit get measured, not estimated from a picture.',
  'Seemingly identical machines do not always take identical parts. Send the one that came off your machine.',
  'More than one worn copy? Send the least worn.',
  `Line cannot run without it? Call ${brand.phone} before you pull the part.`,
  { needs: 'site-visits', text: 'If the part cannot leave the machine, we can come and look at it.' },
  { needs: 'min-order', text: (v) => `Minimum order: ${v}.` },
]);

export default function ReplacementPartsPage() {
  return (
    <PublicLayout>
      <section className="section" style={{ paddingTop: 48 }}>
        <div className="pub-wrap">
          <div className="hero-grid">
            <div>
              <div className="eyebrow" style={{ marginBottom: 14 }}>Replacement parts</div>
              <h1 className="display" style={{ marginBottom: 18 }}>
                Worn plastic part, no drawing? Send us the part.
              </h1>
              <p className="lede" style={{ marginBottom: 26, maxWidth: 540 }}>
                A guide, wear strip or bushing is worn out. The builder quotes weeks, stopped making it, or is not around anymore.
                You have the part in your hand and no drawing. You do not need one. We work from the part itself.
              </p>
              <div className="cta-row">
                <Link className="btn btn-primary btn-lg" to={REQUEST}>Send us the part</Link>
                <a className="btn btn-outline btn-lg" href={brand.phoneHref}>Call {brand.phone}</a>
              </div>
              <p className="next-note">
                The button opens a short request. Send it and you get a reference to write on the box and the address to ship to.
                We measure the part and send you a price.{when('part-quote-time', (v) => ` ${v}`)} The call rings the shop.
                {when('drive-times', (v) => ` ${v}`)}
              </p>
            </div>
            <ShopPhoto id="uhmw-rack" loading="eager" style={{ aspectRatio: '4 / 3' }} />
          </div>
        </div>
      </section>

      <section className="section section-alt">
        <div className="pub-wrap">
          <div className="split">
            <div>
              <h2 className="display h2-sm">How it goes</h2>
              <p className="body-copy" style={{ fontSize: 15 }}>
                Wear strips, guides, lane dividers, bushings, rollers, spacers and guards: the plastic parts that wear out
                on a packaging or processing line long before the machine does.
              </p>
            </div>
            <ol className="steps">
              {STEPS.map(([h, p]) => <li key={h}><div><b>{h}</b><span>{p}</span></div></li>)}
            </ol>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="pub-wrap">
          <div className="grid-2" style={{ gap: 40, alignItems: 'start' }}>
            <div>
              <h2 className="display h2-sm">What to put in the request</h2>
              <ul className="checklist">{SEND.map((t) => <li key={t}>{t}</li>)}</ul>
            </div>
            <div>
              <h2 className="display h2-sm">Why the part, and not a photo</h2>
              <ul className="checklist">{WHY.map((t) => <li key={t}>{t}</li>)}</ul>
            </div>
          </div>
          <div className="cta-row" style={{ marginTop: 40 }}>
            <Link className="btn btn-primary btn-lg" to={REQUEST}>Send us the part</Link>
            <a className="btn btn-outline btn-lg" href={brand.phoneHref}>{brand.phone}</a>
          </div>
          <p className="next-note">
            Already have a drawing or a STEP file? <Link to="/rfq">Request a firm quote</Link> or <Link to="/quote">see a price now</Link>.
            Not sure what it is made of? <Link to="/parts">Parts by type</Link> lists the usual material for each kind of part.
          </p>
        </div>
      </section>
    </PublicLayout>
  );
}
