import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../utils/api';
import Wordmark from '../components/Wordmark';
import Notice, { FormError } from '../components/form/Notice';
import brand from '../brand';
import useFormGuard from '../utils/useFormGuard';

/**
 * Ask for a password-reset link. The answer is the same whether or not the
 * address has an account, so this page cannot be used to find out who does;
 * the page says so in plain words, so a buyer who typed the wrong address
 * knows why nothing arrived.
 */
export default function ForgotPasswordPage() {
  const guard = useFormGuard('password-reset');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [errorAt, setErrorAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState('');
  const done = useRef(null);

  useEffect(() => { document.title = `Reset your password · ${brand.name}`; }, []);
  useEffect(() => { if (sentTo && done.current) done.current.focus(); }, [sentTo]);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      await guard.submit((headers, extra) => api.requestPasswordReset({ email, ...extra }, headers));
      setSentTo(email);
    } catch (err) {
      setError(err.message);
      setErrorAt((n) => n + 1);
    }
    setBusy(false);
  }

  return (
    <div className="auth-shell">
      <main className="auth-card">
        <div className="auth-head">
          <div className="auth-mark"><Wordmark size={18} /></div>
          <h1 className="display">Reset your password</h1>
          {!sentTo && <p>Enter the email on your account. We send a link to choose a new password. It also lifts a sign-in pause.</p>}
        </div>

        {sentTo ? (
          <div>
            <Notice kind="ok" ref={done} tabIndex={-1}>
              If <b>{sentTo}</b> has an account, a link to choose a new password is on its way. It works once and for one hour.
            </Notice>
            <p className="auth-note">
              Nothing in a few minutes? Check the spam folder, and check the address above for a typo: for the account's safety this page says the same
              thing whether or not the address has an account. We send at most three links an hour to one address.
            </p>
            <p className="auth-note">
              <button type="button" className="linklike-inline" onClick={() => { setSentTo(''); setError(''); }}>Try a different address</button>
              {' '}or call <a href={brand.phoneHref}>{brand.phone}</a> and we'll sort it out.
            </p>
          </div>
        ) : (
          <form onSubmit={submit} aria-busy={busy || undefined}>
            {guard.honeypot}
            <div className="field">
              <label className="field-label" htmlFor="forgot-email">Email</label>
              <input id="forgot-email" type="email" inputMode="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
            </div>
            <div style={{ marginBottom: 16 }}>{guard.widget}</div>
            <FormError error={error} at={errorAt} />
            <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>
              {busy ? 'Sending…' : 'Send the reset link'}
            </button>
          </form>
        )}

        <div className="auth-foot">
          <Link to="/login">Back to sign in</Link>
        </div>
      </main>
    </div>
  );
}
