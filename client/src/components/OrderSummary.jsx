import { useNavigate } from 'react-router-dom';
import { formatCurrency, formatWeight } from '../utils/format';
import { useAuth } from '../utils/authContext';
import brand, { PROCESS_LABELS } from '../brand';

const PROCESS_SHORT = { '3d-printing': '3D print', cnc: 'CNC', routing: 'Routing', sheetmetal: 'Sheet metal' };

/**
 * Right-hand rail: lead time, line items, totals, and the one button that
 * matters — checkout when the quote gate allows it, "request a firm quote"
 * when it doesn't. A firm-quote link is always available either way.
 */
export default function OrderSummary({ quote, leadTimes, selectedLeadTime, onLeadTimeChange, partsConfig, materials = [], quoteError, quoteLoading }) {
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

  const materialName = (slug) => materials.find((m) => m.slug === slug)?.name || slug || '—';

  const rail = {
    borderLeft: '1px solid var(--border-primary)', padding: 20, background: 'var(--bg-secondary)',
    display: 'flex', flexDirection: 'column', minWidth: 0,
  };

  if (!quote) {
    return (
      <aside style={{ ...rail, alignItems: 'center', justifyContent: 'center', textAlign: 'center', fontSize: 12, gap: 10 }} aria-live="polite">
        {quoteError ? (
          <>
            <div role="alert" style={{ color: 'var(--error-text)', lineHeight: 1.5 }}>{quoteError}</div>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={handleRfq}>Request a firm quote instead</button>
          </>
        ) : (
          <>
            <div className="spinner" aria-hidden="true" />
            <span style={{ color: 'var(--text-dim)' }}>Pricing your part…</span>
          </>
        )}
      </aside>
    );
  }

  const needsRfq = Boolean(quote.gate?.requiresRfq);
  const reasons = quote.gate?.reasons || [];

  return (
    <aside style={rail} aria-label={needsRfq ? 'Budgetary summary' : 'Order summary'}>
      <div className="font-display" style={{ fontSize: 15, fontWeight: 700, marginBottom: 20, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 10 }}>
        {needsRfq ? 'Budgetary summary' : 'Order summary'}
        {quoteLoading && <div className="spinner" aria-label="Updating" />}
      </div>

      {/* Lead time */}
      <fieldset style={{ marginBottom: 16, border: 'none', padding: 0, minWidth: 0 }}>
        <legend className="field-label">Lead time</legend>
        <div className="flex-col gap-sm" style={{ marginTop: 6 }}>
          {leadTimes.map((lt) => {
            const on = selectedLeadTime === lt.slug;
            return (
              <label key={lt.slug} className={`lead-option${on ? ' on' : ''}`}>
                <input
                  type="radio"
                  name="lead-time"
                  className="sr-only"
                  value={lt.slug}
                  checked={on}
                  onChange={() => onLeadTimeChange(lt.slug)}
                />
                <span className="lead-dot" aria-hidden="true" />
                <span style={{ fontSize: 11, color: 'var(--text-secondary)', flex: 1 }}>
                  {lt.name} <span style={{ color: 'var(--text-dim)' }}>· {lt.days}</span>
                </span>
                {lt.multiplier > 1 && <span style={{ fontSize: 10, color: 'var(--warn-text)' }}>+{((lt.multiplier - 1) * 100).toFixed(0)}%</span>}
              </label>
            );
          })}
        </div>
      </fieldset>

      {/* Line items */}
      <div style={{ flex: 1, overflowY: 'auto', marginTop: 8 }}>
        <span className="field-label">Parts</span>
        {quote.lineItems.map((li, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border-subtle)', fontSize: 11 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="truncate" style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>{li.fileName}</div>
              <div style={{ color: 'var(--text-dim)', fontSize: 10 }}>
                {li.quantity} × {materialName(li.meta?.materialSlug)} · {PROCESS_SHORT[li.meta?.process] || PROCESS_LABELS[li.meta?.process] || li.meta?.process || '—'}
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
        {quote.nestingApplied && <Row label="Multi-part savings" value="Applied" color="var(--success-text)" />}
        <Row label="Ship weight" value={formatWeight(quote.totalWeight)} muted />
        <div className="flex-between" style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'var(--font-display)', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border-primary)' }}>
          <span>{needsRfq ? 'Budgetary' : 'Total'}</span>
          <span>{formatCurrency(quote.orderTotal)}</span>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>
          {quote.partCount} part{quote.partCount !== 1 ? 's' : ''} · {quote.totalUnits} piece{quote.totalUnits !== 1 ? 's' : ''}
        </div>
      </div>

      {/* CTA */}
      {needsRfq ? (
        <>
          <div className="gate-box" style={{ marginTop: 16 }}>
            Why this one needs a person:
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
            Check out →
          </button>
          <div style={{ textAlign: 'center', fontSize: 10, color: 'var(--text-dim)', marginTop: 8 }}>
            Instant price. Shipping is confirmed at checkout.
          </div>
          <button className="btn btn-ghost" style={{ width: '100%', marginTop: 10, justifyContent: 'center', fontSize: 12 }} onClick={handleRfq}>
            Or request a firm quote
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
