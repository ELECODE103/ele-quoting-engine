import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import { formatCurrency, orderStatusLabel } from '../utils/format';

export default function CustomerDashboard() {
  const navigate = useNavigate();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchOrders = async () => {
      try {
        const data = await api.getOrders();
        setOrders(Array.isArray(data) ? data : (data.orders || []));
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchOrders();
  }, []);

  const getStatusColor = (status) => {
    const colors = {
      pending: 'var(--warn-text)',
      confirmed: 'var(--accent)',
      in_production: 'var(--accent)',
      qa: 'var(--text-secondary)',
      shipped: 'var(--success-text)',
      delivered: 'var(--success-text)',
    };
    return colors[status] || 'var(--text-muted)';
  };

  const formatDate = (dateStr) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  return (
    <div className="app-page">
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>
        <h1 className="app-h1">Your orders</h1>
        <p style={{ color: 'var(--text-muted)', marginBottom: 32 }}>Open an order to see where it stands, or to reorder it.</p>

        {loading && (
          <div style={{ textAlign: 'center', padding: '40px 20px' }}>
            <div className="spinner" style={{ margin: '0 auto' }} />
          </div>
        )}

        {error && (
          <div role="alert" className="auth-error" style={{ padding: 16, marginBottom: 24 }}>
            {error}
          </div>
        )}

        {!loading && orders.length === 0 ? (
          <div style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-primary)',
            borderRadius: 'var(--radius-lg)',
            padding: 48,
            textAlign: 'center',
          }}>
            <p style={{ color: 'var(--text-muted)', marginBottom: 24 }}>No orders yet</p>
            <button
              className="btn btn-primary btn-lg"
              onClick={() => navigate('/quote')}
            >
              Get a Quote
            </button>
          </div>
        ) : (
          <div style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-primary)',
            borderRadius: 'var(--radius-lg)',
            overflowX: 'auto',
          }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-primary)' }}>
                  <th style={{ padding: '12px 16px', textAlign: 'left', color: 'var(--text-muted)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Order ID</th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', color: 'var(--text-muted)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Date</th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', color: 'var(--text-muted)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Status</th>
                  <th style={{ padding: '12px 16px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Total</th>
                  <th style={{ padding: '12px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}><span className="sr-only">Open</span></th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order, idx) => (
                  <tr key={order.id} style={{ borderBottom: idx < orders.length - 1 ? '1px solid var(--border-primary)' : 'none' }}>
                    <td style={{ padding: '12px 16px', color: 'var(--text-primary)', fontSize: 12, fontWeight: 500 }}>{String(order.id).slice(0, 8).toUpperCase()}</td>
                    <td style={{ padding: '12px 16px', color: 'var(--text-secondary)', fontSize: 12 }}>{formatDate(order.createdAt)}</td>
                    <td style={{ padding: '12px 16px' }}>
                      <span style={{ color: getStatusColor(order.status), fontSize: 11, fontWeight: 600 }}>
                        {orderStatusLabel(order.status)}
                      </span>
                    </td>
                    <td style={{ padding: '12px 16px', color: 'var(--text-primary)', fontSize: 12, textAlign: 'right', fontWeight: 500 }}>
                      {formatCurrency(order.total)}
                    </td>
                    <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                      <button
                        className="btn btn-ghost"
                        style={{ fontSize: 11, padding: '4px 8px' }}
                        onClick={() => navigate(`/orders/${order.id}`)}
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
