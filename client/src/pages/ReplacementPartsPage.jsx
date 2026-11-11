import { Link } from 'react-router-dom';
import PublicLayout from '../components/PublicLayout';
import ShopPhoto from '../components/ShopPhoto';
import brand from '../brand';
import { ok, when, lines } from '../facts';

const visits = ok('visits-welcome');

const STEPS = [
  ['Send a photo' + (visits ? ', or bring the part in' : ''),
    'Lay a tape measure next to the worn part and take a picture with your phone. Say what machine it came off and what it runs against.'
    + when('phone-texts', ` You can text it to ${brand.phone}.`)
    + (visits ? ` Or drop the part off in ${brand.city}; call ahead.` : '')],
  when('no-cad-drawing',
    (v) => ['It gets measured and drawn', `${v} Where the part is worn, I ask what it runs against and draw it the way it started out.`],
    ['A person looks at it', 'The person who would make the part looks at the photo and tells you whether it can be made from that, or what else is needed: one more dimension, a second photo, or the part itself.']),
  ['Try the fit first, if the fit matters', 'A 3D printed copy can come first, so you can try it on the machine before the real material is cut.'],
  ['Then it is machined', 'Usually from UHMW or acetal, which is what most guides, wear strips and bushings are made of. You get a price before anything is cut.'],
];

const SEND = lines([
  'A photo with a tape measure or a ruler in it. Two angles if the part is not flat.',
  'The machine it came off: make and model if you have it.',
  'What it rides on or runs against, and where it is worn.',
  'The material, if you know it. If not, say what it looks and feels like.',
  'How many you need now, and how soon.',
]);

const LIMITS = lines([
  'A photo does not show a worn dimension. Expect a question or two back before a price.',
  'Some parts cannot be made from a photo. If I need the part in hand, or a dimension you have to take off the machine, I will say so.',
  'Seemingly identical machines do not always take identical parts. Measure the one that is on your machine.',
  { needs: 'site-visits', text: 'If the part cannot leave the machine, I can come and look at it.' },
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
                Worn plastic part, no drawing? {visits ? 'Bring it in.' : 'Send a photo.'}
              </h1>
              <p className="lede" style={{ marginBottom: 26, maxWidth: 540 }}>
                A guide, wear strip or bushing is worn out. The builder quotes weeks, stopped making it, or is not around anymore.
                You have the part in your hand and no drawing. You do not need one to ask.
              </p>
              <div className="cta-row">
                <a className="btn btn-primary btn-lg" href={brand.phoneHref}>Call {brand.phone}</a>
                <Link className="btn btn-outline btn-lg" to="/rfq?nocad=1">Send a photo</Link>
              </div>
              <p className="next-note">
                The call rings the person who would make the part. The photo form takes one picture and a few short answers,
                and the reply comes from the same person{when('quote-turnaround', (v) => ` within ${v}`)}.
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
              <h2 className="display h2-sm">What to send</h2>
              <ul className="checklist">{SEND.map((t) => <li key={t}>{t}</li>)}</ul>
            </div>
            <div>
              <h2 className="display h2-sm">What a photo will not tell me</h2>
              <ul className="checklist">{LIMITS.map((t) => <li key={t}>{t}</li>)}</ul>
            </div>
          </div>
          <div className="cta-row" style={{ marginTop: 40 }}>
            <Link className="btn btn-primary btn-lg" to="/rfq?nocad=1">Send a photo</Link>
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
