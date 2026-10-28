import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import PublicLayout from '../components/PublicLayout';
import { api } from '../utils/api';
import brand from '../brand';

// Plain-language notes per material family. Keyed by slug prefix match.
const NOTES = [
  { match: ['delrin', 'acetal'], use: 'Bushings, gears, wear parts, precision housings. The default plastic for a machined part.', why: 'Stiff, dimensionally stable, low friction, machines like butter. Homopolymer (Delrin) is a little stiffer; copolymer has no centerline porosity in thick rod.', watch: 'Not for chlorine or strong acids. Natural acetal is FDA-compliant.' },
  { match: ['uhmw'], use: 'Conveyor guides, wear strips, chute liners, star wheels, cutting-board duty.', why: 'Best abrasion resistance of any common plastic, very slippery, takes impact, cheap.', watch: 'Soft and gummy to machine — tolerances are looser than acetal. Moves with temperature on long parts.' },
  { match: ['hdpe'], use: 'Trays, totes, tanks, cutting boards, marine and outdoor parts.', why: 'Cheap, tough, chemical-resistant, FDA grades available. Routes fast from sheet.', watch: 'Low stiffness; not for tight-tolerance parts. Nothing sticks to it, including paint.' },
  { match: ['nylon'], use: 'Gears, sprockets, rollers, bearings, sheaves, structural parts that get hit.', why: 'Strong and tough with good wear life. Cast nylon for big blocks; oil-filled grades for dry bearings.', watch: 'Absorbs moisture and grows — up to 2–3% in wet service. We machine it dry and tell you the as-shipped size.' },
  { match: ['peek'], use: 'High-heat seals, bushings and insulators; pump and valve parts; medical and semiconductor fixtures.', why: 'Continuous service to about 480 °F, excellent chemical and wear resistance, holds tolerance.', watch: 'Expensive stock — the material is most of the price. Send the drawing so we can size stock tight.' },
  { match: ['ultem', 'pei'], use: 'Electrical insulators, high-temp fixtures, sterilizable parts.', why: 'Stiff and strong to about 340 °F, flame-rated, transparent amber.', watch: 'Notch-sensitive; keep inside corners radiused.' },
  { match: ['ptfe', 'teflon'], use: 'Seals, seats, slide pads, chemical-service parts, electrical insulators.', why: 'Nothing sticks to it and almost nothing attacks it. Slipperiest material we run.', watch: 'Soft, creeps under load, tolerances are wide. Filled grades (glass, bronze) for wear.' },
  { match: ['polycarbonate'], use: 'Machine guards, windows, covers, lenses.', why: 'Near-unbreakable, clear, machines and polishes well.', watch: 'Scratches and crazes with some solvents. Stress-relieve before polishing if the part is thick.' },
  { match: ['acrylic'], use: 'Displays, windows, light guides, cosmetic covers.', why: 'Optically clear, scratch-resistant, flame-polishes to glass-clear edges.', watch: 'Brittle — radius the corners and don\'t over-tighten fasteners. Cast, not extruded, for machining.' },
  { match: ['pvc'], use: 'Chemical tanks and manifolds, duct, fixtures, signage (expanded PVC).', why: 'Cheap, chemical-resistant, solvent-weldable, easy to machine.', watch: 'Gray Type 1 for structural; expanded PVC is light and soft — not for load.' },
  { match: ['polypropylene'], use: 'Tanks, chemical fixtures, cutting boards, lab parts.', why: 'Chemical resistance close to PTFE at a fraction of the price. FDA grades.', watch: 'Flexible and hard to hold tight tolerances on. Warps if machined unevenly.' },
  { match: ['g10', 'g-10', 'fr-4'], use: 'Electrical insulators, test fixtures, structural plates, knife scales.', why: 'Very stiff and strong, dimensionally stable, excellent insulator.', watch: 'Abrasive — eats tooling, so it prices above plastics. Dust control required.' },
  { match: ['phenolic'], use: 'Wear pads, gears, insulators, bearing retainers, test fixtures.', why: 'Stiff, stable, cheap insulator with good wear life.', watch: 'Abrasive and the edges can fray on through-holes; we use climb cuts and backing.' },
  { match: ['aluminum', '6061'], use: 'Brackets, plates, housings, fixtures — anything that mates with metal.', why: 'Light, stiff, machines fast, anodizes.', watch: 'Priced per the same model as plastics; for heavy aluminum production you may be better served by a dedicated metal shop.' },
  { match: ['brass'], use: 'Fittings, bushings, electrical contacts, decorative.', why: 'Free-machining, corrosion-resistant, conductive.', watch: 'Heavy and not cheap.' },
];

function noteFor(m) {
  const hay = `${m.slug} ${m.name}`.toLowerCase();
  return NOTES.find((n) => n.match.some((k) => hay.includes(k)));
}

export default function MaterialsPage() {
  const navigate = useNavigate();
  const [cnc, setCnc] = useState([]);
  const [routing, setRouting] = useState([]);
  const [printing, setPrinting] = useState([]);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    Promise.all([api.getMaterials('cnc'), api.getMaterials('routing'), api.getMaterials('3d-printing')])
      .then(([a, b, c]) => { setCnc(a); setRouting(b); setPrinting(c); })
      .catch(() => setLoadError(true));
  }, []);

  const routingBySlug = Object.fromEntries(routing.map((m) => [m.name.replace(/ (sheet|plate).*$/i, '').toLowerCase(), m]));

  return (
    <PublicLayout
      title="Materials"
      description={`Engineering plastics we machine and route in ${brand.city}, Illinois: Delrin, UHMW, HDPE, nylon, PEEK, Ultem, PTFE, polycarbonate, acrylic, PVC, polypropylene, G-10 and phenolic, plus 6061 and brass.`}
    >
      <section className="section" style={{ paddingTop: 48 }}>
        <div className="pub-wrap">
          <div style={{ maxWidth: 680, marginBottom: 36 }}>
            <div className="eyebrow" style={{ marginBottom: 14 }}>Materials</div>
            <h1 className="display" style={{ marginBottom: 16 }}>Pick the plastic by the job, not the catalog.</h1>
            <p className="lede">
              Every material below is priced online. The notes are the ones we'd give you on the phone: what it's for,
              why it works, and the thing that bites people. If you're not sure, upload the part and say what it does —
              we'll suggest the material in the quote.
            </p>
          </div>

          <h2 className="display" style={{ fontSize: 22, marginBottom: 12 }}>Machining and routing stock</h2>
          <div className="card" style={{ overflowX: 'auto' }}>
            <table className="mat-table">
              <thead>
                <tr>
                  <th>Material</th>
                  <th>Grades</th>
                  <th>Good for</th>
                  <th>Why it works</th>
                  <th>Watch out for</th>
                  <th>Sheet for routing</th>
                </tr>
              </thead>
              <tbody>
                {cnc.map((m) => {
                  const n = noteFor(m) || {};
                  const rt = routingBySlug[m.name.split(' ')[0].toLowerCase()] || routing.find((r) => noteFor(r)?.match?.[0] === n.match?.[0]);
                  return (
                    <tr key={m.slug}>
                      <td style={{ whiteSpace: 'nowrap', fontWeight: 600, color: 'var(--text-primary)' }}>
                        <span className="swatch" aria-hidden="true" style={{ background: m.color || '#eee' }} />{m.name}
                      </td>
                      <td data-label="Grades" style={{ minWidth: 150 }}>{(m.grades || []).map((g) => g.name).join(' · ')}</td>
                      <td data-label="Good for" style={{ minWidth: 200 }}>{n.use || '—'}</td>
                      <td data-label="Why it works" style={{ minWidth: 200 }}>{n.why || '—'}</td>
                      <td data-label="Watch out for" style={{ minWidth: 200 }}>{n.watch || '—'}</td>
                      <td data-label="Sheet for routing" style={{ whiteSpace: 'nowrap' }}>
                        {rt ? `${rt.thicknesses?.[0]?.label || ''}–${rt.thicknesses?.[rt.thicknesses.length - 1]?.label || ''}` : 'Rod / block'}
                      </td>
                    </tr>
                  );
                })}
                {cnc.length === 0 && !loadError && <tr><td colSpan={6} style={{ color: 'var(--text-dim)' }}>Loading the material list…</td></tr>}
                {cnc.length === 0 && loadError && <tr><td colSpan={6} style={{ color: 'var(--error-text)' }}>The material list didn't load. Reload the page, or call {brand.phone}.</td></tr>}
              </tbody>
            </table>
          </div>

          <h2 className="display" style={{ fontSize: 22, margin: '48px 0 12px' }}>3D printing</h2>
          <div className="chips">
            {printing.map((m) => (
              <span key={m.slug} className="chip" style={{ fontSize: 13, padding: '6px 12px' }}>
                <span className="swatch" aria-hidden="true" style={{ background: m.color || '#eee', width: 10, height: 10 }} />{m.name}
              </span>
            ))}
          </div>

          <div className="card" style={{ marginTop: 48, padding: 28, display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
            <div>
              <h3 className="display" style={{ marginBottom: 6 }}>Need a material that isn't listed?</h3>
              <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>Vespel, Torlon, PPS, PVDF, Kynar, filled grades, customer-supplied stock — ask. If a distributor stocks it, we can run it.</p>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" onClick={() => navigate('/quote')}>Get an instant quote</button>
              <a className="btn btn-ghost" href={`mailto:${brand.email}`}>Email the shop</a>
            </div>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
