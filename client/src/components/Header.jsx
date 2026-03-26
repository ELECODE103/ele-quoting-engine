import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../utils/authContext';

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
        <div style={{
          width: 32, height: 32, borderRadius: 8,
          background: 'var(--accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
        </div>
        <span style={{
          fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700,
          letterSpacing: '-0.5px', color: 'var(--text-primary)', cursor: 'pointer',
        }}
              onClick={() => navigate('/landing')} role="button" tabIndex={0}>
          Nord MFG
        </span>
        <span style={{
          fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
          background: 'var(--accent-light)', color: 'var(--accent)',
          letterSpacing: '0.05em',
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
