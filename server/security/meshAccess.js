/**
 * Who may fetch a part's 3D preview (GET /api/parts/:partId/mesh).
 *
 * ONE function, on purpose: the rule for "may this caller use this part" is
 * being tightened on another branch (review-fixes: security/partAccess.js,
 * `canUse(part, { user, key })`). When the two are merged, the body of
 * mayReadPart() becomes
 *
 *     return require("./partAccess").canUse(part, { user: req.user, key: partKeyFrom(req) });
 *
 * and nothing else in the mesh route changes.
 *
 * The rule on this branch is the one the part already has: a part is opened by
 * its edit key — the key the upload answer (and the quote-session answer, which
 * sits behind the quote's own access check) hands to the browser that holds
 * the part. The part id alone is not enough, and an admin may read any part.
 */
const tokens = require("./tokens");

/** The edit key a request carries: the X-Part-Key header (what the site sends) or ?key= (a plain link). */
function partKeyFrom(req) {
  const header = req.headers && req.headers["x-part-key"];
  if (typeof header === "string" && header) return header;
  const q = req.query && req.query.key;
  return typeof q === "string" ? q : "";
}

/**
 * @param {object} req   the request (req.user when signed in)
 * @param {object} part  the part row (needs id)
 * @returns {boolean}
 */
function mayReadPart(req, part) {
  if (!part || !part.id) return false;
  if (req.user && req.user.role === "admin") return true;
  return tokens.partEditKeyOk(part.id, partKeyFrom(req));
}

module.exports = { mayReadPart, partKeyFrom };
