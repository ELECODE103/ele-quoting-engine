import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../utils/api';
import { useAuth } from '../utils/authContext';
import Wordmark from '../components/Wordmark';
import Notice from '../components/form/Notice';
import brand from '../brand';
import { describeNotice } from '../utils/messages';
import { tokenFromHash } from '../utils/linkToken';
import { storedQuoteId, pendingCheckout, authPath } from '../utils/returnTo';

/**
 * Confirm an email address from the emailed link (/verify-email#token=…).
 *
 * If this browser is signed in, opening the link confirms at once. If it is
 * not (the link was opened on another device, or by a mail scanner that
 * follows links), nothing happens until a person presses the button: a link
 * that confirms itself when fetched would let a mail filter confirm an address
 * its owner never looked at.
 *
 * Once confirmed, the next step is one press away: the checkout this browser
 * was heading for (utils/returnTo.pendingCheckout, which a new tab can read),
 * or, on a device that never had the quote, where the quote is waiting.
 */
export default function VerifyEmailPage() {
  const location = useLocation();
  const { isAuthenticated, isLoading, refresh, user } = useAuth();
  const [token] = useState(() => tokenFromHash(location.hash));
  const [status, setStatus] = useState('idle'); // idle | working | done | invalid
  const [email, setEmail] = useState('');
  const [resent, setResent] = useState(null); // { ok, text }
  const [resending, setResending] = useState(false);
  const result = useRef(null);

  useEffect(() => { document.title = `Confirm your email · ${brand.name}`; }, []);
  useEffect(() => {
    if (token) window.history.replaceState(null, '', location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  useEffect(() => { if ((status === 'done' || status === 'invalid') && result.current) result.current.focus(); }, [status]);

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
    if (resending) return;
    setResent(null);
    setResending(true);
    try {
      const r = await api.resendVerification();
      setResent(r.verified
        ? { ok: true, text: 'This address is already confirmed. There is nothing more to do.' }
        : r.queued
          ? { ok: true, text: describeNotice('verification-queued') }
          : r.sent === false
            ? { ok: false, text: `We couldn't send it just now. Try again in a minute, or call ${brand.phone}.` }
            : { ok: true, text: `A new link is on its way to ${user?.email || 'your address'}. Use the newest email: older links stop working.` });
    } catch (err) {
      setResent({ ok: false, text: err.message });
    }
    setResending(false);
  }

  const quoteId = storedQuoteId();
  const checkout = pendingCheckout() || (quoteId ? `/checkout/${quoteId}` : '');
  const admin = user?.role === 'admin';
  return (
    <div className="auth-shell">
      <main className="auth-card">
        <div className="auth-head">
          <div className="auth-mark"><Wordmark size={18} /></div>
          <h1 className="display">Confirm your email</h1>
        </div>

        {!token && (
          <Notice kind="info">
            This page opens from the link in the email we sent when the account was created. Open that email and press "Confirm my email".
            {isAuthenticated && !user?.emailVerified ? ' Can\'t find it? Send a new one below.' : ''}
          </Notice>
        )}
        {!token && isAuthenticated && !user?.emailVerified && (
          <button type="button" className="btn btn-primary btn-lg btn-block" onClick={resend} disabled={resending}>{resending ? 'Sending…' : 'Send me a new link'}</button>
        )}

        {token && status === 'idle' && !isLoading && !isAuthenticated && (
          <div>
            <p className="auth-lede">
              One press confirms the address on your {brand.name} account. After that the account can check out.
            </p>
            <button type="button" className="btn btn-primary btn-lg btn-block" onClick={confirm}>
              Confirm my email
            </button>
            <p className="auth-note" style={{ marginTop: 12 }}>
              We ask for the press because this browser isn't signed in to the account. Mail filters open links on their own, and a link that confirmed itself would let one do it for you.
            </p>
          </div>
        )}

        {(status === 'working' || (token && status === 'idle' && (isLoading || isAuthenticated))) && (
          <p role="status" className="auth-wait">Confirming…</p>
        )}

        {status === 'done' && (
          <div>
            <Notice kind="ok" ref={result} tabIndex={-1}>
              {email ? <><b>{email}</b> is confirmed.</> : 'Your email is confirmed.'} {admin ? 'The account is ready.' : 'Your account can check out now.'}
            </Notice>
            {isAuthenticated ? (
              <>
                {!admin && (
                  <p className="auth-note">
                    {checkout
                      ? 'Your quote is where you left it. If the checkout page is still open in another tab, it has already unlocked: either one works.'
                      : 'If a checkout page is open in another tab, it has already unlocked.'}
                  </p>
                )}
                <div className="auth-actions">
                  {admin && <Link to="/admin" className="btn btn-primary btn-lg">Open the admin area</Link>}
                  {!admin && checkout && <Link to={checkout} className="btn btn-primary btn-lg">Go to checkout</Link>}
                  {!admin && <Link to="/quote" className={checkout ? 'btn btn-ghost' : 'btn btn-primary btn-lg'}>{checkout ? 'Back to your quote' : 'Price a part'}</Link>}
                </div>
              </>
            ) : (
              <>
                <p className="auth-note">
                  If you built your quote on another device, go back to it: its checkout page has already unlocked, with your parts and your details as you left them.
                  To carry on here instead, sign in.
                </p>
                <div className="auth-actions">
                  <Link to={authPath('/login', checkout)} className="btn btn-primary btn-lg">Sign in on this device</Link>
                </div>
              </>
            )}
          </div>
        )}

        {status === 'invalid' && (
          <div>
            <Notice kind="error" ref={result} tabIndex={-1}>
              This confirmation link has been used, has been replaced by a newer one, or is more than 24 hours old.
              If you already confirmed, there is nothing more to do.
            </Notice>
            {isAuthenticated && user?.emailVerified && (
              <div className="auth-actions">
                {checkout && <Link to={checkout} className="btn btn-primary btn-lg">Go to checkout</Link>}
                <Link to="/quote" className={checkout ? 'btn btn-ghost' : 'btn btn-primary btn-lg'}>Back to your quote</Link>
              </div>
            )}
            {isAuthenticated && !user?.emailVerified && (
              <button type="button" className="btn btn-primary btn-lg btn-block" onClick={resend} disabled={resending}>{resending ? 'Sending…' : 'Send me a new link'}</button>
            )}
            {!isAuthenticated && !isLoading && (
              <Link to={authPath('/login', checkout)} className="btn btn-primary btn-lg btn-block">Sign in to check, or to get a new link</Link>
            )}
          </div>
        )}
        {resent && <Notice kind={resent.ok ? 'ok' : 'error'} style={{ marginTop: 12 }}>{resent.text}</Notice>}

        <div className="auth-foot">
          Wrong address on the account, or no email at all? <a href={brand.phoneHref}>{brand.phone}</a>
        </div>
      </main>
    </div>
  );
}
