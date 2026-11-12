/**
 * Watches what the server answers and what the mailer does, and counts the
 * things worth telling the owner about (ops/events.js). It changes no answer
 * and needs no edit in the routes or in the mailer:
 *
 *   - every response is looked at when it finishes: its status, which route
 *     family it was, and the short `code` field our own error answers carry
 *     ("try-later", "storage-full", …). Bodies are not kept.
 *   - services/mailer.js `send` is wrapped once, so each message is counted
 *     as sent, failed, or not sent because the mailer is not configured. Only
 *     the template's name is kept — never an address or a subject.
 *
 * What is counted, and under which name:
 *   serverError        a 5xx answer other than a deliberate 503
 *   webhookOk          Stripe webhook answered 2xx
 *   webhookRejected    Stripe webhook answered 400 (bad signature or payload)
 *   webhookRefused     Stripe webhook answered 503 (no signing secret configured)
 *   webhookFailed      Stripe webhook answered anything else
 *   signinPaused       a sign-in attempt told to wait (429 try-later, account-busy or two-factor-paused)
 *   signinPauseStarted an account drew many wrong passwords from browsers it has never used and its owner was
 *                      sent the notice (at most one a day per account). Nobody is locked out by this.
 *   storageRefused     an upload refused because storage or the database is at its ceiling
 *   rateLimited        any 429 from a rate limiter (rate-limited, checkout-rate-limited)
 *   mailSent / mailFailed / mailNotConfigured
 */
const events = require("./events");

const WEBHOOK_PATH = "/api/stripe/webhook";
// A sign-in answered "wait" (routes/auth.js, the sign-in throttle of 2026-11-11): this connection after several
// wrong passwords, an address under many wrong passwords from unknown browsers, too many wrong two-step codes.
// (`account-locked`, the per-address lock these replaced, is no longer sent by anything.)
const SIGN_IN_WAIT = new Set(["try-later", "account-busy", "two-factor-paused"]);

function pathOf(req) {
  const url = String(req.originalUrl || req.url || "");
  const q = url.indexOf("?");
  return (q === -1 ? url : url.slice(0, q)).replace(/\/+$/, "").toLowerCase();
}

function classify(pathname, status, code) {
  const out = [];
  if (pathname === WEBHOOK_PATH) {
    if (status >= 200 && status < 300) out.push(["webhookOk"]);
    else if (status === 400) out.push(["webhookRejected", { notable: true, label: "400" }]);
    else if (status === 503) out.push(["webhookRefused", { notable: true, label: "503" }]);
    else out.push(["webhookFailed", { notable: true, label: String(status) }]);
  }
  if (status >= 500 && status !== 503) out.push(["serverError", { notable: true, label: String(status) }]);
  if (SIGN_IN_WAIT.has(code)) out.push(["signinPaused", { notable: true }]);
  if (code === "storage-full") out.push(["storageRefused", { notable: true }]);
  if (status === 429 && (code === "rate-limited" || code === "checkout-rate-limited")) out.push(["rateLimited"]);
  return out;
}

/** Express middleware. Mount once, early. */
function middleware(req, res, next) {
  // Our own error answers go out through res.json with a `code`; remember it for the finish handler.
  const json = res.json;
  res.json = function opsObservedJson(body) {
    try {
      if (res.statusCode >= 400 && body && typeof body === "object" && typeof body.code === "string") res.locals.opsCode = body.code.slice(0, 60);
    } catch { /* the answer goes out unchanged */ }
    return json.call(this, body);
  };
  res.on("finish", () => {
    try {
      for (const [kind, opt] of classify(pathOf(req), res.statusCode, res.locals && res.locals.opsCode)) events.record(kind, opt);
    } catch { /* counting must never break a request */ }
  });
  next();
}

const WRAPPED = Symbol.for("straightedge.ops.mailerWrapped");

/** The names of our own operational messages: their failures are counted but never trigger another alert. */
const OPS_TEMPLATES = new Set(["opsAlert", "opsDigest", "opsEmailCheck"]);

/** Wrap mailer.send once. Every caller uses `mailer.send(...)` on the module object, so they all go through this. */
function watchMailer(mailer = require("../services/mailer")) {
  if (mailer.send[WRAPPED]) return mailer;
  const original = mailer.send;
  const watched = async function opsWatchedSend(message) {
    const template = message && typeof message.template === "string" ? message.template : "unnamed";
    const wasConfigured = mailer.configured();
    const ok = await original.call(mailer, message);
    try {
      // The "wrong passwords were tried on your account" notice (emails/templates.js signInAttempts) goes out when an
      // account has drawn many wrong passwords from browsers it has never used: at most one a day per account.
      if (template === "signInAttempts") events.record("signinPauseStarted", { notable: true });
      if (ok) events.record("mailSent");
      else if (!wasConfigured) events.record("mailNotConfigured");
      else {
        events.record("mailFailed", { notable: true, label: template });
        if (!OPS_TEMPLATES.has(template)) events.record("mailFailedCustomerFacing");
      }
    } catch { /* never let counting change what the caller gets */ }
    return ok;
  };
  watched[WRAPPED] = true;
  watched.original = original;
  mailer.send = watched;
  return mailer;
}

module.exports = { middleware, watchMailer, classify, OPS_TEMPLATES, WEBHOOK_PATH };
