import { useState, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../utils/api';
import { formatCurrency, formatShipDate, formatDate } from '../utils/format';
import { ok, PAPERWORK_LABEL } from '../facts';
import { useAuth } from '../utils/authContext';
import VerifyEmailNotice from '../components/security/VerifyEmailNotice';

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
  // Set when the server says the price is no longer the one this page was showing: the new quote is
  // shown, with the old total beside it, and the buyer presses pay again to accept it.
  const [priceChange, setPriceChange] = useState(null);
  // Refusals that are settled somewhere else (back in the quote, on the order page, by a firm quote).
  const [next, setNext] = useState(null);

  const wasCancelled = searchParams.get('cancelled') === 'true';
  // Paying needs a confirmed email address (when confirmation emails can be sent at all).
  const { user, verificationEnforced, refresh } = useAuth();
  const mustConfirm = Boolean(user && !user.emailVerified && verificationEnforced);

  useEffect(() => {
    api.getQuoteById(quoteId)
      .then(q => setQuoteData(q))
      .catch(err => setError('Could not load quote: ' + err.message));
  }, [quoteId]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setNext(null);
    setLoading(true);

    try {
      const result = await api.createCheckoutSession(quoteId, {
        shippingName: name,
        shippingAddress: street,
        shippingCity: city,
        shippingState: state,
        shippingZip: zip,
        shippingCountry: country,
      }, Number(quoteData?.orderTotal));

      if (result.sessionUrl) {
        // Redirect to Stripe Checkout
        window.location.href = result.sessionUrl;
      } else {
        setError('Could not create payment session');
      }
    } catch (err) {
      const data = err.data || {};
      if (err.code === 'email-unverified') { await refresh(); setError(''); }
      else if (err.code === 'quote-changed' && data.quote && !data.reopen) {
        // Nothing was charged. Show today's price; the same button accepts it.
        setPriceChange({ was: Number.isFinite(data.previousTotal) ? data.previousTotal : quoteData?.orderTotal, now: data.quote.orderTotal });
        setQuoteData(data.quote);
      } else if (err.code === 'quote-changed' || err.code === 'quote-needs-update') {
        setNext({ text: 'Something on this quote has changed since it was priced, so we have not charged you.', link: `/quote?quote=${quoteId}`, label: 'Reopen the quote to see today\'s price' });
      } else if (err.code === 'rfq-required' || err.code === 'price-check-failed') {
        setNext({ text: 'This order needs a firm quote from us before it can be paid for. Nothing was charged.', link: `/rfq/${quoteId}`, label: 'Send it to us for a firm quote' });
      } else if (err.code === 'quote-already-ordered') {
        setNext({ text: 'This quote has already been ordered.', link: data.orderId ? `/orders/${data.orderId}` : '/dashboard', label: data.orderId ? 'Open that order' : 'See your orders' });
      } else setError(err.message || 'Failed to start checkout');
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

        {priceChange && (
          <div role="alert" className="gate-box" style={{ marginBottom: 24 }} data-testid="price-changed">
            <b>The price of this quote has changed.</b>{' '}
            {Number.isFinite(priceChange.was) ? <>It was {formatCurrency(priceChange.was)}; it is now <b>{formatCurrency(priceChange.now)}</b>.</> : <>It is now <b>{formatCurrency(priceChange.now)}</b>.</>}{' '}
            We have not charged you. Check the new total in the summary, then press the pay button again to go ahead at this price,
            or <a href={`/quote?quote=${quoteId}`} style={{ color: 'inherit', fontWeight: 600 }}>go back to the quote</a>.
          </div>
        )}

        {next && (
          <div role="alert" className="gate-box" style={{ marginBottom: 24 }} data-testid="checkout-next">
            {next.text}{' '}
            <a href={next.link} style={{ color: 'inherit', fontWeight: 600 }}>{next.label}</a>.
          </div>
        )}

        <VerifyEmailNotice reason="before you pay" />

        <div className="checkout-grid">
          {/* Left: Shipping Form */}
          <div>
            <h1 style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>Checkout</h1>
            <p style={{ color: 'var(--text-muted)', marginBottom: 32 }}>Provide shipping details, then pay securely via Stripe</p>

            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: 16 }}>
                <label className="field-label" htmlFor="co-name">Full Name</label>
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

              {error && (
                <div style={{ background: 'var(--error-bg)', border: '1px solid var(--error)', borderRadius: 'var(--radius-md)', padding: 12, marginBottom: 24, color: 'var(--error-text)', fontSize: 12 }}>
                  {error}
                </div>
              )}

              <button
                type="submit"
                className="btn btn-primary btn-lg"
                style={{ width: '100%', justifyContent: 'center' }}
                disabled={loading || !quoteData || quoteData.expired || mustConfirm}
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

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Shipping</span>
                  <span style={{ color: 'var(--text-primary)', fontSize: 12, fontWeight: 500 }}>{quoteData ? formatCurrency(quoteData.shippingEstimate) : '...'}</span>
                </div>

                <div style={{ borderTop: '1px solid var(--border-primary)', paddingTop: 12, marginTop: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 600 }}>Total</span>
                    <span style={{ color: 'var(--accent)', fontSize: 16, fontWeight: 700 }}>{quoteData ? formatCurrency(quoteData.orderTotal) : '...'}</span>
                  </div>
                </div>
              </div>

              {quoteData?.shipBy && (
                <div style={{ marginBottom: 16, fontSize: 13, color: 'var(--text-primary)' }}>
                  <b>Ships by {formatShipDate(quoteData.shipBy, { year: true })}</b>
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
