import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../utils/api';
import Wordmark from '../components/Wordmark';
import brand from '../brand';
import useFormGuard from '../utils/useFormGuard';

/**
 * Ask for a password-reset link. The answer is the same whether or not the
 * address has an account, so this page cannot be used to find out who does.
 */
export default function ForgotPasswordPage() {
  const guard = useFormGuard('password-reset');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState('');

  useEffect(() => { document.title = `Reset your password · ${brand.name}`; }, []);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await guard.submit((headers, extra) => api.requestPasswordReset({ email, ...extra }, headers));
      setSentTo(email);
    } catch (err) {
      setError(err.message || `It didn't go through. Try again, or call ${brand.phone}.`);
    }
    setBusy(false);
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-head">
          <div style={{ marginBottom: 24 }}><Wordmark size={18} /></div>
          <h1 className="display" style={{ fontSize: 28, marginBottom: 8 }}>Reset your password</h1>
          <p>Enter the email on your account. We send a link to choose a new password.</p>
        </div>

        {sentTo ? (
          <div role="status">
            <div className="auth-ok">
              If <b>{sentTo}</b> has an account, a link to choose a new password is on its way. It works once and for one hour.
            </div>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              Nothing in a few minutes? Check the spam folder, and check the address for a typo. We send at most three links an hour to one address.
              Still stuck: call <a href={brand.phoneHref}>{brand.phone}</a>.
            </p>
          </div>
        ) : (
          <form onSubmit={submit}>
            {guard.honeypot}
            <div style={{ marginBottom: 16 }}>
              <label className="field-label" htmlFor="forgot-email">Email</label>
              <input id="forgot-email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
            </div>
            <div style={{ marginBottom: 16 }}>{guard.widget}</div>
            {error && <div role="alert" className="auth-error">{error}</div>}
            <button type="submit" className="btn btn-primary btn-lg" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>
              {busy ? 'Sending…' : 'Send the reset link'}
            </button>
          </form>
        )}

        <div className="auth-foot">
          <Link to="/login">Back to sign in</Link>
        </div>
      </div>
    </div>
  );
}
