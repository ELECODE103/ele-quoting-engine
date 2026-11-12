/**
 * Bot defences for the public forms and the quote tool.
 *
 * Two layers:
 *
 *   1. Always on, no keys needed:
 *        - a honeypot field no person sees or fills;
 *        - a form token issued when the form is shown, which must be at least
 *          MIN_FILL_SECONDS old when the form comes back (a script that posts
 *          the instant it loads the page is refused) and can be spent once;
 *        - limits per IP address and per email address;
 *        - a repeat of the same submission inside half an hour gets the first
 *          answer back instead of a second request and a second set of emails.
 *
 *   2. Cloudflare Turnstile, when TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY are
 *      set. Each form sends the widget's token; the quote tool trades one
 *      token for a one-hour "verified human" token so it is not challenged on
 *      every file. A signed-in account with a verified email skips it.
 *
 * `req.human` records the outcome for the route:
 *      { verified: true,  method: "turnstile" | "human-token" | "account" }
 *      { verified: false, method: "off" | "unavailable" }
 */
const crypto = require("crypto");
const turnstile = require("./turnstile");
const tokens = require("./tokens");
const { createThrottle, createTtlStore, clientIp, clientKey } = require("./throttle");
const brand = require("../../shared/brand.json");

const MIN_FILL_SECONDS = 3;
const HONEYPOT_FIELD = "website";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const CALL_US = `Call ${brand.phone} or email ${brand.email} and we'll take it from there.`;
const MESSAGES = {
  requestsPaused: `We're getting more requests than we can read right now, so the form is paused for a little while. ${CALL_US}`,
  humanRequired: "We couldn't confirm you're not a robot. Complete the check and try again.",
  humanUnavailable: `The check that keeps robots out isn't answering right now. Try again in a minute. ${CALL_US}`,
  tooFast: "That was sent faster than a person fills in a form. Wait a few seconds and send it again.",
  formExpired: "This form was open for a long time. Send it again.",
  formMissing: "The form didn't load completely. Reload the page and try again.",
  tooMany: `Too many requests from this connection. ${CALL_US}`,
  tooManyForAddress: `That email address has sent several requests in a short time. ${CALL_US}`,
};

// ─── Limits ────────────────────────────────────────────────────
const limits = {
  formPerIpHour: createThrottle({ windowMs: HOUR, max: 10 }),
  formPerIpDay: createThrottle({ windowMs: DAY, max: 30 }),
  formPerEmailHour: createThrottle({ windowMs: HOUR, max: 6 }),
  formPerEmailDay: createThrottle({ windowMs: DAY, max: 20 }),
  // Confirmation emails to an address somebody typed.
  confirmPerRecipientDay: createThrottle({ windowMs: DAY, max: 4 }),
  confirmPerIpDay: createThrottle({ windowMs: DAY, max: 8 }),
  humanVerifyPerIp: createThrottle({ windowMs: HOUR, max: 30 }),
  formTokenPerIp: createThrottle({ windowMs: HOUR, max: 120 }),
};

// ─── Verified-human token: one client, a bounded number of uses ─
// The token used to carry no claims at all: one solved challenge from one
// address opened upload and pricing to every address for an hour (independent
// review 2026-11-11, M1). It now names the client key it was issued to (as a
// keyed hash) and is counted: past HUMAN_TOKEN_MAX_USES it stops working and
// the browser is asked to pass the check again.
const humanTokenUses = createTtlStore({ ttlMs: tokens.KINDS.human.ttl * 1000 });
const clientBinding = (key) => require("./keys").mac("human-token-client-v1", String(key || "")).slice(0, 32);

/** A verified-human token for one client key (what POST /api/human/verify hands out after a passed check). */
function issueHumanToken(key, opts) {
  return tokens.sign("human", { ck: clientBinding(key) }, opts);
}

/** Is this verified-human token valid for THIS client, and still inside its use allowance? Counts the use. */
function humanTokenOk(req, token, now = Date.now()) {
  const v = tokens.verify("human", token);
  if (!v.ok) return false;
  if (typeof v.claims.ck !== "string" || !require("./keys").safeEqual(v.claims.ck, clientBinding(clientKey(req)))) return false;
  const id = String(v.claims.jti || "");
  if (!id) return false;
  const used = humanTokenUses.get(id, now) || 0;
  if (used >= require("./limits").limits.humanTokenMaxUses) return false;
  humanTokenUses.set(id, used + 1, now, Math.max(1000, Number(v.claims.exp) * 1000 - now));
  return true;
}

const spentFormTokens = createTtlStore({ ttlMs: tokens.KINDS.form.ttl * 1000 });
// A form token whose request is still being handled (the bot check is a network call):
// a second request with the same token waits its turn by being refused.
const pendingFormTokens = createTtlStore({ ttlMs: 60 * 1000 });
const recentSubmissions = createTtlStore({ ttlMs: 30 * 60 * 1000 });

function emailKey(email) {
  return String(email || "").trim().toLowerCase().slice(0, 254);
}

// ─── Form token (minimum time to submit, single use) ───────────

function issueFormToken(form, { now } = {}) {
  return tokens.sign("form", { form: String(form || "form").slice(0, 40) }, { now });
}

/**
 * @returns {{ok: true, id: string} | {ok: false, status: number, code: string, error: string}}
 */
function checkFormToken(token, form, { now = Date.now() } = {}) {
  const v = tokens.verify("form", token);
  if (!v.ok) {
    return v.reason === "expired"
      ? { ok: false, status: 400, code: "form-expired", error: MESSAGES.formExpired }
      : { ok: false, status: 400, code: "form-token-missing", error: MESSAGES.formMissing };
  }
  if (v.claims.form !== form) return { ok: false, status: 400, code: "form-token-missing", error: MESSAGES.formMissing };
  if (now / 1000 - v.claims.iat < MIN_FILL_SECONDS) return { ok: false, status: 400, code: "too-fast", error: MESSAGES.tooFast };
  return { ok: true, id: v.claims.jti };
}

// ─── Turnstile ─────────────────────────────────────────────────

function turnstileTokenFrom(req) {
  const h = req.headers["x-turnstile-token"];
  if (typeof h === "string" && h) return h;
  const b = req.body || {};
  return typeof b.turnstileToken === "string" ? b.turnstileToken : (typeof b["cf-turnstile-response"] === "string" ? b["cf-turnstile-response"] : "");
}

/**
 * Work out whether a person is behind this request.
 * Order: verified account → verified-human token → a fresh Turnstile token.
 * @param {{action?: string, allowAccount?: boolean, allowHumanToken?: boolean}} opts
 * @returns {Promise<{verified: boolean, method: string, reason?: string}>}
 */
async function assess(req, { action, allowAccount = true, allowHumanToken = true } = {}) {
  if (allowAccount && req.user && req.user.emailVerified) return { verified: true, method: "account" };
  if (!turnstile.configured()) return { verified: false, method: "off" };
  if (allowHumanToken) {
    const ht = req.headers["x-human-token"];
    if (typeof ht === "string" && ht && humanTokenOk(req, ht)) return { verified: true, method: "human-token" };
  }
  const result = await turnstile.verify(turnstileTokenFrom(req), { ip: clientIp(req), action });
  if (result.ok) return { verified: true, method: "turnstile" };
  return { verified: false, method: result.reason === "unavailable" ? "unavailable" : "failed", reason: result.reason };
}

/**
 * Middleware: a person must be behind this request whenever the bot check is
 * switched on. With no keys configured it lets the request through unverified
 * (the startup warning says so).
 */
function requireHuman(opts = {}) {
  return async (req, res, next) => {
    try {
      req.human = await assess(req, opts);
      if (req.human.verified || req.human.method === "off") return next();
      if (req.human.method === "unavailable") return res.status(503).json({ error: MESSAGES.humanUnavailable, code: "human-check-unavailable" });
      return res.status(403).json({ error: MESSAGES.humanRequired, code: "human-check-required" });
    } catch (err) {
      next(err);
    }
  };
}

/** Trade a Turnstile token for a one-hour verified-human token (the quote tool does this once). */
async function humanVerifyHandler(req, res) {
  const ip = clientKey(req);
  if (limits.humanVerifyPerIp.hit(ip).count > limits.humanVerifyPerIp.max) return res.status(429).json({ error: MESSAGES.tooMany, code: "rate-limited" });
  if (!turnstile.configured()) return res.json({ required: false, humanToken: "", expiresIn: 0 });
  const result = await turnstile.verify(turnstileTokenFrom(req), { ip: clientIp(req), action: req.body?.action === "quote" ? "quote" : undefined });
  if (!result.ok) {
    if (result.reason === "unavailable") return res.status(503).json({ error: MESSAGES.humanUnavailable, code: "human-check-unavailable" });
    return res.status(403).json({ error: MESSAGES.humanRequired, code: "human-check-required" });
  }
  // Bound to the client it was issued to: sent from another address it is not accepted.
  res.json({ required: true, humanToken: issueHumanToken(ip), expiresIn: tokens.KINDS.human.ttl });
}

// ─── Form guard ────────────────────────────────────────────────

function fingerprint(parts) {
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/**
 * The always-on checks for one form submission, in the order that costs a bot
 * the least information. Call after the body is parsed.
 *
 * @param {object} req
 * @param {{form: string, email?: string, dedupe?: any[]}} o
 *   `dedupe`: the values that make two submissions "the same request".
 * @returns {{ok: true, formTokenId: string, dedupeKey: string|null, replay: any|null}
 *          | {ok: false, honeypot?: true, status?: number, code?: string, error?: string}}
 *   `replay` is the stored answer of an identical submission, when there is one.
 */
function checkForm(req, { form, email, dedupe }) {
  const body = req.body || {};
  // 1. Honeypot: answered like a success by the route, with nothing done. One
  //    log line (no contents) so a run of them, or a real visitor whose browser
  //    filled the field, leaves a trace.
  if (typeof body[HONEYPOT_FIELD] === "string" && body[HONEYPOT_FIELD].trim() !== "") {
    console.warn(`[botguard] honeypot filled on the ${form} form: submission dropped`);
    return { ok: false, honeypot: true };
  }

  // 2. Per-IP limits.
  const ip = clientKey(req);
  if (limits.formPerIpHour.peek(ip).limited || limits.formPerIpDay.peek(ip).limited) {
    return { ok: false, status: 429, code: "rate-limited", error: MESSAGES.tooMany };
  }

  // 3. Form token: present, ours, old enough, not spent. A spent token with the
  //    same content is a double click: hand back the first answer.
  const headerToken = req.headers["x-form-token"];
  const formToken = typeof headerToken === "string" && headerToken ? headerToken : body.formToken;
  const ft = checkFormToken(formToken, form);
  if (!ft.ok) return ft;

  const dedupeKey = dedupe ? fingerprint([form, emailKey(email), ...dedupe]) : null;
  const earlier = dedupeKey ? recentSubmissions.get(dedupeKey) : undefined;
  if (earlier !== undefined) return { ok: true, formTokenId: ft.id, dedupeKey, replay: earlier };
  if (spentFormTokens.has(ft.id) || pendingFormTokens.has(ft.id)) return { ok: false, status: 409, code: "form-reused", error: MESSAGES.formExpired };

  // 4. Per-address limits.
  const ek = emailKey(email);
  if (ek && (limits.formPerEmailHour.peek(ek).limited || limits.formPerEmailDay.peek(ek).limited)) {
    return { ok: false, status: 429, code: "rate-limited", error: MESSAGES.tooManyForAddress };
  }
  pendingFormTokens.set(ft.id, true);
  return { ok: true, formTokenId: ft.id, dedupeKey, replay: null };
}

/** The submission was refused after checkForm passed (bad input, failed bot check): the form token may be used again. */
function releaseForm(check) {
  if (check && check.formTokenId) pendingFormTokens.delete(check.formTokenId);
}

/** Count an accepted submission and remember its answer for duplicate suppression. */
function recordForm(req, check, { email, response }) {
  const ip = clientKey(req);
  limits.formPerIpHour.hit(ip);
  limits.formPerIpDay.hit(ip);
  const ek = emailKey(email);
  if (ek) { limits.formPerEmailHour.hit(ek); limits.formPerEmailDay.hit(ek); }
  pendingFormTokens.delete(check.formTokenId);
  spentFormTokens.set(check.formTokenId, true);
  if (check.dedupeKey && response !== undefined) recentSubmissions.set(check.dedupeKey, response);
}

/**
 * May a confirmation be emailed to `recipient` (an address somebody typed)?
 * Counts the send when the answer is yes.
 */
function allowConfirmationEmail(req, recipient) {
  const ip = clientKey(req);
  const rk = emailKey(recipient);
  if (!rk) return false;
  if (limits.confirmPerRecipientDay.peek(rk).limited || limits.confirmPerIpDay.peek(ip).limited) return false;
  limits.confirmPerRecipientDay.hit(rk);
  limits.confirmPerIpDay.hit(ip);
  return true;
}

function formTokenHandler(req, res) {
  const ip = clientKey(req);
  if (limits.formTokenPerIp.hit(ip).count > limits.formTokenPerIp.max) return res.status(429).json({ error: MESSAGES.tooMany, code: "rate-limited" });
  const form = typeof req.query.form === "string" ? req.query.form.slice(0, 40) : "form";
  res.set("Cache-Control", "no-store");
  res.json({ formToken: issueFormToken(form), minSeconds: MIN_FILL_SECONDS });
}

/** Tests only. */
function resetForTests() {
  for (const t of Object.values(limits)) t.reset();
  spentFormTokens.clear();
  pendingFormTokens.clear();
  recentSubmissions.clear();
  humanTokenUses.clear();
  unverifiedRequests.windowStart = 0;
  unverifiedRequests.count = 0;
  unverifiedRequests.free = 0;
  unverifiedPerClient.reset();
}

// ─── Site-wide cap on requests from unverified senders ─────────
// Per-client and per-address limits do not add up to a limit: 100 addresses
// are 1,000 requests and 1,000 emails to the shop an hour (independent review
// 2026-11-11, M2). Requests from senders who did NOT pass the robot check (the
// check is off, or could not be reached) share one hourly allowance for the
// whole site, RFQ_UNVERIFIED_PER_HOUR_SITE. Verified senders and signed-in
// customers with a confirmed email are not counted and are never refused here.
//
// Independent re-review 2026-11-12, RR-03: with the check off, 30 requests from 3 addresses used
// the allowance up and closed the form, the site's last door, to every real visitor for the rest
// of the hour. So the allowance now starts after each address's own first few: an address's first
// RFQ_UNVERIFIED_FREE_PER_CLIENT_HOUR (2) requests in an hour always pass and are not counted; the
// site-wide allowance is for what an address sends beyond that. The cap bites on the addresses
// that are flooding, never on the next visitor.
const unverifiedRequests = { windowStart: 0, count: 0, refused: 0, free: 0 };
const unverifiedPerClient = new (require("../services/usageWindow").UsageWindow)({ windowMs: HOUR });
function unverifiedWindow(now) {
  if (now - unverifiedRequests.windowStart >= HOUR) { unverifiedRequests.windowStart = now; unverifiedRequests.count = 0; unverifiedRequests.free = 0; }
  return unverifiedRequests;
}
/** Is this one of the client's own first few this hour (which always pass)? */
function unverifiedIsFree(clientKey, now = Date.now()) {
  return Boolean(clientKey) && unverifiedPerClient.total(clientKey, now) < require("./limits").limits.rfqUnverifiedFreePerClientHour;
}
/**
 * Has the site taken its hour's worth of requests from unverified senders — as far as THIS client
 * is concerned? Never for a client's first few.
 */
function unverifiedRequestsFull(now = Date.now(), clientKey = "") {
  if (unverifiedIsFree(clientKey, now)) return false;
  return unverifiedWindow(now).count >= require("./limits").limits.rfqUnverifiedPerHourSite;
}
/** Count one accepted request from an unverified sender. */
function countUnverifiedRequest(now = Date.now(), clientKey = "") {
  const w = unverifiedWindow(now);
  if (unverifiedIsFree(clientKey, now)) w.free++; else w.count++;
  if (clientKey) unverifiedPerClient.add(clientKey, 1, now);
}
function noteUnverifiedRefused() { unverifiedRequests.refused++; }
/** For the status page. */
function unverifiedRequestStats(now = Date.now()) {
  const w = unverifiedWindow(now);
  return { acceptedThisHour: w.count, firstFewThisHour: w.free, capPerHour: require("./limits").limits.rfqUnverifiedPerHourSite, refusedSinceStart: unverifiedRequests.refused, windowStartedAt: new Date(w.windowStart).toISOString() };
}

module.exports = {
  requireHuman, assess, humanVerifyHandler,
  checkForm, recordForm, releaseForm, allowConfirmationEmail,
  issueFormToken, checkFormToken, formTokenHandler,
  emailKey, limits, resetForTests,
  humanTokenOk, issueHumanToken, clientBinding,
  unverifiedRequestsFull, countUnverifiedRequest, noteUnverifiedRefused, unverifiedRequestStats,
  MIN_FILL_SECONDS, HONEYPOT_FIELD, MESSAGES,
};
