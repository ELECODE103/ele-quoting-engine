/**
 * In front of POST /api/rfq, before the attachment is read (index.js mounts it
 * ahead of the router): when the site has already taken its hour's worth of
 * requests from senders who cannot be verified (security/botGuard.js,
 * RFQ_UNVERIFIED_PER_HOUR_SITE), a request that has no way of being verified
 * is refused here — nothing is written to disk for it and nobody is emailed.
 *
 * "No way of being verified": it carries no robot-check answer and no session.
 * A request that carries either goes on to the route, which decides once it has
 * read the form (and applies the same cap to a sender who turns out unverified).
 */
const botGuard = require("./botGuard");

function beforeBody(req, res, next) {
  // Never for an address's own first few requests this hour (botGuard.js: the allowance starts after them).
  if (!botGuard.unverifiedRequestsFull(Date.now(), require("./clientKey").clientKey(req))) return next();
  const hasCheck = typeof req.headers["x-turnstile-token"] === "string" && req.headers["x-turnstile-token"] !== "";
  const hasSession = Boolean(req.headers.cookie || req.headers.authorization);
  if (hasCheck || hasSession) return next();
  botGuard.noteUnverifiedRefused();
  res.set("Connection", "close");
  res.set("Retry-After", "1800");
  require("./uploadGuards").lingerThenClose(req); // the sender is still sending the form: let the answer arrive
  return res.status(429).json({ error: botGuard.MESSAGES.requestsPaused, code: "requests-paused" });
}

module.exports = { beforeBody };
