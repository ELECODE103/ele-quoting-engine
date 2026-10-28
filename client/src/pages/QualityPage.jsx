import { useNavigate } from 'react-router-dom';
import PublicLayout from '../components/PublicLayout';
import brand from '../brand';

export default function QualityPage() {
  const navigate = useNavigate();
  return (
    <PublicLayout
      title="Quality"
      description={`How ${brand.name} inspects machined plastic parts: first-article reports, certificates of conformance, material certs, traceability, and a documented path to ISO 9001.`}
    >
      <section className="section" style={{ paddingTop: 48 }}>
        <div className="pub-wrap">
          <div className="hero-grid">
            <div>
              <div className="eyebrow" style={{ marginBottom: 14 }}>Quality</div>
              <h1 className="display" style={{ marginBottom: 18 }}>What's in the box besides the parts.</h1>
              <p className="lede" style={{ maxWidth: 540 }}>
                A buyer's real question isn't "can you make it," it's "what happens when it's wrong." Here is what we do so it
                isn't, and what we send so you can prove it to your own customer.
              </p>
            </div>
            <div className="photo-frame" style={{ aspectRatio: '4 / 5', maxHeight: 480 }}>
              <img className="photo" src="/photos/brackets-inspection.jpg" alt="Height gage and acetal brackets on a granite surface plate" loading="eager" />
              <div className="cap">Surface plate, height gage, gage pins, calipers. Checked at 68 °F.</div>
            </div>
          </div>
        </div>
      </section>

      <section className="section section-alt">
        <div className="pub-wrap">
          <div className="grid-3" style={{ alignItems: 'start' }}>
            <div>
              <h3 className="display" style={{ marginBottom: 14 }}>With every production order</h3>
              <ul className="checklist">
                <li><b>First-article inspection report</b> on the first piece, against your drawing's dimensions — the critical ones you called out, recorded with the instrument used.</li>
                <li><b>Certificate of conformance</b> stating material, grade, lot and drawing revision.</li>
                <li><b>Material certs</b> passed through from the distributor on request. FDA / USDA grades identified on the paperwork.</li>
                <li><b>Traceability:</b> each job has a traveler tying stock lot, program revision, machine and inspection to your PO.</li>
              </ul>
            </div>
            <div>
              <h3 className="display" style={{ marginBottom: 14 }}>How plastic is different</h3>
              <ul className="checklist">
                <li>Acetal, nylon and UHMW expand with heat and nylon with moisture. Parts are machined, allowed to normalize, then measured — not measured hot off the spindle.</li>
                <li>Clamping distorts plastic. Fixtures are built to hold without crushing, and thin parts are cut in steps so they don't spring.</li>
                <li>Sharp, polished tooling and air blast instead of flood where the material wants it. No melted edges, no smeared bores.</li>
                <li>Tolerances are quoted for the material: ±0.005" standard on plastics, tighter on called-out features, with the as-shipped condition stated.</li>
              </ul>
            </div>
            <div>
              <h3 className="display" style={{ marginBottom: 14 }}>When something is wrong</h3>
              <ul className="checklist">
                <li>You get a person on the phone the same day — the person who ran the job.</li>
                <li>Nonconforming parts are replaced or reworked on our dime; we don't argue over a thousandth that's on the print.</li>
                <li>A corrective-action note goes in the job file so the reorder doesn't repeat it.</li>
                <li>We'd rather know early: send the print with the RFQ, call out what matters, and we'll flag the features we're unsure about before cutting.</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="pub-wrap">
          <div className="grid-2" style={{ gap: 40, alignItems: 'start' }}>
            <div>
              <h2 className="display" style={{ fontSize: 24, marginBottom: 12 }}>Inspection equipment</h2>
              <ul className="checklist">
                <li>Granite surface plate and height gage</li>
                <li>Gage pin sets, thread gages</li>
                <li>Calipers to 8", micrometers</li>
                <li>Bore gages and indicators for turned work</li>
                <li>Handheld 3D scanner for as-built capture and reverse engineering</li>
              </ul>
            </div>
            <div>
              <h2 className="display" style={{ fontSize: 24, marginBottom: 12 }}>ISO 9001</h2>
              <p style={{ fontSize: 14.5, color: 'var(--text-muted)', lineHeight: 1.7, marginBottom: 12 }}>
                We are building the shop's quality system to ISO 9001 and will register when the paperwork has earned it.
                Today that means written procedures for inspection, calibration, traceability and corrective action, and
                records you can audit. If your supplier approval needs the certificate, tell us; if it needs the behavior,
                you already have it.
              </p>
              <p style={{ fontSize: 14.5, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                Supplier-qualification forms, W-9, certificate of insurance and NDAs returned within a business day.
              </p>
            </div>
          </div>
          <div style={{ marginTop: 40 }}>
            <button className="btn btn-primary btn-lg" onClick={() => navigate('/quote')}>Get an instant quote</button>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
