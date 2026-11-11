import { useEffect, useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../utils/authContext';
import { api } from '../utils/api';
import Wordmark from '../components/Wordmark';
import HumanCheck from '../components/security/HumanCheck';
import brand from '../brand';
import { destinationAfterAuth, nextFrom, authPath } from '../utils/returnTo';
import { CHECK_BLOCKED_MESSAGE } from '../utils/security';

/**
 * Sign in. Three things can be asked for beyond email and password, each only
 * when the server says so:
 *   - the spam check, after repeated wrong passwords (its script is not loaded before that);
 *   - a 6-digit authenticator code, when the account has two-step sign-in;
 *   - a recovery code in its place.
 */
export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  // Where to go after login — set by a guarded page (e.g. guest → checkout) as
  // ?next=, so the in-progress quote/checkout survives the login detour.
  const returnTo = destinationAfterAuth(location);
  const toCheckout = returnTo.startsWith('/checkout');
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [needCheck, setNeedCheck] = useState(false);
  const [checkToken, setCheckToken] = useState('');
  const [checkState, setCheckState] = useState('idle');
  const [checkRound, setCheckRound] = useState(0);
  const [twoFactor, setTwoFactor] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const notice = location.state?.notice || '';

  useEffect(() => { document.title = `Sign in · ${brand.name}`; }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (needCheck && checkState === 'blocked') return setError(CHECK_BLOCKED_MESSAGE);
    if (needCheck && checkState !== 'off' && !checkToken) return setError('Finish the spam check below, then sign in again.');
    setLoading(true);

    try {
      const extra = twoFactor ? (useRecovery ? { recoveryCode: code } : { totp: code }) : {};
      const result = await api.login(email, password, extra, needCheck && checkToken ? { 'X-Turnstile-Token': checkToken } : {});
      login(result);
      navigate(returnTo, { replace: true });
    } catch (err) {
      const data = err.data || {};
      if (err.code === 'two-factor-required') {
        setTwoFactor(true);
        setCode('');
      } else {
        setError(err.message || `That email and password didn't match. Try again, or call ${brand.phone}.`);
        if (twoFactor) setCode('');
      }
      if (data.challenge || err.code === 'human-check-required') setNeedCheck(true);
      // A check token is good for one attempt.
      if (needCheck) { setCheckToken(''); setCheckRound((n) => n + 1); }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card" style={{ maxWidth: 400 }}>
        <div className="auth-head">
          <div style={{ marginBottom: 24 }}><Wordmark size={18} /></div>
          <h1 className="display" style={{ fontSize: 28, marginBottom: 8 }}>Sign in</h1>
          <p>
            {toCheckout
              ? 'Sign in to finish checkout. Your quote is saved and will be waiting.'
              : 'For your orders and saved quotes. You don\'t need an account to get a price.'}
          </p>
        </div>

        {notice && <div className="auth-ok" role="status">{notice}</div>}

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

          <div style={{ marginBottom: twoFactor ? 16 : 8 }}>
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

          {twoFactor && (
            <div style={{ marginBottom: 8 }}>
              <label className="field-label" htmlFor="login-code">{useRecovery ? 'Recovery code' : 'Code from your authenticator app'}</label>
              <input
                id="login-code"
                type="text"
                className="input"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode={useRecovery ? 'text' : 'numeric'}
                autoComplete="one-time-code"
                placeholder={useRecovery ? 'XXXXX-XXXXX' : '6 digits'}
                autoFocus
                required
                aria-describedby="login-code-help"
              />
              <span id="login-code-help" className="field-hint">
                {useRecovery
                  ? 'One of the ten codes you saved when you set up two-step sign-in. Each works once.'
                  : 'This account has two-step sign-in. Open your authenticator app and enter the 6-digit code it shows now.'}{' '}
                <button type="button" className="linklike-inline" onClick={() => { setUseRecovery((v) => !v); setCode(''); }}>
                  {useRecovery ? 'Use the authenticator app instead' : 'No phone? Use a recovery code'}
                </button>
              </span>
            </div>
          )}

          <div style={{ textAlign: 'right', marginBottom: 20, fontSize: 12 }}>
            <Link to="/forgot-password" style={{ color: 'var(--accent)' }}>Forgot your password?</Link>
          </div>

          {needCheck && (
            <div style={{ marginBottom: 16 }}>
              <HumanCheck key={checkRound} action="login" onToken={setCheckToken} onState={setCheckState} />
            </div>
          )}

          {error && <div role="alert" className="auth-error">{error}</div>}

          <button
            type="submit"
            className="btn btn-primary btn-lg"
            style={{ width: '100%', justifyContent: 'center', marginBottom: 16 }}
            disabled={loading}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="auth-foot" style={{ marginTop: 0 }}>
          No account yet?{' '}
          <Link to={authPath('/register', nextFrom(location))}>Create one</Link>
          <br />
          <Link to="/quote" style={{ color: 'var(--text-muted)' }}>Back to the quote</Link>
        </div>
      </div>
    </div>
  );
}
