/**
 * Who may fetch a part's 3D preview or geometry detail
 * (GET /api/parts/:partId/mesh, GET /api/parts/:partId/geometry).
 *
 * There is ONE rule for "may this caller use this part", and it lives in
 * security/partAccess.js (`canUse`): the account the part belongs to; for a
 * part uploaded without an account, whoever holds its edit key (the key the
 * upload answer, and the quote-session answer behind the quote's own access
 * check, hand to the browser that holds the part); an admin, any part. The
 * preview routes ask that rule and nothing else. This file only says where a
 * request carries the key.
 */
const partAccess = require("./partAccess");

/** The edit key a request carries: the X-Part-Key header (what the site sends) or ?key= (a plain link). */
function partKeyFrom(req) {
  const header = req.headers && req.headers["x-part-key"];
  if (typeof header === "string" && header) return header;
  const q = req.query && req.query.key;
  return typeof q === "string" ? q : "";
}

/**
 * @param {object} req   the request (req.user when signed in)
 * @param {object} part  the part row (needs id and userId)
 * @returns {boolean}
 */
function mayReadPart(req, part) {
  return partAccess.canUse(part, { user: req.user, key: partKeyFrom(req) });
}

module.exports = { mayReadPart, partKeyFrom };
