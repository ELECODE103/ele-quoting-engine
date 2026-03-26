import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import { formatCurrency, formatDate } from '../utils/format';

export default function OrderTrackingPage() {
  const { orderId } = useParams();
  const navigate = useNavigate();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchOrder = async () => {
      try {
        const data = await api.getOrderById(orderId);
        setOrder(data);
      } catch (err) {
        setError(err.message || 'Failed to load order');
      } finally {
        setLoading(false);
      }
    };
    fetchOrder();
  }, [orderId]);

  const statuses = ['received', 'in_production', 'qc', 'shipped', 'delivered'];

  const getStatusIndex = (status) => {
    const normalizedStatus = status.toLowerCase().replace(/ /g, '_');
    return statuses.indexOf(normalizedStatus);
  };

  const formatStatusLabel = (status) => {
    return status.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)', padding: '32px' }}>
      <div style={{ maxWidth: 800, margin: '0 auto' }}>
        <button
          className="btn btn-ghost"
          onClick={() => navigate('/dashboard')}
          style={{ marginBottom: 24 }}
        >
          ← Back to Orders
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
              <h1 style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>Order #{order.id}</h1>
              <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                Placed on {new Date(order.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
              </p>
            </div>

            {/* Order Details */}
            <div style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border-primary)',
              borderRadius: 'var(--radius-lg)',
              padding: 24,
              marginBottom: 32,
            }}>
              <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>Order Details</h2>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
                <div>
                  <div className="field-label" style={{ marginBottom: 4 }}>Status</div>
                  <div style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 500, textTransform: 'capitalize' }}>
                    {formatStatusLabel(order.status)}
                  </div>
                </div>

                <div>
                  <div className="field-label" style={{ marginBottom: 4 }}>Total Price</div>
                  <div style={{ color: 'var(--accent)', fontSize: 14, fontWeight: 600 }}>{formatCurrency(order.totalPrice)}</div>
                </div>

                <div>
                  <div className="field-label" style={{ marginBottom: 4 }}>Quantity</div>
                  <div style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 500 }}>
                    {order.quantity || 1} part{(order.quantity || 1) !== 1 ? 's' : ''}
                  </div>
                </div>

                <div>
                  <div className="field-label" style={{ marginBottom: 4 }}>Lead Time</div>
                  <div style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 500 }}>
                    {order.leadTime || 'Standard'}
                  </div>
                </div>
              </div>
            </div>

            {/* Status Timeline */}
            <div style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border-primary)',
              borderRadius: 'var(--radius-lg)',
              padding: 24,
              marginBottom: 32,
            }}>
              <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 24 }}>Status Timeline</h2>

              <div style={{ position: 'relative' }}>
                {statuses.map((status, idx) => {
                  const isActive = getStatusIndex(order.status) >= idx;
                  const isCompleted = getStatusIndex(order.status) > idx;

                  return (
                    <div key={status} style={{ display: 'flex', marginBottom: idx < statuses.length - 1 ? 24 : 0 }}>
                      {/* Timeline Dot */}
                      <div style={{ position: 'relative', width: 40, display: 'flex', justifyContent: 'center' }}>
                        <div
                          style={{
                            width: 16,
                            height: 16,
                            borderRadius: '50%',
                            background: isActive ? 'var(--accent)' : 'var(--border-primary)',
                            border: isActive ? '3px solid var(--bg-primary)' : 'none',
                            zIndex: 2,
                            transition: 'all 0.3s',
                          }}
                        />
                        {/* Timeline Line */}
                        {idx < statuses.length - 1 && (
                          <div
                            style={{
                              position: 'absolute',
                              top: 16,
                              left: '50%',
                              transform: 'translateX(-50%)',
                              width: 2,
                              height: 24,
                              background: isCompleted ? 'var(--accent)' : 'var(--border-primary)',
                              transition: 'all 0.3s',
                            }}
                          />
                        )}
                      </div>

                      {/* Status Label */}
                      <div style={{ paddingLeft: 16, paddingTop: 0 }}>
                        <div style={{
                          color: isActive ? 'var(--accent)' : 'var(--text-muted)',
                          fontSize: 12,
                          fontWeight: 600,
                          textTransform: 'capitalize',
                        }}>
                          {formatStatusLabel(status)}
                        </div>
                        <div style={{
                          color: isActive ? 'var(--text-secondary)' : 'var(--text-dim)',
                          fontSize: 11,
                          marginTop: 4,
                        }}>
                          {isCompleted ? 'Completed' : isActive ? 'In progress' : 'Pending'}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Shipping Info */}
            {order.shippingAddress && (
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
            )}
          </>
        )}
      </div>
    </div>
  );
}
