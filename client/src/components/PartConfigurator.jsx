import { formatBox } from '../utils/format';

// Short, friendly use-case guidance per material. Keyed by lowercase keywords
// matched against the material name/category, so it works without a DB field.
const MATERIAL_GUIDANCE = [
  { match: ['pla', 'pla+'], text: 'Stiff and easy to print. Prototypes, fixtures, display models. Softens around 140 °F, so not for hot or outdoor duty.' },
  { match: ['petg'], text: 'Tougher than PLA, takes more heat and most chemicals. Working prototypes and enclosures.' },
  { match: ['abs'], text: 'Takes impact and heat. Enclosures and housings. Smooths well if you want a finished look.' },
  { match: ['tpu', 'flexible'], text: 'Rubber-like. Gaskets, grips, bumpers. Prints slowly, so it prices higher.' },
  { match: ['pa12', 'pa 12'], text: 'Strong, tough, a little flexible. Living hinges, clips, end-use parts.' },
  { match: ['resin', 'sla'], text: 'Finest detail and smoothest surface. Small housings, snap fits, cosmetic models. More brittle than FDM.' },
  { match: ['tough resin', 'abs-like'], text: 'Resin with some give. Working prototypes that need detail and a little impact resistance.' },
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
  { match: ['aluminum'], text: 'Light, stiff, machines fast. Brackets, plates and fixtures that mate with metal.' },
  { match: ['stainless'], text: 'Strong and corrosion-resistant. Food, marine and medical-adjacent parts. Slow to machine, so it prices higher.' },
  { match: ['steel', 'mild'], text: 'Strong and cheap. Brackets and structural parts. Rusts without a finish.' },
  { match: ['copper'], text: 'Conducts heat and electricity. Bus bars and heat sinks.' },
  { match: ['brass'], text: 'Free-machining, corrosion-resistant, conductive. Fittings, bushings, contacts.' },
];

function getGuidance(mat) {
  if (!mat) return null;
  // Match whole words in the slug + name only ("pla" must not hit "plastic" or "plate").
  const hay = `${mat.slug || ''} ${mat.name || ''}`.toLowerCase().replace(/[-/_()]/g, ' ');
  const words = new Set(hay.split(/\s+/));
  const hit = MATERIAL_GUIDANCE.find((g) => g.match.some((k) => words.has(k) || (k.includes(' ') && hay.includes(k))));
  return hit ? hit.text : null;
}

// Relative stock-cost tier. Printed materials are priced per cm³, machined
// stock per kg; the cutoffs are set so the three tiers each hold a few
// materials (otherwise every plastic reads "$$$" and the badge says nothing).
function priceTier(mat) {
  if (!mat) return null;
  if (mat.pricePerCm3 != null) {
    const v = mat.pricePerCm3;
    if (v < 0.08) return { label: '$', title: 'Low-cost material' };
    if (v < 0.16) return { label: '$$', title: 'Mid-cost material' };
    return { label: '$$$', title: 'Premium material' };
  }
  if (mat.pricePerKg != null) {
    const v = mat.pricePerKg;
    if (v < 10) return { label: '$', title: 'Low-cost stock' };
    if (v < 25) return { label: '$$', title: 'Mid-cost stock' };
    return { label: '$$$', title: 'Premium stock' };
  }
  return null;
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
          Part setup
        </span>
        <span className="truncate" style={{ fontSize: 12, color: 'var(--text-dim)', maxWidth: '55%' }} title={part.fileName}>{part.fileName}</span>
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
            <span className="field-label">Layer height</span>
            <select className="input" value={part.layerHeight || currentMat.defaultLayerHeight} onChange={(e) => onChange({ layerHeight: parseFloat(e.target.value) })}>
              {currentMat.layerHeights.map((lh) => (
                <option key={lh} value={lh}>{lh} mm{lh <= 0.1 ? ' — fine detail, slower' : lh >= 0.3 ? ' — draft, fastest' : ' — standard'}</option>
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
                {f.name}{f.pricePerPart > 0 ? ` (+$${f.pricePerPart.toFixed(2)} each)` : ''}
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
              <span title={tier.title} aria-label={tier.title} style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 700 }}>{tier.label}</span>
            )}
          </div>
          {guidance && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>{guidance}</div>
          )}
        </div>
      )}

      {/* Geometry summary */}
      {part.geometry && (
        <div style={{ marginTop: 16, padding: '10px 14px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', display: 'flex', flexWrap: 'wrap', gap: '6px 20px', fontSize: 12, color: 'var(--text-muted)' }}>
          <span>Size: {formatBox(
            part.geometry.boundingBox?.width || part.geometry.flatWidth || 0,
            part.geometry.boundingBox?.height || part.geometry.flatHeight || 0,
            part.geometry.boundingBox?.depth || part.geometry.estimatedThickness || 0,
          )}</span>
          <span>Volume: {((part.geometry.volume || 0) / 16387.064).toFixed(2)} in³ ({((part.geometry.volume || 0) / 1000).toFixed(1)} cm³)</span>
        </div>
      )}

      {/* Actions */}
      <div className="flex-between" style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border-subtle)' }}>
        <button className="btn btn-danger" style={{ fontSize: 12 }} onClick={onRemove}>
          Remove part
        </button>
      </div>
    </div>
  );
}
