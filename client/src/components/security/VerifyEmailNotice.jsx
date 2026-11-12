import { useEffect, useRef, useState } from 'react';
import { api } from '../../utils/api';
import { useAuth } from '../../utils/authContext';
import brand from '../../brand';
import { describeNotice } from '../../utils/messages';

const WAIT_SECONDS = 60; // the server sends one link a minute at most

/**
 * Shown where an unconfirmed email address stops something: checkout, and the
 * confirmation of a request. Says what is needed and why, at the moment it
 * matters; offers to send the link again (and counts down the minute the
 * server makes everyone wait, instead of letting the press be refused); and
 * notices by itself when the address has been confirmed in another tab or on
 * another device (it asks the server every 15 seconds while it is on screen,
 * and when the tab is brought back to the front).
 *
 * Renders nothing when the account is confirmed, when nobody is signed in, or
 * when the server cannot send confirmation links at all (no mailer).
 */
export default function VerifyEmailNotice({ reason = 'before you pay', why = 'Your order confirmation and shipping notice go to that address, so we make sure it reaches you before any money moves.', style }) {
  const { user, refresh, verificationEnforced } = useAuth();
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState(null); // { ok, text }
  const [wait, setWait] = useState(0);
  const timer = useRef(null);
  const needed = Boolean(user && !user.emailVerified && verificationEnforced);

  useEffect(() => {
    if (!needed) return undefined;
    // Every 15 seconds for the first ten minutes (well inside the API's per-visitor
    // request limit), and whenever the tab gets the focus back.
    let polls = 0;
    const poll = setInterval(() => { if (!document.hidden && polls++ < 40) refresh(); }, 15000);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(poll); window.removeEventListener('focus', onFocus); };
  }, [needed, refresh]);

  useEffect(() => () => clearInterval(timer.current), []);
  function startWait(seconds) {
    clearInterval(timer.current);
    setWait(seconds);
    timer.current = setInterval(() => setWait((s) => { if (s <= 1) { clearInterval(timer.current); return 0; } return s - 1; }), 1000);
  }

  if (!needed) return null;

  async function resend() {
    if (busy || wait > 0) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await api.resendVerification();
      if (r.verified) { await refresh(); return; }
      if (r.sent) { setNote({ ok: true, text: `Sent again to ${user.email}. Use the newest email (older links stop working), and check the spam folder too.` }); startWait(WAIT_SECONDS); }
      // queued: the site is over the hour's line for confirmation emails, so this one is held and sent within the hour
      else if (r.queued) { setNote({ ok: true, text: describeNotice('verification-queued') }); startWait(WAIT_SECONDS); }
      else setNote({ ok: false, text: `We couldn't send it just now. Try again in a minute, or call ${brand.phone}.` });
    } catch (err) {
      setNote({ ok: false, text: err.message });
      if (err.status === 429) startWait(WAIT_SECONDS);
    }
    setBusy(false);
  }

  async function check() {
    setChecking(true);
    const account = await refresh();
    setChecking(false);
    if (account && !account.emailVerified) setNote({ ok: false, text: `Not confirmed yet. Open the email we sent to ${user.email} and press "Confirm my email"; this page carries on by itself when you have.` });
  }

  return (
    <div className="verify-box" role="region" aria-label="Confirm your email address" style={style}>
      <p>
        <b>One step {reason}: confirm your email.</b>{' '}
        We sent a link to <b>{user.email}</b> when you created the account. Open it on any device and this page carries on by itself; nothing you have entered here is lost.
        {' '}{why}
      </p>
      <div className="cta-row">
        <button type="button" className="btn btn-outline" onClick={resend} disabled={busy || wait > 0}>
          {busy ? 'Sending…' : wait > 0 ? `Send again in ${wait} s` : 'Send the link again'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={check} disabled={checking}>{checking ? 'Checking…' : 'I\'ve confirmed it'}</button>
      </div>
      <p className="verify-help">Wrong address, or no email after a few minutes? Call <a href={brand.phoneHref}>{brand.phone}</a> and we'll put it right.</p>
      <p role="status" aria-live="polite" className={note ? (note.ok ? 'verify-note ok' : 'verify-note') : 'sr-only'}>{note ? note.text : ''}</p>
    </div>
  );
}
