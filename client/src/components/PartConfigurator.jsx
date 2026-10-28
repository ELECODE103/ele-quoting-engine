// Short, friendly use-case guidance per material. Keyed by lowercase keywords
// matched against the material name/category, so it works without a DB field.
const MATERIAL_GUIDANCE = [
  { match: ['pla', 'pla+'], text: 'Stiff and easy to print — great for prototypes, fixtures, and display models. Not for high heat or outdoor use.' },
  { match: ['petg'], text: 'Tougher than PLA with better heat and chemical resistance — good for functional parts and enclosures.' },
  { match: ['abs'], text: 'Impact-resistant and heat-tolerant — good for enclosures and automotive-style parts. Best with smoothing/finishing.' },
  { match: ['tpu', 'flexible'], text: 'Rubber-like and flexible — for gaskets, grips, and bumpers. Prints slower.' },
  { match: ['pa12', 'pa 12'], text: 'Strong, durable, and slightly flexible — excellent for living hinges, clips, and end-use functional parts.' },
  { match: ['resin', 'sla'], text: 'Highest detail and smoothest surface — ideal for miniatures, dental/jewelry patterns, and fine features. More brittle.' },
  { match: ['tough resin', 'abs-like'], text: 'Engineering resin balancing detail with impact resistance — for functional prototypes.' },
  { match: ['delrin', 'acetal', 'pom'], text: 'The default machined plastic: stiff, stable, low-friction. Bushings, gears, wear parts, housings. Natural grade is FDA-compliant.' },
  { match: ['uhmw'], text: 'Best abrasion resistance and very slippery — conveyor guides, wear strips, chute liners. Looser tolerances than acetal.' },
  { match: ['hdpe'], text: 'Cheap, tough, chemical-resistant — trays, totes, boards, outdoor parts. Not for tight tolerances.' },
  { match: ['nylon'], text: 'Strong and tough with good wear life — gears, rollers, sprockets. Absorbs moisture and grows; we machine it dry.' },
  { match: ['peek'], text: 'Service to ~480 °F with excellent chemical and wear resistance. The stock is most of the price.' },
  { match: ['ultem', 'pei'], text: 'Stiff, strong to ~340 °F, flame-rated insulator. Keep inside corners radiused.' },
  { match: ['ptfe', 'teflon'], text: 'Nothing sticks to it, almost nothing attacks it. Soft and creeps — tolerances are wide.' },
  { match: ['polycarbonate'], text: 'Near-unbreakable and clear — guards, windows, covers. Polishes well.' },
  { match: ['acrylic'], text: 'Optically clear, flame-polishes glass-clear. Brittle — radius corners, don\'t over-tighten fasteners.' },
  { match: ['pvc'], text: 'Chemical-resistant, solvent-weldable, cheap — tanks, manifolds, fixtures.' },
  { match: ['polypropylene'], text: 'Chemical resistance near PTFE at a fraction of the price. Flexible; hard to hold tight.' },
  { match: ['g10', 'g 10', 'fr 4'], text: 'Very stiff, stable insulator. Abrasive on tooling, so it prices above plastics.' },
  { match: ['phenolic'], text: 'Stiff, stable, cheap insulator with good wear life. Abrasive; edges need care on through-holes.' },
  { match: ['aluminum'], text: 'Lightweight, corrosion-resistant, easy to machine — for parts that mate with metal.' },
  { match: ['stainless'], text: 'Strong and corrosion-resistant — for food, marine, and medical-adjacent parts. Harder to machine (higher cost).' },
  { match: ['steel', 'mild'], text: 'Strong and economical — for brackets and structural parts. Will rust without a finish.' },
  { match: ['copper'], text: 'Excellent electrical and thermal conductivity — for bus bars and heat sinks.' },
  { match: ['brass'], text: 'Easy to machine with a gold finish — for fittings, decorative, and electrical parts.' },
];

function getGuidance(mat) {
  if (!mat) return null;
  // Match whole words in the slug + name only ("pla" must not hit "plastic" or "plate").
  const hay = `${mat.slug || ''} ${mat.name || ''}`.toLowerCase().replace(/[-/_()]/g, ' ');
  const words = new Set(hay.split(/\s+/));
  const hit = MATERIAL_GUIDANCE.find((g) => g.match.some((k) => words.has(k) || (k.includes(' ') && hay.includes(k))));
  return hit ? hit.text : null;
}

// Relative price tier from per-volume (3DP) or per-kg (fab) cost.
function priceTier(mat) {
  if (!mat) return null;
  const v = mat.pricePerCm3 != null ? mat.pricePerCm3 : (mat.pricePerKg != null ? mat.pricePerKg / 50 : null);
  if (v == null) return null;
  if (v < 0.06) return { label: '$', title: 'Economical' };
  if (v < 0.15) return { label: '$$', title: 'Mid-range' };
  return { label: '$$$', title: 'Premium' };
}

export default function PartConfigurator({ part, materials, finishes, onChange, onRemove, selectedProcess }) {
  const currentMat = materials.find((m) => m.slug === part.materialSlug) || materials[0];

  const isPrinting = selectedProcess === '3d-printing';
  const isCnc = selectedProcess === 'cnc';
  const isRouting = selectedProcess === 'routing';

  // Closest stock thickness to the model's thinnest dimension (routing).
  function closestThickness(mat) {
    const list = mat?.thicknesses || [];
    if (list.length === 0) return 0;
    const bb = part.geometry?.boundingBox || {};
    const t = Math.min(bb.width || Infinity, bb.height || Infinity, bb.depth || Infinity);
    if (!Number.isFinite(t)) return list[Math.min(2, list.length - 1)].mm;
    return list.reduce((best, x) => (Math.abs(x.mm - t) < Math.abs(best.mm - t) ? x : best), list[0]).mm;
  }

  function handleMaterialChange(slug) {
    const mat = materials.find((m) => m.slug === slug);
    if (!mat) return;
    const updates = {
      materialSlug: slug,
      grade: mat.grades?.[0]?.name || '',
      subProcess: isCnc ? (part.subProcess || 'milling') : (mat.subProcess || (isPrinting ? 'fdm' : '')),
      layerHeight: mat.defaultLayerHeight || 0.2,
    };
    if (mat.thicknesses?.length) updates.thicknessMm = closestThickness(mat);
    onChange(updates);
  }

  const guidance = getGuidance(currentMat);
  const tier = priceTier(currentMat);

  return (
    <div className="card" style={{ padding: 20 }}>
      <div className="flex-between" style={{ marginBottom: 16 }}>
        <span className="font-display" style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
          Part Configuration
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{part.fileName}</span>
      </div>

      <div className="grid-2">
        {/* Material */}
        <label>
          <span className="field-label">Material</span>
          <select className="input" value={part.materialSlug} onChange={(e) => handleMaterialChange(e.target.value)}>
            {materials.map((m) => (
              <option key={m.slug} value={m.slug}>{m.name}</option>
            ))}
          </select>
        </label>

        {/* Grade (plastics come natural/black, nylon extruded/cast, etc.) */}
        {currentMat?.grades?.length > 1 && (
          <label>
            <span className="field-label">Grade / color</span>
            <select className="input" value={part.grade || currentMat.grades[0].name} onChange={(e) => onChange({ grade: e.target.value })}>
              {currentMat.grades.map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}
            </select>
          </label>
        )}

        {/* Milling vs turning (CNC only) */}
        {isCnc && (
          <label>
            <span className="field-label">Operation</span>
            <select className="input" value={part.subProcess || 'milling'} onChange={(e) => onChange({ subProcess: e.target.value })}>
              <option value="milling">Milling — blocks, plates, brackets, housings</option>
              <option value="turning">Turning — bushings, rollers, spacers, shafts</option>
            </select>
          </label>
        )}

        {/* Stock thickness (routing) */}
        {currentMat?.thicknesses?.length > 0 && (
          <label>
            <span className="field-label">Stock thickness</span>
            <select className="input" value={part.thicknessMm || closestThickness(currentMat)} onChange={(e) => onChange({ thicknessMm: parseFloat(e.target.value) })}>
              {currentMat.thicknesses.map((t) => <option key={t.mm} value={t.mm}>{t.label} ({t.mm} mm)</option>)}
            </select>
          </label>
        )}

        {/* Layer Height (resolution) */}
        {currentMat?.layerHeights && (
          <label>
            <span className="field-label">Layer Height</span>
            <select className="input" value={part.layerHeight || currentMat.defaultLayerHeight} onChange={(e) => onChange({ layerHeight: parseFloat(e.target.value) })}>
              {currentMat.layerHeights.map((lh) => (
                <option key={lh} value={lh}>{lh}mm{lh <= 0.1 ? ' — fine' : lh >= 0.3 ? ' — fast/draft' : ''}</option>
              ))}
            </select>
          </label>
        )}

        {/* Infill – FDM only */}
        {currentMat?.subProcess === 'fdm' && (
          <label>
            <span className="field-label">Infill ({Math.round((part.infill || 0.2) * 100)}%)</span>
            <input className="input" type="range" min="0.1" max="1.0" step="0.05" value={part.infill || 0.2} onChange={(e) => onChange({ infill: parseFloat(e.target.value) })} style={{ padding: '10px 0' }} />
          </label>
        )}

        {/* Quantity */}
        <label>
          <span className="field-label">Quantity</span>
          <input className="input" type="number" min="1" max="100000" value={part.quantity} onChange={(e) => onChange({ quantity: Math.max(1, parseInt(e.target.value) || 1) })} />
        </label>

        {/* Finish */}
        <label style={{ gridColumn: '1 / -1' }}>
          <span className="field-label">Finish</span>
          <select className="input" value={part.finishSlug} onChange={(e) => onChange({ finishSlug: e.target.value })}>
            {finishes.map((f) => (
              <option key={f.slug} value={f.slug}>
                {f.name}{f.pricePerPart > 0 ? ` (+$${f.pricePerPart.toFixed(2)}/part)` : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Material guidance */}
      {currentMat && (guidance || tier) && (
        <div style={{ marginTop: 14, padding: '10px 14px', background: 'var(--accent-bg)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: guidance ? 6 : 0 }}>
            {currentMat.color && (
              <span aria-hidden="true" style={{ width: 14, height: 14, borderRadius: 4, background: currentMat.color, border: '1px solid rgba(0,0,0,0.1)', flexShrink: 0 }} />
            )}
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{currentMat.name}</span>
            {tier && (
              <span title={tier.title} style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 700 }}>{tier.label}</span>
            )}
          </div>
          {guidance && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>{guidance}</div>
          )}
        </div>
      )}

      {/* Geometry summary */}
      {part.geometry && (
        <div style={{ marginTop: 16, padding: '10px 14px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', display: 'flex', flexWrap: 'wrap', gap: '12px 20px', fontSize: 12, color: 'var(--text-dim)' }}>
          <span>Bounding: {(part.geometry.boundingBox?.width || part.geometry.flatWidth || 0).toFixed(1)} × {(part.geometry.boundingBox?.height || part.geometry.flatHeight || 0).toFixed(1)} × {(part.geometry.boundingBox?.depth || part.geometry.estimatedThickness || 0).toFixed(1)}mm</span>
          <span>Volume: {((part.geometry.volume || 0) / 1000).toFixed(1)} cm³</span>
          <span>Area: {((part.geometry.surfaceArea || part.geometry.flatArea || 0) / 100).toFixed(1)} cm²</span>
          <span>Triangles: {(part.geometry.triangleCount || 0).toLocaleString()}</span>
        </div>
      )}

      {/* Actions */}
      <div className="flex-between" style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border-subtle)' }}>
        <button className="btn btn-danger" style={{ fontSize: 12 }} onClick={onRemove}>
          Remove Part
        </button>
      </div>
    </div>
  );
}
