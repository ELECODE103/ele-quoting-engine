import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import PublicLayout from '../components/PublicLayout';
import { api } from '../utils/api';
import { formatCurrency, formatDate, formatShipDate, orderStatusLabel } from '../utils/format';
import brand, { PROCESS_LABELS } from '../brand';
import { DeliveryChoice, TaxExemption, deliveryPayload } from '../components/DeliveryOptions';
import { QUOTE_LINK_KEY } from './FirmQuoteReturnPage';
import { describeOrderState } from '../utils/messages';
import ShipToFields, { shipToComplete } from '../components/form/ShipToFields';

/** Remember this quote's link in this tab, so the page the card processor returns to can come back here. */
function rememberLink(token) {
  try { window.sessionStorage.setItem(QUOTE_LINK_KEY, token); } catch { /* storage switched off: the return page shows the order's status itself */ }
}

/**
 * The firm quote behind the link we email when an RFQ is quoted. No account:
 * the signed link is the key. The buyer reviews the price, lead time and
 * validity, then accepts by card (Stripe) or with a purchase order number.
 * After acceptance the same link is their order status page.
 *
 * Where it ships (review of 2026-11-13, N-05): the quote was priced for the address given with the
 * request (`quote.shipTo`), and the order ships there. The buyer may type another address, and is
 * told first what that means: the server does not accept the quote at the quoted total for a
 * different address; it keeps the new address, closes this link and sends the quote back to the
 * shop to confirm the price (`address-reconfirm`). A quote priced before requests carried an
 * address asks for the address here and goes the same way, once. Pickup needs no freight and is
 * accepted as it is.
 */
export default function FirmQuotePage() {
  const { token } = useParams();
  const [searchParams] = useSearchParams();
  const justPaid = searchParams.get('paid') === 'true';
  const cancelled = searchParams.get('cancelled') === 'true';

  const [quote, setQuote] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [method, setMethod] = useState('card');
  const [form, setForm] = useState({ shippingName: '', shippingAddress: '', shippingCity: '', shippingState: '', shippingZip: '', shippingCountry: 'US', poNumber: '' });
  // The buyer has asked to ship somewhere other than the address the quote was priced for.
  const [otherAddress, setOtherAddress] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Delivery choice and tax exemption: shown only when the shop offers a choice or collects tax.
  const [option, setOption] = useState('ship');
  const [carrier, setCarrier] = useState({ carrier: 'UPS', account: '', service: '' });
  const [exempt, setExempt] = useState({ declared: false, reason: '' });

  const load = useCallback(async () => {
    try {
      // Back from Stripe: have the server check the payment before showing the page.
      const q = justPaid ? await api.confirmFirmQuotePayment(token).catch(() => api.getFirmQuote(token)) : await api.getFirmQuote(token);
      setQuote(q);
      setForm((f) => ({ ...f, shippingName: f.shippingName || (q.shipTo && q.shipTo.shippingName) || q.contactName || '' }));
      // A quote priced for pickup starts on pickup, when the shop still offers it.
      if (q.shipTo && q.shipTo.kind === 'pickup' && (q.checkout?.options || []).some((o) => o.method === 'pickup')) setOption('pickup');
    } catch (err) {
      setLoadError(err);
    }
  }, [token, justPaid]);

  useEffect(() => { load(); }, [load]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function accept(e) {
    e.preventDefault();
    setError('');
    const co = quote.checkout;
    const pickup = Boolean(co?.showOptions) && option === 'pickup';
    // The address the quote was priced for stands unless the buyer chose to give another.
    const priced = quote.shipTo && quote.shipTo.kind === 'address' && !otherAddress;
    if (pickup ? !form.shippingName.trim() : (!priced && !shipToComplete(form))) {
      return setError(pickup ? 'Tell us who is picking the order up.' : 'Add the full ship-to address.');
    }
    if (method === 'po' && !form.poNumber.trim()) return setError('Enter your purchase order number.');
    setBusy(true);
    try {
      const { shippingName, shippingAddress, shippingCity, shippingState, shippingZip, shippingCountry, poNumber } = form;
      const r = await api.acceptFirmQuote(token, {
        method, poNumber, shippingName,
        // Only an address the buyer typed is sent: with none, the server ships to the address the quote was priced for.
        ...(pickup || priced ? {} : { shippingAddress, shippingCity, shippingState, shippingZip, shippingCountry }),
        // Which delivery choice, a carrier account, a declared exemption. The quoted total is the total either way.
        ...deliveryPayload({ showOptions: Boolean(co?.showOptions), option, carrier, exemption: co?.tax?.exemption, declared: exempt.declared, reason: exempt.reason }),
        // The total on screen goes with the acceptance: if the quote's price is no longer that, nothing is ordered.
        seenTotal: quote.linkAmount ?? quote.quotedTotal,
      });
      if (r.sessionUrl) { rememberLink(token); window.location.href = r.sessionUrl; return; }
      await load();
      window.scrollTo(0, 0);
    } catch (err) {
      // The quote changed while this page was open: show what it says now. The same for an address
      // the shop has to confirm the price for: nothing was accepted, and the page says what happens next.
      if (err.code === 'quote-changed' || err.code === 'address-reconfirm') { setLoadError(err); return; }
      setError(err.message || `That didn't go through. Call ${brand.phone} and we'll take it by phone.`);
    }
    setBusy(false);
  }

  async function payNow() {
    setBusy(true);
    setError('');
    try {
      const r = await api.acceptFirmQuote(token, { method: 'card' });
      if (r.sessionUrl) { rememberLink(token); window.location.href = r.sessionUrl; return; }
    } catch (err) {
      // Paid or closed in the meantime: show the page as it is now.
      if (err.code === 'already-accepted') { await load(); setBusy(false); return; }
      setError(err.message);
    }
    setBusy(false);
  }

  if (loadError) {
    const expired = loadError.code === 'quote-expired';
    const changed = loadError.code === 'quote-changed';
    const reconfirm = loadError.code === 'address-reconfirm';
    if (reconfirm) {
      return (
        <PublicLayout title="Confirming the price for your address">
          <section className="section">
            <div className="pub-wrap" style={{ maxWidth: 680 }}>
              <div className="eyebrow" style={{ marginBottom: 14 }}>Firm quote</div>
              <h1 className="display" style={{ marginBottom: 16 }}>We are confirming the price for your address.</h1>
              <p className="lede" role="status" style={{ marginBottom: 24 }} data-testid="address-reconfirm">{loadError.message}</p>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <a className="btn btn-primary" href={`mailto:${brand.email}?subject=${encodeURIComponent('My quote: ship-to address')}`}>Email {brand.email}</a>
                <a className="btn btn-ghost" href={brand.phoneHref}>Call {brand.phone}</a>
              </div>
            </div>
          </section>
        </PublicLayout>
      );
    }
    return (
      <PublicLayout title={expired ? 'Quote expired' : changed ? 'Quote updated' : 'Quote link'}>
        <section className="section">
          <div className="pub-wrap" style={{ maxWidth: 680 }}>
            <div className="eyebrow" style={{ marginBottom: 14 }}>Firm quote</div>
            <h1 className="display" style={{ marginBottom: 16 }}>{expired ? 'This quote has expired.' : changed ? 'This quote has been updated.' : "This link can't be opened."}</h1>
            <p className="lede" role="alert" style={{ marginBottom: 24 }}>{loadError.message}</p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <a className="btn btn-primary" href={`mailto:${brand.email}?subject=${encodeURIComponent('Refresh my quote')}`}>Email {brand.email}</a>
              <a className="btn btn-ghost" href={brand.phoneHref}>Call {brand.phone}</a>
            </div>
          </div>
        </section>
      </PublicLayout>
    );
  }

  if (!quote) {
    return (
      <PublicLayout title="Your firm quote">
        <section className="section"><div className="pub-wrap" style={{ textAlign: 'center' }}><div className="spinner" style={{ margin: '0 auto' }} role="status" aria-label="Loading your quote" /></div></section>
      </PublicLayout>
    );
  }

  const order = quote.order;
  const accepted = quote.status === 'accepted';
  const underReview = Boolean(order?.paymentUnderReview);
  const awaitingCard = accepted && order?.status === 'pending_payment' && !underReview;
  const days = quote.quotedLeadDays;
  // The amount this link was sent for. The server refuses the link if the quote no longer matches it.
  const price = quote.linkAmount ?? quote.quotedTotal;
  const co = quote.checkout;
  const showOptions = Boolean(co?.showOptions);
  const pickup = showOptions && option === 'pickup';
  const taxOn = co?.tax?.mode === 'stripe';
  // The address this quote was priced for, when the request gave one.
  const pricedFor = quote.shipTo && quote.shipTo.kind === 'address' ? quote.shipTo : null;
  const usePriced = Boolean(pricedFor) && !otherAddress;

  return (
    <PublicLayout title="Your firm quote">
      <section className="section" style={{ paddingTop: 48 }}>
        <div className="pub-wrap">
          <div className="hero-grid" style={{ alignItems: 'start', gap: 48 }}>
            {/* ─── The quote ─── */}
            <div>
              <div className="eyebrow" style={{ marginBottom: 14 }}>Firm quote · {quote.reference}</div>
              <h1 className="display" style={{ fontSize: 36, marginBottom: 14 }}>
                {accepted
                  ? (awaitingCard ? 'Accepted. Payment is the last step.'
                    : underReview ? "We're checking your payment."
                    : order?.status === 'refunded' ? 'This order was refunded.'
                    : order?.status === 'cancelled' ? 'This order was cancelled.'
                    : 'Order in. Thank you.')
                  : `${formatCurrency(price)}, firm.`}
              </h1>
              <p className="lede" style={{ marginBottom: 24 }}>
                {accepted
                  ? `For ${quote.contactName}${quote.company ? `, ${quote.company}` : ''}.`
                  : `Prepared for ${quote.contactName}${quote.company ? `, ${quote.company}` : ''}. Good until ${formatDate(quote.validUntil)}.`}
              </p>

              <div className="card" style={{ padding: 18, marginBottom: 20 }}>
                <div className="field-label">What's quoted</div>
                {quote.parts.length === 0 && <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '8px 0' }}>Parts as described in your request.</div>}
                {quote.parts.map((p, i) => (
                  <div key={i} style={{ padding: '8px 0', borderBottom: '1px solid var(--border-subtle)', fontSize: 13 }}>
                    <div style={{ fontWeight: 600, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{p.fileName}</div>
                    <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                      {p.quantity} pcs · {[p.materialName, PROCESS_LABELS[p.process] || p.process].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                ))}
                {quote.quoteNote && <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 12, whiteSpace: 'pre-wrap' }}>{quote.quoteNote}</p>}
                {/* What the price covers besides the parts: inspection paperwork (always stated) and, for a part that was shipped in, its return. */}
                {(quote.covers || []).map((line) => (
                  <p key={line} style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 10 }}>{line}</p>
                ))}
                <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 16px', marginTop: 14, fontSize: 13 }}>
                  <dt style={{ color: 'var(--text-dim)' }}>Price</dt>
                  <dd style={{ textAlign: 'right', fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>{formatCurrency(price)}</dd>
                  <dt style={{ color: 'var(--text-dim)' }}>Lead time</dt>
                  <dd style={{ textAlign: 'right' }}>{days} business day{days === 1 ? '' : 's'}</dd>
                  <dt style={{ color: 'var(--text-dim)' }}>{order ? 'Ships by' : 'Ships by, if accepted today'}</dt>
                  <dd style={{ textAlign: 'right', fontWeight: 600 }}>{formatShipDate(order?.shipBy || quote.shipBy, { year: true })}</dd>
                  {!accepted && <><dt style={{ color: 'var(--text-dim)' }}>Good until</dt><dd style={{ textAlign: 'right' }}>{formatDate(quote.validUntil)}</dd></>}
                  {quote.poNumber && <><dt style={{ color: 'var(--text-dim)' }}>PO number</dt><dd style={{ textAlign: 'right' }}>{quote.poNumber}</dd></>}
                </dl>
              </div>

              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                Questions before you commit? <a href={brand.phoneHref} style={{ color: 'var(--accent)' }}>{brand.phone}</a> or{' '}
                <a href={`mailto:${brand.email}`} style={{ color: 'var(--accent)' }}>{brand.email}</a>.
              </p>
            </div>

            {/* ─── Accept, or order status ─── */}
            {accepted ? (
              <div className="card" style={{ padding: 24 }} aria-live="polite">
                {order && !awaitingCard && (
                  <>
                    <div className="field-label">Order {order.reference}</div>
                    <p style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', margin: '6px 0 12px' }}>{orderStatusLabel(order.status)}</p>
                    {order.status === 'pending_po' && (
                      <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                        {describeOrderState('awaiting-po', { poNumber: quote.poNumber })}
                      </p>
                    )}
                    {order.status === 'paid' && (
                      <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                        Payment received. A confirmation is on its way to {quote.email}.
                      </p>
                    )}
                    {underReview && (
                      <p role="status" style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                        {describeOrderState('payment-under-review', { email: quote.email })}
                      </p>
                    )}
                    {order.discountAmount > 0 && order.amountPaid !== null && (
                      <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                        Promotion code: {formatCurrency(order.discountAmount)} off. You paid {formatCurrency(order.amountPaid)}.
                      </p>
                    )}
                    {order.status === 'refunded' && (
                      <p role="status" style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                        {describeOrderState('refunded', { amount: order.refundedAmount || order.total })}
                      </p>
                    )}
                    {order.status !== 'refunded' && order.refundedAmount > 0 && (
                      <p role="status" style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                        {describeOrderState('partially-refunded', { amount: order.refundedAmount })}
                      </p>
                    )}
                    {order.status === 'cancelled' && (
                      <p role="status" style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                        {describeOrderState('cancelled')}
                      </p>
                    )}
                    {!['refunded', 'cancelled'].includes(order.status) && !underReview && (
                      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 10 }}>
                        {order.shippingMethod === 'pickup'
                          ? (order.shippedAt ? `Ready for pickup since ${formatDate(order.shippedAt)}.` : `Ready by ${formatShipDate(order.shipBy, { year: true })}.`)
                          : (order.shippedAt ? `Shipped ${formatDate(order.shippedAt)}.` : `Ships by ${formatShipDate(order.shipBy, { year: true })}.`)}
                      </p>
                    )}
                    {/* Delivery and tax, as the server states them for this order. */}
                    {order.deliveryLine && <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 10 }} data-testid="order-delivery">{order.deliveryLine}.</p>}
                    {order.pickupAddress && (
                      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 10 }} data-testid="pickup-address">
                        Pick up at: {order.pickupAddress.name}, {order.pickupAddress.lines.join(', ')}. Call {brand.phone} before you come.
                      </p>
                    )}
                    {order.taxLine && (
                      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 10 }} data-testid="order-tax">
                        Sales tax: {order.taxLine.valueText || formatCurrency(order.taxLine.amount)}.{order.tax > 0 ? ` Total paid ${formatCurrency(order.total)}.` : ''}
                      </p>
                    )}
                    {order.trackingNumber && (
                      <p style={{ fontSize: 13, marginTop: 10 }}>
                        {order.carrier} tracking:{' '}
                        {order.trackingUrl
                          ? <a href={order.trackingUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontWeight: 600 }}>{order.trackingNumber}</a>
                          : <b>{order.trackingNumber}</b>}
                      </p>
                    )}
                    <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 16 }}>Keep this link: it's your order page.</p>
                  </>
                )}
                {awaitingCard && (
                  <>
                    <div className="field-label">Payment</div>
                    <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '6px 0 16px' }}>
                      {cancelled ? 'The card payment was cancelled. Nothing was charged.' : justPaid ? "We're still waiting for the card processor to confirm. Refresh in a minute." : "You accepted this quote but the card payment wasn't finished."}
                    </p>
                    <button className="btn btn-primary btn-lg" style={{ width: '100%', justifyContent: 'center' }} disabled={busy} onClick={payNow}>
                      {busy ? 'Opening secure payment…' : `Pay ${formatCurrency(price)} by card`}
                    </button>
                    <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 12 }}>Would rather send a PO? Call {brand.phone}.</p>
                    {error && <div role="alert" style={{ color: 'var(--error-text)', fontSize: 13, marginTop: 12 }}>{error}</div>}
                  </>
                )}
              </div>
            ) : quote.status === 'quoted' ? (
              <form className="card" style={{ padding: 24 }} onSubmit={accept} noValidate aria-label="Accept this quote">
                {showOptions && (
                  <DeliveryChoice options={co.options} carriers={co.carriers} value={option} onChange={setOption} carrier={carrier} onCarrierChange={setCarrier} showTotals={false} />
                )}
                <div className="field-label" style={{ marginBottom: 10 }}>{pickup ? 'Pickup' : 'Ship to'}</div>
                {/* The address the quote was priced for: shown, not asked for again. */}
                {!pickup && usePriced && (
                  <div className="plain-box" style={{ marginBottom: 12 }} data-testid="priced-ship-to">
                    <div style={{ fontSize: 13, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{pricedFor.line}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
                      This is the address the price is for.{' '}
                      <button type="button" className="linklike-inline" onClick={() => { setOtherAddress(true); setForm((f) => ({ ...f, shippingAddress: '', shippingCity: '', shippingState: '', shippingZip: '', shippingCountry: 'US' })); }}>Ship to a different address</button>
                    </div>
                  </div>
                )}
                {!pickup && !usePriced && (
                  <div className="gate-box" role="status" style={{ marginBottom: 12 }} data-testid="address-needs-confirming">
                    {pricedFor
                      ? <>The price is for delivery to {pricedFor.line}. For a different address we confirm the price first: when you press the button below, nothing is ordered or charged, and we email you the quote again for the new address.{' '}
                        <button type="button" className="linklike-inline" onClick={() => setOtherAddress(false)}>Keep the original address</button></>
                      : quote.shipTo && quote.shipTo.kind === 'pickup'
                        ? 'This quote was priced for pickup at our shop. To have it shipped we confirm the price first: when you press the button below, nothing is ordered or charged, and we email you the quote again with shipping to this address.'
                        : 'We priced this quote before we had a ship-to address. Enter it here: when you press the button below, nothing is ordered or charged yet. We confirm the price for this address and email you the quote again.'}
                  </div>
                )}
                <div className="rfq-grid">
                  {(pickup || usePriced) && (
                    <label className="full"><span className="field-label">{pickup ? 'Who is picking it up' : 'Name / company on the box'}</span><input className="input" value={form.shippingName} onChange={set('shippingName')} autoComplete="name" required /></label>
                  )}
                  {!pickup && !usePriced && (
                    <ShipToFields value={form} onChange={(v) => setForm((f) => ({ ...f, ...v }))} idPrefix="fq-ship" />
                  )}
                </div>
                {pickup && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>We confirm the pickup address and a time with you once the order is in.</div>}

                <fieldset style={{ border: 'none', padding: 0, margin: '20px 0 0' }}>
                  <legend className="field-label">How would you like to pay?</legend>
                  <div className="flex-col gap-sm" style={{ marginTop: 6 }}>
                    <label className={`lead-option${method === 'card' ? ' on' : ''}`}>
                      <input type="radio" name="pay-method" className="sr-only" checked={method === 'card'} onChange={() => setMethod('card')} />
                      <span className="lead-dot" aria-hidden="true" />
                      <span style={{ fontSize: 13 }}>Card<span style={{ display: 'block', fontSize: 11, color: 'var(--text-dim)' }}>Pay now on Stripe's secure page.</span></span>
                    </label>
                    <label className={`lead-option${method === 'po' ? ' on' : ''}`}>
                      <input type="radio" name="pay-method" className="sr-only" checked={method === 'po'} onChange={() => setMethod('po')} />
                      <span className="lead-dot" aria-hidden="true" />
                      <span style={{ fontSize: 13 }}>Purchase order<span style={{ display: 'block', fontSize: 11, color: 'var(--text-dim)' }}>Give us the PO number. Nothing is charged; we confirm the PO with you before starting.</span></span>
                    </label>
                  </div>
                </fieldset>

                {method === 'po' && (
                  <label style={{ display: 'block', marginTop: 14 }}>
                    <span className="field-label">PO number</span>
                    <input className="input" value={form.poNumber} onChange={set('poNumber')} maxLength={60} required />
                  </label>
                )}

                {/* Sales tax, when the shop collects it: added on the payment page for a card, per invoice for a PO. */}
                {taxOn && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 14, lineHeight: 1.5 }} data-testid="firm-tax-note">
                    {method === 'card' ? co.tax.note : co.tax.poNote}
                  </div>
                )}
                {taxOn && (
                  <div style={{ marginTop: 14 }}>
                    <TaxExemption
                      info={method === 'card' ? co.tax.exemption : { ...co.tax.exemption, note: 'Tick the box and attach your certificate. We read it before we invoice.' }}
                      declared={exempt.declared}
                      reason={exempt.reason}
                      onChange={setExempt}
                      certFileName={quote.taxCertFileName}
                      onUpload={async (file) => { const r = await api.uploadFirmQuoteCertificate(token, file); setQuote((q) => ({ ...q, taxCertFileName: r.taxCertFileName })); setError(''); }}
                      onRemove={async () => { await api.removeFirmQuoteCertificate(token); setQuote((q) => ({ ...q, taxCertFileName: '' })); }}
                    />
                  </div>
                )}

                {cancelled && <div className="gate-box" role="status" style={{ marginTop: 14 }}>The card payment was cancelled. Nothing was charged.</div>}
                {error && <div role="alert" style={{ color: 'var(--error-text)', fontSize: 13, marginTop: 12 }}>{error}</div>}
                <button className="btn btn-primary btn-lg" type="submit" disabled={busy} style={{ width: '100%', justifyContent: 'center', marginTop: 18 }}>
                  {busy ? 'Working…' : (!pickup && !usePriced) ? 'Send this address for a confirmed price' : method === 'card' ? `Accept and pay ${formatCurrency(price)}${taxOn && !(exempt.declared && co.tax.exemption.trusted) ? ' plus tax' : ''}` : 'Accept on this PO'}
                </button>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 10, textAlign: 'center' }}>
                  The ship date counts from the day you accept. Weekends and federal holidays don't count.
                </div>
              </form>
            ) : (
              <div className="card" style={{ padding: 24 }}>
                <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                  This quote is no longer open{quote.status === 'expired' ? `: it expired on ${formatDate(quote.validUntil)}` : ''}. Reply to the quote email or call {brand.phone} and we'll refresh it.
                </p>
                <Link to="/quote" className="btn btn-ghost" style={{ marginTop: 14 }}>Start a new quote</Link>
              </div>
            )}
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
