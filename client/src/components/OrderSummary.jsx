import { useNavigate } from 'react-router-dom';
import { describeGateReason } from '../utils/messages';
import { formatCurrency, formatWeight, formatShipDate, formatDate } from '../utils/format';
import { authPath } from '../utils/returnTo';
import { useAuth } from '../utils/authContext';
import brand, { PROCESS_LABELS } from '../brand';
import { when, SENT_OUT_FINISHES, PAPERWORK_LABEL, PAPERWORK_HELP } from '../facts';

const PROCESS_SHORT = { '3d-printing': '3D print', cnc: 'CNC', routing: 'Routing', sheetmetal: 'Sheet metal' };

/**
 * Right-hand rail: lead time, line items, totals, and the one button that
 * matters — checkout when the quote gate allows it, "request a firm quote"
 * when it doesn't. A firm-quote link is always available either way.
 */
export default function OrderSummary({ quote, leadTimes, selectedLeadTime, onLeadTimeChange, paperwork = false, onPaperworkChange, partsConfig, materials = [], quoteError, quoteLoading }) {
  const sentOutFinish = (partsConfig || []).some((p) => SENT_OUT_FINISHES.has(p.finishSlug));
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();

  const handleCheckout = () => {
    if (!quote || !quote.quoteId) return;
    const checkoutPath = '/checkout/' + quote.quoteId;
    // Guests: send to login with the checkout destination in the URL (?next=),
    // so the quote (persisted server-side by quoteId) survives sign-in or
    // registering, a reload, or opening the link in another tab.
    if (!isAuthenticated) { navigate(authPath('/login', checkoutPath)); return; }
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
      <aside id="order-summary" className="order-summary" style={{ ...rail, alignItems: 'center', justifyContent: 'center', textAlign: 'center', fontSize: 12, gap: 10 }} aria-live="polite">
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
    <aside id="order-summary" className="order-summary" style={rail} aria-label={needsRfq ? 'Budgetary summary' : 'Order summary'}>
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
            // Dates and dollar surcharges come priced from the server with each quote;
            // the lead-time list's own date covers the moment before the first price.
            const opt = quote.leadTimeOptions?.find((o) => o.slug === lt.slug);
            const shipBy = opt?.shipBy || lt.shipBy;
            // Anodize and powder coat go out to a finisher: those parts ship on Standard only.
            const blocked = sentOutFinish && lt.slug !== 'standard';
            return (
              <label key={lt.slug} className={`lead-option${on ? ' on' : ''}`} style={blocked ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}>
                <input
                  type="radio"
                  name="lead-time"
                  className="sr-only"
                  value={lt.slug}
                  checked={on}
                  disabled={blocked}
                  onChange={() => onLeadTimeChange(lt.slug)}
                />
                <span className="lead-dot" aria-hidden="true" />
                <span style={{ fontSize: 11, color: 'var(--text-secondary)', flex: 1 }}>
                  {lt.name}
                  <span style={{ display: 'block', color: 'var(--text-dim)' }}>
                    {blocked ? 'Not available with anodize or powder coat (sent out to a finisher)' : `Ships by ${formatShipDate(shipBy)}`}
                  </span>
                </span>
                {!blocked && opt?.surcharge > 0 && <span style={{ fontSize: 10, color: 'var(--warn-text)', whiteSpace: 'nowrap' }}>+{formatCurrency(opt.surcharge)}</span>}
              </label>
            );
          })}
        </div>
      </fieldset>

      {/* Inspection paperwork: an option the customer asks for, off by default. The fee comes
          priced from the server with each quote (it is admin-editable), never from this file. */}
      {onPaperworkChange && (
        <fieldset style={{ marginBottom: 16, border: 'none', padding: 0, minWidth: 0 }}>
          <legend className="field-label">Inspection paperwork</legend>
          <label className={`lead-option${paperwork ? ' on' : ''}`} style={{ marginTop: 6, alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              name="paperwork"
              checked={paperwork}
              onChange={(e) => onPaperworkChange(e.target.checked)}
              style={{ marginTop: 1, flexShrink: 0, width: 18, height: 18, accentColor: 'var(--accent)' }}
            />
            <span style={{ fontSize: 11, color: 'var(--text-secondary)', flex: 1 }}>
              {PAPERWORK_LABEL}
              <span style={{ display: 'block', color: 'var(--text-dim)', marginTop: 2 }}>{PAPERWORK_HELP}</span>
            </span>
            {quote.paperworkOffer && (
              <span style={{ fontSize: 10, color: 'var(--warn-text)', whiteSpace: 'nowrap' }} data-testid="paperwork-price">+{formatCurrency(quote.paperworkOffer.fee)}</span>
            )}
          </label>
        </fieldset>
      )}

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
        {quote.leadTimeSurcharge > 0 && <Row label={`${leadTimes.find((lt) => lt.slug === selectedLeadTime)?.name || 'Faster'} lead time`} value={`+${formatCurrency(quote.leadTimeSurcharge)}`} color="var(--warn-text)" />}
        {quote.paperwork && <Row label="Inspection paperwork" value={`+${formatCurrency(quote.paperworkFee)}`} />}
        <Row label="Shipping estimate" value={formatCurrency(quote.shippingEstimate)} />
        {quote.nestingApplied && <Row label="Multi-part savings" value="Applied" color="var(--success-text)" />}
        <Row label="Ship weight" value={formatWeight(quote.totalWeight)} muted />
        {quote.shipBy && <Row label="Ships by" value={formatShipDate(quote.shipBy, { year: true })} />}
        <div className="flex-between" style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'var(--font-display)', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border-primary)' }}>
          <span>{needsRfq ? 'Budgetary' : 'Total'}</span>
          <span>{formatCurrency(quote.orderTotal)}</span>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>
          {quote.partCount} part{quote.partCount !== 1 ? 's' : ''} · {quote.totalUnits} piece{quote.totalUnits !== 1 ? 's' : ''}
          {quote.expiresAt && !needsRfq && <> · price held until {formatDate(quote.expiresAt)}</>}
        </div>
      </div>

      {/* CTA */}
      {needsRfq ? (
        <>
          <div className="gate-box" style={{ marginTop: 16 }}>
            Why this one needs a person:
            <ul>{reasons.slice(0, 3).map((r, i) => <li key={i}>{describeGateReason(r)}</li>)}</ul>
          </div>
          <button className="btn btn-primary btn-lg" style={{ width: '100%', marginTop: 12, justifyContent: 'center' }} onClick={handleRfq}>
            Request a firm quote →
          </button>
          <div style={{ textAlign: 'center', fontSize: 10, color: 'var(--text-dim)', marginTop: 8 }}>
            From the engineer who will run the job{when('quote-turnaround', (v) => `, within ${v}`)}.
          </div>
        </>
      ) : (
        <>
          <button className="btn btn-primary btn-lg" style={{ width: '100%', marginTop: 20, justifyContent: 'center', animation: 'pulseGlow 2.5s infinite' }} onClick={handleCheckout}>
            Check out →
          </button>
          <div style={{ textAlign: 'center', fontSize: 10, color: 'var(--text-dim)', marginTop: 8 }}>
            Instant price. Ship date counts from the day you pay.
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
