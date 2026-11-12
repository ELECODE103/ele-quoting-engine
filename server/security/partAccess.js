/**
 * Who may use an uploaded part (independent review 2026-11-11, F5).
 *
 * A part id used to be all it took: anyone who learned one could put the part
 * in a quote of their own, read its measurements, file name and preview, and
 * be handed its edit key. Now a part belongs to whoever uploaded it:
 *
 *   uploaded while signed in   the account, and only the account
 *   uploaded without one       whoever holds the part's edit key — the key the
 *                              upload answer gave the uploader's browser. When
 *                              that visitor signs in (or registers) and prices
 *                              or buys the quote, the part is claimed by the
 *                              account and the key alone stops being enough.
 *
 * Admins may use any part. `allowAnonymous` is for the server pricing a stored
 * quote again (checkout, reorder): a part with no owner was authorised when it
 * went into that quote, so the quote or order the caller owns stands in for
 * the key. It never opens a part that belongs to another account.
 */
const tokens = require("./tokens");

const isAdmin = (user) => Boolean(user && user.role === "admin");

/**
 * @param {object} part    the part row (needs id and userId)
 * @param {object} who     { user, key, allowAnonymous }
 */
function canUse(part, { user = null, key = "", allowAnonymous = false } = {}) {
  if (!part || !part.id) return false;
  if (isAdmin(user)) return true;
  if (part.userId) return Boolean(user && user.userId === part.userId);
  return allowAnonymous === true || tokens.partEditKeyOk(part.id, key);
}

/**
 * Bind a part nobody owns yet to the signed-in account that has just shown it may use it.
 * Only the row is written (partsDB.setOwner): the part's measurements are not read again. The part
 * handed in is marked too, so a quote that names one part on many lines claims it once.
 */
function claim(part, user, partsDB) {
  if (!part || part.userId || !user || !user.userId) return part;
  if (typeof partsDB.setOwner === "function") partsDB.setOwner(part.id, user.userId);
  else partsDB.update(part.id, { userId: user.userId, ownerId: user.userId });
  part.userId = user.userId;
  part.ownerId = user.userId;
  return part;
}

module.exports = { canUse, claim, isAdmin };
