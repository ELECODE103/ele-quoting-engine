import { useState, useEffect } from 'react';
import { api } from '../utils/api';
import { formatCurrency } from '../utils/format';

export default function AdminPanel() {
  const [tab, setTab] = useState('materials');
  const [materials, setMaterials] = useState([]);
  const [finishes, setFinishes] = useState([]);
  const [leadTimes, setLeadTimes] = useState([]);
  const [pricing, setPricing] = useState({});
  const [quotes, setQuotes] = useState([]);
  const [orders, setOrders] = useState([]);
  const [parts, setParts] = useState([]);
  const [stats, setStats] = useState({});
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    try {
      const [mats, fins, lts, pr, qs, st, ord, prt] = await Promise.all([
        api.getAdminMaterials(),
        api.getAdminFinishes(),
        api.getAdminLeadTimes(),
        api.getPricingRules(),
        api.getAdminQuotes(),
        api.getAdminStats(),
        api.getOrders(),
        api.getAdminParts(),
      ]);
      setMaterials(mats);
      setFinishes(fins);
      setLeadTimes(lts);
      setPricing(pr);
      setQuotes(qs);
      setStats(st);
      setOrders(ord);
      setParts(prt);
    } catch (err) {
      console.error('Admin load error:', err);
    }
  }

  async function saveMaterial(id, updates) {
    setSaving(true);
    try {
      await api.updateMaterial(id, updates);
      await loadData();
      setEditingId(null);
    } catch (err) { alert('Save failed: ' + err.message); }
    setSaving(false);
  }

  async function saveFinish(id, updates) {
    setSaving(true);
    try {
      await api.updateFinish(id, updates);
      await loadData();
      setEditingId(null);
    } catch (err) { alert('Save failed: ' + err.message); }
    setSaving(false);
  }

  async function saveLeadTime(id, updates) {
    setSaving(true);
    try {
      await api.updateLeadTime(id, updates);
      await loadData();
      setEditingId(null);
    } catch (err) { alert('Save failed: ' + err.message); }
    setSaving(false);
  }

  async function advanceOrderStatus(orderId, newStatus) {
    setSaving(true);
    try {
      await api.updateOrderStatus(orderId, { status: newStatus });
      await loadData();
    } catch (err) { alert('Update failed: ' + err.message); }
    setSaving(false);
  }

  async function savePricingRules() {
    setSaving(true);
    try {
      await api.updatePricingRules(pricing);
      alert('Pricing rules saved.');
    } catch (err) { alert('Save failed: ' + err.message); }
    setSaving(false);
  }

  const tabs = [
    { key: 'orders', label: 'Orders' },
    { key: 'parts', label: 'Parts' },
    { key: 'materials', label: 'Materials' },
    { key: 'finishes', label: 'Finishes' },
    { key: 'lead-times', label: 'Lead Times' },
    { key: 'pricing', label: 'Pricing Rules' },
    { key: 'quotes', label: 'Quotes' },
  ];

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 32 }}>
      {/* Stats bar */}
      <div className="grid-4" style={{ marginBottom: 32 }}>
        {[
          { label: 'Total Orders', value: stats.totalOrders || 0 },
          { label: 'Paid Revenue', value: formatCurrency(stats.paidRevenue || 0) },
          { label: 'Open Quotes', value: stats.openQuotes || 0 },
          { label: 'Uploads (30d)', value: stats.uploads30d || 0 },
        ].map((s, i) => (
          <div key={i} className="card fade-up" style={{ padding: 20, animationDelay: `${i * 60}ms` }}>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              {s.label}
            </div>
            <div className="font-display" style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', marginTop: 4 }}>
              {s.value}
            </div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 24 }}>
        {tabs.map((t) => (
          <button
            key={t.key}
            className={`btn ${tab === t.key ? 'btn-ghost active' : 'btn-ghost'}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ─── ORDERS TAB ─── */}
      {tab === 'orders' && (
        <div className="card" style={{ overflow: 'hidden' }}>
          {orders.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-dim)' }}>
              No orders yet. Orders appear here when customers complete Stripe checkout.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-primary)', background: 'var(--bg-secondary)' }}>
                  {['Date', 'Order ID', 'Customer', 'Items', 'Total', 'Status', 'Files', 'Action'].map((h) => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const nextMap = {
                    paid: 'received',
                    received: 'in_production',
                    in_production: 'quality_check',
                    quality_check: 'packing',
                    packing: 'shipped',
                    shipped: 'delivered',
                  };
                  const next = nextMap[o.status];
                  const statusColor = {
                    pending_payment: 'var(--text-muted)',
                    paid: '#4F8CFF',
                    received: '#4F8CFF',
                    in_production: '#F5A623',
                    quality_check: '#F5A623',
                    packing: '#F5A623',
                    shipped: '#7ED321',
                    delivered: '#7ED321',
                    cancelled: '#E94E4E',
                    paid_amount_mismatch: '#E94E4E',
                  }[o.status] || 'var(--text-muted)';
                  return (
                    <tr key={o.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      <td style={{ padding: '10px 14px', color: 'var(--text-dim)' }}>
                        {new Date(o.createdAt).toLocaleString()}
                      </td>
                      <td style={{ padding: '10px 14px', fontFamily: 'monospace', fontSize: 11 }}>
                        <a href={`/orders/${o.id}`} style={{ color: 'var(--accent)' }}>{String(o.id).slice(0, 8)}</a>
                      </td>
                      <td style={{ padding: '10px 14px' }}>{o.shippingName || '—'}</td>
                      <td style={{ padding: '10px 14px' }}>{o.itemCount}</td>
                      <td style={{ padding: '10px 14px' }}>
                        {(o.items || []).filter(it => it.storedName).map((it, idx) => (
                          <button
                            key={idx}
                            onClick={() => api.downloadPart(it.partId, it.fileName).catch(e => alert('Download failed: ' + e.message))}
                            title={it.fileName}
                            style={{ fontSize: '11px', padding: '4px 8px', marginRight: '4px', marginBottom: '2px', cursor: 'pointer', border: '1px solid #4F8CFF', background: '#fff', color: '#4F8CFF', borderRadius: '3px' }}
                          >
                            {(it.fileName || 'file').length > 18 ? (it.fileName || 'file').slice(0, 15) + '...' : (it.fileName || 'file')}
                          </button>
                        ))}
                        {(!o.items || o.items.filter(it => it.storedName).length === 0) && (
                          <span style={{ color: '#999', fontSize: '11px' }}>—</span>
                        )}
                      </td>
                      <td style={{ padding: '10px 14px', fontWeight: 600, color: 'var(--accent)' }}>
                        {formatCurrency(o.total)}
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <span style={{ color: statusColor, fontWeight: 600, fontSize: 11, textTransform: 'uppercase' }}>
                          {o.status.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        {next && (
                          <button
                            className="btn btn-ghost"
                            style={{ fontSize: 11, padding: '4px 10px' }}
                            disabled={saving}
                            onClick={() => advanceOrderStatus(o.id, next)}
                          >
                            → {next.replace(/_/g, ' ')}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ─── MATERIALS TAB ─── */}
      {tab === 'parts' && (
          <div>
            <h2 style={{ marginBottom: '16px' }}>All Uploaded Parts ({parts.length})</h2>
            <p style={{ color: '#666', marginBottom: '16px', fontSize: '13px' }}>
              Every CAD file uploaded by customers, including parts that never became orders. Newest first.
            </p>
            {parts.length === 0 ? (
              <p style={{ color: '#999' }}>No uploads yet.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ background: '#f5f5f5', textAlign: 'left' }}>
                    {['Uploaded', 'File Name', 'Size', 'Triangles', 'Bounding Box (mm)', 'Download'].map((h) => (
                      <th key={h} style={{ padding: '10px 14px', borderBottom: '1px solid #ddd' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {parts.map((p) => {
                    const bb = p.boundingBox;
                    const bbStr = bb ? `${Math.round(bb.x || bb.width || 0)} × ${Math.round(bb.y || bb.height || 0)} × ${Math.round(bb.z || bb.depth || 0)}` : '—';
                    const sizeKb = p.fileSize ? (p.fileSize / 1024).toFixed(1) + ' KB' : '—';
                    const dateStr = p.createdAt ? new Date(p.createdAt).toLocaleString() : '—';
                    return (
                      <tr key={p.id} style={{ borderBottom: '1px solid #eee' }}>
                        <td style={{ padding: '10px 14px' }}>{dateStr}</td>
                        <td style={{ padding: '10px 14px', fontFamily: 'monospace' }}>{p.fileName}</td>
                        <td style={{ padding: '10px 14px' }}>{sizeKb}</td>
                        <td style={{ padding: '10px 14px' }}>{p.triangleCount?.toLocaleString() || '—'}</td>
                        <td style={{ padding: '10px 14px' }}>{bbStr}</td>
                        <td style={{ padding: '10px 14px' }}>
                          {p.storedName ? (
                            <button
                              onClick={() => api.downloadPart(p.id, p.fileName).catch(e => alert('Download failed: ' + e.message))}
                              style={{ fontSize: '12px', padding: '6px 12px', cursor: 'pointer', border: '1px solid #4F8CFF', background: '#4F8CFF', color: '#fff', borderRadius: '3px' }}
                            >
                              Download
                            </button>
                          ) : (
                            <span style={{ color: '#999' }}>missing</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {tab === 'materials' && (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-primary)', background: 'var(--bg-secondary)' }}>
                {['Active', 'Name', 'Category', 'Price/kg', 'Grades', 'Thicknesses', ''].map((h) => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {materials.map((m) => (
                <tr key={m.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <td style={{ padding: '10px 14px' }}>
                    <span className={`tag ${m.active ? 'tag-pass' : 'tag-fail'}`}>{m.active ? 'ON' : 'OFF'}</span>
                  </td>
                  <td style={{ padding: '10px 14px', fontWeight: 500, color: 'var(--text-secondary)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 12, height: 12, borderRadius: 2, background: m.color }} />
                      {m.name}
                    </div>
                  </td>
                  <td style={{ padding: '10px 14px', color: 'var(--text-dim)' }}>{m.category}</td>
                  <td style={{ padding: '10px 14px' }}>
                    {editingId === m.id ? (
                      <input
                        className="input"
                        type="number"
                        step="0.01"
                        defaultValue={m.pricePerKg}
                        style={{ width: 80 }}
                        onBlur={(e) => saveMaterial(m.id, { pricePerKg: parseFloat(e.target.value) })}
                        onKeyDown={(e) => e.key === 'Enter' && saveMaterial(m.id, { pricePerKg: parseFloat(e.target.value) })}
                        autoFocus
                      />
                    ) : (
                      <span style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => setEditingId(m.id)}>
                        ${m.pricePerKg?.toFixed(2)}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '10px 14px', color: 'var(--text-dim)' }}>{m.grades?.length}</td>
                  <td style={{ padding: '10px 14px', color: 'var(--text-dim)' }}>{m.thicknesses?.length}</td>
                  <td style={{ padding: '10px 14px' }}>
                    <button className="btn btn-ghost" style={{ fontSize: 10, padding: '4px 10px' }}
                      onClick={() => saveMaterial(m.id, { active: !m.active })}>
                      {m.active ? 'Disable' : 'Enable'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ─── FINISHES TAB ─── */}
      {tab === 'finishes' && (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-primary)', background: 'var(--bg-secondary)' }}>
                {['Active', 'Name', 'Per Part', 'Per in²', ''].map((h) => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {finishes.map((f) => (
                <tr key={f.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <td style={{ padding: '10px 14px' }}>
                    <span className={`tag ${f.active ? 'tag-pass' : 'tag-fail'}`}>{f.active ? 'ON' : 'OFF'}</span>
                  </td>
                  <td style={{ padding: '10px 14px', fontWeight: 500, color: 'var(--text-secondary)' }}>{f.name}</td>
                  <td style={{ padding: '10px 14px' }}>
                    {editingId === `fin-${f.id}` ? (
                      <input className="input" type="number" step="0.01" defaultValue={f.pricePerPart}
                        style={{ width: 80 }}
                        onBlur={(e) => { saveFinish(f.id, { pricePerPart: parseFloat(e.target.value) }); }}
                        autoFocus />
                    ) : (
                      <span style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => setEditingId(`fin-${f.id}`)}>
                        ${f.pricePerPart?.toFixed(2)}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '10px 14px', color: 'var(--text-dim)' }}>${f.pricePerSqIn?.toFixed(3)}</td>
                  <td style={{ padding: '10px 14px' }}>
                    <button className="btn btn-ghost" style={{ fontSize: 10, padding: '4px 10px' }}
                      onClick={() => saveFinish(f.id, { active: !f.active })}>
                      {f.active ? 'Disable' : 'Enable'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ─── LEAD TIMES TAB ─── */}
      {tab === 'lead-times' && (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-primary)', background: 'var(--bg-secondary)' }}>
                {['Active', 'Name', 'Days', 'Multiplier', ''].map((h) => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {leadTimes.map((lt) => (
                <tr key={lt.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <td style={{ padding: '10px 14px' }}>
                    <span className={`tag ${lt.active ? 'tag-pass' : 'tag-fail'}`}>{lt.active ? 'ON' : 'OFF'}</span>
                  </td>
                  <td style={{ padding: '10px 14px', fontWeight: 500, color: 'var(--text-secondary)' }}>{lt.name}</td>
                  <td style={{ padding: '10px 14px', color: 'var(--text-dim)' }}>{lt.days}</td>
                  <td style={{ padding: '10px 14px' }}>
                    {editingId === `lt-${lt.id}` ? (
                      <input className="input" type="number" step="0.01" defaultValue={lt.multiplier}
                        style={{ width: 80 }}
                        onBlur={(e) => saveLeadTime(lt.id, { multiplier: parseFloat(e.target.value) })}
                        autoFocus />
                    ) : (
                      <span style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => setEditingId(`lt-${lt.id}`)}>
                        {lt.multiplier}×
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <button className="btn btn-ghost" style={{ fontSize: 10, padding: '4px 10px' }}
                      onClick={() => saveLeadTime(lt.id, { active: !lt.active })}>
                      {lt.active ? 'Disable' : 'Enable'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ─── PRICING RULES TAB ─── */}
      {tab === 'pricing' && (
        <div className="card" style={{ padding: 24 }}>
          <div className="font-display" style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 20 }}>
            Pricing Engine Configuration
          </div>
          <div className="grid-2" style={{ gap: 20 }}>
            <PricingField label="Laser cut rate (per mm)" field="laserCutRatePerMm" value={pricing} onChange={setPricing} />
            <PricingField label="Thickness exponent" field="laserThicknessExponent" value={pricing} onChange={setPricing} />
            <PricingField label="Bend base cost ($)" field="bendBaseCost" value={pricing} onChange={setPricing} />
            <PricingField label="Bend thickness multiplier" field="bendThicknessMultiplier" value={pricing} onChange={setPricing} />
            <PricingField label="Hole base cost ($)" field="holeBaseCost" value={pricing} onChange={setPricing} />
            <PricingField label="Tap cost ($)" field="tapCost" value={pricing} onChange={setPricing} />
            <PricingField label="Minimum part price ($)" field="minimumPartPrice" value={pricing} onChange={setPricing} />
            <PricingField label="Minimum order total ($)" field="minimumOrderTotal" value={pricing} onChange={setPricing} />
            <PricingField label="Nesting efficiency bonus" field="nestingEfficiencyBonus" value={pricing} onChange={setPricing} step="0.01" />
            <PricingField label="Target margin (%)" field="marginPercent" value={pricing} onChange={setPricing} step="0.01" />
            <PricingField label="Shipping base rate ($)" field="shippingBaseRate" value={pricing} onChange={setPricing} />
            <PricingField label="Shipping per kg ($)" field="shippingPerKg" value={pricing} onChange={setPricing} />
          </div>

          {/* Volume discount tiers */}
          <div style={{ marginTop: 24 }}>
            <span className="field-label">Volume Discount Tiers</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
              {(pricing.volumeDiscounts || []).map((tier, i) => (
                <div key={i} style={{
                  padding: '6px 12px', borderRadius: 'var(--radius-md)',
                  background: 'var(--bg-primary)', border: '1px solid var(--border-primary)',
                  fontSize: 11,
                }}>
                  <span style={{ color: 'var(--text-muted)' }}>{tier.minQty}+ units:</span>{' '}
                  <span style={{ color: 'var(--success-text)', fontWeight: 500 }}>{(tier.discount * 100).toFixed(0)}% off</span>
                </div>
              ))}
            </div>
          </div>

          <button className="btn btn-primary" style={{ marginTop: 24 }} onClick={savePricingRules} disabled={saving}>
            {saving ? 'Saving…' : 'Save Pricing Rules'}
          </button>
        </div>
      )}

      {/* ─── QUOTES TAB ─── */}
      {tab === 'quotes' && (
        <div className="card" style={{ overflow: 'hidden' }}>
          {quotes.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-dim)' }}>
              No quotes yet. Upload parts and configure a quote to see them here.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-primary)', background: 'var(--bg-secondary)' }}>
                  {['Date', 'Parts', 'Units', 'Lead Time', 'Subtotal', 'Total'].map((h) => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {quotes.slice(0, 50).map((q) => (
                  <tr key={q.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <td style={{ padding: '10px 14px', color: 'var(--text-dim)' }}>
                      {new Date(q.createdAt).toLocaleString()}
                    </td>
                    <td style={{ padding: '10px 14px' }}>{q.partCount}</td>
                    <td style={{ padding: '10px 14px' }}>{q.totalUnits}</td>
                    <td style={{ padding: '10px 14px' }}>
                      <span className="tag tag-info">{q.leadTimeSlug}</span>
                    </td>
                    <td style={{ padding: '10px 14px' }}>{formatCurrency(q.subtotal)}</td>
                    <td style={{ padding: '10px 14px', fontWeight: 600, color: 'var(--accent)' }}>
                      {formatCurrency(q.orderTotal)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function PricingField({ label, field, value, onChange, step = '0.001' }) {
  return (
    <label>
      <span className="field-label">{label}</span>
      <input
        className="input"
        type="number"
        step={step}
        value={value[field] ?? ''}
        onChange={(e) => onChange((prev) => ({ ...prev, [field]: parseFloat(e.target.value) || 0 }))}
      />
    </label>
  );
}
