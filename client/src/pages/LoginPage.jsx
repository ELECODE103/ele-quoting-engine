import { useEffect, useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../utils/authContext';
import { api, setAuthToken } from '../utils/api';
import Wordmark from '../components/Wordmark';
import brand from '../brand';

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  // Where to go after login — set by a guarded page (e.g. guest → checkout) so
  // the in-progress quote/checkout survives the login detour.
  const returnTo = location.state?.from || '/quote';
  const toCheckout = returnTo.startsWith('/checkout');
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => { document.title = `Sign in · ${brand.name}`; }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = await api.login(email, password);
      if (result.token) {
        setAuthToken(result.token);
        const decoded = JSON.parse(atob(result.token.split('.')[1]));
        login(result.token, decoded);
        navigate(returnTo);
      }
    } catch (err) {
      setError(err.message || `That email and password didn't match. Try again, or call ${brand.phone}.`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ marginBottom: 24 }}><Wordmark size={18} /></div>
          <h1 className="display" style={{ fontSize: 28, marginBottom: 8 }}>Sign in</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.6 }}>
            {toCheckout
              ? 'Sign in to finish checkout. Your quote is saved and will be waiting.'
              : 'For your orders and saved quotes. You don\'t need an account to get a price.'}
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 16 }}>
            <label className="field-label" htmlFor="login-email">Email</label>
            <input
              id="login-email"
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </div>

          <div style={{ marginBottom: 24 }}>
            <label className="field-label" htmlFor="login-password">Password</label>
            <input
              id="login-password"
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>

          {error && (
            <div role="alert" style={{ background: 'var(--error-bg)', border: '1px solid var(--error)', borderRadius: 'var(--radius-md)', padding: 12, marginBottom: 16, color: 'var(--error-text)', fontSize: 12 }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary btn-lg"
            style={{ width: '100%', justifyContent: 'center', marginBottom: 16 }}
            disabled={loading}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.8 }}>
          No account yet?{' '}
          <Link to="/register" state={location.state} style={{ color: 'var(--accent)' }}>Create one</Link>
          <br />
          <Link to="/quote" style={{ color: 'var(--text-muted)' }}>Back to the quote</Link>
        </div>
      </div>
    </div>
  );
}
