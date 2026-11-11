/**
 * The base URL for links we email about an account (confirm your email, reset
 * your password). These links carry a credential, so the host is never taken
 * on trust from the request: FRONTEND_URL when it is set; otherwise the
 * request's host only if it is one of ours; otherwise the brand's own URL.
 * A forged Host header therefore cannot aim a reset link at another site.
 */
const brand = require("../../shared/brand.json");

function ownHosts() {
  const hosts = new Set([brand.domain, `www.${brand.domain}`, "nordmfg.com", "www.nordmfg.com"]);
  if (process.env.RAILWAY_PUBLIC_DOMAIN) hosts.add(process.env.RAILWAY_PUBLIC_DOMAIN.toLowerCase());
  return hosts;
}

function accountLinkBase(req) {
  if (process.env.FRONTEND_URL) return process.env.FRONTEND_URL.replace(/\/$/, "");
  const host = String((req && req.get && req.get("host")) || "").toLowerCase();
  if (process.env.NODE_ENV !== "production" && host) return `${req.protocol}://${host}`;
  if (host && ownHosts().has(host)) return `https://${host}`;
  return brand.url;
}

module.exports = { accountLinkBase, ownHosts };
