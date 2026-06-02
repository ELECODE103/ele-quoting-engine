import { useState, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../utils/api';
import { formatCurrency } from '../utils/format';

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

  const wasCancelled = searchParams.get('cancelled') === 'true';

  useEffect(() => {
    api.getQuoteById(quoteId)
      .then(q => setQuoteData(q))
      .catch(err => setError('Could not load quote: ' + err.message));
  }, [quoteId]);

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
      });

      if (result.sessionUrl) {
        // Redirect to Stripe Checkout
        window.location.href = result.sessionUrl;
      } else {
        setError('Could not create payment session');
      }
    } catch (err) {
      setError(err.message || 'Failed to start checkout');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)', padding: '32px' }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <button
          className="btn btn-ghost"
          onClick={() => navigate('/quote')}
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

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32 }}>
          {/* Left: Shipping Form */}
          <div>
            <h1 style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>Checkout</h1>
            <p style={{ color: 'var(--text-muted)', marginBottom: 32 }}>Provide shipping details, then pay securely via Stripe</p>

            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: 16 }}>
                <label className="field-label">Full Name</label>
                <input
                  type="text"
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="John Smith"
                  required
                />
              </div>

              <div style={{ marginBottom: 16 }}>
                <label className="field-label">Street Address</label>
                <input
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
                  <label className="field-label">City</label>
                  <input
                    type="text"
                    className="input"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    placeholder="New York"
                    required
                  />
                </div>
                <div>
                  <label className="field-label">State</label>
                  <input
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
                  <label className="field-label">ZIP Code</label>
                  <input
                    type="text"
                    className="input"
                    value={zip}
                    onChange={(e) => setZip(e.target.value)}
                    placeholder="10001"
                    required
                  />
                </div>
                <div>
                  <label className="field-label">Country</label>
                  <select
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
                disabled={loading}
              >
                {loading ? 'Redirecting to payment...' : 'Pay & Place Order'}
              </button>

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
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Quote ID</span>
                  <span style={{ color: 'var(--text-primary)', fontSize: 12, fontWeight: 500 }}>{quoteId}</span>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Subtotal</span>
                  <span style={{ color: 'var(--text-primary)', fontSize: 12, fontWeight: 500 }}>{quoteData ? formatCurrency(quoteData.subtotal) : '...'}</span>
                </div>

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
                🔒 You retain full IP ownership of your designs. Files are stored securely and never shared. NDA available on request.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
