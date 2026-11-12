import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import HumanCheck from '../components/security/HumanCheck';
import Honeypot from '../components/security/Honeypot';
import { CHECK_BLOCKED_SUBMIT, CHECK_NOT_DONE } from './security';

const RETRY_CODES = ['form-expired', 'form-reused', 'form-token-missing', 'too-fast'];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Everything a public form needs to get past the server's bot defences:
 *
 *   const guard = useFormGuard('rfq');
 *   …
 *   <form onSubmit={…}>
 *     {guard.honeypot}
 *     …fields…
 *     {guard.widget}
 *   </form>
 *   const res = await guard.submit((headers, extra) => api.submitRfq({ ...fields, ...extra }, file, headers));
 *
 * `guard.submit` waits out the minimum form time, adds the form token and the
 * Turnstile token as headers and the honeypot value as a field, retries once
 * with a fresh form token when the server says the form went stale, and asks
 * the widget for a new token afterwards (a token is good for one request).
 *
 * `enabled: false` leaves the Turnstile widget out (and its script unloaded)
 * until the page decides it is needed, e.g. sign-in after repeated failures.
 * The first render (server and client) is the same static markup either way.
 */
export default function useFormGuard(form, { enabled = true, action = form } = {}) {
  const [token, setToken] = useState('');
  const [checkState, setCheckState] = useState('idle');
  const [trap, setTrap] = useState('');
  const widgetRef = useRef(null);
  const formToken = useRef(null); // { value, readyAt }
  const tokenRef = useRef('');
  tokenRef.current = token;
  const stateRef = useRef('idle');
  stateRef.current = checkState;
  const trapRef = useRef('');
  trapRef.current = trap;

  const fetchFormToken = useCallback(async () => {
    const r = await api.getFormToken(form);
    formToken.current = { value: r.formToken, readyAt: Date.now() + (Number(r.minSeconds) || 3) * 1000 + 250 };
    return formToken.current;
  }, [form]);

  // The form token is asked for when the form is shown, so the clock starts then.
  useEffect(() => { fetchFormToken().catch(() => { formToken.current = null; }); }, [fetchFormToken]);

  const submit = useCallback(async (send) => {
    for (let attempt = 0; ; attempt++) {
      // The check has to be passed (or be off) before anything is sent.
      if (enabled) {
        const s = stateRef.current;
        if (s === 'blocked') throw new Error(CHECK_BLOCKED_SUBMIT);
        if (s !== 'off' && !tokenRef.current) {
          // Usually the widget finishes on its own within a second or two of the page opening.
          for (let i = 0; i < 40 && !tokenRef.current && !['off', 'blocked', 'error'].includes(stateRef.current); i++) await wait(250);
          if (stateRef.current === 'blocked') throw new Error(CHECK_BLOCKED_SUBMIT);
          if (stateRef.current !== 'off' && !tokenRef.current) throw new Error(CHECK_NOT_DONE);
        }
      }
      let ft = formToken.current;
      if (!ft) ft = await fetchFormToken();
      const remaining = ft.readyAt - Date.now();
      if (remaining > 0) await wait(remaining);

      const headers = { 'X-Form-Token': ft.value };
      if (enabled && tokenRef.current) headers['X-Turnstile-Token'] = tokenRef.current;
      try {
        const result = await send(headers, { website: trapRef.current });
        // Spent: a new form token and a new check for the next submission.
        formToken.current = null;
        fetchFormToken().catch(() => {});
        widgetRef.current?.reset();
        return result;
      } catch (err) {
        if (attempt === 0 && RETRY_CODES.includes(err.code)) {
          formToken.current = null;
          await fetchFormToken();
          continue;
        }
        // The Turnstile token may have been spent by this attempt: get another for the retry.
        widgetRef.current?.reset();
        throw err;
      }
    }
  }, [enabled, fetchFormToken]);

  const widget = enabled
    ? <HumanCheck ref={widgetRef} action={action} onToken={setToken} onState={setCheckState} />
    : null;
  const honeypot = <Honeypot value={trap} onChange={setTrap} />;

  return { widget, honeypot, submit, checkState, solved: Boolean(token), blocked: checkState === 'blocked' };
}
