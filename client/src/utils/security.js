/**
 * Browser side of the bot check.
 *
 *   publicConfig()        what the server says is switched on (the Turnstile
 *                         site key comes from here, never from the bundle)
 *   loadTurnstile()       loads Cloudflare's script, once, only when a page
 *                         that needs the check asks for it
 *   humanToken helpers    the one-hour "verified human" token the quote tool
 *                         sends with uploads and pricing (not a login)
 *   challengeHuman()      asks the page's <HumanGate> to run the check
 *
 * Nothing here runs during prerendering: every entry point is called from an
 * effect or an event handler.
 */
import brand from '../brand';

const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const HUMAN_KEY = 'straightedge.human';
const SCRIPT_TIMEOUT_MS = 12000;

export const CHECK_BLOCKED_MESSAGE =
  `The spam check didn't load. A content blocker or a firewall may be stopping challenges.cloudflare.com. Allow it and reload the page, or call ${brand.phone} or email ${brand.email} and we'll take it from there.`;

/** Said next to the send button when a form cannot go because the check did not load. */
export const CHECK_BLOCKED_SUBMIT =
  `Nothing was sent: the spam check above didn't load, and this form needs it. Call ${brand.phone} or email ${brand.email} instead.`;

// ─── Config ───────────────────────────────────────────────────
let configPromise = null;
export function publicConfig() {
  if (!configPromise) {
    configPromise = fetch('/api/public/config', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('config'))))
      .catch((err) => { configPromise = null; throw err; });
  }
  return configPromise;
}

// ─── Turnstile script ─────────────────────────────────────────
let scriptPromise = null;
/** Resolves with window.turnstile; rejects when the script is blocked or does not arrive in time. */
export function loadTurnstile() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const fail = () => { scriptPromise = null; el.remove(); reject(new Error(CHECK_BLOCKED_MESSAGE)); };
      const el = document.createElement('script');
      el.src = TURNSTILE_SRC;
      el.async = true;
      el.defer = true;
      const timer = setTimeout(fail, SCRIPT_TIMEOUT_MS);
      el.onload = () => { clearTimeout(timer); if (window.turnstile) resolve(window.turnstile); else fail(); };
      el.onerror = () => { clearTimeout(timer); fail(); };
      document.head.appendChild(el);
    });
  }
  return scriptPromise;
}

// ─── Verified-human token (quote tool) ────────────────────────
let accountVerified = false;
/** Set by the auth context: a signed-in account with a confirmed email is not challenged. */
export function setAccountVerified(v) { accountVerified = Boolean(v); }
export function isAccountVerified() { return accountVerified; }

export function getHumanToken() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(HUMAN_KEY) || 'null');
    if (saved && saved.token && saved.expires > Date.now() + 30000) return saved.token;
  } catch { /* private mode, or nothing saved */ }
  return '';
}
export function setHumanToken(token, expiresInSeconds) {
  try {
    if (token) sessionStorage.setItem(HUMAN_KEY, JSON.stringify({ token, expires: Date.now() + expiresInSeconds * 1000 }));
    else sessionStorage.removeItem(HUMAN_KEY);
  } catch { /* private mode */ }
}

// The page mounts one <HumanGate>, which registers how to run a challenge.
let challengeUi = null;
export function registerChallengeUi(fn) { challengeUi = fn; return () => { if (challengeUi === fn) challengeUi = null; }; }

let pending = null;
/**
 * Make sure this browser holds a verified-human token (when the check is on and
 * the visitor is not a signed-in, confirmed account). Shows the check once and
 * resolves when it has passed; rejects with a message for the visitor if it
 * cannot be shown.
 */
export async function ensureHuman({ force = false } = {}) {
  if (accountVerified && !force) return;
  const cfg = await publicConfig().catch(() => null);
  if (!cfg || !cfg.botCheck) return;
  if (!force && getHumanToken()) return;
  if (force) setHumanToken('');
  if (!challengeUi) throw new Error(CHECK_BLOCKED_MESSAGE);
  if (!pending) pending = challengeUi().finally(() => { pending = null; });
  return pending;
}
