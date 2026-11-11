/**
 * The token of an emailed link, from the URL fragment ("#token=…").
 * A fragment is never sent to the server and never appears in a Referer
 * header or an access log, which is why account links carry it there.
 */
export function tokenFromHash(hash) {
  const m = /(?:^#|&)token=([^&]+)/.exec(String(hash || ''));
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch { return ''; }
}
