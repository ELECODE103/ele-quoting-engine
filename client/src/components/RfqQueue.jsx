import { useEffect, useState } from 'react';
import { api } from '../utils/api';
import { formatCurrency, formatDate, orderStatusLabel } from '../utils/format';
import { PROCESS_LABELS } from '../brand';

// Statuses the owner sets by hand. "accepted" and "expired" come from the
// customer's actions and the calendar, so they are shown but not selectable.
const STATUSES = ['new', 'in-review', 'quoted', 'won', 'lost', 'declined'];
const AUTO_STATUSES = ['accepted', 'expired'];
const STATUS_TAG = { new: 'tag-warn', 'in-review': 'tag-info', quoted: 'tag-pass', accepted: 'tag-pass', expired: 'tag-fail', won: 'tag-pass', lost: 'tag-fail', declined: 'tag-fail' };

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

  const [notice, setNotice] = useState(null); // { id, text } — result of the last "Send quote"

  async function update(id, data) {
    setBusy(true);
    try { await api.updateRfq(id, data); await load(); } catch (e) { alert('Save failed: ' + e.message); }
    setBusy(false);
  }

  /** Send (or re-send) the firm quote: price, lead time, what it covers. Emails the customer an accept link. */
  async function sendQuote(r) {
    const val = (name) => document.getElementById(`${name}-${r.id}`)?.value ?? '';
    const partQuantities = {};
    for (const p of r.parts || []) {
      const q = parseInt(val(`qq-${p.partId}`), 10);
      if (q > 0) partQuantities[p.partId] = q;
    }
    setBusy(true);
    setNotice(null);
    try {
      const res = await api.updateRfq(r.id, {
        status: 'quoted',
        quotedTotal: Number(val('qt')) || 0,
        quotedLeadDays: val('ql') === '' ? null : Number(val('ql')),
        quoteNote: val('qn'),
        // What the price covers besides the parts: stated to the customer as fact, so it is the owner's to confirm.
        paperwork: Boolean(document.getElementById(`qp-${r.id}`)?.checked),
        ...(r.requestType === 'part' ? { returnPart: Boolean(document.getElementById(`qr-${r.id}`)?.checked) } : {}),
        partQuantities,
        resend: true,
      });
      setNotice({
        id: r.id,
        text: res.emailSent
          ? `Quote emailed to ${r.email}. Good until ${formatDate(res.validUntil)}.`
          : `Quote saved, but the email was NOT sent (email isn't configured or the send failed). Copy the accept link below and send it to ${r.email} yourself.`,
        warn: !res.emailSent,
      });
      await load();
    } catch (e) {
      setNotice({ id: r.id, text: e.message, warn: true });
    }
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
                  {/* How the sender was checked. "none" is null on requests from before the check existed. */}
                  {r.senderCheck === 'none' && (
                    <div style={{ marginTop: 4 }}>
                      <span className="tag tag-warn" title="Did not pass the bot check and was not a signed-in account with a confirmed email. No confirmation was emailed to this address, and a send-the-part request was not given the ship-to address.">Unverified sender</span>
                    </div>
                  )}
                  {r.senderCheck && r.senderCheck !== 'none' && r.buyerEmailed === false && (
                    <div style={{ marginTop: 4, color: 'var(--text-dim)' }}>No confirmation email was sent</div>
                  )}
                </td>
                <td style={{ padding: '10px 14px' }}>
                  {PROCESS_LABELS[r.process] || r.process || (r.requestType === 'part' ? 'Part shipped in' : '—')}
                  {(r.paperwork || r.returnPart) && (
                    <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {r.paperwork && <span className="tag tag-warn" title="The customer asked for a first-article inspection report and a certificate of conformance: price them in">FAI + CoC</span>}
                      {r.returnPart && <span className="tag tag-warn" title="The customer wants the original part back: price the return shipping in">Return part</span>}
                    </div>
                  )}
                </td>
                <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>{r.quantities || (r.parts || []).map((p) => p.quantity).join(' / ') || '—'}</td>
                <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>{r.budgetTotal ? formatCurrency(r.budgetTotal) : '—'}</td>
                <td style={{ padding: '10px 14px' }}>
                  <select className="input" aria-label={`Status of request ${String(r.id).slice(0, 8).toUpperCase()}`} style={{ padding: '4px 28px 4px 8px', fontSize: 11, width: 'auto' }} value={r.status} disabled={busy}
                    onChange={(e) => (e.target.value === 'quoted' ? setOpen(r.id) : update(r.id, { status: e.target.value }))}>
                    {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    {AUTO_STATUSES.includes(r.status) && <option value={r.status} disabled>{r.status}</option>}
                  </select>
                  {r.status === 'accepted' && (
                    <div style={{ marginTop: 4 }}>
                      <span className={`tag ${STATUS_TAG.accepted}`}>{r.acceptedVia === 'po' ? `PO ${r.poNumber}` : 'card'}</span>
                      {r.orderStatus && <span style={{ color: 'var(--text-dim)', marginLeft: 6 }}>{orderStatusLabel(r.orderStatus)}</span>}
                    </div>
                  )}
                  {r.status === 'expired' && <div style={{ marginTop: 4 }}><span className={`tag ${STATUS_TAG.expired}`}>expired {formatDate(r.validUntil)}</span></div>}
                  {r.status === 'quoted' && r.validUntil && <div style={{ marginTop: 4, color: 'var(--text-dim)' }}>good until {formatDate(r.validUntil)}</div>}
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
                    {/* What the customer asked for besides the parts. Both have to be in the price. */}
                    {(r.paperwork || r.returnPart) && (
                      <div className="gate-box" role="status" style={{ marginBottom: 14, fontWeight: 600 }}>
                        {r.returnPart && <div>Customer wants the original back — include return shipping in the price.</div>}
                        {r.paperwork && <div>Customer asked for a first-article inspection report and a certificate of conformance — include them in the price.</div>}
                        <div style={{ fontWeight: 400, marginTop: 4 }}>The quote email, the quote page and the PDF tell the customer the price includes {[r.paperwork && 'the inspection paperwork', r.returnPart && 'returning the original part'].filter(Boolean).join(' and ')}, unless you untick it below before sending.</div>
                      </div>
                    )}
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
                          <span style={{ color: 'var(--text-dim)' }}>FAI + CoC</span><span>{r.paperwork ? 'Yes — price it in' : 'Not requested'}</span>
                          {r.requestType === 'part' && <><span style={{ color: 'var(--text-dim)' }}>Original part</span><span>{r.returnPart ? 'Send it back with the order — price in the return shipping' : 'Not wanted back'}</span></>}
                        </div>
                        {r.notes && <p style={{ marginTop: 10, whiteSpace: 'pre-wrap', color: 'var(--text-secondary)' }}>{r.notes}</p>}
                        {/* ─── The firm quote that goes to the customer ─── */}
                        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border-subtle)' }}>
                          <div className="field-label">Firm quote to the customer</div>
                          {r.status === 'accepted' ? (
                            <div style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                              Accepted {formatDate(r.acceptedAt)} for {formatCurrency(r.quotedTotal)}, {r.quotedLeadDays} business days,{' '}
                              {r.acceptedVia === 'po' ? <>on <b>PO {r.poNumber}</b> (nothing charged; confirm the PO before starting)</> : 'paying by card'}.
                              {r.orderStatus && <> Order: <b>{orderStatusLabel(r.orderStatus)}</b>.</>}
                            </div>
                          ) : (
                            <>
                              {(r.parts || []).map((p) => (
                                <label key={p.partId} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                                  <span className="truncate" style={{ flex: 1, color: 'var(--text-muted)' }}>Qty quoted · {p.fileName}</span>
                                  <input className="input" type="number" min="1" step="1" style={{ width: 90 }} defaultValue={p.quotedQuantity || p.quantity} id={`qq-${p.partId}-${r.id}`} />
                                </label>
                              ))}
                              <div style={{ display: 'flex', gap: 8 }}>
                                <label style={{ flex: 1 }}>
                                  <span className="field-label">Quoted total ($)</span>
                                  <input className="input" type="number" step="0.01" min="0" defaultValue={r.quotedTotal ?? ''} id={`qt-${r.id}`} />
                                </label>
                                <label style={{ flex: 1 }}>
                                  <span className="field-label">Lead time (business days)</span>
                                  <input className="input" type="number" step="1" min="0" defaultValue={r.quotedLeadDays ?? ''} id={`ql-${r.id}`} />
                                </label>
                              </div>
                              <label style={{ display: 'block', marginTop: 8 }}>
                                <span className="field-label">Note to the customer (what the price covers)</span>
                                <textarea className="input" rows={2} defaultValue={r.quoteNote || ''} id={`qn-${r.id}`} placeholder="e.g. 1,000 pcs in natural Delrin, freight to Rockford included." />
                              </label>
                              <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
                                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', color: 'var(--text-secondary)' }}>
                                  <input type="checkbox" id={`qp-${r.id}`} defaultChecked={Boolean(r.paperwork)} style={{ marginTop: 2 }} />
                                  <span>This price includes a first-article inspection report and a certificate of conformance{r.paperwork ? ' (the customer asked for them)' : ' (not asked for)'}</span>
                                </label>
                                {r.requestType === 'part' && (
                                  <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', color: 'var(--text-secondary)' }}>
                                    <input type="checkbox" id={`qr-${r.id}`} defaultChecked={Boolean(r.returnPart)} style={{ marginTop: 2 }} />
                                    <span>This price includes shipping the original part back{r.returnPart ? ' (the customer asked for it back)' : ' (not asked for)'}</span>
                                  </label>
                                )}
                              </div>
                              <button className="btn btn-primary" style={{ marginTop: 10 }} disabled={busy} onClick={() => sendQuote(r)}>
                                {r.status === 'quoted' ? 'Re-send quote (new link)' : r.status === 'expired' ? 'Refresh and re-send quote' : 'Send quote to customer'}
                              </button>
                              <div style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 6 }}>
                                Emails {r.email} the price, lead time and a link to accept by card or PO. Good for 30 days.
                                {' '}The email, the quote page and the PDF state what is ticked above, yes or no.
                              </div>
                            </>
                          )}
                          {notice?.id === r.id && (
                            <div role="status" className={notice.warn ? 'gate-box' : ''} style={{ marginTop: 10, color: notice.warn ? undefined : 'var(--success-text)' }}>{notice.text}</div>
                          )}
                          {r.quotedTotal > 0 && (
                            <button type="button" className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 10px', marginTop: 10 }}
                              onClick={() => api.openPdf(`rfq-response/${r.id}`).catch((e) => alert(e.message))}>
                              Quote as a PDF
                            </button>
                          )}
                          {r.acceptUrl && (
                            <label style={{ display: 'block', marginTop: 10 }}>
                              <span className="field-label">Customer's accept link</span>
                              <input className="input" readOnly value={r.acceptUrl} onFocus={(e) => e.target.select()} style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }} />
                            </label>
                          )}
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
  let blob;
  try { blob = await api.fetchRfqDrawing(r.id); } catch { alert('Could not download drawing'); return; }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = r.drawingFileName || 'drawing'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
