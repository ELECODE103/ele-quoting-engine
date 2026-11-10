import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import PublicLayout from '../components/PublicLayout';
import { api } from '../utils/api';
import brand from '../brand';
import { catalog, pageSlugForCatalogSlug } from '../data/materials';
import { when, gradeLabel, materialVisible, toleranceFor, toleranceRows } from '../facts';

const SHOW_TOL = toleranceRows().length > 0;
const PLASTIC_COUNT = catalog.cnc.filter((m) => !/aluminum|6061|brass/i.test(`${m.slug} ${m.name}`)).length;

// Plain-language notes per material family. Keyed by slug prefix match.
// Plain strings are general material knowledge. Anything about what this shop
// does or will hold is behind a fact flag (shared/shop-facts.json).
const NOTES = [
  { match: ['delrin', 'acetal'], use: 'Bushings, gears, wear parts, housings. The usual first choice for a machined plastic part.', why: `Stiff, low friction, cuts cleanly and holds size${when('acetal-holds-best', ' better than any other plastic on this list')}. Homopolymer (Delrin) is a little stiffer; copolymer has less centerline porosity in thick rod.`, watch: 'Not for chlorine or strong acids. Food-contact compliance depends on the maker\'s grade, not on the color.' },
  { match: ['uhmw'], use: 'Conveyor guides, wear strips, chute liners, cutting-board duty.', why: 'Among the most abrasion-resistant unfilled plastics. Very slippery, takes impact, cheap.', watch: 'Soft and springy under the cutter, so tolerances are looser than acetal. Moves with temperature on long parts.' },
  { match: ['hdpe'], use: 'Trays, totes, tanks, cutting boards, marine and outdoor parts.', why: 'Cheap, tough, chemical-resistant. Routes fast from sheet.', watch: 'Low stiffness; not for close-tolerance parts. Nothing sticks to it, including paint.' },
  { match: ['nylon'], use: 'Gears, sprockets, rollers, bearings, sheaves, structural parts that get hit.', why: 'Strong and tough with good wear life. Cast nylon for big blocks; oil-filled grades for dry bearings.', watch: `Absorbs moisture and grows, up to about 2% in length when saturated. Say whether the part runs wet.${when('nylon-dry', (v) => ` ${v}`)}` },
  { match: ['peek'], use: 'High-heat seals, bushings and insulators; pump and valve parts.', why: 'Keeps its strength hot (480 °F long-term on the maker\'s datasheet), resists most chemicals, wears well, holds size.', watch: 'Expensive stock. The material is most of the price, so send the drawing and the stock can be sized close.' },
  { match: ['ultem', 'pei'], use: 'Electrical insulators, high-temperature fixtures, parts that get sterilized.', why: 'Stiff and strong when warm (338 °F long-term on the maker\'s datasheet), a good insulator, transparent amber.', watch: 'Notch-sensitive. Keep inside corners radiused.' },
  { match: ['ptfe', 'teflon'], use: 'Seals, seats, slide pads, chemical-service parts, electrical insulators.', why: 'Very low friction, and almost nothing attacks it.', watch: 'Soft, creeps under load, tolerances are wide. Filled grades (glass, bronze) for wear.' },
  { match: ['polycarbonate'], use: 'Machine guards, windows, covers.', why: 'Clear, with very high impact strength. The usual choice for a guard that must not shatter.', watch: 'Scratches, and crazes with some solvents and cleaners. A cut face comes off the cutter frosted, not clear.' },
  { match: ['acrylic'], use: 'Displays, windows, light guides, cosmetic covers.', why: 'Optically clear and harder to scratch than polycarbonate.', watch: 'Brittle. Radius the corners and don\'t over-tighten fasteners. Cast, not extruded, for machining.' },
  { match: ['pvc'], use: 'Chemical tanks and manifolds, duct, fixtures, signage (expanded PVC).', why: 'Cheap, chemical-resistant, solvent-weldable, easy to machine.', watch: 'Gray Type 1 for structural; expanded PVC is light and soft, not for load.' },
  { match: ['polypropylene'], use: 'Tanks, chemical fixtures, cutting boards, lab parts.', why: 'Resists most acids and bases, light, cheap, weldable.', watch: 'Flexible and hard to hold to a close tolerance. Warps if cut unevenly.' },
  { match: ['g10', 'g-10', 'fr-4'], use: 'Electrical insulators, test fixtures, structural plates.', why: 'Very stiff and strong, holds size, a good insulator.', watch: 'Abrasive. It eats tooling, so it prices above the thermoplastics, and the dust has to be collected.' },
  { match: ['phenolic'], use: 'Wear pads, gears, insulators, bearing retainers, test fixtures.', why: 'Stiff, cheap insulator with good wear life.', watch: 'Abrasive, and edges can fray on through-holes.' },
  { match: ['aluminum', '6061'], use: 'Brackets, plates, housings, fixtures: anything that mates with metal.', why: 'Light, stiff, machines fast, anodizes.', watch: 'For heavy aluminum production you may be better served by a dedicated metal shop.' },
  { match: ['brass'], use: 'Fittings, bushings, electrical contacts.', why: 'Free-machining, corrosion-resistant, conductive.', watch: 'Heavy and not cheap.' },
];

function noteFor(m) {
  const hay = `${m.slug} ${m.name}`.toLowerCase();
  return NOTES.find((n) => n.match.some((k) => hay.includes(k)));
}

export default function MaterialsPage() {
  const navigate = useNavigate();
  // Seeded from the build-time catalog so the table is in the prerendered HTML
  // (and never shows "Loading"); the API call below then refreshes it with any
  // admin edits.
  const [cnc, setCnc] = useState(catalog.cnc);
  const [routing, setRouting] = useState(catalog.routing);
  const [printing, setPrinting] = useState(catalog.printing.filter(materialVisible));
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    Promise.all([api.getMaterials('cnc'), api.getMaterials('routing'), api.getMaterials('3d-printing')])
      .then(([a, b, c]) => { setCnc(a); setRouting(b); setPrinting(c.filter(materialVisible)); })
      .catch(() => setLoadError(true));
  }, []);

  const routingBySlug = Object.fromEntries(routing.map((m) => [m.name.replace(/ (sheet|plate).*$/i, '').toLowerCase(), m]));

  return (
    <PublicLayout>
      <section className="section" style={{ paddingTop: 48 }}>
        <div className="pub-wrap">
          <div style={{ maxWidth: 680, marginBottom: 36 }}>
            <div className="eyebrow" style={{ marginBottom: 14 }}>Materials</div>
            <h1 className="display" style={{ marginBottom: 16 }}>Pick the plastic by the job, not the catalog.</h1>
            <p className="lede">
              {PLASTIC_COUNT} plastics are priced online, plus 6061 and brass. The notes are the ones you would get on the phone:
              what it is for, why it works, and the thing that bites people. Not sure which one? <Link to="/parts">Parts by type</Link> starts
              from the part, or call <a href={brand.phoneHref} style={{ color: 'var(--accent)' }}>{brand.phone}</a> and say what it does.
            </p>
          </div>

          <h2 className="display h2-sm">Machining and routing stock</h2>
          <div className="card" style={{ overflowX: 'auto' }}>
            <table className="mat-table">
              <thead>
                <tr>
                  <th>Material</th>
                  <th>Grades</th>
                  <th>Good for</th>
                  <th>Why it works</th>
                  <th>Watch out for</th>
                  {SHOW_TOL && <th>Standard tolerance</th>}
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
                        <span className="swatch" aria-hidden="true" style={{ background: m.color || '#eee' }} />
                        {pageSlugForCatalogSlug(m.slug)
                          ? <Link className="mat-link" to={`/materials/${pageSlugForCatalogSlug(m.slug)}`}>{m.name}</Link>
                          : m.name}
                      </td>
                      <td data-label="Grades" style={{ minWidth: 150 }}>{(m.grades || []).map((g) => gradeLabel(g.name)).join(' · ')}</td>
                      <td data-label="Good for" style={{ minWidth: 200 }}>{n.use || '—'}</td>
                      <td data-label="Why it works" style={{ minWidth: 200 }}>{n.why || '—'}</td>
                      <td data-label="Watch out for" style={{ minWidth: 200 }}>{n.watch || '—'}</td>
                      {SHOW_TOL && <td data-label="Standard tolerance" style={{ whiteSpace: 'nowrap' }}>{toleranceFor(`${m.slug} ${m.name}`)?.standard || 'On the quote'}</td>}
                      <td data-label="Sheet for routing" style={{ whiteSpace: 'nowrap' }}>
                        {rt ? `${rt.thicknesses?.[0]?.label || ''}–${rt.thicknesses?.[rt.thicknesses.length - 1]?.label || ''}` : 'Rod / block'}
                      </td>
                    </tr>
                  );
                })}
                {cnc.length === 0 && !loadError && <tr><td colSpan={SHOW_TOL ? 7 : 6} style={{ color: 'var(--text-dim)' }}>Loading the material list…</td></tr>}
                {cnc.length === 0 && loadError && <tr><td colSpan={SHOW_TOL ? 7 : 6} style={{ color: 'var(--error-text)' }}>The material list didn't load. Reload the page, or call {brand.phone}.</td></tr>}
              </tbody>
            </table>
          </div>

          <h2 className="display h2-sm" style={{ marginTop: 48 }}>3D printing materials</h2>
          <div className="chips">
            {printing.map((m) => (
              <span key={m.slug} className="chip" style={{ fontSize: 13, padding: '6px 12px' }}>
                <span className="swatch" aria-hidden="true" style={{ background: m.color || '#eee', width: 10, height: 10 }} />{m.name}
              </span>
            ))}
          </div>

          <div className="grid-2" style={{ marginTop: 48, gap: 20 }}>
            <div className="plain-box">
              <h3 className="display">Part touches food?</h3>
              <p className="body-copy">
                Food-contact compliance belongs to a specific grade from a specific maker, not to a plastic or a color.{' '}
                <Link to="/food-contact">What a machine shop can and cannot certify</Link>.
              </p>
            </div>
            <div className="plain-box">
              <h3 className="display">Need a material that isn't listed?</h3>
              <p className="body-copy">
                Vespel, Torlon, PPS, PVDF, filled grades, stock you supply: ask. If we haven't cut it before, we'll say so.
              </p>
            </div>
          </div>

          <div className="cta-row" style={{ marginTop: 32 }}>
            <button className="btn btn-primary btn-lg" onClick={() => navigate('/quote')}>Get an instant quote</button>
            <a className="btn btn-outline btn-lg" href={brand.phoneHref}>{brand.phone}</a>
          </div>
          <p className="next-note">Upload a STEP or STL, pick a material from this list, and the price shows in a few seconds. No account needed to look.</p>
        </div>
      </section>
    </PublicLayout>
  );
}
