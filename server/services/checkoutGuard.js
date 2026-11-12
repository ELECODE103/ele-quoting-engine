/**
 * Small pieces the order routes call so the route bodies stay as they are
 * (review fixes 2026-11-11):
 *
 *   limiter        a modest per-account ceiling on asking for a checkout (F8)
 *   pricedSnapshot what was priced for one order line — fingerprint, units and
 *                  dimensions — kept in the order item so the traveler can always
 *                  be checked against what was charged (F2)
 *   checkAgainst   compare an order item's snapshot with the part as stored now
 */
const { createThrottle } = require("../security/throttle");
const { limits } = require("../security/limits");
const quoteIntegrity = require("./quoteIntegrity");

const WINDOW_MS = 15 * 60 * 1000;
let attempts = createThrottle({ windowMs: WINDOW_MS, max: Number.MAX_SAFE_INTEGER }); // counted here; the ceiling is read per request

/** Checkout requests one account may make in 15 minutes (CHECKOUT_PER_ACCOUNT_15MIN, default 12). */
function max() {
  return limits.rateCheckoutPerAccount15Min;
}

/** Express middleware, after `authenticate`. Counted per account, wherever the requests come from. */
function limiter(req, res, next) {
  const key = req.user && req.user.userId;
  if (!key) return next();
  if (attempts.peek(key).count >= max()) {
    res.set("Retry-After", "300");
    return res.status(429).json({ error: "That's a lot of checkout attempts in a short time. Wait a few minutes and try again, or call us and we'll take the order by phone.", code: "checkout-rate-limited" });
  }
  attempts.hit(key);
  next();
}

function resetForTests() {
  attempts.reset();
}

/** The snapshot of line `index` of a priced quote (routes/api.js priceQuote → integrity), or null. */
function pricedSnapshot(priced, index, basis) {
  const line = priced && priced.integrity && Array.isArray(priced.integrity.lines) ? priced.integrity.lines[index] : null;
  if (!line) return null;
  return { fingerprint: line.fingerprint, quoteFingerprint: priced.integrity.fingerprint, basis: basis || "current", pricedAt: priced.integrity.pricedAt, ...line.snapshot };
}

/**
 * Does the part, as stored now, still match what this order line was priced from?
 * @returns {null | {matches: boolean, priced: object}} null when the line has no snapshot (an older order, a firm quote)
 */
function checkAgainst(item, part) {
  const priced = item && item.config && item.config.priced;
  if (!priced || !priced.geometryHash) return null;
  if (!part || !part.geometry) return { matches: false, priced };
  return { matches: quoteIntegrity.geometryHash(part.geometry) === priced.geometryHash, priced };
}

/**
 * The Checkout session to send the buyer to for an unpaid order made from an instant quote (F8).
 *
 * Sessions are made in exactly one place: orderLifecycle.openSession (through
 * orderEvents.createCheckoutSession → orderLifecycle.checkoutSession). That function already hands
 * out the order's open session while it is still good — open at Stripe, made for today's
 * expectedCharge(order), same return pages, same promotion-code setting, not about to expire —
 * closes it at Stripe before making another, and settles the order instead when Stripe says the
 * old session was paid. This used to do a lighter version of the same on its own; it now calls
 * through, so there is one rule and never two payable pages.
 *
 * @returns {Promise<{session: object, reused: boolean, paid: boolean}>} `paid`: Stripe had the
 *   earlier session as paid; the order was settled and `session.url` is the success page.
 */
async function sessionFor(order, opts) {
  const session = await require("./orderEvents").createCheckoutSession(order, opts);
  return { session, reused: Boolean(session && session.reused), paid: Boolean(session && session.alreadyPaid) };
}

module.exports = { limiter, resetForTests, pricedSnapshot, checkAgainst, sessionFor, WINDOW_MS };
