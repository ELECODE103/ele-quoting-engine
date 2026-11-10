import { useMemo, useState } from 'react';

/**
 * 2D preview of a DXF part: the loops the server chained from the drawing,
 * outer profile in ink, cutouts in brass, and a numbered marker wherever a
 * DFM check points at something (open ends, sharp inside corners, thin webs,
 * slots under the cutter …). Shown in place of the 3D viewer.
 *
 * Coordinates arrive in mm with the origin at the lower-left of the part
 * (server/geometry/dxf/analyze.js); the SVG flips Y so the drawing reads the
 * way it does in CAD.
 *
 *   profile        geometry.profile2d
 *   dfm            the routing DFM for the current thickness (checks may carry `locations`)
 *   materialColor  fill tint for the part
 *   onUnitsChange  (units: "mm" | "in") => void — re-reads the file at that scale
 *   unitsBusy      a units change is in flight
 */
const INK = '#101C33';
const BRASS = '#A8834E';
const SEVERITY_COLOR = { fail: '#DC2626', warn: '#D97706', pass: '#2563EB', info: '#2563EB' };
const ROLE_LABEL = { outer: 'Outer profile', hole: 'Round hole', slot: 'Slot', cutout: 'Cutout', open: 'Open contour', sliver: 'Zero-area loop' };

const inches = (mm) => (mm / 25.4).toFixed(mm / 25.4 >= 10 ? 1 : 2);
const fmtMm = (mm) => (mm >= 100 ? mm.toFixed(0) : mm.toFixed(1));
const sizeText = (s) => `${fmtMm(s.w)} × ${fmtMm(s.h)} mm (${inches(s.w)} × ${inches(s.h)} in)`;

function loopPath(pts, closed) {
  if (!pts || pts.length < 2) return '';
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) d += `L${pts[i][0]} ${pts[i][1]}`;
  return closed ? `${d}Z` : d;
}

// A drawn circle arrives as centre + diameter; everything else as a flattened polyline.
function loopD(l) {
  if ((!l.pts || l.pts.length === 0) && l.center && l.diameter) {
    const r = l.diameter / 2, [cx, cy] = l.center;
    return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
  }
  return loopPath(l.pts, l.closed);
}

export default function DxfPreview({ profile, dfm, materialColor = '#F4F4F5', onUnitsChange, unitsBusy = false, height = 360 }) {
  const [hover, setHover] = useState(null);

  const model = useMemo(() => {
    if (!profile) return null;
    const { w, h } = profile.bbox;
    const span = Math.max(w, h, 1e-6);
    const pad = span * 0.12;
    const loops = profile.loops || [];
    const solid = loops.filter((l) => l.closed && l.role !== 'sliver' && l.role !== 'open').map((l) => loopD(l)).join('');
    return { w, h, span, pad, loops, solid, view: [-pad, -pad, w + 2 * pad, h + 2 * pad] };
  }, [profile]);

  // One numbered group per DFM check that points somewhere
  const groups = useMemo(() => {
    const out = [];
    for (const c of dfm?.checks || []) {
      if (!Array.isArray(c.locations) || c.locations.length === 0) continue;
      out.push({ id: c.id, label: c.label, severity: c.severity, color: SEVERITY_COLOR[c.severity] || SEVERITY_COLOR.info, locations: c.locations, detail: c.detail });
    }
    const rank = { fail: 0, warn: 1 };
    out.sort((a, b) => (rank[a.severity] ?? 2) - (rank[b.severity] ?? 2));
    return out.map((g, i) => ({ ...g, n: i + 1 }));
  }, [dfm]);

  if (!model) return null;
  const { w, h, span, pad, loops, solid, view } = model;
  const units = profile.units || {};
  const needsUnits = Boolean(units.needsConfirmation);
  const r = span * 0.028;            // marker radius in drawing units
  const fy = (y) => h - y;           // flip Y for text / markers drawn outside the flipped group
  const unitWord = { mm: 'millimetres', in: 'inches', cm: 'centimetres', m: 'metres', ft: 'feet' }[units.unit] || units.unit;
  const cutLength = (profile.perimeter || 0) + (profile.innerPerimeter || 0);

  const unitButton = (u, label) => {
    const on = units.unit === u && !needsUnits;
    return (
      <button
        type="button" key={u} role="radio" aria-checked={on} disabled={unitsBusy}
        onClick={() => { if (!on && onUnitsChange) onUnitsChange(u); }}
        className="btn"
        style={{
          fontSize: 11, padding: '4px 10px', borderRadius: 6,
          background: on ? INK : '#fff', color: on ? '#fff' : 'var(--text-secondary)',
          border: `1px solid ${on ? INK : 'var(--border-primary)'}`,
        }}
      >{label}</button>
    );
  };

  return (
    <div data-testid="dxf-preview">
      {/* Units: a plain toggle when the file says what it is, a question when it does not */}
      {needsUnits ? (
        <div className="gate-box" role="group" aria-label="Drawing units" style={{ borderRadius: 0, borderWidth: '0 0 1px 0' }}>
          <b>Is this drawing in inches or millimetres?</b> {capitalise(units.reason)}. Pick the size that matches your part — there is no price until you do.
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            {[['mm', 'Millimetres', units.sizeIfMm], ['in', 'Inches', units.sizeIfInch]].map(([u, name, s]) => (
              <button
                key={u} type="button" className="btn" disabled={unitsBusy} data-units={u}
                onClick={() => onUnitsChange && onUnitsChange(u)}
                style={{ flex: '1 1 220px', textAlign: 'left', padding: '10px 12px', background: '#fff', border: '1px solid #FDE68A', borderRadius: 8, display: 'block' }}
              >
                <span style={{ display: 'block', fontSize: 12, fontWeight: 700, color: INK }}>{name}</span>
                <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{s ? `Part is ${sizeText(s)}` : ''}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', fontSize: 11, color: 'var(--text-muted)' }}>
          <span>Drawn in</span>
          <span role="radiogroup" aria-label="Drawing units" style={{ display: 'inline-flex', gap: 4 }}>
            {unitButton('mm', 'mm')}
            {unitButton('in', 'inch')}
          </span>
          <span style={{ color: 'var(--text-dim)' }}>
            {units.unit !== 'mm' && units.unit !== 'in' ? `${unitWord} · ` : ''}{units.source === 'file' ? 'units read from the file' : units.source === 'customer' ? 'units chosen by you' : ''}
          </span>
          <span style={{ marginLeft: 'auto', fontWeight: 600, color: 'var(--text-secondary)' }}>{sizeText({ w, h })}</span>
        </div>
      )}

      <div style={{ position: 'relative', height, background: 'var(--bone, #F4F1EA)', opacity: unitsBusy ? 0.5 : 1, transition: 'opacity 0.15s' }}>
        <svg
          viewBox={view.join(' ')} width="100%" height="100%" preserveAspectRatio="xMidYMid meet"
          role="img" aria-label={`2D preview: ${sizeText({ w, h })}, ${profile.holes?.length || 0} holes, ${groups.length} flagged area${groups.length === 1 ? '' : 's'}`}
          style={{ display: 'block' }}
        >
          <defs>
            <pattern id="dxf-grid" width={gridStep(span)} height={gridStep(span)} patternUnits="userSpaceOnUse">
              <path d={`M${gridStep(span)} 0H0V${gridStep(span)}`} fill="none" stroke="rgba(16,28,51,0.07)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            </pattern>
          </defs>
          {/* grid runs past the viewBox so the letterboxed sides are covered too */}
          <rect x={view[0] - 20 * span} y={view[1] - 20 * span} width={view[2] + 40 * span} height={view[3] + 40 * span} fill="url(#dxf-grid)" />

          {/* Geometry, Y up */}
          <g transform={`translate(0 ${h}) scale(1 -1)`}>
            {solid && <path d={solid} fill={materialColor} fillRule="evenodd" stroke="none" opacity="0.95" />}
            {loops.map((l, i) => {
              const broken = !l.closed || l.role === 'open';
              const stroke = broken ? SEVERITY_COLOR.fail : l.role === 'sliver' ? SEVERITY_COLOR.warn : l.role === 'outer' ? INK : BRASS;
              return (
                <path
                  key={i} d={loopD(l)} fill="none" stroke={stroke}
                  strokeWidth={l.role === 'outer' ? 2 : 1.6} strokeDasharray={broken ? '5 4' : undefined}
                  strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" data-role={l.role}
                >
                  <title>{`${ROLE_LABEL[l.role] || l.role}${l.diameter ? ` Ø${l.diameter.toFixed(2)} mm` : ''} — ${l.perimeter.toFixed(1)} mm of cut`}</title>
                </path>
              );
            })}
          </g>

          {/* Overall dimensions */}
          <g fill="var(--text-muted, #64748B)" fontSize={span * 0.034} fontFamily="var(--font-mono, monospace)">
            <path d={`M0 ${h + pad * 0.42}H${w}M0 ${h + pad * 0.3}v${pad * 0.24}M${w} ${h + pad * 0.3}v${pad * 0.24}`} stroke="var(--text-dim, #94A3B8)" strokeWidth="1" vectorEffect="non-scaling-stroke" fill="none" />
            <text x={w / 2} y={h + pad * 0.82} textAnchor="middle">{fmtMm(w)} mm · {inches(w)}″</text>
            <path d={`M${-pad * 0.42} 0V${h}M${-pad * 0.54} 0h${pad * 0.24}M${-pad * 0.54} ${h}h${pad * 0.24}`} stroke="var(--text-dim, #94A3B8)" strokeWidth="1" vectorEffect="non-scaling-stroke" fill="none" />
            <text x={-pad * 0.58} y={h / 2} textAnchor="middle" transform={`rotate(-90 ${-pad * 0.58} ${h / 2})`}>{h > span * 0.45 ? `${fmtMm(h)} mm · ${inches(h)}″` : `${fmtMm(h)} mm`}</text>
          </g>

          {/* DFM markers */}
          {groups.map((g) => g.locations.map((p, i) => {
            const dim = hover && hover !== g.id;
            return (
              <g key={`${g.id}-${i}`} opacity={dim ? 0.25 : 1} data-dfm-marker={g.id} onMouseEnter={() => setHover(g.id)} onMouseLeave={() => setHover(null)}>
                <circle cx={p.x} cy={fy(p.y)} r={r} fill={g.color} fillOpacity="0.14" stroke={g.color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
                <circle cx={p.x} cy={fy(p.y)} r={r * 0.12} fill={g.color} />
                <g transform={`translate(${p.x + r * 0.95} ${fy(p.y) - r * 0.95})`}>
                  <circle r={r * 0.62} fill={g.color} />
                  <text textAnchor="middle" dominantBaseline="central" fontSize={r * 0.8} fontWeight="700" fill="#fff" fontFamily="var(--font-body, sans-serif)">{g.n}</text>
                </g>
                <title>{`${g.label}: ${p.note || ''} at X ${p.x.toFixed(1)}, Y ${p.y.toFixed(1)} mm`}</title>
              </g>
            );
          }))}
        </svg>

        {/* Colour key */}
        <div style={{ position: 'absolute', top: 10, right: 12, display: 'flex', gap: 12, fontSize: 10.5, color: 'var(--text-secondary)', background: 'rgba(255,255,255,0.85)', padding: '4px 8px', borderRadius: 6 }}>
          <Key color={INK} label="Outer profile" />
          <Key color={BRASS} label="Holes & cutouts" />
          {loops.some((l) => !l.closed) && <Key color={SEVERITY_COLOR.fail} label="Open contour" dashed />}
        </div>
      </div>

      {/* What the numbers mean */}
      {groups.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: '8px 12px', borderTop: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 6 }} aria-label="Flagged on the drawing">
          {groups.map((g) => (
            <li key={g.id} onMouseEnter={() => setHover(g.id)} onMouseLeave={() => setHover(null)} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11.5, lineHeight: 1.45 }}>
              <span aria-hidden="true" style={{ flexShrink: 0, width: 18, height: 18, borderRadius: '50%', background: g.color, color: '#fff', fontSize: 10.5, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>{g.n}</span>
              <span style={{ color: 'var(--text-secondary)' }}>
                <b>{g.label}</b>
                <span style={{ color: g.color, fontWeight: 600 }}> · {g.severity === 'fail' ? 'blocks the order' : g.severity === 'warn' ? 'review' : 'small adder'}</span>
                <span style={{ color: 'var(--text-muted)' }}> — {summarise(g)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', padding: '8px 12px', borderTop: '1px solid var(--border-subtle)', fontSize: 11, color: 'var(--text-muted)' }}>
        <span>{(cutLength / 25.4).toFixed(1)} in of cut ({cutLength.toFixed(0)} mm)</span>
        <span>{((profile.area || 0) / 645.16).toFixed(1)} in² of material</span>
        <span>{profile.holes?.length || 0} round hole{profile.holes?.length === 1 ? '' : 's'}</span>
        {profile.cutoutCount - (profile.holes?.length || 0) > 0 && <span>{profile.cutoutCount - profile.holes.length} other cutout{profile.cutoutCount - profile.holes.length === 1 ? '' : 's'}</span>}
        {profile.ignored?.total > 0 && <span title="Dimensions, text, construction and hidden layers are never cut. The DFM check lists them.">{profile.ignored.total} drawing item{profile.ignored.total === 1 ? '' : 's'} not cut</span>}
      </div>
    </div>
  );
}

function Key({ color, label, dashed }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <svg width="16" height="6" aria-hidden="true"><line x1="0" y1="3" x2="16" y2="3" stroke={color} strokeWidth="2.5" strokeDasharray={dashed ? '4 3' : undefined} /></svg>
      {label}
    </span>
  );
}

// "sharp inside corner (5 places)" / "gap 0.50 mm"
function summarise(g) {
  const notes = [...new Set(g.locations.map((p) => p.note).filter(Boolean))];
  const where = g.locations.length > 1 ? ` (${g.locations.length} places)` : '';
  return `${notes.slice(0, 2).join(', ') || 'see the DFM check'}${where}`;
}

function capitalise(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

// A 10 / 25 / 50 / 100 … mm grid that stays readable at any part size
function gridStep(span) {
  const target = span / 12;
  const steps = [1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000];
  return steps.find((s) => s >= target) || 1000;
}
