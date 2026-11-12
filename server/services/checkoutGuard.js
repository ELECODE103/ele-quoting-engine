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
 * The Checkout session to send the buyer to for an unpaid order made from an
 * instant quote: the one the order already has, when Stripe says it is still
 * open, unpaid and for today's expected charge and the same return pages;
 * otherwise a new one (orderEvents.createCheckoutSession). A buyer who comes
 * back from Stripe and presses pay again — or a script that keeps asking —
 * gets the same session instead of a new one every time (F8).
 *
 * If Stripe says the existing session has been paid, no second session is made:
 * `{ paid: true }` comes back and the caller sends the buyer to the order page,
 * where the payment is confirmed the usual way.
 *
 * @returns {Promise<{session: object|null, reused: boolean, paid: boolean}>}
 */
async function sessionFor(order, opts) {
  const stripeClient = require("./stripeClient");
  const orderEvents = require("./orderEvents");
  const { expectedCharge } = require("./expectedCharge");
  const stripe = stripeClient.get();
  if (stripe && order.stripeSessionId) {
    let existing = null;
    try { existing = await stripe.checkout.sessions.retrieve(order.stripeSessionId); } catch { existing = null; }
    if (existing && existing.payment_status === "paid") return { session: existing, reused: true, paid: true };
    if (existing && typeof existing.url === "string" && existing.url) {
      const open = (existing.status === undefined || existing.status === null || existing.status === "open")
        && (!existing.expires_at || existing.expires_at * 1000 > Date.now() + 5 * 60 * 1000);
      const amount = existing.amount_subtotal ?? existing.amount_total;
      const sameAmount = Number.isInteger(amount) && amount === expectedCharge(order).cents;
      const samePages = (existing.success_url === undefined || existing.success_url === opts.successUrl)
        && (existing.cancel_url === undefined || existing.cancel_url === opts.cancelUrl);
      if (open && sameAmount && samePages) return { session: existing, reused: true, paid: false };
    }
  }
  return { session: await orderEvents.createCheckoutSession(order, opts), reused: false, paid: false };
}

module.exports = { limiter, resetForTests, pricedSnapshot, checkAgainst, sessionFor, WINDOW_MS };
