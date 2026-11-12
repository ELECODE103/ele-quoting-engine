import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import { useAuth } from '../utils/authContext';
import Wordmark from '../components/Wordmark';
import Notice, { FormError } from '../components/form/Notice';
import PasswordField, { passwordProblem } from '../components/form/PasswordField';
import brand from '../brand';
import { tokenFromHash } from '../utils/linkToken';
import { authPath, pendingCheckout } from '../utils/returnTo';

/**
 * Choose a new password from an emailed link (/reset-password#token=…).
 * The token rides in the URL fragment, which browsers do not send to servers
 * or put in a Referer header, and is taken out of the address bar on arrival.
 */
export default function ResetPasswordPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [token] = useState(() => tokenFromHash(location.hash));
  const [status, setStatus] = useState('checking'); // checking | ready | invalid | done
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState(null); // { message, field }
  const [errorAt, setErrorAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const done = useRef(null);

  useEffect(() => { document.title = `Choose a new password · ${brand.name}`; }, []);

  useEffect(() => {
    if (!token) { setStatus('invalid'); return; }
    // Keep the token out of the address bar and the history entry.
    window.history.replaceState(null, '', location.pathname);
    api.checkPasswordReset(token).then((r) => setStatus(r.valid ? 'ready' : 'invalid')).catch(() => setStatus('invalid'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  useEffect(() => { if (status === 'done' && done.current) done.current.focus(); }, [status]);

  const fail = (message, field = '') => { setError({ message, field }); setErrorAt((n) => n + 1); };

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const problem = passwordProblem(password);
    if (problem) return fail(problem, 'password');
    if (password !== again) return fail('The two boxes don\'t hold the same password. Press "Show password" to compare them, then correct one.', 'again');
    setBusy(true);
    try {
      await api.confirmPasswordReset(token, password);
      await refresh(); // any session in this browser was just ended
      setStatus('done');
    } catch (err) {
      if (err.code === 'link-invalid') setStatus('invalid');
      else fail(err.message, err.code === 'weak-password' ? 'password' : '');
    }
    setBusy(false);
  }

  const checkout = pendingCheckout();
  return (
    <div className="auth-shell">
      <main className="auth-card">
        <div className="auth-head">
          <div className="auth-mark"><Wordmark size={18} /></div>
          <h1 className="display">Choose a new password</h1>
        </div>

        {status === 'checking' && <p role="status" className="auth-wait">Checking the link…</p>}

        {status === 'invalid' && (
          <div>
            <Notice kind="error">
              This reset link has been used, has been replaced by a newer one, or is more than an hour old. Links work once, so nobody who finds an old email can use it.
            </Notice>
            <Link to="/forgot-password" className="btn btn-primary btn-lg btn-block">Send a new link</Link>
          </div>
        )}

        {status === 'ready' && (
          <form onSubmit={submit} aria-busy={busy || undefined}>
            <PasswordField
              id="reset-password"
              label="New password"
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              rules
              autoFocus
              invalid={error?.field === 'password'}
              describedBy={error?.field === 'password' ? 'reset-error' : ''}
            />
            <PasswordField
              id="reset-again"
              label="New password, again"
              value={again}
              onChange={setAgain}
              autoComplete="new-password"
              invalid={error?.field === 'again'}
              describedBy={error?.field === 'again' ? 'reset-error' : ''}
              style={{ marginBottom: 20 }}
            />
            <FormError id="reset-error" error={error?.message} at={errorAt} />
            <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>
              {busy ? 'Saving…' : 'Save the new password'}
            </button>
            <p className="auth-note" style={{ marginTop: 12 }}>
              Saving signs the account out on every device, so anyone who had the old password is out too. You then sign in with the new one.
            </p>
          </form>
        )}

        {status === 'done' && (
          <div>
            <Notice kind="ok" ref={done} tabIndex={-1}>
              Your password is changed, and every device that was signed in has been signed out. We sent an email to say so.
            </Notice>
            <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => navigate(authPath('/login', checkout || ''))}>
              Sign in with the new password
            </button>
            {checkout && <p className="auth-note" style={{ marginTop: 12 }}>Your quote is saved: after signing in you go straight back to checkout.</p>}
          </div>
        )}

        <div className="auth-foot">
          <Link to="/login">Back to sign in</Link>
          <br />
          Stuck? <a href={brand.phoneHref}>{brand.phone}</a>
        </div>
      </main>
    </div>
  );
}
