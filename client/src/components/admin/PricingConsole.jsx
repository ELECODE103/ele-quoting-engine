import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../utils/api';
import { formatCurrency, formatDateTime } from '../../utils/format';

/**
 * Pricing console — every pricing rule, rendered generically from the server's
 * rule schema (GET /api/admin/pricing/schema). Nothing here knows a rule by
 * name: labels, help, units, ranges, defaults, grouping and the Simple view all
 * come from the descriptors, so the real rate-card schema drops in unchanged.
 *
 *   left   — group nav (Everything view) with dirty-count badges
 *   middle — one labelled field per rule, default chip, dirty/invalid state
 *   right  — sticky preview: 6 reference parts priced live with the candidate
 *            rules, with deltas against what is saved
 *
 * Save needs a one-line note; it lands in the history drawer, which can
 * restore any earlier snapshot.
 */

const PROC_SHORT = { cnc: 'CNC', routing: 'RTR', '3d-printing': '3DP', sheetmetal: 'SM' };

function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }

// ─── value <-> input text ─────────────────────────────────────
function toInputText(desc, value) {
  if (value === undefined || value === null || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (desc.type === 'percent') return String(roundTo(n * 100, 4));
  return String(roundTo(n, 6));
}
function fromInputText(desc, text) {
  if (text === '' || text === null || text === undefined) return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return NaN;
  return desc.type === 'percent' ? roundTo(n / 100, 6) : n;
}
function roundTo(n, places) { const f = 10 ** places; return Math.round(n * f) / f; }

function formatRuleValue(desc, value) {
  if (value === undefined || value === null) return '—';
  if (desc.type === 'table') {
    if (Array.isArray(value)) return `${value.length} rows`;
    return Object.entries(value).map(([k, v]) => `${k} ${v}`).join(' · ');
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (desc.type === 'percent') return `${roundTo(n * 100, 2)} %`;
  if (desc.type === 'currency') return `$${n.toLocaleString('en-US', { maximumFractionDigits: 4 })}${desc.unit && desc.unit !== '$' ? desc.unit.replace(/^\$/, '') : ''}`;
  return `${n.toLocaleString('en-US', { maximumFractionDigits: 4 })}${desc.unit ? ' ' + desc.unit : ''}`;
}

function unitSuffix(desc) {
  if (desc.type === 'percent') return '%';
  if (desc.type === 'currency') return desc.unit && desc.unit !== '$' ? desc.unit.replace(/^\$\/?/, 'per ') : '';
  return desc.unit || '';
}

/** Client-side mirror of the server range check, for instant feedback. */
function scalarError(desc, value) {
  if (value === null) return 'Enter a number';
  if (Number.isNaN(value)) return 'Not a number';
  if (desc.type === 'integer' && !Number.isInteger(value)) return 'Whole numbers only';
  if (desc.min !== undefined && value < desc.min) return `At least ${formatRuleValue(desc, desc.min)}`;
  if (desc.max !== undefined && value > desc.max) return `At most ${formatRuleValue(desc, desc.max)}`;
  return null;
}
function ruleError(desc, value) {
  if (desc.type !== 'table') return scalarError(desc, value);
  if (desc.shape === 'map') {
    for (const [k, v] of Object.entries(value || {})) { const e = scalarError(desc, v); if (e) return `${k}: ${e}`; }
    return null;
  }
  if (!Array.isArray(value)) return 'Needs rows';
  if (desc.minRows && value.length < desc.minRows) return `Needs at least ${desc.minRows} row(s)`;
  for (let i = 0; i < value.length; i++) {
    for (const col of desc.columns || []) { const e = scalarError(col, value[i][col.key]); if (e) return `Row ${i + 1} ${col.label}: ${e}`; }
    if (desc.sortBy && i > 0 && value[i][desc.sortBy] <= value[i - 1][desc.sortBy]) return `Row ${i + 1}: ${desc.sortBy} must go up`;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
export default function PricingConsole({ initialChanges = null, onConsumedInitialChanges }) {
  const [schema, setSchema] = useState(null);     // { groups, rules }
  const [saved, setSaved] = useState(null);       // rules as stored
  const [draft, setDraft] = useState(null);       // rules being edited
  const [view, setView] = useState(() => { try { return localStorage.getItem('pc-view') || 'simple'; } catch { return 'simple'; } });
  const [group, setGroup] = useState(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewSeq = useRef(0);

  // ─── load ───
  const load = useCallback(async () => {
    const [sch, rules] = await Promise.all([api.getPricingSchema(), api.getPricingRules()]);
    setSchema(sch);
    setSaved(rules);
    setDraft(clone(rules));
    setGroup((g) => g || (sch.groups[0] && sch.groups[0].key));
  }, []);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);
  useEffect(() => { try { localStorage.setItem('pc-view', view); } catch { /* ignore */ } }, [view]);

  // A suggestion handed over from the Calibration tab lands as a dirty edit.
  useEffect(() => {
    if (!initialChanges || !draft) return;
    setDraft((d) => ({ ...d, ...clone(initialChanges) }));
    setView('everything');
    const desc = schema?.rules.find((r) => r.key === Object.keys(initialChanges)[0]);
    if (desc) setGroup(desc.group);
    onConsumedInitialChanges && onConsumedInitialChanges();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialChanges, !!draft]);

  const descriptors = schema ? schema.rules : [];
  const byKey = useMemo(() => Object.fromEntries(descriptors.map((d) => [d.key, d])), [descriptors]);

  // ─── dirty / invalid ───
  const dirtyKeys = useMemo(() => {
    if (!draft || !saved) return [];
    return descriptors.filter((d) => !deepEqual(draft[d.key], saved[d.key])).map((d) => d.key);
  }, [draft, saved, descriptors]);
  const errors = useMemo(() => {
    const out = {};
    if (!draft) return out;
    for (const key of dirtyKeys) { const e = ruleError(byKey[key], draft[key]); if (e) out[key] = e; }
    return out;
  }, [draft, dirtyKeys, byKey]);
  const invalidCount = Object.keys(errors).length;

  // ─── preview (debounced) ───
  useEffect(() => {
    if (!draft || !saved) return;
    const candidate = {};
    for (const key of dirtyKeys) if (!errors[key]) candidate[key] = draft[key];
    const seq = ++previewSeq.current;
    setPreviewBusy(true);
    const t = setTimeout(() => {
      api.previewPricing(candidate)
        .then((res) => { if (seq === previewSeq.current) { setPreview(res); setPreviewBusy(false); } })
        .catch(() => { if (seq === previewSeq.current) setPreviewBusy(false); });
    }, dirtyKeys.length ? 350 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(dirtyKeys.map((k) => [k, draft && draft[k]])), !!saved]);

  // ─── edits ───
  const setRule = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
  const resetRule = (key) => setRule(key, clone(byKey[key].default));
  const discard = () => { setDraft(clone(saved)); setNote(''); setError(null); };

  async function save() {
    if (!note.trim()) { setError('Add a one-line note first — it goes in the history.'); return; }
    if (invalidCount) { setError('Fix the highlighted values first.'); return; }
    setSaving(true); setError(null);
    try {
      const changes = {};
      for (const key of dirtyKeys) changes[key] = draft[key];
      const res = await api.updatePricingRules(changes, note.trim());
      setSaved(res.rules); setDraft(clone(res.rules)); setNote('');
      setFlash(`Saved ${dirtyKeys.length} change${dirtyKeys.length === 1 ? '' : 's'}.`);
      setTimeout(() => setFlash(null), 4000);
    } catch (e) { setError(e.message); }
    setSaving(false);
  }

  async function resetAll() {
    if (!window.confirm('Put every pricing rule back to the shipped defaults? The current values stay in the history, so you can restore them.')) return;
    setSaving(true); setError(null);
    try { const res = await api.resetPricing(); setSaved(res.rules); setDraft(clone(res.rules)); setFlash('Reset to defaults.'); setTimeout(() => setFlash(null), 4000); }
    catch (e) { setError(e.message); }
    setSaving(false);
  }

  async function restore(id) {
    setSaving(true); setError(null);
    try { const res = await api.restorePricing(id); setSaved(res.rules); setDraft(clone(res.rules)); setHistoryOpen(false); setFlash('Restored.'); setTimeout(() => setFlash(null), 4000); }
    catch (e) { setError(e.message); }
    setSaving(false);
  }

  if (error && !schema) return <div className="card empty">Could not load the pricing console: {error}</div>;
  if (!schema || !draft) return <div className="card empty">Loading pricing rules…</div>;

  const groups = schema.groups;
  const simpleRules = descriptors.filter((d) => d.simple);
  const visibleGroups = view === 'simple'
    ? groups.filter((g) => simpleRules.some((d) => d.group === g.key))
    : groups.filter((g) => g.key === group);
  const rulesFor = (g) => (view === 'simple' ? simpleRules : descriptors).filter((d) => d.group === g.key);
  const dirtyInGroup = (gKey) => dirtyKeys.filter((k) => byKey[k].group === gKey).length;

  return (
    <div>
      <div className="pc-head">
        <div>
          <h2>Pricing console</h2>
          <p>{view === 'simple' ? `The ${simpleRules.length} rules that move prices most. Switch to Everything for the full rate card.` : 'Every rule the engine uses, by area. Changes preview on the right before you save.'}</p>
        </div>
        <div className="pc-actions">
          <div className="seg" role="tablist" aria-label="View">
            <button className={view === 'simple' ? 'on' : ''} onClick={() => setView('simple')}>Simple</button>
            <button className={view === 'everything' ? 'on' : ''} onClick={() => setView('everything')}>Everything</button>
          </div>
          <button className="btn btn-ghost" onClick={() => setHistoryOpen(true)}>History</button>
          <button className="btn btn-ghost" onClick={resetAll} disabled={saving}>Reset to defaults</button>
        </div>
      </div>

      <div className={`pc ${view === 'simple' ? 'pc-simple' : ''}`}>
        {view === 'everything' && (
          <nav className="pc-nav" aria-label="Rule groups">
            {groups.map((g) => (
              <button key={g.key} className={group === g.key ? 'on' : ''} onClick={() => setGroup(g.key)}>
                <span>{g.label}</span>
                {dirtyInGroup(g.key) > 0 && <span className="pc-badge">{dirtyInGroup(g.key)}</span>}
              </button>
            ))}
          </nav>
        )}

        <div>
          {(dirtyKeys.length > 0 || flash || error) && (
            <div className="pc-savebar" role="status">
              {dirtyKeys.length > 0 ? (
                <>
                  <span className="count">{dirtyKeys.length} change{dirtyKeys.length === 1 ? '' : 's'}{invalidCount ? ` · ${invalidCount} invalid` : ''}</span>
                  <input className="input" placeholder="What changed and why (required — goes in the history)" value={note} maxLength={200}
                    onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
                  <button className="btn btn-ghost" onClick={discard} disabled={saving}>Discard</button>
                  <button className="btn btn-primary" onClick={save} disabled={saving || invalidCount > 0 || !note.trim()}>{saving ? 'Saving…' : 'Save'}</button>
                </>
              ) : (
                <span className="count" style={{ color: error ? '#FCA5A5' : '#86EFAC' }}>{error || flash}</span>
              )}
            </div>
          )}
          {error && dirtyKeys.length > 0 && <div style={{ color: 'var(--error-text)', fontSize: 12.5, margin: '-6px 0 12px 4px' }}>{error}</div>}

          {visibleGroups.map((g) => (
            <section key={g.key} className="pc-group card" style={{ padding: '14px 4px 4px' }}>
              <div className="pc-group-head" style={{ padding: '0 14px 10px' }}>
                <h3>{g.label}</h3>
                {g.blurb && <p>{g.blurb}</p>}
              </div>
              {rulesFor(g).map((desc) => (
                <RuleField key={desc.key} desc={desc} value={draft[desc.key]} savedValue={saved[desc.key]}
                  dirty={dirtyKeys.includes(desc.key)} error={errors[desc.key]}
                  onChange={(v) => setRule(desc.key, v)} onReset={() => resetRule(desc.key)} />
              ))}
              {rulesFor(g).length === 0 && <div className="empty" style={{ padding: 20 }}>No rules in this group yet.</div>}
            </section>
          ))}
        </div>

        <aside className="pc-preview">
          <PreviewPanel preview={preview} busy={previewBusy} dirty={dirtyKeys.length > 0} />
        </aside>
      </div>

      {historyOpen && <HistoryDrawer byKey={byKey} onClose={() => setHistoryOpen(false)} onRestore={restore} busy={saving} />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
function RuleField({ desc, value, dirty, error, onChange, onReset }) {
  const isDefault = deepEqual(value, desc.default);
  const cls = `rule ${desc.type === 'table' ? 'rule-table' : ''} ${dirty ? 'dirty' : ''} ${error ? 'invalid' : ''}`;
  const range = desc.type !== 'table' && (desc.min !== undefined || desc.max !== undefined)
    ? `${desc.min !== undefined ? formatRuleValue(desc, desc.min) : '…'} – ${desc.max !== undefined ? formatRuleValue(desc, desc.max) : '…'}`
    : null;

  const defaultChip = (
    <button type="button" className={`chip ${isDefault ? 'is-default' : ''}`} title={isDefault ? 'This is the shipped default' : 'Put the shipped default back'}
      onClick={() => !isDefault && onReset()} disabled={isDefault}>
      {isDefault ? 'default' : <>↺ default {formatRuleValue(desc, desc.default)}</>}
    </button>
  );

  if (desc.type === 'table') {
    return (
      <div className={cls}>
        <div>
          <div className="rule-label">{desc.label}<span className="rule-key">{desc.key}</span>{defaultChip}</div>
          <div className="rule-help">{desc.help}</div>
          {desc.shape === 'map'
            ? <MapTable desc={desc} value={value || {}} onChange={onChange} />
            : <RowsTable desc={desc} value={Array.isArray(value) ? value : []} onChange={onChange} />}
          {error && <div className="rule-error" style={{ marginTop: 6 }}>{error}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className={cls}>
      <div>
        <div className="rule-label">{desc.label}<span className="rule-key">{desc.key}</span></div>
        <div className="rule-help">{desc.help}</div>
      </div>
      <div className="rule-ctl">
        <NumberInput desc={desc} value={value} onChange={onChange} />
        <div className="rule-meta">
          {range && <span title="Allowed range">{range}</span>}
          {defaultChip}
        </div>
        {error && <div className="rule-error">{error}</div>}
      </div>
    </div>
  );
}

/** Number input that keeps its own text while typing, so "0." survives a render. */
function NumberInput({ desc, value, onChange, compact = false, ariaLabel }) {
  const [text, setText] = useState(() => toInputText(desc, value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(toInputText(desc, value)); }, [value, desc]);
  const suffix = unitSuffix(desc);
  return (
    <div className="rule-input" style={compact ? { width: 150 } : undefined}>
      {desc.type === 'currency' && <span className="pre">$</span>}
      <input type="number" inputMode="decimal" step={desc.type === 'percent' ? (desc.step ? desc.step * 100 : 1) : (desc.step || 'any')}
        value={text} aria-label={ariaLabel || desc.label}
        onFocus={() => { focused.current = true; }}
        onBlur={() => { focused.current = false; setText(toInputText(desc, value)); }}
        onChange={(e) => { setText(e.target.value); onChange(fromInputText(desc, e.target.value)); }} />
      {suffix && <span className="unit">{suffix}</span>}
    </div>
  );
}

function MapTable({ desc, value, onChange }) {
  const rows = desc.rows && desc.rows.length ? desc.rows : Object.keys(desc.default || {}).map((k) => ({ key: k, label: k }));
  return (
    <table className="tbl">
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td className="lbl">{r.label}</td>
            <td style={{ width: 160 }}>
              <NumberInput desc={desc} compact ariaLabel={`${desc.label} ${r.label}`} value={value[r.key] ?? (desc.default || {})[r.key]}
                onChange={(v) => onChange({ ...value, [r.key]: v })} />
            </td>
            <td style={{ fontSize: 11, color: 'var(--text-dim)' }}>
              {(desc.default || {})[r.key] !== undefined && value[r.key] !== (desc.default || {})[r.key]
                ? <button type="button" className="chip" onClick={() => onChange({ ...value, [r.key]: (desc.default || {})[r.key] })}>↺ {(desc.default || {})[r.key]}</button>
                : <span>default</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RowsTable({ desc, value, onChange }) {
  const cols = desc.columns || [];
  const setCell = (i, key, v) => onChange(value.map((row, idx) => (idx === i ? { ...row, [key]: v } : row)));
  const addRow = () => {
    const last = value[value.length - 1] || {};
    const row = {};
    for (const c of cols) row[c.key] = c.key === desc.sortBy ? (Number(last[c.key]) || 0) * 2 || 1 : (last[c.key] ?? c.min ?? 0);
    onChange([...value, row]);
  };
  return (
    <div>
      <table className="tbl">
        <thead><tr>{cols.map((c) => <th key={c.key}>{c.label}{c.unit ? ` (${c.unit})` : ''}</th>)}<th /></tr></thead>
        <tbody>
          {value.map((row, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c.key} style={{ width: 170 }}>
                  <NumberInput desc={c} compact ariaLabel={`${desc.label} row ${i + 1} ${c.label}`} value={row[c.key]} onChange={(v) => setCell(i, c.key, v)} />
                </td>
              ))}
              <td><button type="button" className="rowbtn" title="Remove row" onClick={() => onChange(value.filter((_, idx) => idx !== i))} disabled={desc.minRows && value.length <= desc.minRows}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="chip" style={{ marginTop: 6 }} onClick={addRow} disabled={desc.maxRows && value.length >= desc.maxRows}>+ add row</button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
function PreviewPanel({ preview, busy, dirty }) {
  const stats = useMemo(() => {
    if (!preview) return null;
    let n = 0, changed = 0, sumPct = 0, maxAbs = 0, maxLabel = '';
    for (const part of preview.parts) for (const line of part.lines) for (const q of preview.quantities) {
      const at = line.at[q]; if (!at || !Number.isFinite(at.unit) || !Number.isFinite(at.baseUnit) || at.baseUnit === 0) continue;
      n++;
      const pct = (at.unit - at.baseUnit) / at.baseUnit;
      if (Math.abs(pct) > 0.0005) { changed++; sumPct += pct; }
      if (Math.abs(pct) > Math.abs(maxAbs)) { maxAbs = pct; maxLabel = `${part.name} · ${PROC_SHORT[line.process] || line.process} ×${q}`; }
    }
    return { n, changed, avgPct: changed ? sumPct / changed : 0, maxAbs, maxLabel };
  }, [preview]);

  return (
    <div className="card">
      <div className="pv-head">
        <h3>Preview · 6 reference parts</h3>
        <span className="pv-status">{busy ? 'updating…' : dirty ? 'vs saved rules' : 'saved rules'}</span>
      </div>
      {!preview ? <div className="empty" style={{ padding: 24 }}>Pricing the reference parts…</div> : (
        <>
          <div className="pv-summary">
            <div className="pv-stat"><div className="k">Prices moved</div><div className="v">{stats.changed}<span style={{ fontSize: 12, color: 'var(--text-dim)', fontWeight: 500 }}> / {stats.n}</span></div></div>
            <div className="pv-stat"><div className="k">Avg change</div><div className="v" style={{ color: stats.changed ? (stats.avgPct > 0 ? 'var(--warn-text)' : 'var(--success-text)') : undefined }}>{stats.changed ? `${stats.avgPct > 0 ? '+' : ''}${(stats.avgPct * 100).toFixed(1)}%` : '—'}</div></div>
            <div className="pv-stat"><div className="k">Biggest</div><div className="v" style={{ fontSize: 13, lineHeight: 1.25 }} title={stats.maxLabel}>{stats.changed ? <>{stats.maxAbs > 0 ? '+' : ''}{(stats.maxAbs * 100).toFixed(0)}%<div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 500, fontFamily: 'var(--font-body)' }} className="truncate">{stats.maxLabel}</div></> : '—'}</div></div>
          </div>
          <table className="pv-table">
            <thead><tr><th>Part · line</th>{preview.quantities.map((q) => <th key={q}>× {q}</th>)}</tr></thead>
            <tbody>
              {preview.parts.map((part) => [
                <tr key={part.id} className="pv-part"><td colSpan={1 + preview.quantities.length} title={part.summary}>{part.name}<span>{part.bbox ? `${fmtDim(part.bbox.w)} × ${fmtDim(part.bbox.h)} × ${fmtDim(part.bbox.d)} mm` : ''}</span></td></tr>,
                ...part.lines.map((line, i) => (
                  <tr key={`${part.id}-${i}`}>
                    <td><span className="pv-line"><span className="proc">{PROC_SHORT[line.process] || line.process}</span>{shortMaterial(line.materialName)}{line.subProcess === 'turning' ? ' · turned' : ''}</span></td>
                    {preview.quantities.map((q) => <PriceCell key={q} at={line.at[q]} />)}
                  </tr>
                )),
              ])}
            </tbody>
          </table>
          <div className="pv-foot">Per-piece price at that quantity, standard lead time, no finish. Deltas compare to the rules as saved. Oversize and over-100 lines are gated to RFQ on the live site; the price still moves the same way.</div>
        </>
      )}
    </div>
  );
}

function PriceCell({ at }) {
  if (!at || at.error) return <td title={at && at.error}>—</td>;
  const pct = Number.isFinite(at.baseUnit) && at.baseUnit > 0 ? (at.unit - at.baseUnit) / at.baseUnit : 0;
  const moved = Math.abs(pct) > 0.0005;
  return (
    <td title={`${formatCurrency(at.baseUnit)} → ${formatCurrency(at.unit)} · ${at.minutes != null ? `${fmtMin(at.minutes)} machine` : ''}`}>
      {formatCurrency(at.unit)}
      <span className={`pv-delta ${moved ? (pct > 0 ? 'up' : 'down') : ''}`}>{moved ? `${pct > 0 ? '+' : ''}${(pct * 100).toFixed(pct > 0.995 || pct < -0.995 ? 0 : 1)}%` : (at.minutes != null ? fmtMin(at.minutes) : ' ')}</span>
    </td>
  );
}

function fmtDim(n) { return n >= 100 ? Math.round(n) : Math.round(n * 10) / 10; }
function fmtMin(m) { return m >= 90 ? `${(m / 60).toFixed(1)} h` : `${m.toFixed(m < 10 ? 1 : 0)} min`; }
function shortMaterial(name) {
  if (!name) return '';
  return name.replace(/\s*\(.*?\)\s*/g, ' ').replace(/ Sheet| Plate| Resin/g, '').trim().slice(0, 22);
}

// ═══════════════════════════════════════════════════════════════
function HistoryDrawer({ byKey, onClose, onRestore, busy }) {
  const [entries, setEntries] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { api.getPricingHistory(100).then(setEntries).catch((e) => setErr(e.message)); }, []);
  useEffect(() => { const k = (e) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  const fmtVal = (key, v) => { const d = byKey[key]; return d ? formatRuleValue(d, v) : JSON.stringify(v); };
  // For a map table (feeds by class) show only the rows that moved, not the whole table.
  const diffText = (key, from, to) => {
    const isMap = (x) => x && typeof x === 'object' && !Array.isArray(x);
    if (isMap(from) && isMap(to)) {
      const rows = [...new Set([...Object.keys(from), ...Object.keys(to)])].filter((k) => from[k] !== to[k]);
      return { from: rows.map((k) => `${k} ${from[k]}`).join(' · '), to: rows.map((k) => `${k} ${to[k]}`).join(' · ') };
    }
    return { from: fmtVal(key, from), to: fmtVal(key, to) };
  };
  const ACTION_TAG = { save: 'tag-info', restore: 'tag-warn', reset: 'tag-fail' };
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer" role="dialog" aria-label="Pricing history">
        <div className="drawer-head">
          <h3>Pricing history</h3>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
        <div className="drawer-body">
          {err && <div className="empty">{err}</div>}
          {entries && entries.length === 0 && <div className="empty">No saves yet. The first save with a note shows up here.</div>}
          {!entries && !err && <div className="empty">Loading…</div>}
          {(entries || []).map((h, i) => (
            <div key={h.id} className="hist">
              <div className="hist-top">
                <span className="hist-when">{formatDateTime(h.createdAt)}{h.userEmail ? ` · ${h.userEmail}` : ''} <span className={`tag ${ACTION_TAG[h.action] || 'tag-info'}`} style={{ marginLeft: 6 }}>{h.action}</span></span>
                {i > 0 && <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 10px' }} disabled={busy}
                  onClick={() => window.confirm(`Restore the rules as they were after “${h.note || h.action}” on ${formatDateTime(h.createdAt)}? Today's values stay in the history.`) && onRestore(h.id)}>Restore</button>}
                {i === 0 && <span className="tag tag-pass">current</span>}
              </div>
              <div className="hist-note">{h.note || <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>(no note)</span>}</div>
              <div className="hist-diffs">
                {h.changedKeys.slice(0, 12).map((k) => {
                  const d = diffText(k, h.diff[k].from, h.diff[k].to);
                  return (
                    <span key={k} className="hist-diff" title={`${k}: ${d.from} → ${d.to}`}>
                      {byKey[k] ? byKey[k].label : k}: {d.from} → <b>{d.to}</b>
                    </span>
                  );
                })}
                {h.changedKeys.length > 12 && <span className="hist-diff">+{h.changedKeys.length - 12} more</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
