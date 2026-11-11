import { useEffect, useState } from 'react';
import { api } from '../../utils/api';
import { useAuth } from '../../utils/authContext';
import brand from '../../brand';

/**
 * Shown where an unconfirmed email address stops something: checkout, and the
 * confirmation of a request. Says what is needed and why, offers to send the
 * link again, and notices by itself when the address has been confirmed in
 * another tab (it asks the server every few seconds while it is on screen).
 *
 * Renders nothing when the account is confirmed, when nobody is signed in, or
 * when the server cannot send confirmation links at all (no mailer).
 */
export default function VerifyEmailNotice({ reason = 'before you pay', style }) {
  const { user, refresh, verificationEnforced } = useAuth();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const needed = Boolean(user && !user.emailVerified && verificationEnforced);

  useEffect(() => {
    if (!needed) return undefined;
    const timer = setInterval(() => { if (!document.hidden) refresh(); }, 5000);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [needed, refresh]);

  if (!needed) return null;

  async function resend() {
    setBusy(true);
    setNote('');
    try {
      const r = await api.resendVerification();
      if (r.verified) { await refresh(); return; }
      setNote(r.sent ? `Sent again to ${user.email}. Use the newest email; check the spam folder too.` : `We couldn't send it just now. Try again in a minute, or call ${brand.phone}.`);
    } catch (err) {
      setNote(err.message || `We couldn't send it. Call ${brand.phone}.`);
    }
    setBusy(false);
  }

  return (
    <div className="verify-box" role="region" aria-label="Confirm your email address" style={style}>
      <b>Confirm your email {reason}.</b>{' '}
      We sent a link to <b>{user.email}</b> when you created the account. Open it, and this page carries on by itself.
      Your order confirmation and shipping notice go to that address, so we check it reaches you first.
      <div className="cta-row">
        <button type="button" className="btn btn-outline" onClick={resend} disabled={busy}>{busy ? 'Sending…' : 'Send the link again'}</button>
        <button type="button" className="btn btn-ghost" onClick={() => refresh()}>I've confirmed it</button>
        <span style={{ fontSize: 12 }}>Wrong address, or no email? Call <a href={brand.phoneHref} style={{ color: 'inherit' }}>{brand.phone}</a>.</span>
      </div>
      {note && <p role="status" style={{ marginTop: 8 }}>{note}</p>}
    </div>
  );
}
