/**
 * One key per client for rate limits, upload budgets and parse fairness.
 *
 * `req.ip` is the address Express takes from X-Forwarded-For after skipping the
 * trusted proxy hops (Railway's edge = 1, see TRUST_PROXY_HOPS). Two fixes on
 * top of it:
 *   - an IPv4 address written as IPv6 (::ffff:203.0.113.9) is the same client
 *     as 203.0.113.9
 *   - an IPv6 client owns a whole /64 (2^64 addresses) and can hop between
 *     them for free, so the key is the /64 prefix, not the single address
 */
const net = require("net");

function expandV6(addr) {
  let a = addr.split("%")[0];
  // dotted quad tail (::ffff:1.2.3.4) → two hex groups
  const m = a.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) a = `${m[1]}${((+m[2] << 8) | +m[3]).toString(16)}:${((+m[4] << 8) | +m[5]).toString(16)}`;
  const [head, tail] = a.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const fill = tail !== undefined ? new Array(Math.max(0, 8 - h.length - t.length)).fill("0") : [];
  return [...h, ...fill, ...t].map((g) => (parseInt(g, 16) || 0));
}

/** Normalised client key for an address string. */
function keyForAddress(address) {
  const raw = String(address || "").trim();
  if (!raw) return "unknown";
  if (net.isIPv4(raw)) return raw;
  if (net.isIPv6(raw.split("%")[0])) {
    const g = expandV6(raw);
    // ::ffff:a.b.c.d — an IPv4 client seen through a dual-stack socket
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
      return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
    }
    return `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
  }
  return raw.slice(0, 64);
}

/** Key for a request (express-rate-limit keyGenerator signature). */
function clientKey(req) {
  return keyForAddress(req.ip || (req.socket && req.socket.remoteAddress));
}

module.exports = { clientKey, keyForAddress };
