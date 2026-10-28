import { useEffect, useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../utils/authContext';
import { api, setAuthToken } from '../utils/api';
import Wordmark from '../components/Wordmark';
import brand from '../brand';

export default function RegisterPage() {
  const navigate = useNavigate();
  const location = useLocation();
  // Carried over from the login page when a guest was heading to checkout.
  const returnTo = location.state?.from || '/quote';
  const { login } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [company, setCompany] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => { document.title = `Create an account · ${brand.name}`; }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = await api.register(name, email, password, company);
      if (result.token) {
        setAuthToken(result.token);
        const decoded = JSON.parse(atob(result.token.split('.')[1]));
        login(result.token, decoded);
        navigate(returnTo);
      }
    } catch (err) {
      setError(err.message || `We couldn't create the account. Try again, or call ${brand.phone}.`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ marginBottom: 24 }}><Wordmark size={18} /></div>
          <h1 className="display" style={{ fontSize: 28, marginBottom: 8 }}>Create an account</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.6 }}>
            Needed to check out and track orders. Pricing a part doesn't need one.
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 16 }}>
            <label className="field-label" htmlFor="reg-name">Name</label>
            <input
              id="reg-name"
              type="text"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              required
            />
          </div>

          <div style={{ marginBottom: 16 }}>
            <label className="field-label" htmlFor="reg-email">Email</label>
            <input
              id="reg-email"
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </div>

          <div style={{ marginBottom: 16 }}>
            <label className="field-label" htmlFor="reg-company">Company (optional)</label>
            <input
              id="reg-company"
              type="text"
              className="input"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              autoComplete="organization"
            />
          </div>

          <div style={{ marginBottom: 24 }}>
            <label className="field-label" htmlFor="reg-password">Password</label>
            <input
              id="reg-password"
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>At least 8 characters.</div>
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
            {loading ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.8 }}>
          Already have one?{' '}
          <Link to="/login" state={location.state} style={{ color: 'var(--accent)' }}>Sign in</Link>
          <br />
          <Link to="/quote" style={{ color: 'var(--text-muted)' }}>Back to the quote</Link>
        </div>
      </div>
    </div>
  );
}
