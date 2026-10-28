import { useNavigate } from 'react-router-dom';
import { formatCurrency, formatWeight } from '../utils/format';
import { useAuth } from '../utils/authContext';
import brand from '../brand';

const PROCESS_ABBR = { '3d-printing': '3DP', cnc: 'CNC', routing: 'RTR', sheetmetal: 'SM' };

/**
 * Right-hand rail: lead time, line items, totals, and the one button that
 * matters — checkout when the quote gate allows it, "request a firm quote"
 * when it doesn't. A firm-quote link is always available either way.
 */
export default function OrderSummary({ quote, leadTimes, selectedLeadTime, onLeadTimeChange, partsConfig, quoteError }) {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();

  const handleCheckout = () => {
    if (!quote || !quote.quoteId) return;
    const checkoutPath = '/checkout/' + quote.quoteId;
    // Guests: send to login but remember the checkout destination so the quote
    // (persisted server-side by quoteId) survives the round-trip.
    if (!isAuthenticated) { navigate('/login', { state: { from: checkoutPath } }); return; }
    navigate(checkoutPath);
  };

  const handleRfq = () => {
    if (!quote || !quote.quoteId) { navigate('/rfq'); return; }
    navigate('/rfq/' + quote.quoteId);
  };

  const rail = {
    borderLeft: '1px solid var(--border-primary)', padding: 20, background: 'var(--bg-secondary)',
    display: 'flex', flexDirection: 'column', minWidth: 0,
  };

  if (!quote) {
    return (
      <aside style={{ ...rail, alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: quoteError ? 'var(--error-text)' : 'var(--text-dim)', fontSize: 12 }}>
        {quoteError ? `⚠ ${quoteError}` : 'Configure parts to see pricing'}
      </aside>
    );
  }

  const needsRfq = Boolean(quote.gate?.requiresRfq);
  const reasons = quote.gate?.reasons || [];

  return (
    <aside style={rail}>
      <div className="font-display" style={{ fontSize: 15, fontWeight: 700, marginBottom: 20, color: 'var(--text-primary)' }}>
        {needsRfq ? 'Budgetary Summary' : 'Order Summary'}
      </div>

      {/* Lead time */}
      <div style={{ marginBottom: 16 }}>
        <span className="field-label">Lead Time</span>
        <div className="flex-col gap-sm" style={{ marginTop: 6 }}>
          {leadTimes.map((lt) => {
            const on = selectedLeadTime === lt.slug;
            return (
              <label
                key={lt.slug}
                onClick={() => onLeadTimeChange(lt.slug)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 6, cursor: 'pointer', transition: 'all 0.2s',
                  border: `1px solid ${on ? 'var(--accent)' : 'var(--border-primary)'}`,
                  background: on ? 'var(--bg-hover)' : 'transparent',
                }}
              >
                <div style={{ width: 14, height: 14, borderRadius: '50%', border: `2px solid ${on ? 'var(--accent)' : '#94A3B8'}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {on && <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)' }} />}
                </div>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)', flex: 1 }}>
                  {lt.name} <span style={{ color: 'var(--text-dim)' }}>({lt.days})</span>
                </span>
                {lt.multiplier > 1 && <span style={{ fontSize: 10, color: 'var(--warn-text)' }}>+{((lt.multiplier - 1) * 100).toFixed(0)}%</span>}
              </label>
            );
          })}
        </div>
      </div>

      {/* Line items */}
      <div style={{ flex: 1, overflowY: 'auto', marginTop: 8 }}>
        <span className="field-label">Line Items</span>
        {quote.lineItems.map((li, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border-subtle)', fontSize: 11 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="truncate" style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>{li.fileName}</div>
              <div style={{ color: 'var(--text-dim)', fontSize: 10 }}>
                ×{li.quantity} · {PROCESS_ABBR[li.meta?.process] || li.meta?.process || '—'} · {li.meta?.materialSlug || 'N/A'}
              </div>
            </div>
            <div style={{ color: 'var(--text-secondary)', fontWeight: 500, marginLeft: 8 }}>{formatCurrency(li.lineTotal)}</div>
          </div>
        ))}
      </div>

      {/* Totals */}
      <div style={{ borderTop: '1px solid var(--border-primary)', paddingTop: 16, marginTop: 16 }}>
        <Row label="Subtotal" value={formatCurrency(quote.subtotal)} />
        {quote.leadTimeSurcharge > 0 && <Row label="Rush fee" value={`+${formatCurrency(quote.leadTimeSurcharge)}`} color="var(--warn-text)" />}
        <Row label="Shipping estimate" value={formatCurrency(quote.shippingEstimate)} />
        {quote.nestingApplied && <Row label="Multi-part savings" value="Applied ✓" color="var(--success-text)" />}
        <Row label={`Weight: ${formatWeight(quote.totalWeight)}`} value="" muted />
        <div className="flex-between" style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'var(--font-display)', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border-primary)' }}>
          <span>{needsRfq ? 'Budgetary' : 'Total'}</span>
          <span>{formatCurrency(quote.orderTotal)}</span>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>
          {quote.partCount} part{quote.partCount !== 1 ? 's' : ''} · {quote.totalUnits} total units
        </div>
      </div>

      {/* CTA */}
      {needsRfq ? (
        <>
          <div className="gate-box" style={{ marginTop: 16 }}>
            This one gets a person before it gets a price you can buy at:
            <ul>{reasons.slice(0, 3).map((r, i) => <li key={i}>{r.message}</li>)}</ul>
          </div>
          <button className="btn btn-primary btn-lg" style={{ width: '100%', marginTop: 12, justifyContent: 'center' }} onClick={handleRfq}>
            Request a firm quote →
          </button>
          <div style={{ textAlign: 'center', fontSize: 10, color: 'var(--text-dim)', marginTop: 8 }}>
            Within {brand.quoteTurnaroundHours} hours, from the person who runs the job.
          </div>
        </>
      ) : (
        <>
          <button className="btn btn-primary btn-lg" style={{ width: '100%', marginTop: 20, justifyContent: 'center', animation: 'pulseGlow 2.5s infinite' }} onClick={handleCheckout}>
            Proceed to Checkout →
          </button>
          <div style={{ textAlign: 'center', fontSize: 10, color: 'var(--text-dim)', marginTop: 8 }}>
            Instant price. Final shipping confirmed at checkout.
          </div>
          <button className="btn btn-ghost" style={{ width: '100%', marginTop: 10, justifyContent: 'center', fontSize: 12 }} onClick={handleRfq}>
            Prefer a firm quote from a person?
          </button>
        </>
      )}
    </aside>
  );
}

function Row({ label, value, color, muted }) {
  return (
    <div className="flex-between" style={{ fontSize: 12, marginBottom: 6, color: color || (muted ? 'var(--text-dim)' : 'var(--text-muted)') }}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
