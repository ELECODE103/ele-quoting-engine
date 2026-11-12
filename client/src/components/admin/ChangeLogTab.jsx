import { useEffect, useState } from 'react';
import { api } from '../../utils/api';

const AREAS = {
  material: 'Material', finish: 'Finish', 'lead-time': 'Lead time', 'rate-card': 'Pricing rules',
  order: 'Order', quotes: 'Quotes', 'admin-account': 'Admin account',
  catalogue: 'Catalogue upgrade',
};
const ACTIONS = {
  update: 'changed', create: 'added', delete: 'removed', duplicate: 'copied', save: 'saved', restore: 'restored',
  reset: 'reset to defaults', status: 'status changed', 'void-open': 'price holds ended', takeover: 'set up', recovery: 'set up again',
  // Order moves made by hand (the order state machine's own names; services/orderLifecycle.js)
  'order.status': 'status changed', 'order.mark-paid': 'marked paid by hand', 'order.cancel': 'cancelled',
  'order.tracking': 'shipping details changed', 'order.attention-resolved': 'flag cleared',
  // A catalogue upgrade and the prices that had been changed by hand (server/config/seedCarry.js)
  'price-kept': 'your price kept', 'price-not-kept': 'your price NOT kept',
};
const FIELDS = { paidVia: 'paid by', attention: 'flag', tracking: 'tracking number', voided: 'quotes' };
const show = (v) => (v === null || v === undefined || v === '' ? 'nothing' : String(v));

/**
 * Who changed what and when: materials, finishes, lead times, pricing rules, quotes whose price
 * hold was ended, and every order move made by hand (status, marked paid with its reason, cancelled,
 * shipping details, a payment flag cleared). One log, one table (server/services/audit.js).
 * Entries are only ever added.
 */
export default function ChangeLogTab() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');

  const load = () => api.getAdminAudit().then(setRows).catch((err) => setError(err.message || 'Could not load the change log.'));
  useEffect(() => { load(); }, []);

  async function endHolds() {
    if (!window.confirm('End the price hold on every open quote? Buyers keep their parts and setup, and get today\'s price when they reopen the quote. Orders and firm quotes are not affected.')) return;
    setBusy(true);
    setDone('');
    try {
      const r = await api.voidOpenQuotes(note);
      setDone(`${r.voided} open quote${r.voided === 1 ? '' : 's'} will be priced again at today's rules when reopened.`);
      setNote('');
      load();
    } catch (err) {
      setError(err.message || 'That did not go through. Try again.');
    }
    setBusy(false);
  }

  return (
    <div>
      <div className="card" style={{ padding: 20, marginBottom: 20 }}>
        <div className="font-display" style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>After a price change</div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, maxWidth: 720 }}>
          A saved quote keeps its price for 30 days. If you have changed prices and do not want earlier quotes bought at the old ones,
          end the price hold on open quotes here. Nothing is deleted: the buyer reopens the quote and sees today's price.
        </p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="input" style={{ maxWidth: 360 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why (for the change log)" aria-label="Why (for the change log)" maxLength={200} />
          <button className="btn btn-ghost" onClick={endHolds} disabled={busy}>{busy ? 'Working…' : 'End price hold on open quotes'}</button>
        </div>
        {done && <div role="status" style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 10 }}>{done}</div>}
      </div>

      {/* Scrolls sideways on a phone, so it can be reached and scrolled from the keyboard (as the other admin tables are). */}
      <div className="card table-scroll" tabIndex={0} role="region" aria-label="Change log table" style={{ overflow: 'hidden' }}>
        {error && <div role="alert" style={{ padding: 16, color: 'var(--error-text)', fontSize: 12 }}>{error}</div>}
        {rows === null && !error && <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-dim)' }}>Loading…</div>}
        {rows && rows.length === 0 && <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-dim)' }}>No changes recorded yet.</div>}
        {rows && rows.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-primary)', background: 'var(--bg-secondary)' }}>
                {['When', 'Who', 'What', 'Change'].map((h) => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--border-subtle)', verticalAlign: 'top' }}>
                  <td style={{ padding: '10px 14px', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{new Date(r.createdAt).toLocaleString()}</td>
                  <td style={{ padding: '10px 14px' }}>{r.userEmail || 'the server'}</td>
                  <td style={{ padding: '10px 14px' }}>{AREAS[r.area] || r.area}: {r.target} <span style={{ color: 'var(--text-muted)' }}>({ACTIONS[r.action] || r.action})</span></td>
                  <td style={{ padding: '10px 14px' }}>
                    {Object.entries(r.changes || {}).map(([field, pair]) => (
                      <div key={field}>{FIELDS[field] || field}: {Array.isArray(pair) ? `${show(pair[0])} → ${show(pair[1])}` : show(pair)}</div>
                    ))}
                    {r.note && <div style={{ color: 'var(--text-muted)' }}>Reason: {r.note}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
