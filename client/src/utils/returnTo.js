/**
 * "Where to go after sign-in / register."
 *
 * A guest who clicks checkout is sent to /login?next=/checkout/<quoteId>. The
 * destination rides in the URL (so it survives a reload, a new tab, or the hop
 * between the login and register pages) and is only ever honoured when it is a
 * path on this site.
 */
const DEFAULT_DESTINATION = '/quote';

/** A same-site path ("/checkout/abc?x=1"), or null for anything else (absolute URLs, "//host", "/\host", control characters). */
export function safeNext(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\\]/.test(value)) return null;
  if (/^\/(login|register|forgot-password|reset-password|verify-email)(\/|\?|#|$)/.test(value)) return null; // never bounce back to the auth pages
  return value;
}

/** Destination carried by a router location: ?next= first, then router state (older links). */
export function nextFrom(location) {
  const fromQuery = safeNext(new URLSearchParams(location?.search || '').get('next'));
  return fromQuery || safeNext(location?.state?.from) || null;
}

export function destinationAfterAuth(location) {
  return nextFrom(location) || DEFAULT_DESTINATION;
}

/** "/login?next=…" (or "/register?next=…") for a destination; the bare path when there is none. */
export function authPath(page, next) {
  const safe = safeNext(next);
  return safe ? `${page}?next=${encodeURIComponent(safe)}` : page;
}

// ─── The quote this browser tab is working on ─────────────────
const QUOTE_KEY = 'straightedge.quoteId';

function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  // RFC 4122 v4 from getRandomValues, for browsers without randomUUID.
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The session's quote id, if one has been started. */
export function storedQuoteId(storage = globalThis.sessionStorage) {
  try { return storage?.getItem(QUOTE_KEY) || null; } catch { return null; }
}

export function storeQuoteId(id, storage = globalThis.sessionStorage) {
  try { if (id) storage?.setItem(QUOTE_KEY, id); else storage?.removeItem(QUOTE_KEY); } catch { /* private mode */ }
}

/** The session's quote id, created on first use — one quote row per session, not one per price refresh. */
export function sessionQuoteId(storage = globalThis.sessionStorage) {
  let id = storedQuoteId(storage);
  if (!id) { id = newId(); storeQuoteId(id, storage); }
  return id;
}

// ─── The checkout this browser was heading for ────────────────
// The quote id above lives in sessionStorage, which a new tab does not share. The link in a
// confirmation or reset email opens in a new tab, so without this the buyer who has just confirmed
// their address would be looking at a page that no longer knows which quote they were buying.
// What is kept is the path of their own checkout page and when it was noted; it is forgotten after
// a week, when the order is placed, and on sign-out. Nothing about the session is stored here.
const CHECKOUT_KEY = 'straightedge.checkout';
const CHECKOUT_DAYS = 7;

/** Remember (or with no path, forget) the checkout page this browser is on its way to. */
export function notePendingCheckout(path, storage = globalThis.localStorage, now = Date.now()) {
  try {
    const safe = safeNext(path);
    if (safe && /^\/checkout\/[A-Za-z0-9-]{8,64}$/.test(safe)) storage?.setItem(CHECKOUT_KEY, JSON.stringify({ path: safe, at: now }));
    else storage?.removeItem(CHECKOUT_KEY);
  } catch { /* private mode */ }
}

/** "/checkout/<quoteId>" this browser was heading for in the last week, or null. */
export function pendingCheckout(storage = globalThis.localStorage, now = Date.now()) {
  try {
    const saved = JSON.parse(storage?.getItem(CHECKOUT_KEY) || 'null');
    if (!saved || typeof saved.path !== 'string' || !/^\/checkout\/[A-Za-z0-9-]{8,64}$/.test(saved.path)) return null;
    if (!(now - Number(saved.at) < CHECKOUT_DAYS * 24 * 60 * 60 * 1000)) { storage?.removeItem(CHECKOUT_KEY); return null; }
    return saved.path;
  } catch { return null; }
}

// ─── What the buyer typed on the checkout page ────────────────
// Kept for this tab only (sessionStorage), per quote, so the ship-to details survive a reload, the
// trip to sign in again when a session ends mid-checkout, and the way back from the card page.
const DRAFT_KEY = 'straightedge.checkoutDraft';
const DRAFT_FIELDS = ['name', 'street', 'city', 'state', 'zip', 'country'];

export function saveCheckoutDraft(quoteId, fields, storage = globalThis.sessionStorage) {
  try {
    if (!quoteId) return;
    const kept = {};
    for (const k of DRAFT_FIELDS) kept[k] = String(fields?.[k] ?? '').slice(0, 200);
    storage?.setItem(DRAFT_KEY, JSON.stringify({ quoteId, fields: kept }));
  } catch { /* private mode */ }
}

export function loadCheckoutDraft(quoteId, storage = globalThis.sessionStorage) {
  try {
    const saved = JSON.parse(storage?.getItem(DRAFT_KEY) || 'null');
    if (!saved || saved.quoteId !== quoteId || !saved.fields) return null;
    const out = {};
    for (const k of DRAFT_FIELDS) out[k] = typeof saved.fields[k] === 'string' ? saved.fields[k] : '';
    return out;
  } catch { return null; }
}

export function clearCheckoutDraft(storage = globalThis.sessionStorage) {
  try { storage?.removeItem(DRAFT_KEY); } catch { /* private mode */ }
}
