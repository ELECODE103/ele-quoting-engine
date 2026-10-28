import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../utils/authContext';
import Wordmark from './Wordmark';

export default function Header() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, isAuthenticated, logout } = useAuth();

  const isActive = (path) => location.pathname === path;

  const btnStyle = (path) => ({
    fontSize: 13,
    padding: '8px 16px',
    borderRadius: 8,
    border: 'none',
    cursor: 'pointer',
    fontWeight: 500,
    letterSpacing: '-0.01em',
    transition: 'all 0.15s',
    background: isActive(path) ? 'var(--accent-bg)' : 'transparent',
    color: isActive(path) ? 'var(--accent)' : 'var(--text-muted)',
    fontFamily: 'var(--font-body)',
  });

  return (
    <header style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 28px', borderBottom: '1px solid var(--border-primary)',
      background: '#fff',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Wordmark size={17} />
      </div>

      <nav style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
        <button style={btnStyle('/materials')} onClick={() => navigate('/materials')}>
          Materials
        </button>
        <button style={btnStyle('/quote')} onClick={() => navigate('/quote')}>
          Instant Quote
        </button>
        {isAuthenticated && (
          <button style={btnStyle('/dashboard')} onClick={() => navigate('/dashboard')}>
            My Orders
          </button>
        )}
        {user?.role === 'admin' && (
          <button style={btnStyle('/admin')} onClick={() => navigate('/admin')}>
            Admin
          </button>
        )}
        {isAuthenticated ? (
          <button style={{
            ...btnStyle('/logout'),
            marginLeft: 8,
            background: 'transparent',
            color: 'var(--text-muted)',
          }} onClick={() => { logout(); navigate('/'); }}>
            Logout
          </button>
        ) : (
          <button style={{
            ...btnStyle('/login'),
            marginLeft: 8,
            background: 'var(--accent)',
            color: '#fff',
            borderRadius: 8,
          }} onClick={() => navigate('/login')}>
            Sign In
          </button>
        )}
      </nav>
    </header>
  );
}
