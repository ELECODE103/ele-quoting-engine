import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../utils/authContext';

export default function Header() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, isAuthenticated, logout } = useAuth();

  const isActive = (path) => location.pathname === path;

  const btnStyle = (path) => ({
    fontSize: 11,
    padding: '6px 14px',
    borderRadius: 6,
    border: 'none',
    cursor: 'pointer',
    fontWeight: 600,
    letterSpacing: '0.3px',
    textTransform: 'uppercase',
    transition: 'all 0.15s',
    background: isActive(path) ? 'var(--accent)' : 'transparent',
    color: isActive(path) ? '#fff' : 'var(--text-secondary)',
  });

  return (
    <header style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '14px 28px', borderBottom: '1px solid var(--border-primary)',
      background: 'var(--bg-secondary)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 6,
          background: 'linear-gradient(135deg, var(--accent-dark, #1a5ae0), var(--accent, #2b6ff2))',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round">
            <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
            <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
            <line x1="12" y1="22.08" x2="12" y2="12" />
          </svg>
        </div>
        <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.5px', color: 'var(--text-primary)' }}
              onClick={() => navigate('/')} role="button" tabIndex={0}>
          INSTANT QUOTE
        </span>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
          background: 'rgba(59,130,246,0.15)', color: 'var(--accent, #3b82f6)',
        }}>BETA</span>
      </div>

      <nav style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <button style={btnStyle('/')} onClick={() => navigate('/')}>
          Quote Builder
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
            color: 'var(--text-secondary)',
          }} onClick={() => { logout(); navigate('/'); }}>
            Logout
          </button>
        ) : (
          <button style={{
            ...btnStyle('/login'),
            marginLeft: 8,
            background: 'var(--accent)',
            color: '#fff',
          }} onClick={() => navigate('/login')}>
            Sign In
          </button>
        )}
      </nav>
    </header>
  );
}
