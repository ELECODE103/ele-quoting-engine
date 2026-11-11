/**
 * What may go into a log line about a request.
 *
 * Some URLs are credentials: a firm-quote link carries a signed token in its
 * path (/api/rfq/quote/<token>/accept, /firm-quote/<token>), and a query
 * string can carry anything. A log line names the route, not the secret.
 */
const JWT = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

/** A request URL safe to log: no query string, no tokens, no long opaque segments. */
function redactUrl(url) {
  const pathOnly = String(url || "").split("?")[0].split("#")[0].slice(0, 300);
  return pathOnly
    .replace(JWT, "[token]")
    .split("/")
    .map((seg) => (seg.length > 64 ? "[redacted]" : seg))
    .join("/")
    // the segment after /quote/ on the RFQ routes and after /firm-quote/ is always a token, whatever it looks like
    .replace(/(\/rfq\/quote\/|\/firm-quote\/)[^/]+/g, "$1[token]")
    .replace(/[\u0000-\u001f\u007f]/g, "");
}

module.exports = { redactUrl };
