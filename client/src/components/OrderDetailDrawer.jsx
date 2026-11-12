import { useState, useEffect } from 'react';
import { api } from '../utils/api';
import { formatCurrency, formatShipDate } from '../utils/format';
import { OrderPaymentPanel } from './admin/OrderPayment';
import { orderLineSpec } from '../utils/orderLine';

/**
 * Fulfillment drawer — single unified view for an order.
 * Shows shipping info, line items with CAD downloads, status timeline,
 * tracking entry, notes, and traveler PDF link.
 */

const STATUS_PIPELINE = [
  { key: 'pending_payment', label: 'Pending Payment' },
  { key: 'pending_po', label: 'PO to confirm' },
  { key: 'paid', label: 'Paid' },
  { key: 'received', label: 'Received' },
  { key: 'in_production', label: 'In Production' },
  { key: 'quality_check', label: 'Quality Check' },
  { key: 'packing', label: 'Packing' },
  { key: 'shipped', label: 'Shipped' },
  { key: 'delivered', label: 'Delivered' },
];

const CARRIERS = ['UPS', 'FedEx', 'USPS', 'DHL', 'Other'];

export default function OrderDetailDrawer({ orderId, onClose, onUpdated }) {
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  // Editable fields
  const [carrier, setCarrier] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [shippedAt, setShippedAt] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => { load(); }, [orderId]);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const o = await api.getOrderById(orderId);
      setOrder(o);
      setCarrier(o.carrier || '');
      setTrackingNumber(o.trackingNumber || '');
      setShippedAt(o.shippedAt ? o.shippedAt.slice(0, 10) : '');
      setNotes(o.notes || '');
    } catch (e) {
      setErr(e.message);
    }
    setLoading(false);
  }

  // Which statuses this order may be moved to by hand (the server decides; this only greys out the rest).
  const [moves, setMoves] = useState(null);
  useEffect(() => { api.getPaymentSettings().then((s) => setMoves(s.manualMoves || null)).catch(() => setMoves(null)); }, []);
  const canMoveTo = (status) => !moves || !order || (moves[order.status] || []).includes(status);

  async function updateStatus(newStatus) {
    // Marking an order paid when no payment is on record, or refunded, is the owner vouching for it: say how.
    let reason;
    if ((newStatus === 'paid' && !order.paidAt) || newStatus === 'refunded') {
      reason = window.prompt(newStatus === 'paid'
        ? 'How was this order paid? (for example: cheque 1042, wire received 11 Nov, PO terms agreed)'
        : 'Why is this order being marked refunded?');
      if (!reason || reason.trim().length < 3) return;
    }
    if (newStatus === 'cancelled') {
      if (!window.confirm('Cancel this order? Its payment page is closed. If money was already taken, refund it in Stripe.')) return;
      reason = window.prompt('Why is it being cancelled? (optional)') || undefined;
    }
    setSaving(true);
    try {
      await api.updateOrderStatus(orderId, {
        status: newStatus,
        reason: reason ? reason.trim() : undefined,
        carrier: carrier || undefined,
        trackingNumber: trackingNumber || undefined,
        shippedAt: shippedAt ? new Date(shippedAt).toISOString() : undefined,
        notes: notes || undefined,
      });
      await load();
      if (onUpdated) onUpdated();
    } catch (e) {
      alert('Update failed: ' + e.message);
    }
    setSaving(false);
  }

  async function saveShipping() {
    if (!order) return;
    setSaving(true);
    try {
      await api.updateOrderStatus(orderId, {
        status: order.status,
        carrier: carrier || '',
        trackingNumber: trackingNumber || '',
        shippedAt: shippedAt ? new Date(shippedAt).toISOString() : '',
        notes: notes || '',
      });
      await load();
      if (onUpdated) onUpdated();
    } catch (e) {
      alert('Save failed: ' + e.message);
    }
    setSaving(false);
  }

  // Escape to close
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const currentIdx = order ? STATUS_PIPELINE.findIndex(s => s.key === order.status) : -1;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        zIndex: 9999, display: 'flex', justifyContent: 'flex-end',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(720px, 96vw)', background: 'var(--bg-primary, #fff)',
          height: '100%', overflowY: 'auto', boxShadow: '-8px 0 32px rgba(0,0,0,0.3)',
          padding: 24,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div className="font-display" style={{ fontSize: 20, fontWeight: 700 }}>
            Order Detail
          </div>
          <button className="btn btn-ghost" onClick={onClose} style={{ fontSize: 12 }}>Close ✕</button>
        </div>

        {loading && <div style={{ padding: 40, textAlign: 'center', color: '#888' }}>Loading…</div>}
        {err && <div style={{ padding: 16, color: '#E94E4E' }}>Error: {err}</div>}

        {order && !loading && (
          <>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, fontSize: 12 }}>
              <div>
                <div style={{ fontFamily: 'monospace', color: '#888' }}>
                  ID: {String(order.id).slice(0, 12)}
                </div>
                <div style={{ color: '#888' }}>
                  Placed: {new Date(order.createdAt).toLocaleString()}
                </div>
                {order.shipBy && (
                  <div style={{ color: '#333', fontWeight: 600, marginTop: 4 }}>
                    Promised ship-by: {formatShipDate(order.shipBy, { year: true })}{order.leadTimeName ? ` (${order.leadTimeName})` : ''}
                  </div>
                )}
                {order.paymentMethod === 'po' && (
                  <div style={{ color: '#92400E', fontWeight: 600, marginTop: 4 }}>
                    PO {order.poNumber} — not charged. Confirm the PO before starting.
                  </div>
                )}
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent, #4F8CFF)' }}>
                {formatCurrency(order.total || 0)}
              </div>
            </div>

            {/* Payments that need the owner, refunds, disputes, discounts, manual payments */}
            <OrderPaymentPanel order={order} onChanged={async () => { await load(); if (onUpdated) onUpdated(); }} />

            {/* What the customer paid for besides the parts: do it before this ships. */}
            {order.paperwork && (
              <div role="status" data-testid="paperwork-flag" style={{ marginBottom: 16, padding: '12px 14px', border: '2px solid #B45309', borderRadius: 6, background: '#FFFBEB', color: '#78350F', fontSize: 13, lineHeight: 1.5 }}>
                <div style={{ fontWeight: 700, fontSize: 14, letterSpacing: 0.3 }}>FAI + CoC ordered{order.paperworkFee > 0 ? ` (${formatCurrency(order.paperworkFee)})` : ' (in the quoted price)'}</div>
                Measure the first piece of each part number against the drawing and fill in the first-article report
                ({order.items?.length || 0} part number{(order.items?.length || 0) === 1 ? '' : 's'}), then fill in and sign the
                certificate of conformance with material and lot. Both go in the box.
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                  {(order.items || []).map((it, i) => (
                    <button key={it.id || i} type="button" className="btn btn-primary" style={{ fontSize: 11, padding: '5px 10px' }}
                      onClick={() => api.openPdf(`fai?orderId=${order.id}&line=${i + 1}`).catch((e) => alert(e.message))}>
                      First-article form{(order.items || []).length > 1 ? `: line ${i + 1}` : ''}
                    </button>
                  ))}
                  <button type="button" className="btn btn-primary" style={{ fontSize: 11, padding: '5px 10px' }}
                    onClick={() => api.openPdf(`coc/${order.id}`).catch((e) => alert(e.message))}>
                    Certificate of conformance
                  </button>
                </div>
              </div>
            )}
            {order.returnPart && (
              <div role="status" style={{ marginBottom: 16, padding: '10px 14px', border: '2px solid #B45309', borderRadius: 6, background: '#FFFBEB', color: '#78350F', fontSize: 13, fontWeight: 600 }}>
                Return the customer's original part in the box with this order. The quoted price covers that shipping.
              </div>
            )}

            {/* Status timeline */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
                Fulfillment Status
                {currentIdx < 0 && (
                  <span data-testid="closed-status" style={{ marginLeft: 8, color: '#B42318' }}>
                    {{ expired: 'Not paid, closed', cancelled: 'Cancelled', refunded: 'Refunded', paid_amount_mismatch: 'Paid, under review' }[order.status] || order.status}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {STATUS_PIPELINE.map((s, i) => {
                  const done = i < currentIdx;
                  const active = i === currentIdx;
                  const clickable = i !== currentIdx && i > 0 && canMoveTo(s.key);
                  return (
                    <button
                      key={s.key}
                      disabled={saving || !clickable}
                      onClick={() => updateStatus(s.key)}
                      title={clickable ? `Set status to ${s.label}` : ''}
                      style={{
                        fontSize: 10, padding: '6px 10px', borderRadius: 4,
                        border: '1px solid',
                        borderColor: active ? '#4F8CFF' : (done ? '#7ED321' : '#ccc'),
                        background: active ? '#4F8CFF' : (done ? '#E8F7D4' : '#f7f7f7'),
                        color: active ? '#fff' : (done ? '#4F7A1F' : '#555'),
                        cursor: clickable ? 'pointer' : 'default',
                        fontWeight: active ? 700 : 500,
                        textTransform: 'uppercase',
                        letterSpacing: 0.3,
                      }}
                    >
                      {done && '✓ '}{s.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Shipping address */}
            <Section title="Ship To">
              <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                <div style={{ fontWeight: 600 }}>{order.shippingName || '—'}</div>
                <div>{order.shippingAddress || ''}</div>
                <div>
                  {[order.shippingCity, order.shippingState, order.shippingZip].filter(Boolean).join(', ')}
                </div>
                <div>{order.shippingCountry}</div>
              </div>
            </Section>

            {/* Line items */}
            <Section title={`Line Items (${order.items?.length || 0})`}>
              {(order.items || []).map((it, idx) => (
                <div key={idx} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 0', borderBottom: '1px solid #eee', fontSize: 12,
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontFamily: 'monospace', overflowWrap: 'anywhere' }}>
                      {it.fileName || 'part'}
                    </div>
                    {/* The full description the order was priced on, as on the job traveler: nothing the
                        shop needs (grade, stock thickness) is left inside the stored config, and a value
                        the line does not carry reads NOT RECORDED rather than being left out. */}
                    <div data-testid="order-line-spec" style={{ color: '#475569', fontSize: 11, lineHeight: 1.5, whiteSpace: 'normal' }}>
                      {orderLineSpec(it).parts.map((part, n) => (
                        <span key={n}>
                          {n > 0 ? ' · ' : ''}
                          {part.missing ? <b style={{ color: '#B91C1C' }}>{part.text}</b> : part.text}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', marginLeft: 12 }}>
                    <div style={{ fontWeight: 600 }}>{formatCurrency(it.lineTotal || 0)}</div>
                    {it.storedName && (
                      <button
                        onClick={() => api.downloadPart(it.partId, it.fileName).catch(e => alert('Download failed: ' + e.message))}
                        style={{
                          fontSize: 10, padding: '3px 8px', marginTop: 4,
                          border: '1px solid #4F8CFF', background: '#fff', color: '#4F8CFF',
                          borderRadius: 3, cursor: 'pointer',
                        }}
                      >
                        ⬇ CAD
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {/* What the total is made of */}
              <div style={{ fontSize: 12, paddingTop: 8, color: '#555' }}>
                {[
                  ['Parts', order.subtotal],
                  order.leadTimeSurcharge > 0 && [`${order.leadTimeName || 'Faster'} lead time`, order.leadTimeSurcharge],
                  order.paperwork && ['FAI + CoC', order.paperworkFee > 0 ? order.paperworkFee : 'in the quoted price'],
                  order.shippingCost > 0 && ['Shipping', order.shippingCost],
                  ['Total', order.total],
                ].filter(Boolean).map(([label, amount]) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontWeight: label === 'Total' ? 700 : 400 }}>
                    <span>{label}</span><span>{typeof amount === 'number' ? formatCurrency(amount) : amount}</span>
                  </div>
                ))}
              </div>
            </Section>

            {/* What the buyer attached on the quote: notes + drawing (price unaffected) */}
            {(order.customerNotes || order.drawingFileName) && (
              <Section title="From the customer">
                {order.customerNotes && <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', marginBottom: order.drawingFileName ? 8 : 0 }}>{order.customerNotes}</div>}
                {order.drawingFileName && (
                  <div style={{ fontSize: 12 }}>
                    Drawing:{' '}
                    {order.hasDrawing ? (
                      <button
                        onClick={() => api.downloadOrderDrawing(order.id, order.drawingFileName).catch(e => alert(e.message))}
                        style={{ border: 'none', background: 'none', color: '#4F8CFF', cursor: 'pointer', padding: 0, textDecoration: 'underline', fontSize: 12 }}
                      >
                        {order.drawingFileName}
                      </button>
                    ) : order.drawingFileName}
                    <span style={{ color: '#888' }}> — review before cutting; contact the customer if it changes the price.</span>
                  </div>
                )}
              </Section>
            )}

            {/* Tracking / shipping */}
            <Section title="Tracking">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Field label="Carrier">
                  <select
                    value={carrier}
                    onChange={(e) => setCarrier(e.target.value)}
                    style={{ width: '100%', padding: '6px 8px', fontSize: 12 }}
                  >
                    <option value="">—</option>
                    {CARRIERS.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </Field>
                <Field label="Ship Date">
                  <input
                    type="date"
                    value={shippedAt}
                    onChange={(e) => setShippedAt(e.target.value)}
                    style={{ width: '100%', padding: '6px 8px', fontSize: 12 }}
                  />
                </Field>
                <div style={{ gridColumn: '1 / -1' }}>
                  <Field label="Tracking Number">
                    <input
                      value={trackingNumber}
                      onChange={(e) => setTrackingNumber(e.target.value)}
                      placeholder="1Z999AA10123456784"
                      style={{ width: '100%', padding: '6px 8px', fontSize: 12, fontFamily: 'monospace' }}
                    />
                  </Field>
                </div>
              </div>
            </Section>

            {/* Notes */}
            <Section title="Notes">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
                placeholder="Internal notes (not shown to customer)"
                style={{ width: '100%', padding: 8, fontSize: 12, fontFamily: 'inherit' }}
              />
            </Section>

            {/* Documents: the branded PDFs (server/services/documents.js) */}
            <Section title="Documents (PDF)">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {[
                  ['Order confirmation', `order-confirmation/${order.id}`],
                  ['Packing slip', `packing-slip/${order.id}`],
                  // Always available; when the customer ordered them they are also the buttons in the banner at the top.
                  ['Certificate of conformance', `coc/${order.id}`],
                  ['First-article form', `fai?orderId=${order.id}&line=1`],
                  ['Traveler', `traveler/${order.id}`],
                  ...(order.quoteId ? [['Quote', `quote/${order.quoteId}`]] : []),
                ].map(([label, path]) => (
                  <button key={path} type="button" className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                    onClick={() => api.openPdf(path).catch((e) => alert(e.message))}>
                    {label}
                  </button>
                ))}
              </div>
            </Section>

            {/* Actions */}
            <div style={{ display: 'flex', gap: 8, marginTop: 20, flexWrap: 'wrap' }}>
              <button
                className="btn btn-primary"
                onClick={saveShipping}
                disabled={saving}
                style={{ fontSize: 12 }}
              >
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
              <a
                href={`/orders/${order.id}/traveler`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-ghost"
                style={{ fontSize: 12, textDecoration: 'none' }}
              >
                Open job traveler
              </a>
              <a
                href={`/orders/${order.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-ghost"
                style={{ fontSize: 12, textDecoration: 'none' }}
              >
                Customer view
              </a>
              {order.status !== 'cancelled' && canMoveTo('cancelled') && (
                <button className="btn btn-ghost" onClick={() => updateStatus('cancelled')} disabled={saving} style={{ fontSize: 12, color: '#B42318' }} data-testid="cancel-order">
                  Cancel order
                </button>
              )}
              {['pending_payment', 'expired', 'cancelled'].includes(order.status) && canMoveTo('paid') && (
                <button className="btn btn-ghost" onClick={() => updateStatus('paid')} disabled={saving} style={{ fontSize: 12 }} data-testid="mark-paid">
                  Mark paid by hand
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{
      marginBottom: 18, padding: 14, border: '1px solid #e5e5e5',
      borderRadius: 6, background: '#fafafa',
    }}>
      <div style={{
        fontSize: 10, fontWeight: 600, color: '#888',
        textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'block', fontSize: 11 }}>
      <span style={{ color: '#666', fontWeight: 500, display: 'block', marginBottom: 2 }}>{label}</span>
      {children}
    </label>
  );
}
