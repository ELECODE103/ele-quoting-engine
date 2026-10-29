import { useEffect, useState } from 'react';
import { api, getAuthToken } from '../utils/api';
import { formatCurrency } from '../utils/format';
import { PROCESS_LABELS } from '../brand';

const STATUSES = ['new', 'in-review', 'quoted', 'won', 'lost', 'declined'];
const STATUS_TAG = { new: 'tag-warn', 'in-review': 'tag-info', quoted: 'tag-pass', won: 'tag-pass', lost: 'tag-fail', declined: 'tag-fail' };

/**
 * Admin RFQ queue. Shows what the buyer saw (budgetary numbers, the gate's
 * reasons, engine assumptions) so the firm quote starts from facts.
 */
export default function RfqQueue() {
  const [rfqs, setRfqs] = useState([]);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.getAdminRfqs().then(setRfqs).catch(() => {});
  useEffect(() => { load(); }, []);

  async function update(id, data) {
    setBusy(true);
    try { await api.updateRfq(id, data); await load(); } catch (e) { alert('Save failed: ' + e.message); }
    setBusy(false);
  }

  const hoursOpen = (r) => Math.round((Date.now() - new Date(r.createdAt).getTime()) / 36e5);

  if (rfqs.length === 0) {
    return <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-dim)' }}>No quote requests yet.</div>;
  }

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border-primary)', background: 'var(--bg-secondary)' }}>
            {['Received', 'Who', 'Process', 'Qty', 'Budgetary', 'Status', 'Clock', ''].map((h) => (
              <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rfqs.map((r) => {
            const late = r.status === 'new' && hoursOpen(r) > 20;
            const isOpen = open === r.id;
            return [
              <tr key={r.id} style={{ borderBottom: '1px solid var(--border-subtle)', background: late ? 'var(--warn-bg)' : 'transparent' }}>
                <td style={{ padding: '10px 14px', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{new Date(r.createdAt).toLocaleString()}</td>
                <td style={{ padding: '10px 14px' }}>
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{r.contactName}{r.company ? ` · ${r.company}` : ''}</div>
                  <div style={{ color: 'var(--text-dim)' }}><a href={`mailto:${r.email}`}>{r.email}</a>{r.phone ? ` · ${r.phone}` : ''}</div>
                </td>
                <td style={{ padding: '10px 14px' }}>{PROCESS_LABELS[r.process] || r.process || '—'}</td>
                <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>{r.quantities || (r.parts || []).map((p) => p.quantity).join(' / ') || '—'}</td>
                <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>{r.budgetTotal ? formatCurrency(r.budgetTotal) : '—'}</td>
                <td style={{ padding: '10px 14px' }}>
                  <select className="input" style={{ padding: '4px 28px 4px 8px', fontSize: 11, width: 'auto' }} value={r.status} disabled={busy} onChange={(e) => update(r.id, { status: e.target.value })}>
                    {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </td>
                <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: late ? 'var(--warn-text)' : 'var(--text-dim)' }}>
                  {r.quotedAt ? `quoted in ${Math.round((new Date(r.quotedAt) - new Date(r.createdAt)) / 36e5)} h` : `${hoursOpen(r)} h open`}
                </td>
                <td style={{ padding: '10px 14px' }}>
                  <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => setOpen(isOpen ? null : r.id)}>{isOpen ? 'Close' : 'Detail'}</button>
                </td>
              </tr>,
              isOpen && (
                <tr key={r.id + '-d'} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <td colSpan={8} style={{ padding: '14px 18px', background: 'var(--bg-secondary)' }}>
                    <div className="grid-2" style={{ gap: 18, alignItems: 'start' }}>
                      <div>
                        <div className="field-label">Parts (what the buyer saw)</div>
                        {(r.parts || []).length === 0 && <div style={{ color: 'var(--text-dim)' }}>No online quote attached.</div>}
                        {(r.parts || []).map((p) => (
                          <div key={p.partId} style={{ padding: '6px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                            <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{p.fileName}</div>
                            <div style={{ color: 'var(--text-muted)' }}>
                              {PROCESS_LABELS[p.process] || p.process}{p.subProcess ? ` / ${p.subProcess}` : ''} · {p.materialSlug}{p.grade ? ` (${p.grade})` : ''}{p.thicknessMm ? ` · ${p.thicknessMm} mm` : ''} · finish {p.finishSlug}
                            </div>
                            <div style={{ color: 'var(--text-muted)' }}>× {p.quantity} at {formatCurrency(p.budgetUnit)}/ea = {formatCurrency(p.budgetLine)}</div>
                            {p.engine && (
                              <div style={{ color: 'var(--text-dim)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                                engine: stock {p.engine.stockMm?.w}×{p.engine.stockMm?.h}×{p.engine.stockMm?.d} mm · removal {p.engine.removalCm3} cm³ · part/stock {p.engine.volumeRatio}
                              </div>
                            )}
                          </div>
                        ))}
                        {(r.reasons || []).length > 0 && (
                          <div className="gate-box" style={{ marginTop: 10 }}>
                            Why it came here:<ul>{r.reasons.map((x, i) => <li key={i}>{x.message}</li>)}</ul>
                          </div>
                        )}
                      </div>
                      <div>
                        <div className="field-label">Buyer's notes</div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', color: 'var(--text-secondary)' }}>
                          <span style={{ color: 'var(--text-dim)' }}>Tolerance</span><span>{r.tolerance || '—'}</span>
                          <span style={{ color: 'var(--text-dim)' }}>Finish</span><span>{r.finishNotes || '—'}</span>
                          <span style={{ color: 'var(--text-dim)' }}>Need by</span><span>{r.dueDate || '—'}</span>
                          <span style={{ color: 'var(--text-dim)' }}>Drawing</span>
                          <span>{r.drawingFileName ? <a href={api.rfqDrawingUrl(r.id)} onClick={(e) => { e.preventDefault(); downloadDrawing(r); }}>{r.drawingFileName}</a> : '—'}</span>
                        </div>
                        {r.notes && <p style={{ marginTop: 10, whiteSpace: 'pre-wrap', color: 'var(--text-secondary)' }}>{r.notes}</p>}
                        <div style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'end' }}>
                          <label style={{ flex: 1 }}>
                            <span className="field-label">Quoted total ($)</span>
                            <input className="input" type="number" step="0.01" defaultValue={r.quotedTotal ?? ''} id={`qt-${r.id}`} />
                          </label>
                          <button className="btn btn-primary" disabled={busy} onClick={() => {
                            const v = document.getElementById(`qt-${r.id}`).value;
                            update(r.id, { quotedTotal: Number(v) || 0, status: 'quoted' });
                          }}>Mark quoted</button>
                        </div>
                      </div>
                    </div>
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

async function downloadDrawing(r) {
  const headers = {};
  const token = getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(api.rfqDrawingUrl(r.id), { headers });
  if (!res.ok) { alert('Could not download drawing'); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = r.drawingFileName || 'drawing'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
