import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import { formatCurrency } from '../utils/format';

export default function JobTravelerPage() {
  const { orderId } = useParams();
  const navigate = useNavigate();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adminNote, setAdminNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);

  useEffect(() => {
    const fetchOrder = async () => {
      try {
        const data = await api.getOrderById(orderId);
        setOrder(data);
        setAdminNote(data.adminNote || '');
      } catch (err) {
        setError(err.message || 'Failed to load order');
      } finally {
        setLoading(false);
      }
    };
    fetchOrder();
  }, [orderId]);

  const handleSaveNote = async () => {
    if (!adminNote.trim()) return;
    setSavingNote(true);
    try {
      // In a real app, this would call an API to update the admin note
      // await api.updateOrderNote(orderId, adminNote);
      console.log('Note saved:', adminNote);
    } catch (err) {
      console.error('Failed to save note:', err);
    } finally {
      setSavingNote(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)', padding: '32px' }}>
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>
        <button
          className="btn btn-ghost"
          onClick={() => navigate('/admin')}
          style={{ marginBottom: 24 }}
        >
          ← Back to Admin
        </button>

        {loading && (
          <div style={{ textAlign: 'center', padding: '40px 20px' }}>
            <div className="spinner" style={{ margin: '0 auto' }} />
          </div>
        )}

        {error && (
          <div style={{ background: 'var(--error-bg)', border: '1px solid var(--error)', borderRadius: 'var(--radius-md)', padding: 16, marginBottom: 24, color: 'var(--error-text)' }}>
            {error}
          </div>
        )}

        {!loading && order && (
          <>
            <div style={{ marginBottom: 32 }}>
              <h1 style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>Job Traveler - Order #{order.id}</h1>
              <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Admin production tracking and notes</p>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32, marginBottom: 32 }}>
              {/* Order Information */}
              <div>
                <div style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-primary)',
                  borderRadius: 'var(--radius-lg)',
                  padding: 24,
                }}>
                  <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>Order Information</h2>

                  <div style={{ marginBottom: 12 }}>
                    <div className="field-label" style={{ marginBottom: 4 }}>Order ID</div>
                    <div style={{ color: 'var(--text-primary)', fontSize: 12, fontFamily: 'var(--font-mono)', fontWeight: 500 }}>
                      {order.id}
                    </div>
                  </div>

                  <div style={{ marginBottom: 12 }}>
                    <div className="field-label" style={{ marginBottom: 4 }}>Status</div>
                    <div style={{ color: 'var(--accent)', fontSize: 12, fontWeight: 600, textTransform: 'capitalize' }}>
                      {order.status.replace(/_/g, ' ')}
                    </div>
                  </div>

                  <div style={{ marginBottom: 12 }}>
                    <div className="field-label" style={{ marginBottom: 4 }}>Total Price</div>
                    <div style={{ color: 'var(--text-primary)', fontSize: 12, fontWeight: 600 }}>
                      {formatCurrency(order.totalPrice)}
                    </div>
                  </div>

                  <div style={{ marginBottom: 12 }}>
                    <div className="field-label" style={{ marginBottom: 4 }}>Quantity</div>
                    <div style={{ color: 'var(--text-primary)', fontSize: 12 }}>
                      {order.quantity || 1} part{(order.quantity || 1) !== 1 ? 's' : ''}
                    </div>
                  </div>

                  <div style={{ marginBottom: 12 }}>
                    <div className="field-label" style={{ marginBottom: 4 }}>Lead Time</div>
                    <div style={{ color: 'var(--text-primary)', fontSize: 12 }}>
                      {order.leadTime || 'Standard'}
                    </div>
                  </div>

                  <div>
                    <div className="field-label" style={{ marginBottom: 4 }}>Placed Date</div>
                    <div style={{ color: 'var(--text-primary)', fontSize: 12 }}>
                      {new Date(order.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                </div>
              </div>

              {/* Quality Checkpoints */}
              <div>
                <div style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-primary)',
                  borderRadius: 'var(--radius-lg)',
                  padding: 24,
                }}>
                  <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>Quality Checkpoints</h2>

                  {['dimension_check', 'surface_finish', 'assembly', 'packaging'].map((checkpoint) => (
                    <div key={checkpoint} style={{ marginBottom: 12 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          style={{
                            width: 16,
                            height: 16,
                            cursor: 'pointer',
                            accentColor: 'var(--accent)',
                          }}
                        />
                        <span style={{ color: 'var(--text-secondary)', fontSize: 12, textTransform: 'capitalize' }}>
                          {checkpoint.replace(/_/g, ' ')}
                        </span>
                      </label>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Admin Notes */}
            <div style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border-primary)',
              borderRadius: 'var(--radius-lg)',
              padding: 24,
            }}>
              <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>Production Notes</h2>

              <textarea
                value={adminNote}
                onChange={(e) => setAdminNote(e.target.value)}
                placeholder="Add notes about production, material batch, special handling, etc."
                style={{
                  width: '100%',
                  minHeight: 120,
                  padding: 12,
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-primary)',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--text-secondary)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  resize: 'vertical',
                  marginBottom: 12,
                }}
              />

              <button
                className="btn btn-primary"
                onClick={handleSaveNote}
                disabled={savingNote || !adminNote.trim()}
              >
                {savingNote ? 'Saving...' : 'Save Notes'}
              </button>
            </div>

            {/* Shipping Address */}
            {order.shippingAddress && (
              <div style={{ marginTop: 32 }}>
                <div style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-primary)',
                  borderRadius: 'var(--radius-lg)',
                  padding: 24,
                }}>
                  <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>Shipping Address</h2>
                  <div style={{ color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.8 }}>
                    <div>{order.shippingAddress.street}</div>
                    <div>{order.shippingAddress.city}, {order.shippingAddress.state} {order.shippingAddress.zip}</div>
                    <div>{order.shippingAddress.country}</div>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
