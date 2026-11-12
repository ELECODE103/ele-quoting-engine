import { useEffect, useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../utils/authContext';
import { api } from '../utils/api';
import Wordmark from '../components/Wordmark';
import HumanCheck from '../components/security/HumanCheck';
import Notice, { FormError } from '../components/form/Notice';
import PasswordField from '../components/form/PasswordField';
import CodeField from '../components/form/CodeField';
import brand from '../brand';
import { destinationAfterAuth, nextFrom, authPath } from '../utils/returnTo';
import { CHECK_BLOCKED_SUBMIT, CHECK_NOT_DONE } from '../utils/security';

/** "3:42 PM": when a pause that lasts `seconds` from now is over. */
function clockIn(seconds) {
  try { return new Date(Date.now() + seconds * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return ''; }
}

/**
 * Sign in. Three things can be asked for beyond email and password, each only
 * when the server says so:
 *   - the spam check, after repeated wrong passwords (its script is not loaded before that);
 *   - a 6-digit authenticator code, when the account has two-step sign-in;
 *   - a recovery code in its place.
 *
 * Whatever goes wrong, what was typed stays, the message takes the focus, and
 * the message says what to do next (utils/messageCatalogue.js has the words).
 */
export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  // Where to go after login — set by a guarded page (e.g. guest → checkout) as
  // ?next=, so the in-progress quote/checkout survives the login detour.
  const returnTo = destinationAfterAuth(location);
  const toCheckout = returnTo.startsWith('/checkout');
  const { login, sessionEnded } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);   // { message, code, until }
  const [errorAt, setErrorAt] = useState(0);
  const [info, setInfo] = useState('');
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

  const fail = (message, extra = {}) => { setError({ message, ...extra }); setErrorAt((n) => n + 1); };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setInfo('');
    if (needCheck && checkState === 'blocked') return fail(CHECK_BLOCKED_SUBMIT);
    if (needCheck && checkState !== 'off' && !checkToken) return fail(CHECK_NOT_DONE);
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
      } else if (err.code === 'human-check-required' && !needCheck) {
        // The server wants the spam check and this page had not shown it yet: not an error of the visitor's.
        setInfo('One quick check first, after the earlier wrong passwords. It appears below; when it says "Check passed", press Sign in again.');
      } else {
        fail(err.message, {
          code: err.code,
          until: err.code === 'account-locked' && data.retryAfterSeconds ? clockIn(data.retryAfterSeconds) : '',
        });
        if (twoFactor) setCode('');
      }
      if (data.challenge || err.code === 'human-check-required') setNeedCheck(true);
      // A check token is good for one attempt.
      if (needCheck) { setCheckToken(''); setCheckRound((n) => n + 1); }
    } finally {
      setLoading(false);
    }
  };

  const startOver = () => { setTwoFactor(false); setUseRecovery(false); setCode(''); setPassword(''); setError(null); };
  const offerReset = error && ['invalid-credentials', 'account-locked'].includes(error.code);

  return (
    <div className="auth-shell">
      <main className="auth-card" style={{ maxWidth: 400 }}>
        <div className="auth-head">
          <div className="auth-mark"><Wordmark size={18} /></div>
          <h1 className="display">{twoFactor ? 'One more step' : 'Sign in'}</h1>
          <p>
            {twoFactor
              ? 'This account has two-step sign-in: your password, then a code.'
              : toCheckout
                ? 'Sign in to finish checkout. Your quote is saved and will be waiting.'
                : 'For your orders and saved quotes. You don\'t need an account to get a price.'}
          </p>
        </div>

        {notice && <Notice kind="ok">{notice}</Notice>}
        {!notice && sessionEnded && !error && (
          <Notice kind="info">
            You were signed out. Sessions end on their own after a while, and at once when the password changes.
            Sign in and you go straight back to where you were{toCheckout ? '; your quote and what you typed are saved' : ''}.
          </Notice>
        )}

        <form onSubmit={handleSubmit} aria-busy={loading || undefined}>
          {/* The email and password stay in the form (and in the password manager's view of it) during the code step; they are just not shown. */}
          <div hidden={twoFactor || undefined}>
            <div className="field">
              <label className="field-label" htmlFor="login-email">Email</label>
              <input
                id="login-email"
                type="email"
                inputMode="email"
                className="input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required
              />
            </div>

            <PasswordField id="login-password" label="Password" value={password} onChange={setPassword} autoComplete="current-password" style={{ marginBottom: 8 }} />

            <div className="auth-aside">
              <Link to="/forgot-password">Forgot your password?</Link>
            </div>
          </div>

          {twoFactor && (
            <>
              <p className="auth-who">Signing in as <b>{email}</b>. <button type="button" className="linklike-inline" onClick={startOver}>Use a different account</button></p>
              <CodeField
                id="login-code"
                label={useRecovery ? 'Recovery code' : 'Code from your authenticator app'}
                value={code}
                onChange={setCode}
                recovery={useRecovery}
                autoFocus
                key={useRecovery ? 'recovery' : 'totp'}
                help={(
                  <>
                    {useRecovery
                      ? 'One of the ten codes you saved when you set up two-step sign-in. Each works once.'
                      : 'Open the authenticator app on your phone and enter the 6-digit code it shows now for Straightedge.'}{' '}
                    <button type="button" className="linklike-inline" onClick={() => { setUseRecovery((v) => !v); setCode(''); setError(null); }}>
                      {useRecovery ? 'Use the authenticator app instead' : 'No phone? Use a recovery code'}
                    </button>
                  </>
                )}
              />
            </>
          )}

          {needCheck && (
            <div style={{ marginBottom: 16 }}>
              <HumanCheck key={checkRound} action="login" onToken={setCheckToken} onState={setCheckState} />
            </div>
          )}

          {info && <Notice kind="info" style={{ marginBottom: 16 }}>{info}</Notice>}
          <FormError error={error?.message} at={errorAt}>
            {offerReset && (
              <>
                {error.until && <span>The pause ends at about {error.until}.</span>}
                <Link to="/forgot-password" className="btn btn-outline">Choose a new password</Link>
              </>
            )}
          </FormError>

          <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="auth-foot">
          No account yet?{' '}
          <Link to={authPath('/register', nextFrom(location))}>Create one</Link>
          <br />
          <Link to="/quote" className="quiet">Back to the quote</Link>
          <br />
          Locked out or stuck? <a href={brand.phoneHref}>{brand.phone}</a>
        </div>
      </main>
    </div>
  );
}
