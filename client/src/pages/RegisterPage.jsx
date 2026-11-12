import { useEffect, useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../utils/authContext';
import { api } from '../utils/api';
import Wordmark from '../components/Wordmark';
import { FormError } from '../components/form/Notice';
import PasswordField, { passwordProblem, PASSWORD_HINT } from '../components/form/PasswordField';
import brand from '../brand';
import { destinationAfterAuth, nextFrom, authPath } from '../utils/returnTo';
import useFormGuard from '../utils/useFormGuard';

export { PASSWORD_HINT };

/**
 * Create an account. The password rules are on the page before anything is
 * sent, the one email we send is explained where the address is typed, and a
 * refusal keeps what was typed, takes the focus, and says what to do next.
 */
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
  const [error, setError] = useState(null); // { message, code, field }
  const [errorAt, setErrorAt] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => { document.title = `Create an account · ${brand.name}`; }, []);

  const fail = (message, extra = {}) => { setError({ message, ...extra }); setErrorAt((n) => n + 1); };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (loading) return;
    setError(null);
    // The rules are checked here first, so a short password never costs a round trip.
    const problem = passwordProblem(password, { email });
    if (problem) return fail(problem, { field: 'password' });
    setLoading(true);

    try {
      const result = await guard.submit((headers, extra) => api.register({ name, email, password, company, ...extra }, headers));
      login(result);
      navigate(returnTo, { replace: true });
    } catch (err) {
      fail(err.message, { code: err.code, field: err.code === 'weak-password' ? 'password' : err.code === 'account-exists' ? 'email' : '' });
    } finally {
      setLoading(false);
    }
  };

  const signInPath = authPath('/login', nextFrom(location));
  return (
    <div className="auth-shell">
      <main className="auth-card" style={{ maxWidth: 400 }}>
        <div className="auth-head">
          <div className="auth-mark"><Wordmark size={18} /></div>
          <h1 className="display">Create an account</h1>
          <p>
            {toCheckout
              ? 'One short form, then straight back to checkout. Your quote is saved.'
              : 'Needed to check out and track orders. Pricing a part doesn\'t need one.'}
          </p>
        </div>

        <form onSubmit={handleSubmit} aria-busy={loading || undefined}>
          {guard.honeypot}
          <div className="field">
            <label className="field-label" htmlFor="reg-name">Name</label>
            <input id="reg-name" type="text" className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="reg-email">Email</label>
            <input
              id="reg-email"
              type="email"
              inputMode="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              aria-invalid={error?.field === 'email' || undefined}
              aria-describedby={`reg-email-help${error?.field === 'email' ? ' reg-error' : ''}`}
            />
            <span id="reg-email-help" className="field-hint">
              We send one email with a link to confirm this address, because your order confirmation and shipping notice go to it.
              You open the link before you pay; pricing works straight away.
            </span>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="reg-company">Company <span className="optional">(optional)</span></label>
            <input id="reg-company" type="text" className="input" value={company} onChange={(e) => setCompany(e.target.value)} autoComplete="organization" />
          </div>

          <PasswordField
              id="reg-password"
              label="Password"
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              rules
              invalid={error?.field === 'password'}
              describedBy={error?.field === 'password' ? 'reg-error' : ''}
            />

          <div style={{ marginBottom: 16 }}>{guard.widget}</div>

          <FormError id="reg-error" error={error?.message} at={errorAt}>
            {error?.code === 'account-exists' && (
              <>
                <Link to={signInPath} className="btn btn-outline">Sign in</Link>
                <Link to="/forgot-password" className="btn btn-ghost">Choose a new password</Link>
              </>
            )}
          </FormError>

          <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={loading}>
            {loading ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <div className="auth-foot">
          Already have one?{' '}
          <Link to={signInPath}>Sign in</Link>
          <br />
          <Link to="/quote" className="quiet">Back to the quote</Link>
          <br />
          Rather set it up by phone? <a href={brand.phoneHref}>{brand.phone}</a>
        </div>
      </main>
    </div>
  );
}
