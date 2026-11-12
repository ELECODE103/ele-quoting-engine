import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { api } from '../utils/api';
import { formatCurrency, formatShipDate, formatDate } from '../utils/format';
import { ok, PAPERWORK_LABEL } from '../facts';
import { useAuth } from '../utils/authContext';
import VerifyEmailNotice from '../components/security/VerifyEmailNotice';
import Notice, { FormError } from '../components/form/Notice';
import brand from '../brand';
import { notePendingCheckout, saveCheckoutDraft, loadCheckoutDraft } from '../utils/returnTo';
import { DeliveryChoice, TaxExemption, deliveryPayload } from '../components/DeliveryOptions';

// Where each "settled somewhere else" refusal leads (the catalogue's `action` for the code, utils/messageCatalogue.js).
const NEXT_STEP = {
  'reopen-quote': ({ quoteId }) => ({ link: `/quote?quote=${quoteId}`, label: 'Reopen the quote' }),
  rfq: ({ quoteId }) => ({ link: `/rfq/${quoteId}`, label: 'Request a firm quote' }),
  'open-order': ({ orderId }) => (orderId ? { link: `/orders/${orderId}`, label: 'Open that order' } : { link: '/dashboard', label: 'See your orders' }),
};

/**
 * Checkout: ship-to details, then the hand-off to the card page.
 *
 * What the buyer types is kept for this tab (utils/returnTo: saveCheckoutDraft),
 * so it is still there after a reload, after signing in again when a session
 * ends mid-checkout, and on the way back from the card page. The checkout path
 * is also noted for the browser (notePendingCheckout), so the page that opens
 * from the confirmation email, in a new tab, can lead straight back here.
 */
export default function CheckoutPage() {
  const { quoteId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [quoteData, setQuoteData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const draft = useRef(loadCheckoutDraft(quoteId)).current;
  const [name, setName] = useState(draft?.name || '');
  const [street, setStreet] = useState(draft?.street || '');
  const [city, setCity] = useState(draft?.city || '');
  const [state, setState] = useState(draft?.state || '');
  const [zip, setZip] = useState(draft?.zip || '');
  const [country, setCountry] = useState(draft?.country || 'US');
  const [error, setError] = useState(null); // { message, action }
  const [errorAt, setErrorAt] = useState(0);
  const [loading, setLoading] = useState(false);
  // Set when the server says the price is no longer the one this page was showing: the new quote is
  // shown, with the old total beside it, and the buyer presses pay again to accept it.
  const [priceChange, setPriceChange] = useState(null);
  // Refusals that are settled somewhere else (back in the quote, on the order page, by a firm quote).
  const [next, setNext] = useState(null);
  // Delivery choice and tax exemption. Shown only when the shop offers more than "we ship it" or
  // collects tax; what each choice costs comes priced from the server with the quote.
  const [option, setOption] = useState('ship');
  const [carrier, setCarrier] = useState({ carrier: 'UPS', account: '', service: '' });
  const [exempt, setExempt] = useState({ declared: false, reason: '' });

  const wasCancelled = searchParams.get('cancelled') === 'true';
  // Paying needs a confirmed email address (when confirmation emails can be sent at all).
  const { user, verificationEnforced, refresh } = useAuth();
  const mustConfirm = Boolean(user && !user.emailVerified && verificationEnforced);

  useEffect(() => { document.title = `Checkout · ${brand.name}`; }, []);
  useEffect(() => { notePendingCheckout(`/checkout/${quoteId}`); }, [quoteId]);
  useEffect(() => { saveCheckoutDraft(quoteId, { name, street, city, state, zip, country }); }, [quoteId, name, street, city, state, zip, country]);

  useEffect(() => {
    api.getQuoteById(quoteId)
      .then(q => {
        setQuoteData(q);
        // When "we ship it" has no price for this order, start on the first choice that does.
        const first = (q.checkout?.options || []).find((o) => o.available !== false);
        if (first) setOption(first.method);
      })
      .catch(err => setLoadError(err.message));
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
    if (loading) return;
    setError(null);
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
        // Which delivery choice, a carrier account, a declared exemption. Never an amount to charge.
        ...deliveryPayload({ showOptions, option, carrier, exemption: co?.tax?.exemption, declared: exempt.declared, reason: exempt.reason }),
        // The total this page is showing for that choice: the server charges nothing else without asking again.
      }, Number(selected?.total ?? quoteData?.orderTotal));

      if (result.sessionUrl) {
        // Redirect to Stripe Checkout. The button stays busy until the card page has replaced this one.
        window.location.href = result.sessionUrl;
        return;
      }
      setError({ message: `We couldn't start the card payment, and nothing was charged. Try again in a minute, or call ${brand.phone} and we'll take the order by phone.` });
      setErrorAt((n) => n + 1);
    } catch (err) {
      const data = err.data || {};
      // Not confirmed after all: the notice at the top of the page says what to do.
      if (err.code === 'email-unverified') await refresh();
      else if (err.code === 'quote-changed' && data.quote && !data.reopen) {
        // The price is no longer the one this page was showing. Nothing was charged. Show today's
        // price beside the old one; the same button accepts it.
        // (`newTotal` is the total for the delivery choice made on this page; the quote's own total otherwise.)
        setPriceChange({ was: Number.isFinite(data.previousTotal) ? data.previousTotal : (selected?.total ?? quoteData?.orderTotal), now: Number.isFinite(data.newTotal) ? data.newTotal : data.quote.orderTotal });
        setQuoteData(data.quote);
      } else if (NEXT_STEP[err.action]) {
        // Refusals that are settled somewhere else (back in the quote, by a firm quote, on the order page):
        // the words are the catalogue's (err.message), and the way there is a link beside them.
        setNext({ text: err.message, ...NEXT_STEP[err.action]({ quoteId, orderId: data.orderId }) });
      }
      // Signed out: the app is already on its way to the sign-in page, and comes back here with the details kept.
      else if (err.status !== 401) { setError({ message: err.message, action: err.action }); setErrorAt((n) => n + 1); }
    }
    setLoading(false);
  };

  const quotePath = `/quote?quote=${quoteId}`;
  return (
    <div className="app-page">
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <button type="button" className="btn btn-ghost" onClick={() => navigate(quotePath)} style={{ marginBottom: 24 }}>
          ← Back to the quote
        </button>

        {wasCancelled && (
          <Notice kind="warn" style={{ marginBottom: 24 }}>
            <b>You came back from the card page before paying, so nothing was charged.</b>{' '}
            Your parts{draft?.street ? ' and ship-to details' : ''} are as you left them. Pay when you are ready. Something not right on the card page? Call {brand.phone}.
          </Notice>
        )}

        {loadError && (
          <Notice kind="error" style={{ marginBottom: 24 }}>
            {loadError}{' '}
            <Link to="/quote">Open the quote tool</Link>
          </Notice>
        )}

        {quoteData?.expired && (
          <div role="alert" className="gate-box" style={{ marginBottom: 24 }}>
            This price was held until {formatDate(quoteData.expiresAt)} and has expired.{' '}
            <a href={quotePath} style={{ color: 'inherit', fontWeight: 600 }}>Reopen the quote</a> to get today's price. Your parts are still there.
          </div>
        )}

        {priceChange && (
          <div role="alert" className="gate-box" style={{ marginBottom: 24 }} data-testid="price-changed">
            <b>The price of this quote has changed.</b>{' '}
            {Number.isFinite(priceChange.was) ? <>It was {formatCurrency(priceChange.was)}; it is now <b>{formatCurrency(priceChange.now)}</b>.</> : <>It is now <b>{formatCurrency(priceChange.now)}</b>.</>}{' '}
            We have not charged you. Check the new total in the summary, then press the pay button again to go ahead at this price,
            or <a href={quotePath} style={{ color: 'inherit', fontWeight: 600 }}>go back to the quote</a>.
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
            <h1 className="app-h1">Checkout</h1>
            <p className="app-lede">{showOptions ? 'How the order gets to you, then the card page.' : 'Where the parts ship, then the card page.'} Payment is taken by Stripe; we never see the card number.</p>

            <form onSubmit={handleSubmit} aria-busy={loading || undefined}>
              {showOptions && (
                <DeliveryChoice options={co.options} carriers={co.carriers} value={option} onChange={setOption} carrier={carrier} onCarrierChange={setCarrier} />
              )}
              <fieldset className="plain-fieldset">
                <legend className="sr-only">{pickup ? 'Pickup' : 'Ship to'}</legend>
                <div className="field">
                  <label className="field-label" htmlFor="co-name">{pickup ? 'Who is picking it up' : 'Full name'}</label>
                  <input id="co-name" type="text" className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete={pickup ? 'name' : 'shipping name'} required />
                </div>

                {pickup && (
                  <p className="field-hint" style={{ marginBottom: 16 }} data-testid="pickup-note">
                    No shipping address needed. The pickup address comes with your order confirmation, after payment. We tell you when the order is ready.
                  </p>
                )}
                {!pickup && (<>
                <div className="field">
                  <label className="field-label" htmlFor="co-street">Street address</label>
                  <input id="co-street" type="text" className="input" value={street} onChange={(e) => setStreet(e.target.value)} autoComplete="shipping address-line1" required aria-describedby="co-street-help" />
                  <span id="co-street-help" className="field-hint">Include the suite, dock or building number.</span>
                </div>

                <div className="field-row field-row-2-1">
                  <div className="field">
                    <label className="field-label" htmlFor="co-city">City</label>
                    <input id="co-city" type="text" className="input" value={city} onChange={(e) => setCity(e.target.value)} autoComplete="shipping address-level2" required />
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor="co-state">State</label>
                    <input id="co-state" type="text" className="input" value={state} onChange={(e) => setState(e.target.value)} autoComplete="shipping address-level1" autoCapitalize="characters" required />
                  </div>
                </div>

                <div className="field-row field-row-1-1" style={{ marginBottom: 8 }}>
                  <div className="field">
                    <label className="field-label" htmlFor="co-zip">ZIP code</label>
                    <input id="co-zip" type="text" className="input" value={zip} onChange={(e) => setZip(e.target.value)} autoComplete="shipping postal-code" inputMode={country === 'US' ? 'numeric' : 'text'} required />
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor="co-country">Country</label>
                    <select id="co-country" className="input" value={country} onChange={(e) => setCountry(e.target.value)} autoComplete="shipping country">
                      <option value="US">United States</option>
                      <option value="CA">Canada</option>
                      <option value="MX">Mexico</option>
                    </select>
                  </div>
                </div>
                </>)}
              </fieldset>

              <TaxExemption
                info={co?.tax?.exemption}
                declared={exempt.declared}
                reason={exempt.reason}
                onChange={setExempt}
                certFileName={quoteData?.taxCertFileName}
                onUpload={async (file) => { const r = await api.uploadTaxCertificate(quoteId, file); setQuoteData((q) => ({ ...q, taxCertFileName: r.taxCertFileName })); setError(null); }}
                onRemove={async () => { await api.removeTaxCertificate(quoteId); setQuoteData((q) => ({ ...q, taxCertFileName: '' })); }}
              />

              {selected && selected.available === false && (
                <div role="status" className="gate-box" style={{ marginBottom: 24 }} data-testid="delivery-unavailable">
                  {selected.unavailableReason}{' '}
                  <Link to={`/rfq/${quoteId}`} style={{ color: 'inherit', fontWeight: 600 }}>Request a firm quote</Link>{co.options.length > 1 ? ', or choose another delivery option above.' : '.'}
                </div>
              )}

              <FormError error={error?.message} at={errorAt} />

              <button
                type="submit"
                className="btn btn-primary btn-lg btn-block"
                disabled={loading || !quoteData || quoteData.expired || mustConfirm || (selected && selected.available === false)}
                aria-describedby={mustConfirm ? 'pay-needs-email' : 'pay-next'}
              >
                {loading ? 'Opening the card page…' : 'Pay and place order'}
              </button>
              {mustConfirm ? (
                <p id="pay-needs-email" className="pay-note warn">
                  This button switches on by itself once your email address is confirmed (see the top of this page). What you have typed stays.
                </p>
              ) : (
                <p id="pay-next" className="pay-note">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ verticalAlign: '-1px', marginRight: 4 }}>
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0110 0v4" />
                  </svg>
                  Next: Stripe's card page. You come back here when it is done; the back button brings you back unpaid, with nothing lost.
                </p>
              )}
            </form>
          </div>

          {/* Right: Order Summary */}
          <div>
            <div style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border-primary)',
              borderRadius: 'var(--radius-lg)',
              padding: 24,
            }} className="checkout-summary">
              <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>Order summary</h2>

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

              <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                Your designs stay yours. The files are used to make your parts and are not shared. {ok('paperwork-packet') ? 'NDA available on request.' : ''}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
