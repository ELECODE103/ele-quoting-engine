import { useState, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../utils/api';
import { formatCurrency, formatShipDate, formatDate } from '../utils/format';
import { ok, PAPERWORK_LABEL } from '../facts';
import { useAuth } from '../utils/authContext';
import VerifyEmailNotice from '../components/security/VerifyEmailNotice';
import { DeliveryChoice, TaxExemption, deliveryPayload } from '../components/DeliveryOptions';

export default function CheckoutPage() {
  const { quoteId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [quoteData, setQuoteData] = useState(null);
  const [name, setName] = useState('');
  const [street, setStreet] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zip, setZip] = useState('');
  const [country, setCountry] = useState('US');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Delivery choice and tax exemption. Shown only when the shop offers more than "we ship it" or
  // collects tax; what each choice costs comes priced from the server with the quote.
  const [option, setOption] = useState('ship');
  const [carrier, setCarrier] = useState({ carrier: 'UPS', account: '', service: '' });
  const [exempt, setExempt] = useState({ declared: false, reason: '' });

  const wasCancelled = searchParams.get('cancelled') === 'true';
  // Paying needs a confirmed email address (when confirmation emails can be sent at all).
  const { user, verificationEnforced, refresh } = useAuth();
  const mustConfirm = Boolean(user && !user.emailVerified && verificationEnforced);

  useEffect(() => {
    api.getQuoteById(quoteId)
      .then(q => {
        setQuoteData(q);
        // When "we ship it" has no price for this order, start on the first choice that does.
        const first = (q.checkout?.options || []).find((o) => o.available !== false);
        if (first) setOption(first.method);
      })
      .catch(err => setError('Could not load quote: ' + err.message));
  }, [quoteId]);

  const co = quoteData?.checkout;
  const showOptions = Boolean(co?.showOptions);
  const selected = co?.options.find((o) => o.method === option) || co?.options[0];
  const pickup = showOptions && option === 'pickup';
  const taxOn = co?.tax?.mode === 'stripe';
  // The summary reads as it always did unless a setting has changed what is true.
  const plainShipping = !co || (!showOptions && co.shipping.mode === 'formula' && co.shipping.valueText !== 'Free');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = await api.createCheckoutSession(quoteId, {
        shippingName: name,
        shippingAddress: street,
        shippingCity: city,
        shippingState: state,
        shippingZip: zip,
        shippingCountry: country,
        // Which delivery choice, a carrier account, a declared exemption. Never an amount.
        ...deliveryPayload({ showOptions, option, carrier, exemption: co?.tax?.exemption, declared: exempt.declared, reason: exempt.reason }),
      });

      if (result.sessionUrl) {
        // Redirect to Stripe Checkout
        window.location.href = result.sessionUrl;
      } else {
        setError('Could not create payment session');
      }
    } catch (err) {
      if (err.code === 'email-unverified') { await refresh(); setError(''); }
      else setError(err.message || 'Failed to start checkout');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)', padding: '32px' }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <button
          className="btn btn-ghost"
          onClick={() => navigate(`/quote?quote=${quoteId}`)}
          style={{ marginBottom: 24 }}
        >
          ← Back to Quote
        </button>

        {wasCancelled && (
          <div style={{
            background: '#FFF3CD', border: '1px solid #FFECB5', borderRadius: 'var(--radius-md)',
            padding: 12, marginBottom: 24, color: '#664D03', fontSize: 13,
          }}>
            Payment was cancelled. You can try again below.
          </div>
        )}

        {quoteData?.expired && (
          <div role="alert" className="gate-box" style={{ marginBottom: 24 }}>
            This price was held until {formatDate(quoteData.expiresAt)} and has expired.{' '}
            <a href={`/quote?quote=${quoteId}`} style={{ color: 'inherit', fontWeight: 600 }}>Reopen the quote</a> to get today's price. Your parts are still there.
          </div>
        )}

        <VerifyEmailNotice reason="before you pay" />

        <div className="checkout-grid">
          {/* Left: Shipping Form */}
          <div>
            <h1 style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>Checkout</h1>
            <p style={{ color: 'var(--text-muted)', marginBottom: 32 }}>{showOptions ? 'Choose how the order is delivered, then pay securely via Stripe' : 'Provide shipping details, then pay securely via Stripe'}</p>

            <form onSubmit={handleSubmit}>
              {showOptions && (
                <DeliveryChoice options={co.options} carriers={co.carriers} value={option} onChange={setOption} carrier={carrier} onCarrierChange={setCarrier} />
              )}
              <div style={{ marginBottom: 16 }}>
                <label className="field-label" htmlFor="co-name">{pickup ? 'Who is picking it up' : 'Full Name'}</label>
                <input
                  id="co-name"
                  type="text"
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="John Smith"
                  required
                />
              </div>

              {pickup && (
                <div style={{ marginBottom: 24, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  No shipping address needed. The pickup address comes with your order confirmation, after payment. We tell you when the order is ready.
                </div>
              )}
              {!pickup && (<>
              <div style={{ marginBottom: 16 }}>
                <label className="field-label" htmlFor="co-street">Street Address</label>
                <input
                  id="co-street"
                  type="text"
                  className="input"
                  value={street}
                  onChange={(e) => setStreet(e.target.value)}
                  placeholder="123 Main St"
                  required
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginBottom: 16 }}>
                <div>
                  <label className="field-label" htmlFor="co-city">City</label>
                  <input
                    id="co-city"
                    type="text"
                    className="input"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    placeholder="New York"
                    required
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="co-state">State</label>
                  <input
                    id="co-state"
                    type="text"
                    className="input"
                    value={state}
                    onChange={(e) => setState(e.target.value)}
                    placeholder="NY"
                    required
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 24 }}>
                <div>
                  <label className="field-label" htmlFor="co-zip">ZIP Code</label>
                  <input
                    id="co-zip"
                    type="text"
                    className="input"
                    value={zip}
                    onChange={(e) => setZip(e.target.value)}
                    placeholder="10001"
                    required
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="co-country">Country</label>
                  <select
                    id="co-country"
                    className="input"
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                  >
                    <option value="US">United States</option>
                    <option value="CA">Canada</option>
                    <option value="MX">Mexico</option>
                  </select>
                </div>
              </div>
              </>)}

              <TaxExemption
                info={co?.tax?.exemption}
                declared={exempt.declared}
                reason={exempt.reason}
                onChange={setExempt}
                certFileName={quoteData?.taxCertFileName}
                onUpload={async (file) => { const r = await api.uploadTaxCertificate(quoteId, file); setQuoteData((q) => ({ ...q, taxCertFileName: r.taxCertFileName })); setError(''); }}
                onRemove={async () => { await api.removeTaxCertificate(quoteId); setQuoteData((q) => ({ ...q, taxCertFileName: '' })); }}
              />

              {selected && selected.available === false && (
                <div role="status" className="gate-box" style={{ marginBottom: 24 }}>
                  {selected.unavailableReason}{' '}
                  <a href={`/rfq/${quoteId}`} style={{ color: 'inherit', fontWeight: 600 }}>Request a firm quote</a>{co.options.length > 1 ? ', or choose another delivery option above.' : '.'}
                </div>
              )}

              {error && (
                <div style={{ background: 'var(--error-bg)', border: '1px solid var(--error)', borderRadius: 'var(--radius-md)', padding: 12, marginBottom: 24, color: 'var(--error-text)', fontSize: 12 }}>
                  {error}
                </div>
              )}

              <button
                type="submit"
                className="btn btn-primary btn-lg"
                style={{ width: '100%', justifyContent: 'center' }}
                disabled={loading || !quoteData || quoteData.expired || mustConfirm || (selected && selected.available === false)}
                aria-describedby={mustConfirm ? 'pay-needs-email' : undefined}
              >
                {loading ? 'Redirecting to payment...' : 'Pay & Place Order'}
              </button>
              {mustConfirm && (
                <div id="pay-needs-email" style={{ textAlign: 'center', marginTop: 8, fontSize: 12, color: 'var(--warn-text)' }}>
                  The pay button switches on once your email address is confirmed (see the top of this page). Your address details stay as typed.
                </div>
              )}

              <div style={{ textAlign: 'center', marginTop: 12, fontSize: 11, color: 'var(--text-muted)' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ verticalAlign: 'middle', marginRight: 4 }}>
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0110 0v4" />
                </svg>
                Secure payment powered by Stripe
              </div>
            </form>
          </div>

          {/* Right: Order Summary */}
          <div>
            <div style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border-primary)',
              borderRadius: 'var(--radius-lg)',
              padding: 24,
              position: 'sticky',
              top: 100,
            }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>Order Summary</h3>

              <div style={{ marginBottom: 16 }}>
                {(quoteData?.lineItems || []).map((li) => (
                  <div key={li.partId} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 10, fontSize: 12 }}>
                    <span style={{ color: 'var(--text-primary)', minWidth: 0, overflowWrap: 'anywhere' }}>
                      {li.fileName} <span style={{ color: 'var(--text-muted)' }}>× {li.quantity}</span>
                    </span>
                    <span style={{ color: 'var(--text-primary)', fontWeight: 500, whiteSpace: 'nowrap' }}>{formatCurrency(li.lineTotal)}</span>
                  </div>
                ))}

                <div style={{ borderTop: '1px solid var(--border-primary)', margin: '12px 0' }} />

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Subtotal</span>
                  <span style={{ color: 'var(--text-primary)', fontSize: 12, fontWeight: 500 }}>{quoteData ? formatCurrency(quoteData.subtotal) : '...'}</span>
                </div>

                {quoteData?.leadTimeSurcharge > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{quoteData.leadTimeName || 'Rush'} fee</span>
                    <span style={{ color: 'var(--text-primary)', fontSize: 12, fontWeight: 500 }}>{formatCurrency(quoteData.leadTimeSurcharge)}</span>
                  </div>
                )}

                {quoteData?.paperwork && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
                    <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{PAPERWORK_LABEL}</span>
                    <span style={{ color: 'var(--text-primary)', fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap' }}>{formatCurrency(quoteData.paperworkFee)}</span>
                  </div>
                )}

                {/* Shipping and the total: what the server works out now for the delivery choice (never
                    a figure kept from when the quote was priced). With the shop's original settings
                    this is the one "Shipping $x" line it has always been. */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: plainShipping ? 12 : 4 }} data-testid="summary-shipping">
                  <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Shipping</span>
                  <span style={{ color: 'var(--text-primary)', fontSize: 12, fontWeight: 500 }}>
                    {!quoteData ? '...' : plainShipping ? formatCurrency(selected?.shippingCost ?? quoteData.shippingEstimate) : selected.shippingText}
                  </span>
                </div>
                {!plainShipping && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }} data-testid="summary-shipping-note">
                    {selected.available === false ? selected.unavailableReason : selected.detail}
                  </div>
                )}

                {taxOn && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }} data-testid="summary-tax">
                    <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Sales tax</span>
                    <span style={{ color: 'var(--text-primary)', fontSize: 12, fontWeight: 500 }}>
                      {exempt.declared && co.tax.exemption.trusted ? 'Exempt with certificate' : 'Added at payment'}
                    </span>
                  </div>
                )}

                <div style={{ borderTop: '1px solid var(--border-primary)', paddingTop: 12, marginTop: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 600 }}>{taxOn ? 'Total before tax' : 'Total'}</span>
                    <span style={{ color: 'var(--accent)', fontSize: 16, fontWeight: 700 }} data-testid="summary-total">
                      {!quoteData ? '...' : plainShipping ? formatCurrency(selected?.total ?? quoteData.orderTotal) : (selected.total != null ? formatCurrency(selected.total) : 'To be confirmed')}
                    </span>
                  </div>
                  {taxOn && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }} data-testid="summary-tax-note">{co.tax.note}</div>}
                </div>
              </div>

              {quoteData?.shipBy && (
                <div style={{ marginBottom: 16, fontSize: 13, color: 'var(--text-primary)' }}>
                  <b>{pickup ? 'Ready by' : 'Ships by'} {formatShipDate(quoteData.shipBy, { year: true })}</b>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {quoteData.leadTimeName ? `${quoteData.leadTimeName} lead time, ` : ''}if you pay today. Weekends and federal holidays don't count.
                  </div>
                  {quoteData.expiresAt && !quoteData.expired && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Price held until {formatDate(quoteData.expiresAt)}.</div>
                  )}
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                    {quoteData.paperwork
                      ? 'Inspection paperwork ordered: the first-article report and the signed certificate of conformance ship with the parts.'
                      : <>No first-article report or certificate of conformance on this order. Need them? <a href={`/quote?quote=${quoteId}`} style={{ color: 'inherit', fontWeight: 600 }}>Go back and tick the box</a>.</>}
                  </div>
                  {quoteData.drawingFileName && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                      Drawing attached: {quoteData.drawingFileName}. We review drawings before cutting; we'll contact you before work starts if anything changes the price.
                    </div>
                  )}
                </div>
              )}

              <div style={{
                background: 'var(--accent-bg)',
                border: '1px solid var(--accent)',
                borderRadius: 'var(--radius-md)',
                padding: 12,
                fontSize: 11,
                color: 'var(--accent)',
                lineHeight: 1.6,
              }}>
                ⓘ You'll be redirected to Stripe to complete payment securely. Your card info never touches our servers.
              </div>

              <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                🔒 You retain full IP ownership of your designs. Files are stored securely and never shared. {ok('paperwork-packet') ? 'NDA available on request.' : ''}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
