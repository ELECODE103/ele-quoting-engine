/**
 * Rate limiters for the expensive routes, and the pieces the general limiters
 * in server/index.js share (the client key, what the general limiter skips).
 *
 * Every limiter is keyed by clientKey(): the address Railway's edge reports
 * (one trusted proxy hop), with IPv6 clients grouped by /64.
 *
 *   route                               limit (per client)          override
 *   ─────────────────────────────────── ─────────────────────────── ───────────────────────────
 *   /api/* (general, in index.js)       200 / 15 min                RATE_API_PER_15MIN
 *   POST /api/upload (in index.js)      50 / 15 min                 RATE_UPLOAD_PER_15MIN
 *   POST /api/parts/:id/units           shares the upload limit's size (its own bucket)
 *   POST /api/quote (pricing)           300 / 15 min and 40 / 10 s  RATE_QUOTE_PER_15MIN, RATE_QUOTE_BURST_PER_10SEC
 *   GET  /api/quote/:id/session         60 / 15 min                 RATE_QUOTE_SESSION_PER_15MIN
 *   GET  /api/parts/:id/mesh|geometry   240 / 15 min (together)     RATE_PART_PREVIEW_PER_15MIN
 *   POST /api/quote/:id/drawing         20 / hour                   RATE_DRAWING_PER_HOUR
 *   /api/pdf/*, /api/orders/:id/traveler 60 / 15 min                RATE_PDF_PER_15MIN
 *   GET  /api/admin/backup/*            12 / hour
 *   POST /api/rfq (in index.js)         20 / hour                   RATE_RFQ_PER_HOUR
 *
 * Quote pricing has its own budget and is left out of the general one: the
 * quote tool re-prices on every change (debounced to at most 2.5 a second), so
 * a buyer working through a ten-part quote makes far more pricing calls than
 * anything else, and must not lock themselves out of checkout by doing so.
 * The health check is not rate limited at all (Railway and uptime monitors).
 */
const rateLimit = require("express-rate-limit");
const { limits } = require("./limits");
const { clientKey } = require("./clientKey");
const brand = require("../../shared/brand.json");

const MIN = 60 * 1000;

function limiter({ windowMs, max, message, skip, code = "rate-limited" }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: clientKey,
    skip,
    message: { error: message, code },
  });
}

/** Requests the general /api limiter does not count: the health check, and pricing (which has its own limiter). */
function skipGeneral(req) {
  const p = req.path; // relative to the /api mount
  if (p === "/health") return true;
  if (req.method === "POST" && (p === "/quote" || p === "/quote/")) return true;
  // Part previews have their own limiter: a 25-part quote reopened is 25 fetches.
  if (req.method === "GET" && /^\/parts\/[^/]+\/(mesh|geometry)\/?$/.test(p)) return true;
  return false;
}

/** Mount the route-specific limiters. Call before the API routers. */
function install(app) {
  const tooFast = "You're changing the quote faster than we can price it. Wait a few seconds and it will update.";
  app.post("/api/quote", limiter({ windowMs: 10 * 1000, max: limits.rateQuoteBurstPer10Sec, message: tooFast }));
  app.post("/api/quote", limiter({ windowMs: 15 * MIN, max: limits.rateQuotePer15Min, message: `That's a lot of pricing requests from this network. Try again in a few minutes, or call ${brand.phone}.` }));

  app.get("/api/quote/:id/session", limiter({ windowMs: 15 * MIN, max: limits.rateSessionPer15Min, message: "Too many requests, please try again later." }));

  // A part's 3D preview and geometry detail (streamed files, megabytes each): their own allowance.
  const preview = limiter({ windowMs: 15 * MIN, max: limits.ratePartPreviewPer15Min, message: "You've loaded a lot of part previews in a short time. They'll be back in a few minutes; pricing and ordering still work.", code: "preview-rate-limited" });
  app.get("/api/parts/:partId/mesh", preview);
  app.get("/api/parts/:partId/geometry", preview);

  app.post("/api/parts/:partId/units", limiter({ windowMs: 15 * MIN, max: limits.rateUploadPer15Min, message: "Too many changes to this drawing. Try again in a few minutes." }));

  app.post("/api/quote/:id/drawing", limiter({ windowMs: 60 * MIN, max: limits.rateDrawingPerHour, message: `Too many drawings from this network. Email it to ${brand.email} and we'll attach it.` }));

  const pdf = limiter({ windowMs: 15 * MIN, max: limits.ratePdfPer15Min, message: "Too many documents requested. Try again in a few minutes." });
  app.use("/api/pdf", pdf);
  app.get("/api/orders/:id/traveler", pdf);

  app.use("/api/admin/backup", limiter({ windowMs: 60 * MIN, max: 12, message: "Too many backups requested. Try again later." }));
}

module.exports = { install, skipGeneral, limiter, clientKey };
