/**
 * Cloudflare Turnstile, server side.
 *
 * Switched on by TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY. Every token the
 * browser sends is checked against Cloudflare's siteverify endpoint; nothing
 * the browser says about a token is trusted. The check fails closed: a missing
 * token, a rejected token, a timeout or an unreadable answer are all "not
 * verified". Callers decide what "not verified" means for them (refuse the
 * request, or accept it as an unverified sender).
 *
 * Keys are never logged. Cloudflare's published dummy keys (always pass /
 * always fail) are for tests and docs: in production they count as "not
 * configured", because the always-pass secret would wave every bot through.
 */
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 5000;
const MAX_TOKEN_LENGTH = 2048; // Cloudflare: tokens are at most 2048 characters

// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
const DUMMY_SITE_KEYS = ["1x00000000000000000000AA", "2x00000000000000000000AB", "1x00000000000000000000BB", "2x00000000000000000000BB", "3x00000000000000000000FF"];
const DUMMY_SECRETS = ["1x0000000000000000000000000000000AA", "2x0000000000000000000000000000000AA", "3x0000000000000000000000000000000AA"];

let fetchImpl = (...args) => fetch(...args);

function keys() {
  return {
    siteKey: (process.env.TURNSTILE_SITE_KEY || "").trim(),
    secret: (process.env.TURNSTILE_SECRET_KEY || "").trim(),
  };
}

/** Are the configured keys Cloudflare's public test keys? */
function usingDummyKeys() {
  const { siteKey, secret } = keys();
  return DUMMY_SITE_KEYS.includes(siteKey) || DUMMY_SECRETS.includes(secret);
}

/** Is the bot check switched on? Both keys set, and not the public test keys in production. */
function configured() {
  const { siteKey, secret } = keys();
  if (!siteKey || !secret) return false;
  if (process.env.NODE_ENV === "production" && usingDummyKeys()) return false;
  return true;
}

/** The site key for the browser, or "" when the check is off. */
function siteKey() {
  return configured() ? keys().siteKey : "";
}

/**
 * Check one token with Cloudflare.
 * @param {string} token   the widget's response
 * @param {{ip?: string, action?: string}} [opts]  `action` must match the widget's action when given
 * @returns {Promise<{ok: boolean, reason: "ok"|"off"|"missing"|"rejected"|"unavailable", codes: string[]}>}
 *   "off": the check is not configured (ok is false: nothing was verified).
 *   "unavailable": Cloudflare could not be reached or answered nonsense.
 */
async function verify(token, { ip, action } = {}) {
  if (!configured()) return { ok: false, reason: "off", codes: [] };
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: "missing", codes: [] };
  }
  const body = new URLSearchParams({ secret: keys().secret, response: token });
  if (ip && ip !== "unknown") body.set("remoteip", ip);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reason: "unavailable", codes: [`http-${res.status}`] };
    const data = await res.json();
    if (!data || typeof data !== "object") return { ok: false, reason: "unavailable", codes: ["bad-response"] };
    const codes = Array.isArray(data["error-codes"]) ? data["error-codes"].map(String) : [];
    if (data.success !== true) {
      // Our own misconfiguration (bad secret) is an outage, not a bot.
      const ours = codes.some((c) => c === "invalid-input-secret" || c === "missing-input-secret" || c === "internal-error");
      if (ours) console.error(`[turnstile] siteverify refused our request: ${codes.join(", ")}`);
      return { ok: false, reason: ours ? "unavailable" : "rejected", codes };
    }
    // A token solved for one form must not be spent on another.
    if (action && data.action && data.action !== action) return { ok: false, reason: "rejected", codes: ["action-mismatch"] };
    return { ok: true, reason: "ok", codes: [] };
  } catch (err) {
    return { ok: false, reason: "unavailable", codes: [err.name === "AbortError" ? "timeout" : "network-error"] };
  } finally {
    clearTimeout(timer);
  }
}

/** Tests only: replace the network call. Pass nothing to restore the real one. */
function setFetchForTests(fn) {
  fetchImpl = fn || ((...args) => fetch(...args));
}

module.exports = { configured, siteKey, verify, usingDummyKeys, setFetchForTests, SITEVERIFY_URL, TIMEOUT_MS, DUMMY_SITE_KEYS, DUMMY_SECRETS };
