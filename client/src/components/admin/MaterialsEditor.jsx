import { useEffect, useMemo, useState } from 'react';
import { api } from '../../utils/api';
import { PROCESS_LABELS } from '../../brand';

/**
 * Materials editor — every material field the pricing models read, editable
 * inline, grouped by process. Each editor opens with a "what this changes"
 * note so the owner knows which quotes move when a number does.
 */

const PROCESS_ORDER = ['cnc', 'routing', '3d-printing', 'sheetmetal'];
const FEED_CLASSES = [
  { value: 'soft', label: 'Soft — HDPE, UHMW, PVC, PP' },
  { value: 'medium', label: 'Medium — acetal, nylon, PC' },
  { value: 'brittle', label: 'Brittle — cast acrylic' },
  { value: 'abrasive', label: 'Abrasive — G-10, phenolic' },
  { value: 'aluminum', label: 'Aluminum plate' },
];

const WHAT_IT_CHANGES = {
  cnc: [
    ['Price per kg', 'material cost on every CNC quote in this material: stock blank weight (part box + padding) × this.'],
    ['Machinability', 'CNC minutes. 1.0 is 6061; 1.3 cuts 30 % faster (cheaper), 0.6 cuts slower (dearer). Also scales tooling wear.'],
    ['Grade density', 'blank weight (lb/in³), so material cost and shipping.'],
    ['Active', 'whether customers can pick it at all. Off hides it from quoting but keeps old orders readable.'],
  ],
  routing: [
    ['Price per kg', 'material cost on every routed quote: blank area × thickness × density ÷ nest yield × this.'],
    ['Feed class', 'which cut feed from the Pricing console (Routing › Cut feed by material class) the cycle time uses.'],
    ['Thicknesses', 'the sizes a customer can pick for this sheet; the middle one is the default.'],
    ['Grade density', 'blank weight (lb/in³), so material cost and shipping.'],
  ],
  '3d-printing': [
    ['Price per cm³', 'material cost: printed volume (plus supports or un-reused powder) × this.'],
    ['Density', 'shipped weight in g/cm³ — shipping only.'],
    ['Layer heights', 'what a customer can pick; thinner layers mean more layers, so longer print time on SLA/SLS.'],
    ['Default layer', 'used when the customer does not pick one.'],
  ],
  sheetmetal: [
    ['Price per kg', 'material cost on sheet-metal quotes (the process is inactive for Straightedge).'],
    ['Thicknesses', 'the gauges a customer can pick.'],
  ],
};

export default function MaterialsEditor({ materials, onChanged }) {
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const byProcess = useMemo(() => {
    const groups = {};
    for (const m of materials) (groups[m.process || 'sheetmetal'] ||= []).push(m);
    return PROCESS_ORDER.filter((p) => groups[p]).map((p) => ({ process: p, items: groups[p] }));
  }, [materials]);

  async function run(label, fn) {
    setBusy(true); setMsg(null);
    try { await fn(); await onChanged(); setMsg(label); setTimeout(() => setMsg(null), 3000); }
    catch (e) { setMsg('Failed: ' + e.message); }
    setBusy(false);
  }

  const toggle = (m) => run(`${m.name} ${m.active ? 'disabled' : 'enabled'}.`, () => api.updateMaterial(m.id, { active: !m.active }));
  const duplicate = (m) => run(`Copied ${m.name} — the copy is off until you turn it on.`, async () => { const c = await api.duplicateMaterial(m.id); setOpenId(c.id); });

  return (
    <div>
      <div className="pc-head">
        <div>
          <h2>Materials</h2>
          <p>Stock prices, machinability, feeds and grades — the numbers that sit under every quote. Click a row to edit.</p>
        </div>
        {msg && <span style={{ fontSize: 12.5, color: msg.startsWith('Failed') ? 'var(--error-text)' : 'var(--success-text)', fontWeight: 600 }}>{msg}</span>}
      </div>

      {byProcess.map(({ process, items }) => (
        <section key={process} className="mat-proc">
          <div className="mat-proc-head">
            <h3>{PROCESS_LABELS[process] || process}</h3>
            <span>{items.filter((m) => m.active).length} of {items.length} active</span>
          </div>
          <div className="card" style={{ overflow: 'hidden' }}>
            <table className="mat-tbl">
              <thead>
                <tr>
                  <th style={{ width: 60 }}>Active</th>
                  <th>Material</th>
                  <th>Category</th>
                  {process === '3d-printing' ? <><th>$/cm³</th><th>Density</th><th>Layers</th></> : <><th>$/kg</th><th>{process === 'cnc' ? 'Machinability' : process === 'routing' ? 'Feed class' : 'Gauges'}</th><th>Grades</th></>}
                  <th style={{ width: 220 }} />
                </tr>
              </thead>
              <tbody>
                {items.map((m) => [
                  <tr key={m.id} className={m.active ? '' : 'off'} style={{ cursor: 'pointer' }} onClick={(e) => { if (e.target.closest('button')) return; setOpenId(openId === m.id ? null : m.id); }}>
                    <td><span className={`tag ${m.active ? 'tag-pass' : 'tag-fail'}`}>{m.active ? 'on' : 'off'}</span></td>
                    <td style={{ fontWeight: 600, color: m.active ? 'var(--text-primary)' : undefined }}><span className="swatch" style={{ background: m.color || '#ddd' }} />{m.name}<div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-ghost)', fontWeight: 400 }}>{m.slug}</div></td>
                    <td>{m.category || '—'}</td>
                    {process === '3d-printing' ? (
                      <><td className="num">{m.pricePerCm3 != null ? `$${Number(m.pricePerCm3).toFixed(2)}` : '—'}</td><td className="num">{m.density ?? '—'} g/cm³</td><td className="num">{(m.layerHeights || []).join(' / ') || '—'}</td></>
                    ) : (
                      <>
                        <td className="num">{m.pricePerKg != null ? `$${Number(m.pricePerKg).toFixed(2)}` : '—'}</td>
                        <td className="num">{process === 'cnc' ? (m.machinability ?? '—') : process === 'routing' ? (m.feedClass || '—') : `${(m.thicknesses || []).length}`}</td>
                        <td>{(m.grades || []).length} grade{(m.grades || []).length === 1 ? '' : 's'}{process === 'routing' ? ` · ${(m.thicknesses || []).length} thicknesses` : ''}</td>
                      </>
                    )}
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 10px', marginRight: 6 }} onClick={() => setOpenId(openId === m.id ? null : m.id)}>{openId === m.id ? 'Close' : 'Edit'}</button>
                      <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 10px', marginRight: 6 }} disabled={busy} onClick={() => duplicate(m)}>Duplicate</button>
                      <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} disabled={busy} onClick={() => toggle(m)}>{m.active ? 'Disable' : 'Enable'}</button>
                    </td>
                  </tr>,
                  openId === m.id && (
                    <tr key={m.id + '-edit'}>
                      <td colSpan={7} style={{ padding: 0 }}>
                        <MaterialForm material={m} process={process} busy={busy}
                          onCancel={() => setOpenId(null)}
                          onSave={(updates) => run(`${m.name} saved.`, async () => { await api.updateMaterial(m.id, updates); setOpenId(null); })} />
                      </td>
                    </tr>
                  ),
                ])}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
function MaterialForm({ material: m, process, busy, onSave, onCancel }) {
  const [f, setF] = useState(() => ({
    name: m.name || '', slug: m.slug || '', category: m.category || '', color: m.color || '#CCCCCC', description: m.description || '',
    pricePerKg: m.pricePerKg ?? '', pricePerCm3: m.pricePerCm3 ?? '', machinability: m.machinability ?? '', feedClass: m.feedClass || '',
    density: m.density ?? '', defaultLayerHeight: m.defaultLayerHeight ?? '',
    layerHeights: (m.layerHeights || []).join(', '),
    grades: (m.grades || []).map((g) => ({ name: g.name || '', density: g.density ?? '' })),
    thicknesses: (m.thicknesses || []).map((t) => ({ mm: t.mm ?? '', inch: t.inch ?? '', label: t.label || '' })),
    active: !!m.active,
  }));
  useEffect(() => { /* form state is initialised from the material once per open */ }, []);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const setGrade = (i, k, v) => set('grades', f.grades.map((g, idx) => (idx === i ? { ...g, [k]: v } : g)));
  const setThk = (i, k, v) => set('thicknesses', f.thicknesses.map((t, idx) => (idx === i ? { ...t, [k]: v } : t)));

  const isPrint = process === '3d-printing';
  const hasThickness = process === 'routing' || process === 'sheetmetal';

  function submit() {
    const out = {
      name: f.name.trim(), slug: f.slug.trim(), category: f.category.trim(), color: f.color.trim(), description: f.description.trim(), active: f.active,
    };
    if (isPrint) {
      out.pricePerCm3 = Number(f.pricePerCm3); out.density = f.density === '' ? null : Number(f.density);
      out.defaultLayerHeight = f.defaultLayerHeight === '' ? null : Number(f.defaultLayerHeight);
      out.layerHeights = f.layerHeights.split(/[,\s]+/).filter(Boolean).map(Number);
    } else {
      out.pricePerKg = Number(f.pricePerKg);
      out.grades = f.grades.map((g) => ({ name: g.name.trim(), density: Number(g.density) }));
      if (process === 'cnc') out.machinability = Number(f.machinability);
      if (process === 'routing') out.feedClass = f.feedClass;
      if (hasThickness) out.thicknesses = f.thicknesses.map((t) => ({ mm: Number(t.mm), inch: t.inch === '' ? undefined : Number(t.inch), label: t.label || undefined }));
    }
    onSave(out);
  }

  return (
    <div className="mat-edit">
      <div className="note">
        <b>What this changes</b> — new quotes move right away; nothing already ordered does.
        {(WHAT_IT_CHANGES[process] || []).map(([k, v]) => <div key={k} style={{ marginTop: 3 }}><b>{k}</b> → {v}</div>)}
      </div>
      <div className="mat-fields">
        <label><span className="field-label">Name</span><input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label><span className="field-label">Slug</span><input className="input" value={f.slug} onChange={(e) => set('slug', e.target.value)} /><div className="hint">lowercase-with-dashes; used in quote records</div></label>
        <label><span className="field-label">Category</span><input className="input" value={f.category} onChange={(e) => set('category', e.target.value)} /><div className="hint">Plastic, Composite, Aluminum, FDM, SLA …</div></label>
        <label><span className="field-label">Color</span><div style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="color" value={/^#[0-9a-f]{6}$/i.test(f.color) ? f.color : '#cccccc'} onChange={(e) => set('color', e.target.value)} style={{ width: 36, height: 36, border: '1px solid var(--border-primary)', borderRadius: 6, padding: 2, background: '#fff' }} /><input className="input" value={f.color} onChange={(e) => set('color', e.target.value)} /></div></label>

        {isPrint ? (
          <>
            <label><span className="field-label">Price per cm³ ($)</span><input className="input" type="number" step="0.01" value={f.pricePerCm3} onChange={(e) => set('pricePerCm3', e.target.value)} /><div className="hint">printed volume × this = material cost</div></label>
            <label><span className="field-label">Density (g/cm³)</span><input className="input" type="number" step="0.01" value={f.density} onChange={(e) => set('density', e.target.value)} /><div className="hint">shipping weight only</div></label>
            <label><span className="field-label">Layer heights (mm)</span><input className="input" value={f.layerHeights} onChange={(e) => set('layerHeights', e.target.value)} /><div className="hint">comma-separated, e.g. 0.1, 0.15, 0.2</div></label>
            <label><span className="field-label">Default layer (mm)</span><input className="input" type="number" step="0.005" value={f.defaultLayerHeight} onChange={(e) => set('defaultLayerHeight', e.target.value)} /></label>
          </>
        ) : (
          <>
            <label><span className="field-label">Price per kg ($)</span><input className="input" type="number" step="0.25" value={f.pricePerKg} onChange={(e) => set('pricePerKg', e.target.value)} /><div className="hint">landed stock cost, not a sell price</div></label>
            {process === 'cnc' && <label><span className="field-label">Machinability</span><input className="input" type="number" step="0.05" value={f.machinability} onChange={(e) => set('machinability', e.target.value)} /><div className="hint">1.0 = 6061; higher cuts faster</div></label>}
            {process === 'routing' && (
              <label><span className="field-label">Feed class</span>
                <select className="input" value={f.feedClass} onChange={(e) => set('feedClass', e.target.value)}>
                  <option value="">(medium)</option>
                  {FEED_CLASSES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
                <div className="hint">picks the cut feed from the pricing console</div>
              </label>
            )}
          </>
        )}
        <label style={{ gridColumn: 'span 2' }}><span className="field-label">Note (shown to you only)</span><input className="input" value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="Supplier, stock sizes on hand, anything to remember" /></label>
      </div>

      {!isPrint && (
        <div className="mat-sub">
          <h4>Grades</h4>
          <table>
            <thead><tr><th style={{ width: 360 }}>Name shown to customer</th><th style={{ width: 130 }}>Density (lb/in³)</th><th /></tr></thead>
            <tbody>
              {f.grades.map((g, i) => (
                <tr key={i}>
                  <td><input className="input" value={g.name} onChange={(e) => setGrade(i, 'name', e.target.value)} /></td>
                  <td><input className="input" type="number" step="0.001" value={g.density} onChange={(e) => setGrade(i, 'density', e.target.value)} /></td>
                  <td><button type="button" className="rowbtn" title="Remove" onClick={() => set('grades', f.grades.filter((_, idx) => idx !== i))} disabled={f.grades.length <= 1}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="chip" style={{ marginTop: 4 }} onClick={() => set('grades', [...f.grades, { name: '', density: f.grades[f.grades.length - 1]?.density ?? '' }])}>+ add grade</button>
        </div>
      )}

      {hasThickness && (
        <div className="mat-sub">
          <h4>Thicknesses</h4>
          <table>
            <thead><tr><th style={{ width: 110 }}>mm</th><th style={{ width: 110 }}>inch</th><th style={{ width: 180 }}>Label</th><th /></tr></thead>
            <tbody>
              {f.thicknesses.map((t, i) => (
                <tr key={i}>
                  <td><input className="input" type="number" step="0.05" value={t.mm} onChange={(e) => setThk(i, 'mm', e.target.value)} /></td>
                  <td><input className="input" type="number" step="0.001" value={t.inch} placeholder={t.mm ? (Number(t.mm) / 25.4).toFixed(3) : ''} onChange={(e) => setThk(i, 'inch', e.target.value)} /></td>
                  <td><input className="input" value={t.label} placeholder='e.g. 1/4"' onChange={(e) => setThk(i, 'label', e.target.value)} /></td>
                  <td><button type="button" className="rowbtn" title="Remove" onClick={() => set('thicknesses', f.thicknesses.filter((_, idx) => idx !== i))}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="chip" style={{ marginTop: 4 }} onClick={() => set('thicknesses', [...f.thicknesses, { mm: '', inch: '', label: '' }])}>+ add thickness</button>
        </div>
      )}

      <div className="mat-edit-actions">
        <button className="btn btn-primary" disabled={busy || !f.name.trim()} onClick={submit}>{busy ? 'Saving…' : 'Save material'}</button>
        <button className="btn btn-ghost" disabled={busy} onClick={onCancel}>Cancel</button>
        <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> Available to customers
        </label>
      </div>
    </div>
  );
}
