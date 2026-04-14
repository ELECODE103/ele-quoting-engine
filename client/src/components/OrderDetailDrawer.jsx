import { useState, useEffect } from 'react';
import { api } from '../utils/api';
import { formatCurrency } from '../utils/format';

/**
 * Fulfillment drawer â single unified view for an order.
 * Shows shipping info, line items with CAD downloads, status timeline,
 * tracking entry, notes, and traveler PDF link.
 */

const STATUS_PIPELINE = [
  { key: 'pending_payment', label: 'Pending Payment' },
  { key: 'paid', label: 'Paid' },
  { key: 'received', label: 'Received' },
  { key: 'in_production', label: 'In Production' },
  { key: 'quality_check', label: 'Quality Check' },
  { key: 'packing', label: 'Packing' },
  { key: 'shipped', label: 'Shipped' },
  { key: 'delivered', label: 'Delivered' },
];

const CARRIERS = ['UPS', 'FedEx', 'USPS', 'DHL', 'Other'];

export default function OrderDetailDrawer({ orderId, onClose, onUpdated }) {
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  // Editable fields
  const [carrier, setCarrier] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [shippedAt, setShippedAt] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => { load(); }, [orderId]);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const o = await api.getOrderById(orderId);
      setOrder(o);
      setCarrier(o.carrier || '');
      setTrackingNumber(o.trackingNumber || '');
      setShippedAt(o.shippedAt ? o.shippedAt.slice(0, 10) : '');
      setNotes(o.notes || '');
    } catch (e) {
      setErr(e.message);
    }
    setLoading(false);
  }

  async function updateStatus(newStatus) {
    setSaving(true);
    try {
      await api.updateOrderStatus(orderId, {
        status: newStatus,
        carrier: carrier || undefined,
        trackingNumber: trackingNumber || undefined,
        shippedAt: shippedAt ? new Date(shippedAt).toISOString() : undefined,
        notes: notes || undefined,
      });
      await load();
      if (onUpdated) onUpdated();
    } catch (e) {
      alert('Update failed: ' + e.message);
    }
    setSaving(false);
  }

  async function saveShipping() {
    if (!order) return;
    setSaving(true);
    try {
      await api.updateOrderStatus(orderId, {
        status: order.status,
        carrier: carrier || '',
        trackingNumber: trackingNumber || '',
        shippedAt: shippedAt ? new Date(shippedAt).toISOString() : '',
        notes: notes || '',
      });
      await load();
      if (onUpdated) onUpdated();
    } catch (e) {
      alert('Save failed: ' + e.message);
    }
    setSaving(false);
  }

  // Escape to close
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const currentIdx = order ? STATUS_PIPELINE.findIndex(s => s.key === order.status) : -1;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        zIndex: 9999, display: 'flex', justifyContent: 'flex-end',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(720px, 96vw)', background: 'var(--bg-primary, #fff)',
          height: '100%', overflowY: 'auto', boxShadow: '-8px 0 32px rgba(0,0,0,0.3)',
          padding: 24,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div className="font-display" style={{ fontSize: 20, fontWeight: 700 }}>
            Order Detail
          </div>
          <button className="btn btn-ghost" onClick={onClose} style={{ fontSize: 12 }}>Close â</button>
        </div>

        {loading && <div style={{ padding: 40, textAlign: 'center', color: '#888' }}>Loadingâ¦</div>}
        {err && <div style={{ padding: 16, color: '#E94E4E' }}>Error: {err}</div>}

        {order && !loading && (
          <>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, fontSize: 12 }}>
              <div>
                <div style={{ fontFamily: 'monospace', color: '#888' }}>
                  ID: {String(order.id).slice(0, 12)}
                </div>
                <div style={{ color: '#888' }}>
                  Placed: {new Date(order.createdAt).toLocaleString()}
                </div>
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent, #4F8CFF)' }}>
                {formatCurrency(order.total || 0)}
              </div>
            </div>

            {/* Status timeline */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
                Fulfillment Status
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {STATUS_PIPELINE.map((s, i) => {
                  const done = i < currentIdx;
                  const active = i === currentIdx;
                  const clickable = i !== currentIdx && i > 0;
                  return (
                    <button
                      key={s.key}
                      disabled={saving || !clickable}
                      onClick={() => updateStatus(s.key)}
                      title={clickable ? `Set status to ${s.label}` : ''}
                      style={{
                        fontSize: 10, padding: '6px 10px', borderRadius: 4,
                        border: '1px solid',
                        borderColor: active ? '#4F8CFF' : (done ? '#7ED321' : '#ccc'),
                        background: active ? '#4F8CFF' : (done ? '#E8F7D4' : '#f7f7f7'),
                        color: active ? '#fff' : (done ? '#4F7A1F' : '#555'),
                        cursor: clickable ? 'pointer' : 'default',
                        fontWeight: active ? 700 : 500,
                        textTransform: 'uppercase',
                        letterSpacing: 0.3,
                      }}
                    >
                      {done && 'â '}{s.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Shipping address */}
            <Section title="Ship To">
              <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                <div style={{ fontWeight: 600 }}>{order.shippingName || 'â'}</div>
                <div>{order.shippingAddress || ''}</div>
                <div>
                  {[order.shippingCity, order.shippingState, order.shippingZip].filter(Boolean).join(', ')}
                </div>
                <div>{order.shippingCountry}</div>
              </div>
            </Section>

            {/* Line items */}
            <Section title={`Line Items (${order.items?.length || 0})`}>
              {(order.items || []).map((it, idx) => (
                <div key={idx} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 0', borderBottom: '1px solid #eee', fontSize: 12,
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontFamily: 'monospace', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                      {it.fileName || 'part'}
                    </div>
                    <div style={{ color: '#888', fontSize: 11 }}>
                      {it.process} Â· {it.materialName || it.materialSlug}
                      {it.finishName ? ` Â· ${it.finishName}` : ''} Â· qty {it.quantity}
                    </div>
                    {it.geometry && (
                      <div style={{ color: '#999', fontSize: 10, fontFamily: 'monospace' }}>
                        {it.geometry.boundingBox ? `${Math.round(it.geometry.boundingBox.x || 0)}Ã${Math.round(it.geometry.boundingBox.y || 0)}Ã${Math.round(it.geometry.boundingBox.z || 0)} mm` : ''}
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: 'right', marginLeft: 12 }}>
                    <div style={{ fontWeight: 600 }}>{formatCurrency(it.lineTotal || 0)}</div>
                    {it.storedName && (
                      <button
                        onClick={() => api.downloadPart(it.partId, it.fileName).catch(e => alert('Download failed: ' + e.message))}
                        style={{
                          fontSize: 10, padding: '3px 8px', marginTop: 4,
                          border: '1px solid #4F8CFF', background: '#fff', color: '#4F8CFF',
                          borderRadius: 3, cursor: 'pointer',
                        }}
                      >
                        â¬ CAD
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </Section>

            {/* Tracking / shipping */}
            <Section title="Tracking">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Field label="Carrier">
                  <select
                    value={carrier}
                    onChange={(e) => setCarrier(e.target.value)}
                    style={{ width: '100%', padding: '6px 8px', fontSize: 12 }}
                  >
                    <option value="">â</option>
                    {CARRIERS.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </Field>
                <Field label="Ship Date">
                  <input
                    type="date"
                    value={shippedAt}
                    onChange={(e) => setShippedAt(e.target.value)}
                    style={{ width: '100%', padding: '6px 8px', fontSize: 12 }}
                  />
                </Field>
                <div style={{ gridColumn: '1 / -1' }}>
                  <Field label="Tracking Number">
                    <input
                      value={trackingNumber}
                      onChange={(e) => setTrackingNumber(e.target.value)}
                      placeholder="1Z999AA10123456784"
                      style={{ width: '100%', padding: '6px 8px', fontSize: 12, fontFamily: 'monospace' }}
                    />
                  </Field>
                </div>
              </div>
            </Section>

            {/* Notes */}
            <Section title="Notes">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
                placeholder="Internal notes (not shown to customer)"
                style={{ width: '100%', padding: 8, fontSize: 12, fontFamily: 'inherit' }}
              />
            </Section>

            {/* Actions */}
            <div style={{ display: 'flex', gap: 8, marginTop: 20, flexWrap: 'wrap' }}>
              <button
                className="btn btn-primary"
                onClick={saveShipping}
                disabled={saving}
                style={{ fontSize: 12 }}
              >
                {saving ? 'Savingâ¦' : 'Save Changes'}
              </button>
              <a
                href={`/orders/${order.id}/traveler`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-ghost"
                style={{ fontSize: 12, textDecoration: 'none' }}
              >
                ð Open Job Traveler
              </a>
              <a
                href={`/orders/${order.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-ghost"
                style={{ fontSize: 12, textDecoration: 'none' }}
              >
                ð Customer View
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{
      marginBottom: 18, padding: 14, border: '1px solid #e5e5e5',
      borderRadius: 6, background: '#fafafa',
    }}>
      <div style={{
        fontSize: 10, fontWeight: 600, color: '#888',
        textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'block', fontSize: 11 }}>
      <span style={{ color: '#666', fontWeight: 500, display: 'block', marginBottom: 2 }}>{label}</span>
      {children}
    </label>
  );
}
