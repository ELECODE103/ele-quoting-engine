import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import PublicLayout from '../components/PublicLayout';
import { api } from '../utils/api';
import { formatCurrency, formatDate, formatShipDate, orderStatusLabel } from '../utils/format';
import brand, { PROCESS_LABELS } from '../brand';
import { DeliveryChoice, TaxExemption, deliveryPayload } from '../components/DeliveryOptions';

/**
 * The firm quote behind the link we email when an RFQ is quoted. No account:
 * the signed link is the key. The buyer reviews the price, lead time and
 * validity, then accepts by card (Stripe) or with a purchase order number.
 * After acceptance the same link is their order status page.
 */
export default function FirmQuotePage() {
  const { token } = useParams();
  const [searchParams] = useSearchParams();
  const justPaid = searchParams.get('paid') === 'true';
  const cancelled = searchParams.get('cancelled') === 'true';

  const [quote, setQuote] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [method, setMethod] = useState('card');
  const [form, setForm] = useState({ shippingName: '', shippingAddress: '', shippingCity: '', shippingState: '', shippingZip: '', poNumber: '' });
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
      setForm((f) => ({ ...f, shippingName: f.shippingName || q.contactName || '' }));
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
    if (pickup ? !form.shippingName.trim() : (!form.shippingName.trim() || !form.shippingAddress.trim() || !form.shippingCity.trim() || !form.shippingState.trim() || !form.shippingZip.trim())) {
      return setError(pickup ? 'Tell us who is picking the order up.' : 'Add the full ship-to address.');
    }
    if (method === 'po' && !form.poNumber.trim()) return setError('Enter your purchase order number.');
    setBusy(true);
    try {
      const r = await api.acceptFirmQuote(token, {
        method, ...form,
        // Which delivery choice, a carrier account, a declared exemption. The quoted total is the total either way.
        ...deliveryPayload({ showOptions: Boolean(co?.showOptions), option, carrier, exemption: co?.tax?.exemption, declared: exempt.declared, reason: exempt.reason }),
      });
      if (r.sessionUrl) { window.location.href = r.sessionUrl; return; }
      await load();
      window.scrollTo(0, 0);
    } catch (err) {
      setError(err.message || `That didn't go through. Call ${brand.phone} and we'll take it by phone.`);
    }
    setBusy(false);
  }

  async function payNow() {
    setBusy(true);
    setError('');
    try {
      const r = await api.acceptFirmQuote(token, { method: 'card' });
      if (r.sessionUrl) { window.location.href = r.sessionUrl; return; }
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }

  if (loadError) {
    const expired = loadError.code === 'quote-expired';
    return (
      <PublicLayout title={expired ? 'Quote expired' : 'Quote link'}>
        <section className="section">
          <div className="pub-wrap" style={{ maxWidth: 680 }}>
            <div className="eyebrow" style={{ marginBottom: 14 }}>Firm quote</div>
            <h1 className="display" style={{ marginBottom: 16 }}>{expired ? 'This quote has expired.' : "This link can't be opened."}</h1>
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
  const awaitingCard = accepted && order?.status === 'pending_payment';
  const days = quote.quotedLeadDays;
  const co = quote.checkout;
  const showOptions = Boolean(co?.showOptions);
  const pickup = showOptions && option === 'pickup';
  const taxOn = co?.tax?.mode === 'stripe';

  return (
    <PublicLayout title="Your firm quote">
      <section className="section" style={{ paddingTop: 48 }}>
        <div className="pub-wrap">
          <div className="hero-grid" style={{ alignItems: 'start', gap: 48 }}>
            {/* ─── The quote ─── */}
            <div>
              <div className="eyebrow" style={{ marginBottom: 14 }}>Firm quote · {quote.reference}</div>
              <h1 className="display" style={{ fontSize: 36, marginBottom: 14 }}>
                {accepted ? (awaitingCard ? 'Accepted. Payment is the last step.' : 'Order in. Thank you.') : `${formatCurrency(quote.quotedTotal)}, firm.`}
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
                  <dd style={{ textAlign: 'right', fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>{formatCurrency(quote.quotedTotal)}</dd>
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
                        We have PO <b>{quote.poNumber}</b>. Nothing has been charged. We'll confirm the PO with you and then start work.
                      </p>
                    )}
                    {order.status === 'paid' && (
                      <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                        Payment received. A confirmation is on its way to {quote.email}.
                      </p>
                    )}
                    <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 10 }}>
                      {order.shippingMethod === 'pickup'
                        ? (order.shippedAt ? `Ready for pickup since ${formatDate(order.shippedAt)}.` : `Ready by ${formatShipDate(order.shipBy, { year: true })}.`)
                        : (order.shippedAt ? `Shipped ${formatDate(order.shippedAt)}.` : `Ships by ${formatShipDate(order.shipBy, { year: true })}.`)}
                    </p>
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
                      {busy ? 'Opening secure payment…' : `Pay ${formatCurrency(quote.quotedTotal)} by card`}
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
                <div className="rfq-grid">
                  <label className="full"><span className="field-label">{pickup ? 'Who is picking it up' : 'Name / company'}</span><input className="input" value={form.shippingName} onChange={set('shippingName')} autoComplete="name" required /></label>
                  {!pickup && (<>
                  <label className="full"><span className="field-label">Street address</span><input className="input" value={form.shippingAddress} onChange={set('shippingAddress')} autoComplete="street-address" required /></label>
                  <label><span className="field-label">City</span><input className="input" value={form.shippingCity} onChange={set('shippingCity')} autoComplete="address-level2" required /></label>
                  <label><span className="field-label">State</span><input className="input" value={form.shippingState} onChange={set('shippingState')} autoComplete="address-level1" required /></label>
                  <label><span className="field-label">ZIP</span><input className="input" value={form.shippingZip} onChange={set('shippingZip')} autoComplete="postal-code" required /></label>
                  </>)}
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
                  {busy ? 'Working…' : method === 'card' ? `Accept and pay ${formatCurrency(quote.quotedTotal)}${taxOn && !(exempt.declared && co.tax.exemption.trusted) ? ' plus tax' : ''}` : 'Accept on this PO'}
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
