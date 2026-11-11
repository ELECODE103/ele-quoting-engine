import { useEffect, useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../utils/authContext';
import { api } from '../utils/api';
import Wordmark from '../components/Wordmark';
import brand from '../brand';
import { destinationAfterAuth, nextFrom, authPath } from '../utils/returnTo';
import useFormGuard from '../utils/useFormGuard';

export const PASSWORD_HINT = 'At least 10 characters, with an upper-case letter, a lower-case letter and a number. Not a common password.';

export default function RegisterPage() {
  const navigate = useNavigate();
  const location = useLocation();
  // Carried over (as ?next=) from the login page or a guarded page when a
  // guest was heading to checkout, so a first-time buyer lands back on it.
  const returnTo = destinationAfterAuth(location);
  const toCheckout = returnTo.startsWith('/checkout');
  const { login } = useAuth();
  const guard = useFormGuard('register');
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
      const result = await guard.submit((headers, extra) => api.register({ name, email, password, company, ...extra }, headers));
      login(result);
      navigate(returnTo, { replace: true });
    } catch (err) {
      setError(err.message || `We couldn't create the account. Try again, or call ${brand.phone}.`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card" style={{ maxWidth: 400 }}>
        <div className="auth-head">
          <div style={{ marginBottom: 24 }}><Wordmark size={18} /></div>
          <h1 className="display" style={{ fontSize: 28, marginBottom: 8 }}>Create an account</h1>
          <p>
            {toCheckout
              ? 'Create an account to finish checkout. Your quote is saved and you go straight back to it.'
              : 'Needed to check out and track orders. Pricing a part doesn\'t need one.'}
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          {guard.honeypot}
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
              aria-describedby="reg-email-help"
            />
            <div id="reg-email-help" style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>
              We send one email to confirm this address. You confirm it before you pay; quoting works straight away.
            </div>
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

          <div style={{ marginBottom: 16 }}>
            <label className="field-label" htmlFor="reg-password">Password</label>
            <input
              id="reg-password"
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={10}
              maxLength={72}
              required
              aria-describedby="reg-password-help"
            />
            <div id="reg-password-help" style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>{PASSWORD_HINT}</div>
          </div>

          <div style={{ marginBottom: 16 }}>{guard.widget}</div>

          {error && <div role="alert" className="auth-error">{error}</div>}

          <button
            type="submit"
            className="btn btn-primary btn-lg"
            style={{ width: '100%', justifyContent: 'center', marginBottom: 16 }}
            disabled={loading}
          >
            {loading ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <div className="auth-foot" style={{ marginTop: 0 }}>
          Already have one?{' '}
          <Link to={authPath('/login', nextFrom(location))}>Sign in</Link>
          <br />
          <Link to="/quote" style={{ color: 'var(--text-muted)' }}>Back to the quote</Link>
        </div>
      </div>
    </div>
  );
}
