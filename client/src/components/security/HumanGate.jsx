import { useCallback, useEffect, useRef, useState } from 'react';
import HumanCheck from './HumanCheck';
import { api } from '../../utils/api';
import { registerChallengeUi, setHumanToken, CHECK_BLOCKED_MESSAGE } from '../../utils/security';
import brand from '../../brand';

/**
 * The quote tool's one-time bot check.
 *
 * Mounted once on the quote page. It shows nothing until an upload or a price
 * request needs a verified-human token (utils/security.ensureHuman); then it
 * opens a small dialog with the check, trades the result for a one-hour token
 * and gets out of the way. A signed-in account with a confirmed email never
 * sees it. Cloudflare's script loads only when the dialog opens.
 */
export default function HumanGate() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [state, setState] = useState('idle');
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

  useEffect(() => { if (open && dialog.current) dialog.current.focus(); }, [open]);

  // Leaving the page with the dialog open: whoever was waiting is told.
  useEffect(() => () => { if (waiting.current) waiting.current.reject(new Error('The spam check was closed before it finished.')); }, []);

  const onToken = useCallback(async (token) => {
    if (!token) return;
    try {
      const r = await api.verifyHuman(token);
      setHumanToken(r.humanToken || '', r.expiresIn || 0);
      finish();
    } catch (err) {
      setError(err.message || `We couldn't confirm the check. Try again, or call ${brand.phone}.`);
    }
  }, [finish]);

  if (!open) return null;
  const cancel = () => finish(new Error('The spam check was closed before it finished. Try the upload again when you are ready.'));
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
        onKeyDown={(e) => { if (e.key === 'Escape') cancel(); }}
      >
        <h2 id="human-gate-title" className="display" style={{ fontSize: 20, marginBottom: 8 }}>One quick check</h2>
        <p id="human-gate-text" style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          Before we read your file we check that a person is asking. It usually finishes by itself, and you will not be asked again for an hour.
        </p>
        <HumanCheck action="quote" onToken={onToken} onState={setState} />
        {error && <p className="human-check-problem" role="alert">{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {state === 'blocked' ? '' : <>Signed in with a confirmed email? You skip this.</>}
          </span>
          <button type="button" className="btn btn-ghost" onClick={() => (state === 'blocked' ? finish(new Error(CHECK_BLOCKED_MESSAGE)) : cancel())}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
