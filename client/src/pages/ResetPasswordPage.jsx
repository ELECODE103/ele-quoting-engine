import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import { useAuth } from '../utils/authContext';
import Wordmark from '../components/Wordmark';
import brand from '../brand';
import { PASSWORD_HINT } from './RegisterPage';
import { tokenFromHash } from '../utils/linkToken';

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
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { document.title = `Choose a new password · ${brand.name}`; }, []);

  useEffect(() => {
    if (!token) { setStatus('invalid'); return; }
    // Keep the token out of the address bar and the history entry.
    window.history.replaceState(null, '', location.pathname);
    api.checkPasswordReset(token).then((r) => setStatus(r.valid ? 'ready' : 'invalid')).catch(() => setStatus('invalid'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (password !== again) return setError('The two passwords are not the same. Type the new password again.');
    setBusy(true);
    try {
      await api.confirmPasswordReset(token, password);
      await refresh(); // any session in this browser was just ended
      setStatus('done');
    } catch (err) {
      if (err.code === 'link-invalid') setStatus('invalid');
      else setError(err.message || `It didn't save. Try again, or call ${brand.phone}.`);
    }
    setBusy(false);
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-head">
          <div style={{ marginBottom: 24 }}><Wordmark size={18} /></div>
          <h1 className="display" style={{ fontSize: 28, marginBottom: 8 }}>Choose a new password</h1>
        </div>

        {status === 'checking' && <p role="status" style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Checking the link…</p>}

        {status === 'invalid' && (
          <div>
            <div className="auth-error" role="alert">
              This reset link has been used, has been replaced by a newer one, or is more than an hour old.
            </div>
            <Link to="/forgot-password" className="btn btn-primary btn-lg" style={{ width: '100%', justifyContent: 'center' }}>Send a new link</Link>
          </div>
        )}

        {status === 'ready' && (
          <form onSubmit={submit}>
            <div style={{ marginBottom: 16 }}>
              <label className="field-label" htmlFor="reset-password">New password</label>
              <input id="reset-password" type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={10} maxLength={72} required aria-describedby="reset-help" autoFocus />
              <div id="reset-help" style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>{PASSWORD_HINT}</div>
            </div>
            <div style={{ marginBottom: 20 }}>
              <label className="field-label" htmlFor="reset-again">New password, again</label>
              <input id="reset-again" type="password" className="input" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required />
            </div>
            {error && <div role="alert" className="auth-error">{error}</div>}
            <button type="submit" className="btn btn-primary btn-lg" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>
              {busy ? 'Saving…' : 'Save the new password'}
            </button>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, marginTop: 12 }}>
              Saving signs the account out on every device. You sign in again with the new password.
            </p>
          </form>
        )}

        {status === 'done' && (
          <div>
            <div className="auth-ok" role="status">
              Your password is changed, and every device that was signed in has been signed out. We sent an email to say so.
            </div>
            <button type="button" className="btn btn-primary btn-lg" style={{ width: '100%', justifyContent: 'center' }} onClick={() => navigate('/login')}>
              Sign in with the new password
            </button>
          </div>
        )}

        <div className="auth-foot">
          <Link to="/login">Back to sign in</Link>
        </div>
      </div>
    </div>
  );
}
