/**
 * Return tokens for Stripe's success page.
 *
 * Stripe is given a success_url and a cancel_url and sends the buyer's browser to one of
 * them; Stripe therefore sees those URLs. A firm-quote buyer has no account, and the link
 * that lets them accept the quote is a credential, so it must not be in there (review,
 * section 8). The return URL carries the order id and one of these instead: a short-lived
 * token good for exactly one thing — asking "has this order been paid?" for that one order.
 * It cannot open the quote, accept anything, or show who the customer is.
 *
 * Signed with a key derived from JWT_SECRET for this purpose only, with its own audience, so
 * it can never pass as a login or as a quote link, nor the other way round.
 */
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const AUDIENCE = "checkout-return";
const ALGORITHM = "HS256";

function key() {
  return crypto.createHmac("sha256", require("../security/keys").baseSecret()).update("checkout-return-v1").digest();
}

/** @param {string} orderId  @param {number} ttlMinutes how long the token works */
function sign(orderId, ttlMinutes) {
  const minutes = Math.min(48 * 60, Math.max(5, Math.round(Number(ttlMinutes) || 180)));
  return jwt.sign({ o: orderId }, key(), { audience: AUDIENCE, algorithm: ALGORITHM, expiresIn: minutes * 60 });
}

/** @returns {string|null} the order id, or null when the token is forged, expired or for another order */
function verify(token, orderId) {
  try {
    const p = jwt.verify(String(token || ""), key(), { audience: AUDIENCE, algorithms: [ALGORITHM] });
    return p && typeof p.o === "string" && p.o === orderId ? p.o : null;
  } catch {
    return null;
  }
}

module.exports = { sign, verify };
