import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../utils/api';
import { useAuth } from '../utils/authContext';
import Wordmark from '../components/Wordmark';
import brand from '../brand';
import { tokenFromHash } from '../utils/linkToken';
import { storedQuoteId } from '../utils/returnTo';

/**
 * Confirm an email address from the emailed link (/verify-email#token=…).
 *
 * If this browser is signed in, opening the link confirms at once. If it is
 * not (the link was opened on another device, or by a mail scanner that
 * follows links), nothing happens until a person presses the button: a link
 * that confirms itself when fetched would let a mail filter confirm an address
 * its owner never looked at.
 */
export default function VerifyEmailPage() {
  const location = useLocation();
  const { isAuthenticated, isLoading, refresh, user } = useAuth();
  const [token] = useState(() => tokenFromHash(location.hash));
  const [status, setStatus] = useState('idle'); // idle | working | done | invalid
  const [email, setEmail] = useState('');
  const [resent, setResent] = useState('');

  useEffect(() => { document.title = `Confirm your email · ${brand.name}`; }, []);
  useEffect(() => {
    if (token) window.history.replaceState(null, '', location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function confirm() {
    setStatus('working');
    try {
      const r = await api.verifyEmail(token);
      setEmail(r.email || '');
      await refresh();
      setStatus('done');
    } catch {
      setStatus('invalid');
    }
  }

  // Signed in here: no extra click.
  useEffect(() => {
    if (!isLoading && isAuthenticated && token && status === 'idle') confirm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, isAuthenticated]);

  async function resend() {
    setResent('');
    try {
      const r = await api.resendVerification();
      setResent(r.verified ? 'This address is already confirmed.' : 'A new link is on its way. Use the newest email.');
    } catch (err) {
      setResent(err.message || `We couldn't send it. Call ${brand.phone}.`);
    }
  }

  const quoteId = storedQuoteId();
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-head">
          <div style={{ marginBottom: 24 }}><Wordmark size={18} /></div>
          <h1 className="display" style={{ fontSize: 28, marginBottom: 8 }}>Confirm your email</h1>
        </div>

        {!token && (
          <div className="auth-error" role="alert">
            This page opens from the link in the confirmation email. Open that email and use the button in it.
          </div>
        )}

        {token && status === 'idle' && !isLoading && !isAuthenticated && (
          <div>
            <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 16, textAlign: 'center' }}>
              One press confirms the address on your {brand.name} account. After that the account can check out.
            </p>
            <button type="button" className="btn btn-primary btn-lg" style={{ width: '100%', justifyContent: 'center' }} onClick={confirm}>
              Confirm my email
            </button>
          </div>
        )}

        {(status === 'working' || (token && status === 'idle' && (isLoading || isAuthenticated))) && (
          <p role="status" style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Confirming…</p>
        )}

        {status === 'done' && (
          <div>
            <div className="auth-ok" role="status">
              {email ? <><b>{email}</b> is confirmed.</> : 'Your email is confirmed.'} Your account can check out now.
            </div>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 16 }}>
              If the checkout page is still open in another tab, go back to it: it has already noticed.
            </p>
            <div style={{ display: 'grid', gap: 8 }}>
              {isAuthenticated && quoteId && <Link to={`/checkout/${quoteId}`} className="btn btn-primary btn-lg" style={{ justifyContent: 'center' }}>Go to checkout</Link>}
              {isAuthenticated
                ? <Link to={user?.role === 'admin' ? '/admin' : '/quote'} className={`btn ${quoteId ? 'btn-ghost' : 'btn-primary btn-lg'}`} style={{ justifyContent: 'center' }}>{user?.role === 'admin' ? 'Open the admin area' : 'Back to your quote'}</Link>
                : <Link to="/login" className="btn btn-primary btn-lg" style={{ justifyContent: 'center' }}>Sign in</Link>}
            </div>
          </div>
        )}

        {status === 'invalid' && (
          <div>
            <div className="auth-error" role="alert">
              This confirmation link has been used, has been replaced, or is more than 24 hours old.
            </div>
            {isAuthenticated ? (
              <button type="button" className="btn btn-primary btn-lg" style={{ width: '100%', justifyContent: 'center' }} onClick={resend}>Send me a new link</button>
            ) : (
              <Link to="/login" className="btn btn-primary btn-lg" style={{ width: '100%', justifyContent: 'center' }}>Sign in to get a new link</Link>
            )}
            {resent && <p role="status" style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 12 }}>{resent}</p>}
          </div>
        )}

        <div className="auth-foot">
          Questions? <a href={brand.phoneHref}>{brand.phone}</a>
        </div>
      </div>
    </div>
  );
}
