/**
 * One public address for the site.
 *
 *   CANONICAL_HOST   the one host the site lives on, e.g. straightedgemfg.com
 *   REDIRECT_HOSTS   comma-separated hosts that answer with a redirect to the
 *                    same path on CANONICAL_HOST, e.g.
 *                    www.straightedgemfg.com,nordmfg.com,www.nordmfg.com
 *   NOINDEX_HOSTS    optional, comma-separated: extra hosts that serve the site
 *                    but tell search engines not to index it. Railway's own
 *                    host (RAILWAY_PUBLIC_DOMAIN, and anything ending in
 *                    .up.railway.app) is always in this list.
 *   HSTS_ALL_HOSTS   "true" once the cutover is verified: until then the
 *                    Strict-Transport-Security header is sent on CANONICAL_HOST
 *                    only (see below).
 *
 * With CANONICAL_HOST unset nothing is redirected and HSTS is left exactly as
 * security/headers.js set it; only the no-index rule for Railway's host applies.
 *
 * Rules, each with a test in canonicalHost.test.js:
 *
 *   - A redirect goes to https://CANONICAL_HOST and nowhere else. The host in
 *     the Location header is the configured value, never anything from the
 *     request. The path is the request's own, forced to start with exactly one
 *     "/" followed by something that is not a slash or backslash (raw or
 *     percent-encoded), so "//evil.example", "/\evil.example" and
 *     "/%2f/evil.example" cannot become a protocol-relative URL here or at any
 *     later hop. The query string is kept as sent.
 *   - GET and HEAD get 301. Other methods get 308, which keeps the method and
 *     body (a 301 would turn a POST into a GET).
 *   - Never redirected, on any host: the health check (Railway calls it on its
 *     own hostname, and an uptime monitor may call it on any) and the Stripe
 *     webhook (Stripe treats a redirect as a failed delivery, so the endpoint
 *     registered on the old domain keeps working during the switch).
 *   - A host that is neither canonical nor listed is served as before: only
 *     listed hosts redirect, so a typo in REDIRECT_HOSTS cannot take the site
 *     down and Railway's health check host is never bounced.
 *   - HSTS: a browser that sees the header refuses plain HTTP for that host —
 *     and, with includeSubDomains, for every subdomain — for a year. That is a
 *     promise worth making for the canonical host only, until the old domains
 *     and Railway's host are known to be staying on HTTPS. Until HSTS_ALL_HOSTS
 *     is "true", the header is removed from every answer on any other host.
 *
 * Mount with install(app) after security/headers.js (which sets the HSTS
 * header this may remove) and before everything else.
 */
const brand = require("../../shared/brand.json");

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const EXEMPT_PATHS = ["/api/health", "/api/stripe/webhook"];

/** A bare host name from whatever was typed: "https://Example.com/" → "example.com". "" when it is not a host name. */
function cleanHost(value) {
  let v = String(value || "").trim().toLowerCase();
  if (!v || /[\s@\\]/.test(v)) return "";      // nothing with a space, a user part or a backslash is a host name
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // a pasted scheme
  v = v.replace(/[/?#].*$/, "");                // a pasted path
  v = v.replace(/:\d+$/, "");                   // a port
  v = v.replace(/\.$/, "");                     // a trailing dot
  return HOST_RE.test(v) ? v : "";
}

function hostList(value) {
  return String(value || "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Read the settings. Returns what is in force and, in `problems`, anything
 * that was typed but could not be used (shown at startup and on the admin
 * System page).
 */
function readConfig(env = process.env) {
  const problems = [];
  let canonical = cleanHost(env.CANONICAL_HOST);
  if (env.CANONICAL_HOST && !canonical) problems.push("CANONICAL_HOST is set but is not a host name (expected something like straightedgemfg.com): it is ignored and nothing is redirected.");
  // server/seo.js already sends www.<brand domain> to the bare domain. A canonical host of
  // www.<brand domain> would send it straight back: refuse that setting instead of looping.
  if (canonical && canonical === `www.${brand.domain}`) {
    problems.push(`CANONICAL_HOST is www.${brand.domain}, but the site's pages, sitemap and canonical tags are built for ${brand.domain} and www is already redirected to it: the setting is ignored and nothing is redirected. Use CANONICAL_HOST=${brand.domain}.`);
    canonical = "";
  }

  const redirects = new Set();
  for (const raw of hostList(env.REDIRECT_HOSTS)) {
    const h = cleanHost(raw);
    if (!h) { problems.push("REDIRECT_HOSTS has an entry that is not a host name: that entry is ignored."); continue; }
    if (h === canonical) continue; // never redirect the canonical host to itself
    redirects.add(h);
  }
  if (redirects.size && !canonical) {
    problems.push("REDIRECT_HOSTS is set but CANONICAL_HOST is not: there is nowhere to redirect to, so nothing is redirected.");
    redirects.clear();
  }

  const noindex = new Set();
  for (const raw of hostList(env.NOINDEX_HOSTS)) {
    const h = cleanHost(raw);
    if (!h) { problems.push("NOINDEX_HOSTS has an entry that is not a host name: that entry is ignored."); continue; }
    if (h === canonical) { problems.push("NOINDEX_HOSTS lists the canonical host: that entry is ignored (the live site must stay indexable)."); continue; }
    noindex.add(h);
  }
  const railway = cleanHost(env.RAILWAY_PUBLIC_DOMAIN);
  // RAILWAY_PUBLIC_DOMAIN is "the public service or customer domain": once a custom domain is attached it can be
  // the custom domain itself, so it is added only when it is not one of the hosts the site is meant to be found on.
  if (railway && railway !== canonical && !redirects.has(railway) && /\.railway\.app$/.test(railway)) noindex.add(railway);

  if (canonical && env.FRONTEND_URL) {
    const front = cleanHost(env.FRONTEND_URL);
    if (front && front !== canonical) problems.push("FRONTEND_URL and CANONICAL_HOST name different hosts: links in emails and Stripe's return pages use FRONTEND_URL, so a buyer would land on one host and be redirected to the other. Make them agree.");
  }

  return {
    canonical,
    redirects,
    noindex,
    hstsAllHosts: String(env.HSTS_ALL_HOSTS || "").trim().toLowerCase() === "true",
    problems,
  };
}

/** The request's own host, lower-case, without a port. Taken from Host, not from X-Forwarded-Host, which a client can set. */
function requestHost(req) {
  const raw = String((req.headers && req.headers.host) || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("[")) return raw.replace(/\]:\d+$/, "]"); // an IPv6 literal
  return raw.replace(/:\d+$/, "").replace(/\.$/, "");
}

function isRailwayHost(host) {
  return /\.up\.railway\.app$/.test(host) || /\.railway\.internal$/.test(host);
}

/** The health check and the Stripe webhook answer on every host. */
function isExemptPath(pathname) {
  const p = String(pathname || "").toLowerCase().replace(/\/+$/, "");
  return EXEMPT_PATHS.some((e) => p === e || p.startsWith(`${e}/`));
}

// A leading run of slashes and backslashes, raw or percent-encoded (%2f, %5c), in any mix.
const LEADING_SEPARATORS = /^(?:[/\\]|%2f|%5c)+/i;

/**
 * The path and query to put after https://CANONICAL_HOST.
 * Always starts with exactly one "/"; what follows is never a slash or a
 * backslash, raw or encoded. Control characters are removed. The query string
 * (from the first "?") is kept as it was sent.
 */
function safeTarget(originalUrl) {
  // eslint-disable-next-line no-control-regex
  let url = String(originalUrl || "/").replace(/[\u0000- \u007f]/g, "");
  const hash = url.indexOf("#");
  if (hash !== -1) url = url.slice(0, hash); // a fragment never arrives in a request; if one does, drop it
  const q = url.indexOf("?");
  let pathname = q === -1 ? url : url.slice(0, q);
  const query = q === -1 ? "" : url.slice(q);
  // An absolute-form request target ("GET http://other.example/x") or anything else not starting with "/": the root.
  if (!pathname.startsWith("/") && !pathname.startsWith("\\") && !/^%(?:2f|5c)/i.test(pathname)) pathname = "/";
  pathname = `/${pathname.replace(LEADING_SEPARATORS, "")}`;
  // A backslash anywhere in the path goes out percent-encoded (relaunch integration, 2026-11-12). The authority
  // of the Location is fixed before the first "/", so one further in was never a way off the site — but a
  // browser reads "\" as "/", and the path normaliser on the canonical host (server/seo.js) refuses to emit a
  // path with one. Encoded, the two layers agree: no Location this site sends carries a raw backslash.
  pathname = pathname.replace(/\\/g, "%5C");
  return pathname + query;
}

function redirectLocation(canonical, originalUrl) {
  return `https://${canonical}${safeTarget(originalUrl)}`;
}

// Which host names requests have arrived for since the process started (at most 20 names, health checks left out).
// Shown on Admin → System: after cutover the canonical host must be in this list. If it is not, either DNS does not
// point here yet or the platform is not passing the visitor's Host header through.
const hostsSeen = new Map();
function noteHost(host) {
  const name = cleanHost(host) || (/^[\d.]+$|^\[/.test(host) ? "(an IP address)" : "(not a host name)");
  if (hostsSeen.has(name)) hostsSeen.set(name, hostsSeen.get(name) + 1);
  else if (hostsSeen.size < 20) hostsSeen.set(name, 1);
}
function seenHosts() {
  return [...hostsSeen.entries()].map(([host, requests]) => ({ host, requests })).sort((a, b) => b.requests - a.requests);
}

/**
 * @param {object} [opt]
 * @param {object} [opt.env] settings to read instead of process.env (tests)
 */
function middleware(opt = {}) {
  const cfg = opt.config || readConfig(opt.env || process.env);
  return function canonicalHost(req, res, next) {
    const host = requestHost(req);
    const canonical = cfg.canonical;
    if (!isExemptPath(req.path)) noteHost(host);

    // HSTS on the canonical host only, until the owner says every host is staying on HTTPS.
    if (canonical && !cfg.hstsAllHosts && host !== canonical) res.removeHeader("Strict-Transport-Security");

    if (canonical && cfg.redirects.has(host) && !isExemptPath(req.path)) {
      const status = req.method === "GET" || req.method === "HEAD" ? 301 : 308;
      res.setHeader("Cache-Control", "public, max-age=3600"); // an hour: long enough to help, short enough to undo
      res.setHeader("X-Robots-Tag", "noindex");
      return res.redirect(status, redirectLocation(canonical, req.originalUrl));
    }

    // Railway's own host (and any host listed in NOINDEX_HOSTS) serves the site but is kept out of search results.
    if (host && host !== canonical && (cfg.noindex.has(host) || isRailwayHost(host))) {
      res.setHeader("X-Robots-Tag", "noindex, nofollow");
      // seo.js sets its own X-Robots-Tag ("noindex") on some pages afterwards; either value keeps the page out.
    }
    next();
  };
}

/** One line for the startup log, and the problems (if any) as warnings. */
function describe(cfg = readConfig()) {
  const lines = [];
  if (!cfg.canonical) lines.push("[hosts] CANONICAL_HOST is not set: no host is redirected; Railway's own host is marked noindex.");
  else {
    lines.push(`[hosts] canonical host ${cfg.canonical}; redirecting to it: ${cfg.redirects.size ? [...cfg.redirects].join(", ") : "(none listed in REDIRECT_HOSTS)"}; noindex on ${cfg.noindex.size ? [...cfg.noindex].join(", ") : "any *.up.railway.app host"}; HSTS ${cfg.hstsAllHosts ? "on every host (HSTS_ALL_HOSTS=true)" : "on the canonical host only"}.`);
  }
  return { lines, warnings: cfg.problems.map((p) => `WARNING: ${p}`) };
}

function install(app, opt = {}) {
  const cfg = opt.config || readConfig(opt.env || process.env);
  app.use(middleware({ config: cfg }));
  return cfg;
}

module.exports = { install, middleware, readConfig, describe, cleanHost, requestHost, isExemptPath, safeTarget, redirectLocation, isRailwayHost, seenHosts, EXEMPT_PATHS };
