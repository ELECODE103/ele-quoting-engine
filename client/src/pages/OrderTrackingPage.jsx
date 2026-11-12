import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../utils/api';
import { formatCurrency, formatShipDate, formatDate, orderStatusLabel } from '../utils/format';
import { storeQuoteId } from '../utils/returnTo';
import brand, { PROCESS_LABELS } from '../brand';
import { PAPERWORK_LABEL } from '../facts';

const TIMELINE = ['pending_payment', 'paid', 'received', 'in_production', 'quality_check', 'packing', 'shipped', 'delivered'];
// A PO order skips card payment: it waits for the shop to confirm the PO instead.
const PO_TIMELINE = ['pending_po', ...TIMELINE.slice(2)];

const card = { background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-lg)', padding: 24, marginBottom: 24 };
const h2 = { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 };

/**
 * Order confirmation + tracking. Stripe sends the buyer back here with
 * ?paid=true; the page then asks the server to confirm the payment so the
 * banner doesn't depend on webhook timing.
 */
export default function OrderTrackingPage() {
  const { orderId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const justPaid = searchParams.get('paid') === 'true';
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(justPaid);
  const [reordering, setReordering] = useState(false);
  const [reorderError, setReorderError] = useState('');

  const load = useCallback(() => api.getOrderById(orderId).then((o) => { setOrder(o); return o; }), [orderId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let o = await load();
        if (justPaid) {
          storeQuoteId(null); // that quote is an order now; the builder starts fresh
          // Stripe's confirmation can trail the redirect by a few seconds.
          for (let attempt = 0; attempt < 5 && !cancelled && o.status === 'pending_payment'; attempt++) {
            await api.confirmOrderPayment(orderId).catch(() => null);
            o = await load();
            if (o.status === 'pending_payment') await new Promise((r) => setTimeout(r, 2000));
          }
        }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to load order');
      } finally {
        if (!cancelled) { setLoading(false); setConfirming(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [orderId, justPaid, load]);

  async function reorder() {
    setReordering(true);
    setReorderError('');
    try {
      const r = await api.reorder(orderId);
      navigate(`/quote?quote=${r.quoteId}`);
    } catch (err) {
      setReorderError(err.message || 'Could not rebuild the quote.');
      setReordering(false);
    }
  }

  const timeline = order?.paymentMethod === 'po' ? PO_TIMELINE : TIMELINE;
  const statusIndex = order ? timeline.indexOf(order.status === 'paid_amount_mismatch' ? 'paid' : order.status) : -1;
  const paid = order && !['pending_payment', 'pending_po', 'cancelled', 'expired'].includes(order.status);
  // A payment arrived that we are looking at by hand before the order is confirmed.
  const underReview = Boolean(order?.paymentUnderReview);
  const refunded = Number(order?.refundedAmount) || 0;
  const discount = Number(order?.discountAmount) || 0;
  const closed = order && ['expired', 'cancelled', 'refunded'].includes(order.status);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)', padding: '32px' }}>
      <div style={{ maxWidth: 800, margin: '0 auto' }}>
        <button className="btn btn-ghost" onClick={() => navigate('/dashboard')} style={{ marginBottom: 24 }}>
          ← Your orders
        </button>

        {loading && (
          <div style={{ textAlign: 'center', padding: '40px 20px' }}>
            <div className="spinner" style={{ margin: '0 auto' }} />
            {confirming && <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 16 }} role="status">Confirming your payment…</p>}
          </div>
        )}

        {error && (
          <div role="alert" style={{ background: 'var(--error-bg)', border: '1px solid var(--error)', borderRadius: 'var(--radius-md)', padding: 16, marginBottom: 24, color: 'var(--error-text)' }}>
            {error}
          </div>
        )}

        {!loading && order && (
          <>
            {justPaid && paid && (
              <div role="status" style={{ background: 'var(--success-bg, #ECFDF5)', border: '1px solid var(--success, #10B981)', borderRadius: 'var(--radius-md)', padding: 16, marginBottom: 24, color: 'var(--success-text)', fontSize: 14 }}>
                <b>Payment received. Thank you.</b>{' '}
                {order.shipBy ? `Your parts ship by ${formatShipDate(order.shipBy, { year: true })}.` : ''}{' '}
                {order.customerEmail ? `A confirmation is on its way to ${order.customerEmail}.` : ''}
              </div>
            )}
            {justPaid && order.status === 'pending_payment' && !underReview && (
              <div role="status" className="gate-box" style={{ marginBottom: 24 }}>
                We're still waiting for the payment confirmation from the card processor. This page will show it as soon as it arrives;
                refresh in a minute, or call {brand.phone} if it doesn't.
              </div>
            )}
            {underReview && (
              <div role="status" className="gate-box" data-testid="payment-under-review" style={{ marginBottom: 24 }}>
                <b>We're checking your payment.</b> We received a payment for this order and need to look at it before we confirm the order.
                We'll email {order.customerEmail || 'you'} today. Questions: {brand.phone}.
              </div>
            )}
            {order.status === 'expired' && (
              <div role="status" className="gate-box" data-testid="order-expired" style={{ marginBottom: 24 }}>
                <b>This order was not paid for, so it has closed.</b> Nothing was charged.{' '}
                {order.quoteId && !order.rfqId
                  ? <>Your quote is still there: <a href={`/checkout/${order.quoteId}`} style={{ color: 'var(--accent)', fontWeight: 600 }}>go back to checkout</a> to order it.</>
                  : <>Open the link in your quote email to order, or call {brand.phone}.</>}
              </div>
            )}
            {order.status === 'cancelled' && (
              <div role="status" className="gate-box" style={{ marginBottom: 24 }}>
                <b>This order was cancelled</b> and won't be made. Call {brand.phone} if that isn't what you expected.
              </div>
            )}
            {order.status === 'refunded' && (
              <div role="status" className="gate-box" data-testid="order-refunded" style={{ marginBottom: 24 }}>
                <b>We refunded this order.</b> {formatCurrency(refunded || order.total)} went back to your card. Banks usually show a refund within 5 to 10 business days.
              </div>
            )}
            {order.status !== 'refunded' && refunded > 0 && (
              <div role="status" className="gate-box" data-testid="order-part-refunded" style={{ marginBottom: 24 }}>
                <b>We refunded {formatCurrency(refunded)} of this order</b> to your card. The rest of the order stands.
              </div>
            )}

            <div style={{ marginBottom: 24, display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div>
                <h1 style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>Order {String(order.id).slice(0, 8).toUpperCase()}</h1>
                <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                  Placed {new Date(order.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
                </p>
              </div>
              <div style={{ textAlign: 'right' }}>
                <button className="btn btn-primary" onClick={reorder} disabled={reordering}>
                  {reordering ? 'Rebuilding the quote…' : 'Reorder'}
                </button>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>Opens these parts as a new quote at today's price.</div>
              </div>
            </div>
            {reorderError && <div role="alert" style={{ color: 'var(--error-text)', fontSize: 13, marginBottom: 16 }}>{reorderError}</div>}

            {/* Summary */}
            <div style={card}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 24 }}>
                <Fact label="Status" value={orderStatusLabel(order.status)} />
                {!closed && (
                  <Fact label={order.status === 'shipped' || order.status === 'delivered' ? 'Shipped' : 'Ships by'}
                    value={order.status === 'shipped' || order.status === 'delivered'
                      ? formatDate(order.shippedAt)
                      : (order.shipBy ? formatShipDate(order.shipBy, { year: true }) : '—')}
                    note={order.status === 'pending_payment' ? 'if paid today' : order.leadTimeName} />
                )}
                <Fact label="Total" value={formatCurrency(order.total)} accent />
                {discount > 0 && order.amountPaid !== null && order.amountPaid !== undefined && (
                  <Fact label="You paid" value={formatCurrency(order.amountPaid)} note={`after ${formatCurrency(discount)} off with a promotion code`} />
                )}
                {refunded > 0 && <Fact label="Refunded" value={formatCurrency(refunded)} />}
                {order.poNumber && <Fact label="PO number" value={order.poNumber} />}
              </div>
            </div>

            {/* Tracking */}
            {(order.trackingNumber || order.status === 'shipped' || order.status === 'delivered') && (
              <div style={card}>
                <h2 style={h2}>Tracking</h2>
                {order.trackingNumber ? (
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                    {order.carrier ? `${order.carrier} ` : ''}
                    {order.trackingUrl
                      ? <a href={order.trackingUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontWeight: 600 }}>{order.trackingNumber}</a>
                      : <b>{order.trackingNumber}</b>}
                  </div>
                ) : (
                  <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Shipped. No tracking number was recorded for this shipment; call {brand.phone} if you need one.</div>
                )}
              </div>
            )}

            {/* Line items */}
            <div style={card}>
              <h2 style={h2}>Parts ({order.items?.length || 0})</h2>
              {(order.items || []).map((it) => (
                <div key={it.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '10px 0', borderBottom: '1px solid var(--border-subtle)', fontSize: 13 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{it.fileName || 'Part'}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                      {[it.materialName || it.materialSlug, PROCESS_LABELS[it.process] || it.process, it.finishName].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{formatCurrency(it.lineTotal)}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Qty {it.quantity}{it.quantity > 1 ? ` · ${formatCurrency(it.unitPrice)} each` : ''}</div>
                  </div>
                </div>
              ))}
              {(order.leadTimeSurcharge > 0 || order.shippingCost > 0 || order.paperwork) && (
                <div style={{ fontSize: 13, paddingTop: 10 }}>
                  {[
                    ['Parts', order.subtotal],
                    order.leadTimeSurcharge > 0 && [`${order.leadTimeName || 'Faster'} lead time`, order.leadTimeSurcharge],
                    // On an order from a firm quote the paperwork is inside the quoted price.
                    order.paperwork && [PAPERWORK_LABEL, order.paperworkFee > 0 ? order.paperworkFee : 'Included'],
                    order.shippingCost > 0 && ['Shipping', order.shippingCost],
                    ['Total', order.total],
                  ].filter(Boolean).map(([label, amount]) => (
                    <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '3px 0', color: label === 'Total' ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: label === 'Total' ? 700 : 400 }}>
                      <span>{label}</span><span style={{ whiteSpace: 'nowrap' }}>{typeof amount === 'number' ? formatCurrency(amount) : amount}</span>
                    </div>
                  ))}
                </div>
              )}
              {order.paperwork && (
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12 }}>
                  <b>Inspection paperwork ordered.</b> The first piece of each part number is measured against your drawing; the report and a signed certificate of conformance ship with the parts.
                </p>
              )}
              {order.returnPart && (
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
                  <b>Your original part</b> comes back in the box with the finished parts.
                </p>
              )}
              {order.customerNotes && (
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12, whiteSpace: 'pre-wrap' }}><b>{order.rfqId ? 'Quote notes' : 'Your notes'}:</b> {order.customerNotes}</p>
              )}
              {order.drawingFileName && (
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
                  <b>Drawing:</b> {order.drawingFileName}. We review drawings before cutting; we'll contact you before work starts if anything changes the price.
                </p>
              )}
            </div>

            {/* Status Timeline */}
            {statusIndex >= 0 && (
              <div style={card}>
                <h2 style={{ ...h2, marginBottom: 24 }}>Status</h2>
                <div style={{ position: 'relative' }}>
                  {timeline.map((status, idx) => {
                    const isActive = statusIndex >= idx;
                    const isCompleted = statusIndex > idx;
                    return (
                      <div key={status} style={{ display: 'flex', marginBottom: idx < timeline.length - 1 ? 24 : 0 }}>
                        <div style={{ position: 'relative', width: 40, display: 'flex', justifyContent: 'center' }}>
                          <div style={{
                            width: 16, height: 16, borderRadius: '50%',
                            background: isActive ? 'var(--accent)' : 'var(--border-primary)',
                            border: isActive ? '3px solid var(--bg-primary)' : 'none',
                            zIndex: 2, transition: 'all 0.3s',
                          }} />
                          {idx < timeline.length - 1 && (
                            <div style={{
                              position: 'absolute', top: 16, left: '50%',
                              transform: 'translateX(-50%)', width: 2, height: 24,
                              background: isCompleted ? 'var(--accent)' : 'var(--border-primary)',
                              transition: 'all 0.3s',
                            }} />
                          )}
                        </div>
                        <div style={{ paddingLeft: 16 }}>
                          <div style={{ color: isActive ? 'var(--accent)' : 'var(--text-muted)', fontSize: 12, fontWeight: 600 }}>
                            {orderStatusLabel(status)}
                          </div>
                          <div style={{ color: isActive ? 'var(--text-secondary)' : 'var(--text-dim)', fontSize: 11, marginTop: 4 }}>
                            {isCompleted ? 'Completed' : isActive ? 'Current' : 'Pending'}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Shipping Info */}
            {(order.shippingName || order.shippingAddress) && (
              <div style={card}>
                <h2 style={h2}>Shipping Address</h2>
                <div style={{ color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.8 }}>
                  {order.shippingName && <div>{order.shippingName}</div>}
                  {order.shippingAddress && <div>{order.shippingAddress}</div>}
                  <div>{[order.shippingCity, order.shippingState].filter(Boolean).join(', ')} {order.shippingZip || ''}</div>
                  {order.shippingCountry && <div>{order.shippingCountry}</div>}
                </div>
              </div>
            )}

            <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Question about this order?{' '}
              <a href={`mailto:${brand.email}?subject=${encodeURIComponent(`Order ${String(order.id).slice(0, 8).toUpperCase()}`)}`} style={{ color: 'var(--accent)' }}>{brand.email}</a>{' '}
              or <a href={brand.phoneHref} style={{ color: 'var(--accent)' }}>{brand.phone}</a>.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Fact({ label, value, note, accent }) {
  return (
    <div>
      <div className="field-label" style={{ marginBottom: 4 }}>{label}</div>
      <div style={{ color: accent ? 'var(--accent)' : 'var(--text-primary)', fontSize: 14, fontWeight: 600 }}>{value}</div>
      {note && <div style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 2 }}>{note}</div>}
    </div>
  );
}
