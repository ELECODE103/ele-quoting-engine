import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { publicConfig, loadTurnstile, CHECK_BLOCKED_MESSAGE } from '../../utils/security';

/**
 * The Cloudflare Turnstile widget, for one form.
 *
 * Renders an empty box on the server and on the first client render (so
 * prerendered pages hydrate cleanly), then, in an effect: asks the server
 * whether the check is on, loads Cloudflare's script only if it is, and draws
 * the widget. Pages that never mount this component never load the script.
 *
 *   onToken(token)   a fresh token ("" when it expires or is reset)
 *   onState(state)   "off"      the check is not configured: nothing is shown
 *                    "loading"  script on its way
 *                    "ready"    widget showing, not solved yet
 *                    "solved"   a token is in hand
 *                    "error"    the widget reported a problem (retry offered)
 *                    "blocked"  the script could not load (message + phone)
 *   ref.reset()      get a new token (a token can be spent once)
 *
 * The widget is Cloudflare's own accessible control inside an iframe; what
 * this component adds is a labelled group and a live region that says what
 * is happening in words.
 */
const HumanCheck = forwardRef(function HumanCheck({ action, onToken, onState, label = 'Spam check' }, ref) {
  const box = useRef(null);
  const widgetId = useRef(null);
  const callbacks = useRef({ onToken, onState });
  callbacks.current = { onToken, onState };
  const [state, setStateRaw] = useState('idle');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let dead = false;
    const setState = (s) => { if (dead) return; setStateRaw(s); callbacks.current.onState?.(s); };
    const give = (t) => { if (!dead) callbacks.current.onToken?.(t || ''); };

    publicConfig().then((cfg) => {
      if (dead) return undefined;
      if (!cfg.botCheck || !cfg.turnstileSiteKey) { setState('off'); return undefined; }
      setState('loading');
      return loadTurnstile().then((ts) => {
        if (dead || !box.current) return;
        widgetId.current = ts.render(box.current, {
          sitekey: cfg.turnstileSiteKey,
          action,
          theme: 'light',
          size: 'flexible',
          callback: (token) => { give(token); setState('solved'); },
          'expired-callback': () => { give(''); setState('ready'); },
          'timeout-callback': () => { give(''); setState('ready'); },
          'error-callback': () => { give(''); setState('error'); return true; },
        });
        setState('ready');
      });
    }).catch(() => { give(''); setState('blocked'); });

    return () => {
      dead = true;
      if (widgetId.current !== null && window.turnstile) {
        try { window.turnstile.remove(widgetId.current); } catch { /* already gone */ }
      }
      widgetId.current = null;
    };
    // `attempt` re-runs the whole thing for "Try again".
  }, [action, attempt]);

  useImperativeHandle(ref, () => ({
    reset() {
      callbacks.current.onToken?.('');
      if (widgetId.current !== null && window.turnstile) {
        try { window.turnstile.reset(widgetId.current); setStateRaw('ready'); callbacks.current.onState?.('ready'); } catch { /* widget gone */ }
      }
    },
  }), []);

  const hidden = state === 'idle' || state === 'off';
  return (
    <div className="human-check" data-state={state} role="group" aria-label={label} hidden={hidden || undefined}>
      <div ref={box} className="human-check-box" />
      <p className="human-check-note" role="status" aria-live="polite">
        {state === 'loading' && 'Loading the spam check…'}
        {state === 'ready' && 'One quick check that you are a person. It usually finishes by itself.'}
        {state === 'solved' && 'Check passed.'}
      </p>
      {state === 'error' && (
        <p className="human-check-problem" role="alert">
          The spam check hit a problem.{' '}
          <button type="button" className="linklike-inline" onClick={() => setAttempt((n) => n + 1)}>Try it again</button>
        </p>
      )}
      {state === 'blocked' && (
        <p className="human-check-problem" role="alert">
          {CHECK_BLOCKED_MESSAGE}{' '}
          <button type="button" className="linklike-inline" onClick={() => setAttempt((n) => n + 1)}>Try it again</button>
        </p>
      )}
    </div>
  );
});

export default HumanCheck;
