import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import { formatCurrency, formatShipDate, orderStatusLabel } from '../utils/format';
import { orderLineSpec } from '../utils/orderLine';
import { PAPERWORK_LABEL } from '../facts';

const card = { background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-lg)', padding: 24, marginBottom: 24 };
const h2 = { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 };
/** A typed value on one line: a typed line break cannot start a line of its own on a shop document. */
const oneLine = (v) => String(v || '').replace(/\s+/g, ' ').trim();

/**
 * The job traveler on screen (admin). It carries what the printed traveler
 * carries (server/services/pdfGenerator.js), because the shop works from
 * either one:
 *   - the two things that change what goes in the box, in boxes at the top:
 *     inspection paperwork was bought, and the customer's original part goes back;
 *   - for every line, the full description the order was priced on (process,
 *     material, grade, stock thickness, size, finish, tolerance, layer height,
 *     quantity), with NOT RECORDED in red for anything the line does not carry;
 *   - what the customer typed (PO number, notes), each on one line.
 * The printed sheet is one button away.
 */
export default function JobTravelerPage() {
  const { orderId } = useParams();
  const navigate = useNavigate();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pdfError, setPdfError] = useState('');

  useEffect(() => {
    api.getOrderById(orderId)
      .then((data) => setOrder(data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [orderId]);

  const items = order?.items || [];
  const specs = items.map((it) => orderLineSpec(it));
  const missing = specs.reduce((n, s) => n + s.missing.length, 0);
  const ref = order ? String(order.id).slice(0, 8).toUpperCase() : '';
  const po = order && (order.paymentMethod === 'po' || order.status === 'pending_po');

  return (
    <div className="app-page">
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <button type="button" className="btn btn-ghost" onClick={() => navigate('/admin')} style={{ marginBottom: 24 }}>
          ← Back to admin
        </button>

        {loading && (
          <div style={{ textAlign: 'center', padding: '40px 20px' }} role="status">
            <div className="spinner" style={{ margin: '0 auto' }} aria-hidden="true" />
            <span className="sr-only">Loading the order…</span>
          </div>
        )}

        {error && <div role="alert" className="auth-error" style={{ padding: 16, marginBottom: 24 }}>{error}</div>}

        {!loading && order && (
          <>
            <div style={{ marginBottom: 24, display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div>
                <h1 className="app-h1">Job traveler · order {ref}</h1>
                <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                  {orderStatusLabel(order.status)}
                  {order.shipBy ? ` · ships by ${formatShipDate(order.shipBy, { year: true })}${order.leadTimeName ? ` (${order.leadTimeName})` : ''}` : ''}
                  {po ? ` · purchase order ${oneLine(order.poNumber) || '(number not recorded)'}, not charged: confirm the PO before starting` : ''}
                </p>
                {/* How it leaves the shop when we are not shipping it ourselves (the account by its last four only). */}
                {order.deliveryLine && (
                  <p data-testid="traveler-delivery" style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, marginTop: 4 }}>
                    {order.shippingMethod === 'pickup' ? 'Customer pickup: do not ship' : `${oneLine(order.deliveryLine)}: ship collect (full account number on the order)`}
                  </p>
                )}
              </div>
              <button type="button" className="btn btn-primary" onClick={() => { setPdfError(''); api.openPdf(`traveler/${order.id}`).catch((e) => setPdfError(e.message)); }}>
                Print the traveler (PDF)
              </button>
            </div>
            {pdfError && <div role="alert" className="auth-error">{pdfError}</div>}

            {order.paperwork && (
              <div className="traveler-flag" data-testid="traveler-paperwork">
                <b>Inspection paperwork ordered: first-article report + certificate of conformance</b>
                <span>
                  The customer bought both{order.paperworkFee > 0 ? ` (${formatCurrency(order.paperworkFee)})` : ' (in the quoted price)'}. Measure the first piece of each part number against the drawing and write
                  the first-article report; fill in and sign the certificate of conformance with material and lot. Both ship in the box with the parts.
                </span>
              </div>
            )}
            {order.returnPart && (
              <div className="traveler-flag" data-testid="traveler-return-part">
                <b>Return the customer's original part with this order</b>
                <span>It goes in the box with the finished parts; the price already covers the return shipping. Do not scrap it, and do not ship without it.</span>
              </div>
            )}
            {missing > 0 && (
              <div className="traveler-flag traveler-flag-stop" role="alert">
                <b>Check before cutting: {missing} value{missing === 1 ? '' : 's'} not recorded on this order</b>
                <span>Each one is marked NOT RECORDED in its line below. Confirm it with the customer before any material is cut.</span>
              </div>
            )}
            {(!order.paperwork || !order.returnPart) && (
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>
                {!order.paperwork ? `${PAPERWORK_LABEL}: not ordered. ` : ''}
                {!order.returnPart ? 'Customer\'s original part: none to return.' : ''}
              </p>
            )}

            <div style={card}>
              <h2 style={h2}>Parts to make ({items.length})</h2>
              {items.map((it, i) => (
                <div key={it.id || i} style={{ padding: '12px 0', borderBottom: i < items.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'baseline' }}>
                    <div style={{ fontWeight: 600, color: 'var(--text-primary)', overflowWrap: 'anywhere', minWidth: 0 }}>{i + 1}. {it.fileName || 'Part'}</div>
                    <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 18, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>Qty {it.quantity}</div>
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginTop: 4 }}>
                    {specs[i].parts.map((part, n) => (
                      <span key={n}>{n > 0 ? ' · ' : ''}{part.missing ? <b style={{ color: 'var(--error-text)' }}>{part.text}</b> : part.text}</span>
                    ))}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                    {formatCurrency(it.unitPrice || 0)} each · {formatCurrency(it.lineTotal || 0)}
                    {it.storedName && (
                      <> · <button type="button" className="linklike-inline" onClick={() => api.downloadPart(it.partId, it.fileName).catch((e) => setPdfError(e.message))}>Download the file</button></>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {(order.poNumber || order.customerNotes || order.drawingFileName) && (
              <div style={card}>
                <h2 style={h2}>From the customer</h2>
                <dl className="traveler-facts">
                  {order.poNumber && <><dt>PO number (as typed)</dt><dd>{oneLine(order.poNumber)}</dd></>}
                  {order.customerNotes && <><dt>{order.rfqId ? 'Quote notes' : 'Notes (as typed)'}</dt><dd>{oneLine(order.customerNotes)}</dd></>}
                  {order.drawingFileName && <><dt>Drawing</dt><dd>{oneLine(order.drawingFileName)}: review before cutting</dd></>}
                </dl>
              </div>
            )}

            <div style={card}>
              <h2 style={h2}>Ship to</h2>
              <div style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.7 }}>
                <div>{order.shippingName || 'Not recorded'}</div>
                <div>{order.shippingAddress || ''}</div>
                <div>{[order.shippingCity, order.shippingState].filter(Boolean).join(', ')} {order.shippingZip || ''}</div>
                <div>{order.shippingCountry || ''}</div>
              </div>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 12 }}>
                Order total {formatCurrency(order.total || 0)}
                {order.paperwork ? ` · inspection paperwork ${order.paperworkFee > 0 ? formatCurrency(order.paperworkFee) : 'in the quoted price'}` : ''}.
                Status, tracking and your own notes on the order are in the admin order list.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
