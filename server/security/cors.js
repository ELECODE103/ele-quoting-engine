/**
 * Cross-origin requests.
 *
 * The session is a cookie now, so this is the list of who may make the
 * browser send it from script and read the answer. It is short on purpose:
 *
 *   - the site's own origin (the page and the API are one origin; a module
 *     script sends an Origin header even then). Scheme, host and port must all
 *     match the request's own;
 *   - FRONTEND_URL, when the front end is ever served from another origin;
 *   - outside production, the two dev-server origins.
 *
 * Anyone else gets no CORS headers at all: no Access-Control-Allow-Origin, no
 * Access-Control-Allow-Credentials, and a preflight that grants nothing, so a
 * page on another site can neither read an answer nor send a request that
 * needs a preflight (anything with JSON, X-CSRF-Token or another custom
 * header). An arbitrary origin is never reflected, in any environment.
 *
 * This is one of three layers that keep another site from acting as a
 * signed-in visitor; the other two do not depend on it:
 *   - the session cookie is SameSite=Strict (and `__Host-`, Secure, HttpOnly in
 *     production), so a browser does not attach it to a cross-site request;
 *   - a cookie session must carry X-CSRF-Token on every request that is not a
 *     GET (security/session.js), which another site can neither read nor guess.
 */
const cors = require("cors");

const DEV_ORIGINS = ["http://localhost:3001", "http://localhost:3000", "http://127.0.0.1:3001", "http://127.0.0.1:3000"];

// Every custom header the app's own pages send (client/src/utils/api.js, security.js).
const ALLOWED_HEADERS = ["Content-Type", "Authorization", "X-CSRF-Token", "X-Human-Token", "X-Form-Token", "X-Turnstile-Token", "X-Part-Key"];
const METHODS = ["GET", "POST", "PUT", "DELETE", "OPTIONS"];

function originOf(url) {
  try { return new URL(url).origin; } catch { return ""; }
}

function configuredOrigins() {
  const list = process.env.NODE_ENV === "production" ? [] : [...DEV_ORIGINS];
  const front = originOf(process.env.FRONTEND_URL || "");
  if (front) list.push(front);
  return list;
}

/** May a page at `origin` call the API with the visitor's credentials? */
function originAllowed(req, origin) {
  if (!origin) return true; // no Origin header: not a cross-origin browser request (curl, server-to-server); nothing is granted either
  const o = originOf(origin);
  if (!o || o === "null") return false;
  // The site itself: same scheme, host and port as this request arrived on.
  if (o === `${req.protocol}://${req.get("host")}`) return true;
  return configuredOrigins().includes(o);
}

function middleware() {
  return (req, res, next) => cors({
    origin: (origin, callback) => callback(null, originAllowed(req, origin)),
    credentials: true,
    methods: METHODS,
    allowedHeaders: ALLOWED_HEADERS,
    maxAge: 86400, // cache a preflight for 24 hours
  })(req, res, next);
}

function install(app) {
  app.use(middleware());
}

module.exports = { install, middleware, originAllowed, configuredOrigins, ALLOWED_HEADERS, METHODS };
