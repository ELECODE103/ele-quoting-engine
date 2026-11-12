import { useCallback, useEffect, useRef, useState } from 'react';
import HumanCheck from './HumanCheck';
import { api } from '../../utils/api';
import { registerChallengeUi, setHumanToken, CHECK_BLOCKED_MESSAGE, CHECK_CLOSED } from '../../utils/security';
import brand from '../../brand';

/**
 * The quote tool's one-time spam check.
 *
 * Mounted once on the quote page. It shows nothing until an upload or a price
 * request needs a verified-human token (utils/security.ensureHuman); then it
 * opens a small dialog with the check, trades the result for a one-hour token
 * and gets out of the way. A signed-in account with a confirmed email never
 * sees it. Cloudflare's script loads only when the dialog opens.
 *
 * As a dialog: it takes the focus when it opens and gives it back when it
 * closes, Tab stays inside it, Escape closes it, and the page behind does not
 * scroll while it is up.
 */
export default function HumanGate() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [state, setState] = useState('idle');
  const [round, setRound] = useState(0);
  const waiting = useRef(null); // { resolve, reject }
  const dialog = useRef(null);
  const lastFocus = useRef(null);

  const finish = useCallback((err) => {
    const w = waiting.current;
    waiting.current = null;
    setOpen(false);
    setError('');
    if (lastFocus.current && lastFocus.current.focus) lastFocus.current.focus();
    if (w) { if (err) w.reject(err); else w.resolve(); }
  }, []);

  useEffect(() => registerChallengeUi(() => new Promise((resolve, reject) => {
    waiting.current = { resolve, reject };
    lastFocus.current = document.activeElement;
    setState('idle');
    setOpen(true);
  })), []);

  useEffect(() => {
    if (!open) return undefined;
    if (dialog.current) dialog.current.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = overflow; };
  }, [open]);

  // Leaving the page with the dialog open: whoever was waiting is told.
  useEffect(() => () => { if (waiting.current) waiting.current.reject(new Error(CHECK_CLOSED)); }, []);

  const onToken = useCallback(async (token) => {
    if (!token) return;
    try {
      const r = await api.verifyHuman(token);
      setHumanToken(r.humanToken || '', r.expiresIn || 0);
      finish();
    } catch (err) {
      setError(err.message);
    }
  }, [finish]);

  if (!open) return null;
  const cancel = () => finish(new Error(state === 'blocked' ? CHECK_BLOCKED_MESSAGE : CHECK_CLOSED));
  const again = () => { setError(''); setRound((n) => n + 1); };
  // Keep Tab inside the dialog.
  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); return; }
    if (e.key !== 'Tab' || !dialog.current) return;
    const stops = [...dialog.current.querySelectorAll('button, a[href], input, iframe, [tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null);
    if (stops.length === 0) { e.preventDefault(); return; }
    const first = stops[0]; const last = stops[stops.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  return (
    <div className="human-gate-backdrop">
      <div
        className="human-gate"
        role="dialog"
        aria-modal="true"
        aria-labelledby="human-gate-title"
        aria-describedby="human-gate-text"
        tabIndex={-1}
        ref={dialog}
        onKeyDown={onKeyDown}
      >
        <h2 id="human-gate-title" className="display" style={{ fontSize: 20, marginBottom: 8 }}>One quick check</h2>
        <p id="human-gate-text" className="human-gate-text">
          Before we read your file we check that a person is asking: it keeps automated uploads from tying up the quote tool.
          It usually finishes by itself, and you will not be asked again for an hour.
        </p>
        <HumanCheck key={round} action="quote" onToken={onToken} onState={setState} />
        {error && (
          <p className="human-check-problem" role="alert">
            {error}{' '}
            <button type="button" className="linklike-inline" onClick={again}>Run the check again</button>
          </p>
        )}
        <div className="human-gate-foot">
          <span>
            {state === 'blocked'
              ? <>Rather not? Email the file to <a href={`mailto:${brand.email}`}>{brand.email}</a>.</>
              : <>Signed in with a confirmed email? You skip this.</>}
          </span>
          <button type="button" className="btn btn-ghost" onClick={cancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
