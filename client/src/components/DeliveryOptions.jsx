/**
 * Delivery choice and tax exemption for the checkout page and the firm-quote page.
 *
 * Everything shown here comes from the server (the quote's `checkout` block): which choices
 * exist, what each one says, what each one comes to. This file computes no amount. It renders
 * nothing new when the shop offers one choice (we ship) and collects no tax: the pages then
 * look as they did before.
 */
import { useRef, useState } from 'react';
import { formatCurrency } from '../utils/format';

/** The radio list of delivery choices, with the carrier-account fields under that choice. */
export function DeliveryChoice({ options, carriers = [], value, onChange, carrier, onCarrierChange, showTotals = true }) {
  return (
    <fieldset style={{ border: 'none', padding: 0, margin: '0 0 20px', minWidth: 0 }} data-testid="delivery-choice">
      <legend className="field-label">How would you like it delivered?</legend>
      <div className="flex-col gap-sm" style={{ marginTop: 6 }}>
        {options.map((o) => {
          const on = value === o.method;
          const off = o.available === false;
          return (
            <label key={o.method} className={`lead-option${on ? ' on' : ''}`} style={{ alignItems: 'flex-start', ...(off ? { opacity: 0.6, cursor: 'not-allowed' } : {}) }}>
              <input type="radio" name="delivery" className="sr-only" value={o.method} checked={on} disabled={off} onChange={() => onChange(o.method)} />
              <span className="lead-dot" aria-hidden="true" style={{ marginTop: 3 }} />
              <span style={{ fontSize: 13, flex: 1, color: 'var(--text-primary)' }}>
                {o.title}
                <span style={{ display: 'block', fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>{off ? o.unavailableReason : o.detail}</span>
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', textAlign: 'right' }}>
                {o.shippingText}
                {showTotals && o.total != null && <span style={{ display: 'block', fontSize: 11, color: 'var(--text-dim)' }}>total {formatCurrency(o.total)}</span>}
              </span>
            </label>
          );
        })}
      </div>

      {value === 'carrier-account' && (
        <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 12 }}>
          <label>
            <span className="field-label">Carrier</span>
            <select className="input" value={carrier.carrier} onChange={(e) => onCarrierChange({ ...carrier, carrier: e.target.value })} aria-label="Carrier">
              {carriers.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label>
            <span className="field-label">Account number</span>
            {/* Typed by the buyer, sent once over HTTPS, stored encrypted. Not kept in the browser. */}
            <input className="input" value={carrier.account} onChange={(e) => onCarrierChange({ ...carrier, account: e.target.value })} autoComplete="off" spellCheck={false} maxLength={30} required aria-label="Carrier account number" />
          </label>
          <label style={{ gridColumn: '1 / -1' }}>
            <span className="field-label">Service <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}>(optional)</span></span>
            <input className="input" value={carrier.service} onChange={(e) => onCarrierChange({ ...carrier, service: e.target.value })} placeholder="Ground" maxLength={60} aria-label="Carrier service" />
          </label>
          <div style={{ gridColumn: '1 / -1', fontSize: 11, color: 'var(--text-dim)' }}>
            We ship collect on this account and keep the number with your order. Only the last four characters appear on your confirmation.
          </div>
        </div>
      )}
    </fieldset>
  );
}

/**
 * "This order is tax-exempt": a reason and the certificate. What the declaration does (no tax
 * today, or tax today and a refund after review) is the shop's setting, said in `info.note`.
 * `onUpload(file)` / `onRemove()` return promises; the file name shown is the server's answer.
 */
export function TaxExemption({ info, declared, reason, onChange, certFileName, onUpload, onRemove }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!info || !info.offered) return null;

  const pick = async (file) => {
    if (!file) return;
    setBusy(true); setError('');
    try { await onUpload(file); } catch (err) { setError(err.message || 'Could not attach the certificate.'); }
    setBusy(false);
    if (input.current) input.current.value = '';
  };
  const remove = async () => {
    setBusy(true); setError('');
    try { await onRemove(); } catch (err) { setError(err.message || 'Could not remove the certificate.'); }
    setBusy(false);
  };

  return (
    <fieldset style={{ border: 'none', padding: 0, margin: '0 0 20px', minWidth: 0 }} data-testid="tax-exemption">
      <legend className="field-label">Sales tax</legend>
      <label className={`lead-option${declared ? ' on' : ''}`} style={{ marginTop: 6, alignItems: 'flex-start' }}>
        <input type="checkbox" name="tax-exempt" checked={declared} onChange={(e) => onChange({ declared: e.target.checked, reason })} style={{ marginTop: 2, flexShrink: 0, accentColor: 'var(--accent)' }} />
        <span style={{ fontSize: 13, flex: 1, color: 'var(--text-primary)' }}>
          This order is tax-exempt
          <span style={{ display: 'block', fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>{info.note}</span>
        </span>
      </label>
      {declared && (
        <div style={{ marginTop: 12 }}>
          <label>
            <span className="field-label">Why it is exempt</span>
            <select className="input" value={reason} onChange={(e) => onChange({ declared, reason: e.target.value })} required aria-label="Exemption reason">
              <option value="">Choose one…</option>
              {(info.reasons || []).map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </label>
          <div style={{ marginTop: 12 }}>
            <span className="field-label">Exemption certificate</span>
            {certFileName ? (
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <span data-testid="tax-cert-name" style={{ overflowWrap: 'anywhere' }}>{certFileName}</span>
                <button type="button" className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 10px' }} onClick={remove} disabled={busy}>Remove</button>
              </div>
            ) : (
              <input ref={input} type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" className="input" disabled={busy} onChange={(e) => pick(e.target.files && e.target.files[0])} aria-label="Exemption certificate" />
            )}
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
              A resale certificate, an equipment exemption certificate, or your exemption letter. PDF, JPG or PNG.
            </div>
            {busy && <div role="status" style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>Working…</div>}
            {error && <div role="alert" style={{ color: 'var(--error-text)', fontSize: 12, marginTop: 4 }}>{error}</div>}
          </div>
        </div>
      )}
    </fieldset>
  );
}

/** The fields a checkout request carries for the delivery choice and the exemption (never an amount). */
export function deliveryPayload({ showOptions, option, carrier, exemption, declared, reason }) {
  const out = {};
  if (showOptions) {
    out.shippingOption = option;
    if (option === 'carrier-account') Object.assign(out, { carrier: carrier.carrier, carrierAccount: carrier.account, carrierService: carrier.service });
  }
  if (exemption && exemption.offered && declared) Object.assign(out, { taxExempt: true, taxExemptReason: reason });
  return out;
}
