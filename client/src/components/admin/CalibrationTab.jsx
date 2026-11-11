import { useEffect, useState } from 'react';
import { api } from '../../utils/api';
import { formatCurrency, formatDate } from '../../utils/format';
import { PROCESS_LABELS } from '../../brand';

/**
 * Calibration — engine-estimated machine minutes per piece next to what the
 * job actually took. The owner types the actual on each completed order line;
 * the server summarises the ratio per process and suggests one conservative
 * rule change, which can be carried straight into the Pricing console.
 */
export default function CalibrationTab({ onApplySuggestion }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [savingId, setSavingId] = useState(null);

  const load = () => api.getCalibration().then(setData).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  async function saveActual(item, fields) {
    setSavingId(item.itemId);
    try { await api.updateOrderItemActuals(item.itemId, fields); await load(); }
    catch (e) { alert('Save failed: ' + e.message); }
    setSavingId(null);
  }

  if (err) return <div className="card empty">Could not load calibration: {err}</div>;
  if (!data) return <div className="card empty">Loading…</div>;

  const label = (s) => s.process === '3d-printing' ? `${(s.subProcess || 'fdm').toUpperCase()} printing` : (PROCESS_LABELS[s.process] || s.process);

  return (
    <div>
      <div className="pc-head">
        <div>
          <h2>Calibration</h2>
          <p>For each finished order line, enter the machine minutes per piece it really took (spindle or print time, not setup). After {data.minSamples} measured jobs per process the console suggests one rate change.</p>
        </div>
      </div>

      {data.summary.length > 0 && (
        <div className="cal-cards">
          {data.summary.map((s) => {
            const r = s.medianRatio;
            const color = r == null ? 'var(--text-dim)' : Math.abs(r - 1) <= 0.1 ? 'var(--success-text)' : r > 1 ? 'var(--warn-text)' : 'var(--accent)';
            const sg = s.suggestion || {};
            return (
              <div key={s.process + s.subProcess} className="card cal-card">
                <div className="top"><h3>{label(s)}</h3><span className="n">{s.measured} of {s.jobs} job{s.jobs === 1 ? '' : 's'} measured</span></div>
                <div className="ratio" style={{ color }}>{r != null ? `${r.toFixed(2)}×` : '—'}<small>{r != null ? `actual ÷ engine · range ${s.minRatio}–${s.maxRatio}` : 'no actuals yet'}</small></div>
                <div className={`sugg ${sg.kind || ''}`}>
                  {sg.text}
                  {sg.kind === 'adjust' && onApplySuggestion && (
                    <div style={{ marginTop: 8 }}>
                      <button className="btn btn-primary" style={{ fontSize: 11.5, padding: '5px 12px' }} onClick={() => onApplySuggestion({ [sg.key]: sg.suggested })}>
                        Try {sg.label} → {typeof sg.suggested === 'object' ? 'suggested feeds' : `${sg.suggested}${sg.unit ? ' ' + sg.unit : ''}`} in the pricing console
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        {data.items.length === 0 ? (
          <div className="empty">No finished order lines yet. Lines appear here once an order is in production or later ({data.statuses.join(', ').replace(/_/g, ' ')}).</div>
        ) : (
          <table className="cal-tbl">
            <thead>
              <tr>
                <th>Date</th><th>Order</th><th>Part</th><th>Process</th><th>Material</th>
                <th className="num">Qty</th><th className="num">Price/pc</th><th className="num">Engine min/pc</th><th className="num">Actual min/pc</th><th className="num">Ratio</th><th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((it) => (
                <tr key={it.itemId} style={{ opacity: savingId === it.itemId ? 0.6 : 1 }}>
                  <td style={{ whiteSpace: 'nowrap', color: 'var(--text-dim)' }}>{formatDate(it.orderDate)}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{it.orderShort}<div style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-body)' }}>{it.orderStatus.replace(/_/g, ' ')}</div></td>
                  <td style={{ fontWeight: 600, color: 'var(--text-primary)', maxWidth: 180 }} className="truncate" title={it.fileName}>{it.fileName || '—'}</td>
                  <td>{PROCESS_LABELS[it.process] || it.process || '—'}{it.subProcess ? <div style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>{it.subProcess}</div> : null}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{it.materialSlug || '—'}</td>
                  <td className="num">{it.quantity}</td>
                  <td className="num">{it.unitPrice != null ? formatCurrency(it.unitPrice) : '—'}</td>
                  <td className="num">{it.engineMinutes != null ? it.engineMinutes.toFixed(1) : <span title="This line was ordered before the engine saved its time estimate">—</span>}</td>
                  <td className="num">
                    <input className="input mins" type="number" step="0.5" min="0" defaultValue={it.actualMinutes ?? ''} placeholder="min"
                      key={`${it.itemId}-${it.actualMinutes}`}
                      onBlur={(e) => { const v = e.target.value; if ((v === '' ? null : Number(v)) !== it.actualMinutes) saveActual(it, { actualMinutes: v === '' ? null : Number(v) }); }}
                      onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} />
                  </td>
                  <td className="num">{it.ratio != null ? <span className={`ratio-pill ${Math.abs(it.ratio - 1) <= 0.1 ? 'ok' : it.ratio > 1 ? 'hi' : 'lo'}`}>{it.ratio.toFixed(2)}×</span> : <span style={{ color: 'var(--text-ghost)' }}>—</span>}</td>
                  <td>
                    <input className="input notes" defaultValue={it.actualNotes || ''} placeholder="e.g. two setups, tool change, re-run"
                      key={`${it.itemId}-n-${it.actualNotes}`}
                      onBlur={(e) => { if (e.target.value !== (it.actualNotes || '')) saveActual(it, { actualNotes: e.target.value }); }}
                      onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 10, lineHeight: 1.5 }}>
        Ratio = actual ÷ engine. 1.0 means the model matched the floor; above 1 the model under-estimates time (you are under-charging), below 1 it over-estimates. Suggestions move a rate halfway toward the measured ratio and only after {data.minSamples} jobs — check the preview before saving.
      </p>
    </div>
  );
}
