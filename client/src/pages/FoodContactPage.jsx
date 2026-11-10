import { Link } from 'react-router-dom';
import PublicLayout from '../components/PublicLayout';
import brand from '../brand';
import { ok, fact, when, lines } from '../facts';

const WITH_JOB = lines([
  { needs: 'food-docs', text: 'The stock maker\'s food-contact compliance statement for the exact grade and color.' },
  { needs: 'food-docs', text: 'The lot cert for the stock your parts were cut from.' },
  { needs: 'fai-coc', text: 'A certificate of conformance tying that lot to your order.' },
  { needs: 'food-cleaning', text: (v) => `Metal is cut in this shop too. ${v}` },
]);

export default function FoodContactPage() {
  return (
    <PublicLayout>
      <section className="section" style={{ paddingTop: 48 }}>
        <div className="pub-wrap">
          <div style={{ maxWidth: 760, marginBottom: 8 }}>
            <div className="eyebrow" style={{ marginBottom: 14 }}>Food-contact plastics</div>
            <h1 className="display" style={{ marginBottom: 16 }}>Food-contact plastics: what a machine shop can and cannot certify.</h1>
            <p className="lede">
              "FDA approved," "food safe" and "NSF plastic" get used loosely. They mean different things, and none of them is
              something a machine shop can stamp on a part. Here is what each one is, and what to ask for.
            </p>
          </div>
        </div>
      </section>

      <section className="section section-alt" style={{ paddingTop: 48, paddingBottom: 48 }}>
        <div className="pub-wrap">
          <div className="grid-3" style={{ alignItems: 'start' }}>
            <div>
              <h2 className="display h3-like">FDA: a property of the grade</h2>
              <p className="body-copy">
                The FDA does not inspect or approve plastic parts. Its food-contact rules for polymers are in{' '}
                <a href="https://www.ecfr.gov/current/title-21/chapter-I/subchapter-B/part-177" target="_blank" rel="noopener noreferrer">21 CFR Part 177</a>.
                A resin whose composition meets those rules can be called FDA compliant by its maker, who says so in a
                written statement for that grade and color. Natural grades usually have one. Many black, colored
                and filled grades do not.
              </p>
            </div>
            <div>
              <h2 className="display h3-like">USDA, NSF and 3-A: not a property of a plastic</h2>
              <p className="body-copy">
                USDA acceptance for meat and poultry equipment rests on the maker's written guaranty of FDA compliance.
                NSF certifies a finished product in a specific use. 3-A accepts materials by product, grade, form and supplier.
                None of the three attaches to "UHMW" or "acetal" in general, or to the shop that cut it.
              </p>
            </div>
            <div>
              <h2 className="display h3-like">What you actually need in hand</h2>
              <ul className="checklist">
                <li>The maker's compliance statement for the exact grade and color.</li>
                <li>Lot traceability from that stock to your parts.</li>
                <li>A certificate of conformance from whoever machined them.</li>
              </ul>
            </div>
          </div>
          <p className="fineprint">
            Source for the definitions: Boedeker Plastics, <a href="https://boedeker.com/Technical-Resources/Technical-Library/Agency-Regulatory-Compliance-amp-Standards" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>Agency Regulatory Compliance &amp; Standards</a>.
            This page is a plain-language summary, not regulatory advice. The use of the part is the end user's responsibility.
          </p>
        </div>
      </section>

      <section className="section">
        <div className="pub-wrap">
          <div className="grid-2" style={{ gap: 40, alignItems: 'start' }}>
            <div>
              <h2 className="display h2-sm">What this shop does</h2>
              {WITH_JOB.length > 0 ? (
                <>
                  <p className="body-copy" style={{ fontSize: 15, marginBottom: 12 }}>Tell us the part touches food and which regulation your customer cites. With the job you get:</p>
                  <ul className="checklist">{WITH_JOB.map((t) => <li key={t}>{t}</li>)}</ul>
                </>
              ) : (
                <p className="body-copy" style={{ fontSize: 15 }}>
                  It machines the grade you specify. Tell us the part touches food, name the grade or the regulation your
                  customer cites, and you will be told before you order what paperwork can be had for that stock.
                  If the statement you need cannot be had, you hear that then, not after the parts ship.
                </p>
              )}
              <p className="body-copy" style={{ fontSize: 15, marginTop: 12 }}>
                Plastics commonly sold in food-contact grades: natural acetal, UHMW, HDPE, nylon, polypropylene and virgin PTFE.
                Each has a page under <Link to="/materials">materials</Link>.
              </p>
            </div>
            <div>
              <h2 className="display h2-sm">What this shop does not claim</h2>
              <ul className="checklist">
                <li>That any part is "FDA approved." Nothing is.</li>
                <li>That a plastic is "food safe" because it is white or natural.</li>
                <li>NSF, 3-A or USDA status for the shop or for a part it made.</li>
                <li>That a finished part is fit for your use. That depends on your process, and it is yours to decide.</li>
              </ul>
            </div>
          </div>
          <div className="cta-row" style={{ marginTop: 40 }}>
            <Link className="btn btn-primary btn-lg" to="/rfq">Request a firm quote</Link>
            <a className="btn btn-outline btn-lg" href={brand.phoneHref}>{brand.phone}</a>
          </div>
          <p className="next-note">
            On the form, put "touches food" under where the part lives and name the regulation. The person who will cut the part
            replies{when('quote-turnaround', (v) => ` within ${v}`)} and says what paperwork comes with it.
          </p>
        </div>
      </section>
    </PublicLayout>
  );
}
