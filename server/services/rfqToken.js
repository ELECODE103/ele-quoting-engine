/**
 * Signed, expiring links for firm quotes.
 *
 * The customer accepts a quoted RFQ from an emailed link without an account,
 * so the link itself is the credential: a JWT naming the RFQ, expiring with
 * the quote's validity date, and stamped with the send time so re-sending a
 * revised quote kills the older link.
 *
 * It is signed with a key derived from JWT_SECRET (not JWT_SECRET itself), so
 * a quote link can never pass as a login token or the other way round.
 */
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const AUDIENCE = "rfq-quote";

const ALGORITHM = "HS256"; // signed and verified with this one algorithm, named on both sides

function key() {
  return crypto.createHmac("sha256", require("../security/keys").baseSecret()).update("rfq-quote-link-v1").digest();
}

/** @param {{id:string, quoteSentAt:string, validUntil:string}} rfq */
function sign(rfq) {
  const exp = Math.floor(new Date(rfq.validUntil).getTime() / 1000);
  return jwt.sign({ rfqId: rfq.id, v: rfq.quoteSentAt, exp }, key(), { audience: AUDIENCE, algorithm: ALGORITHM });
}

/**
 * @returns {{rfqId:string, v:string, expired:boolean}|null} null when the token
 * is forged or malformed. An expired token still verifies (with `expired`) so
 * the caller can say "this quote expired" instead of "bad link".
 */
function verify(token) {
  try {
    const p = jwt.verify(String(token || ""), key(), { audience: AUDIENCE, algorithms: [ALGORITHM], ignoreExpiration: true });
    if (!p || !p.rfqId || !p.exp) return null;
    return { rfqId: p.rfqId, v: p.v, expired: p.exp * 1000 < Date.now() };
  } catch {
    return null;
  }
}

module.exports = { sign, verify };
