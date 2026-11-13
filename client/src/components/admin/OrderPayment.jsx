import { useEffect, useState } from 'react';
import { api } from '../../utils/api';
import { formatCurrency, formatDateTime } from '../../utils/format';

/**
 * The payment side of an order, for the owner: what needs attention and why, refunds,
 * disputes, promotion-code discounts, and orders marked paid by hand. The words here are the
 * owner's working words; the customer's pages say less (OrderTrackingPage, FirmQuotePage).
 */

const ATTENTION_LABELS = {
  'duplicate-payment': 'Duplicate payment',
  'late-payment': 'Late payment',
  'payment-mismatch': 'Payment does not match',
  'zero-payment': 'Nothing was collected',
  dispute: 'Payment disputed',
  'refund-problem': 'Refund problem',
};

const WHAT_TO_DO = {
  'duplicate-payment': 'Refund the second payment in Stripe, unless the customer meant to pay twice. Then clear this flag.',
  'late-payment': 'This order was closed when the payment arrived. Refund it in Stripe, or mark the order paid below if you will build it.',
  'payment-mismatch': 'The order has not been marked paid. Look at the payment in Stripe: refund it, or mark the order paid below and say why.',
  'zero-payment': 'A promotion code covered the whole amount, so nothing was collected. Mark the order paid below if that was meant; otherwise cancel it.',
  dispute: "Answer the dispute in Stripe before its deadline. Nothing was cancelled: it's your call whether to keep working on this order.",
  'refund-problem': 'A refund did not go through or was reversed. Check the payment in Stripe.',
};

const EVENT_LABELS = {
  'order-paid': 'Paid by card',
  'manual-paid': 'Marked paid by hand',
  'po-order': 'Accepted on a purchase order',
  'duplicate-payment': 'Second payment received',
  'late-payment': 'Payment received after the order closed',
  'payment-mismatch': 'Payment that does not match the order',
  'zero-payment': 'Checkout completed with nothing to pay',
  refund: 'Refund',
  'refund-problem': 'Refund problem',
  'dispute-opened': 'Dispute opened',
  'dispute-closed': 'Dispute closed',
  'order-expired': 'Closed unpaid',
  'order-cancelled': 'Cancelled',
  'attention-resolved': 'Flag cleared',
};

/** Small tags for the order list: needs attention, refunded, part refunded, disputed, expired, discount, paid by hand. */
export function OrderFlags({ order }) {
  const refunded = Number(order.refundedAmount) || 0;
  const tags = [];
  if (order.attention) tags.push(['tag-fail', `Needs attention: ${(ATTENTION_LABELS[order.attention] || 'check payment').toLowerCase()}`]);
  if (order.status === 'refunded') tags.push(['tag-warn', `Refunded ${formatCurrency(refunded || order.total)}`]);
  else if (refunded > 0) tags.push(['tag-warn', `Part refunded ${formatCurrency(refunded)}`]);
  if (order.disputeStatus === 'open' && order.attention !== 'dispute') tags.push(['tag-fail', 'Disputed']);
  if (order.disputeStatus === 'lost') tags.push(['tag-fail', 'Dispute lost']);
  if (order.status === 'expired') tags.push(['tag-warn', 'Never paid']);
  if (Number(order.discountAmount) > 0) tags.push(['tag-warn', `Promo -${formatCurrency(order.discountAmount)}`]);
  if (order.paidVia === 'manual') tags.push(['tag-warn', 'Paid by hand']);
  if (tags.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }} data-testid="order-flags">
      {tags.map(([cls, text]) => <span key={text} className={`tag ${cls}`}>{text}</span>)}
    </div>
  );
}

/** One line above the order list: how many orders are waiting for the owner, and what is switched on. */
export function PaymentStatus({ orders = [] }) {
  const [settings, setSettings] = useState(null);
  // Asked again whenever the list changes: the count is of ALL orders, and the list shows one page of them.
  useEffect(() => { api.getPaymentSettings().then(setSettings).catch(() => setSettings(null)); }, [orders]);
  const waiting = settings && Number.isFinite(Number(settings.needsAttention)) ? Number(settings.needsAttention) : orders.filter((o) => o.attention).length;
  return (
    <div className="card" data-testid="payment-status" style={{ padding: '10px 14px', marginBottom: 12, fontSize: 12, display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
      <span style={{ fontWeight: 700, color: waiting ? 'var(--error-text, #B42318)' : 'var(--text-secondary)' }} data-testid="attention-count">
        {waiting ? `${waiting} order${waiting === 1 ? '' : 's'} need${waiting === 1 ? 's' : ''} attention` : 'No orders need attention'}
      </span>
      {settings && (
        <>
          <span>Promotion codes at checkout: <b data-testid="promo-setting">{settings.promotionCodes ? 'On' : 'Off'}</b></span>
          <span>A payment page stays open for <b>{settings.sessionMinutes >= 120 ? `${settings.sessionMinutes / 60} hours` : `${settings.sessionMinutes} minutes`}</b>; unpaid orders close after that</span>
          {!settings.shopEmails && <span style={{ color: 'var(--error-text, #B42318)', fontWeight: 600 }}>Order emails to the shop are off</span>}
        </>
      )}
    </div>
  );
}

/** In the order drawer: the flag with what to do about it, the payment facts, and the money history. */
export function OrderPaymentPanel({ order, onChanged }) {
  const [busy, setBusy] = useState(false);
  const refunded = Number(order.refundedAmount) || 0;
  const discount = Number(order.discountAmount) || 0;

  async function resolve() {
    const note = window.prompt('What was done about it? (for example: refunded in Stripe, customer called)');
    if (!note || !note.trim()) return;
    setBusy(true);
    try { await api.resolveOrderAttention(order.id, note.trim()); if (onChanged) await onChanged(); }
    catch (e) { alert(e.message); }
    setBusy(false);
  }

  const facts = [
    order.status === 'refunded' && ['Refunded', `${formatCurrency(refunded || order.total)} — the whole payment. Not in the production queue.`],
    order.status !== 'refunded' && refunded > 0 && ['Part refunded', `${formatCurrency(refunded)} of ${formatCurrency(order.amountPaid ?? order.total)}. The order is still active.`],
    discount > 0 && ['Promotion code', `${formatCurrency(discount)} off; ${formatCurrency(order.amountPaid || 0)} collected of ${formatCurrency(order.total)}`],
    order.paidVia === 'manual' && ['Marked paid by hand', `${order.manualPaidReason || ''}${order.manualPaidBy ? ` (${order.manualPaidBy})` : ''}`],
    order.disputeStatus && ['Dispute', { open: 'Open: answer it in Stripe', won: 'Won: the payment stands', lost: 'Lost: the bank took the money back', closed: 'Closed' }[order.disputeStatus] || order.disputeStatus],
    order.status === 'expired' && ['Never paid', 'The payment page lapsed and this order closed. The quote can be ordered again.'],
    order.status === 'cancelled' && ['Cancelled', 'Its payment page was closed. If money was already taken, refund it in Stripe.'],
  ].filter(Boolean);
  const events = order.paymentEvents || [];
  if (!order.attention && facts.length === 0 && events.length === 0) return null;

  return (
    <div style={{ marginBottom: 16 }} data-testid="order-payment-panel">
      {order.attention && (
        <div role="alert" data-testid="attention-banner" style={{ marginBottom: 10, padding: '12px 14px', border: '2px solid #B42318', borderRadius: 6, background: '#FEF3F2', color: '#7A271A', fontSize: 13, lineHeight: 1.5 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Needs attention: {(ATTENTION_LABELS[order.attention] || 'check payment').toLowerCase()}</div>
          <div style={{ margin: '4px 0' }}>{order.attentionNote}</div>
          <div style={{ fontWeight: 600 }}>{WHAT_TO_DO[order.attention] || ''}</div>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={resolve} style={{ fontSize: 11, padding: '4px 10px', marginTop: 8 }}>
            {busy ? 'Saving…' : "I've dealt with it: clear the flag"}
          </button>
        </div>
      )}
      {facts.length > 0 && (
        <div style={{ padding: '10px 14px', border: '1px solid #e5e5e5', borderRadius: 6, background: '#fafafa', fontSize: 12, marginBottom: 10 }}>
          {facts.map(([k, v]) => (
            <div key={k} style={{ display: 'flex', gap: 10, padding: '2px 0' }}>
              <span style={{ fontWeight: 700, minWidth: 130 }}>{k}</span><span>{v}</span>
            </div>
          ))}
        </div>
      )}
      {events.length > 0 && (
        <div style={{ padding: '10px 14px', border: '1px solid #e5e5e5', borderRadius: 6, background: '#fafafa', fontSize: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Payment history</div>
          {events.map((e, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, padding: '2px 0' }}>
              <span style={{ color: '#888', minWidth: 130 }}>{formatDateTime(e.at)}</span>
              <span style={{ fontWeight: 600 }}>{EVENT_LABELS[e.kind] || e.kind}</span>
              <span>{e.amount !== null && e.amount !== undefined ? formatCurrency(e.amount) : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
