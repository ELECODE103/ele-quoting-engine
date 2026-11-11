/**
 * Where the account and bot defences plug into the app. server/index.js (and
 * the test harness) call `mount(app)` once, before the API routers; nothing
 * else in those files changes.
 *
 * Mounted here:
 *   GET  /api/public/config       what the browser needs to know: the Turnstile
 *                                 site key (empty when the check is off) and
 *                                 whether email confirmation is enforced. No
 *                                 key is ever compiled into the bundle.
 *   GET  /api/public/form-token   a token for one showing of a form
 *   POST /api/human/verify        Turnstile token → one-hour verified-human token
 *   gates in front of POST /api/upload, POST /api/quote and
 *   POST /api/parts/:partId/units (the routes themselves live in routes/api.js
 *   and are not touched)
 */
const express = require("express");
const turnstile = require("./turnstile");
const botGuard = require("./botGuard");
const tokens = require("./tokens");
const session = require("./session");
const mailer = require("../services/mailer");
const { orderItemsDB, rfqsDB } = require("../models");

/** Add each part's edit key to an upload / quote-session response, so the browser that holds the part can set its units. */
function addPartEditKeys(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => {
    try {
      if (body && Array.isArray(body.parts)) {
        for (const p of body.parts) if (p && typeof p.partId === "string") p.editKey = tokens.partEditKey(p.partId);
      }
    } catch { /* the response goes out unchanged */ }
    return json(body);
  };
  next();
}

/**
 * Changing a DXF's units re-reads the file and replaces the stored geometry,
 * so it is for the browser that uploaded the part (it holds the edit key) and
 * only until the part is on an order or a firm-quote request.
 */
function partEditGate(req, res, next) {
  const partId = req.params.partId;
  const key = req.headers["x-part-key"] || (req.body && req.body.editKey);
  if (!tokens.partEditKeyOk(partId, key)) {
    return res.status(404).json({ error: "Part not found" });
  }
  const ordered = orderItemsDB.query((i) => i.partId === partId).length > 0
    || rfqsDB.query((r) => (r.parts || []).some((p) => p.partId === partId)).length > 0;
  if (ordered) {
    return res.status(409).json({ error: "This part is on an order or a quote request, so its units can no longer be changed. Upload the file again for a new quote.", code: "part-locked" });
  }
  next();
}

function mount(app) {
  const router = express.Router();

  router.get("/public/config", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({
      turnstileSiteKey: turnstile.siteKey(),
      botCheck: turnstile.configured(),
      emailVerification: mailer.configured(),
      honeypotField: botGuard.HONEYPOT_FIELD,
      minFormSeconds: botGuard.MIN_FILL_SECONDS,
    });
  });
  router.get("/public/form-token", botGuard.formTokenHandler);
  router.post("/human/verify", (req, res, next) => botGuard.humanVerifyHandler(req, res).catch(next));

  // The quote tool: a verified-human token (or a signed-in account with a
  // confirmed email) whenever the bot check is switched on.
  const quoteGate = [session.optionalAuth, botGuard.requireHuman({ action: "quote" })];
  router.post("/upload", quoteGate, addPartEditKeys);
  router.post("/quote", quoteGate);
  router.post("/parts/:partId/units", quoteGate, partEditGate);
  router.get("/quote/:id/session", addPartEditKeys);

  app.use("/api", router);
}

/**
 * Printed at startup in production: every protection that is switched off
 * because a setting is missing, by name, so it is found in the deploy log.
 */
function startupWarnings(log = console.warn) {
  const lines = [];
  if (!turnstile.configured()) {
    const why = turnstile.usingDummyKeys()
      ? "TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY are Cloudflare's public TEST keys, which pass every visitor"
      : "TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY are not set";
    lines.push(
      "════════════════════════════════════════════════════════════════════",
      `WARNING: BOT CHECK IS OFF — ${why}.`,
      "  These checks are NOT running:",
      "    - registration: no challenge before an account is created",
      "    - firm-quote form and send-us-the-part form: no challenge; every request",
      "      from a visitor who is not signed in is treated as an UNVERIFIED SENDER:",
      "      no confirmation email is sent to the address they type and the ship-to",
      "      address is not shown or emailed (the shop still gets the request)",
      "    - password-reset request: no challenge",
      "    - sign-in: no challenge after repeated wrong passwords",
      "    - CAD upload and pricing: open to anyone without a verified-human token",
      "  Still running without keys: honeypot field, minimum time to submit,",
      "  per-IP and per-address limits, duplicate-submission suppression,",
      "  per-account sign-in pause.",
      "════════════════════════════════════════════════════════════════════",
    );
  }
  if (!mailer.configured()) {
    lines.push(
      "WARNING: EMAIL VERIFICATION AND PASSWORD RESET CANNOT WORK — EMAIL_API_KEY / EMAIL_FROM are not set.",
      "  - new accounts cannot confirm their address, so checkout is NOT held back for unconfirmed accounts",
      "  - password-reset and sign-in-paused emails are not sent",
      "  - a new ADMIN_EMAIL account cannot be confirmed by link (see ADMIN_RECOVERY=verify-email)",
    );
  }
  if (process.env.ADMIN_RECOVERY) lines.push("WARNING: ADMIN_RECOVERY is set. It repeats its action on every start: remove it.");
  for (const l of lines) log(l);
  return lines;
}

module.exports = { mount, startupWarnings, partEditGate, addPartEditKeys };
