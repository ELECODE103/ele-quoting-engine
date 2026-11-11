/**
 * Stand-in for Cloudflare's Turnstile widget script, for browser runs in a
 * sandbox that cannot reach challenges.cloudflare.com.
 *
 * It is served to the browser for the real URL
 * (https://challenges.cloudflare.com/turnstile/v0/api.js), so it only runs
 * because the page's Content-Security-Policy allows that host in script-src,
 * and, like the real widget, it opens a frame on that host (frame-src). It
 * draws a box, waits a moment and hands the page a token that starts with
 * "e2e-pass", which the server-side stub (stub-network.cjs) accepts.
 *
 * What it does not prove: Cloudflare's own behaviour. That needs real keys.
 */
const TURNSTILE_STUB = `
(function () {
  var n = 0, widgets = {};
  function issue(id) {
    var w = widgets[id]; if (!w) return;
    // The real widget lives in a frame on Cloudflare's host: open one, so frame-src is exercised too.
    if (!w.frame) { w.frame = document.createElement('iframe'); w.frame.src = 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/stand-in'; w.frame.title = 'test stand-in frame'; w.frame.width = 1; w.frame.height = 1; w.frame.setAttribute('aria-hidden', 'true'); document.body.appendChild(w.frame); }
    w.el.innerHTML = '<div style="border:1px solid #d6d3cb;border-radius:6px;padding:14px 16px;font:14px sans-serif;background:#fafafa;display:flex;gap:10px;align-items:center;max-width:300px"><span style="width:22px;height:22px;border-radius:50%;border:3px solid #cbd5e1;border-top-color:#101C33;display:inline-block"></span>Verifying you are human… (test stand-in)</div>';
    clearTimeout(w.timer);
    w.timer = setTimeout(function () {
      if (!widgets[id]) return;
      w.el.innerHTML = '<div style="border:1px solid #d6d3cb;border-radius:6px;padding:14px 16px;font:14px sans-serif;background:#fafafa;display:flex;gap:10px;align-items:center;max-width:300px"><span style="color:#059669;font-size:20px">✓</span>Success! (test stand-in)</div>';
      w.opts.callback('e2e-pass-' + (++n) + '-' + Date.now());
    }, window.__turnstileDelay == null ? 350 : window.__turnstileDelay);
  }
  window.turnstile = {
    render: function (el, opts) { var id = 'w' + (++n); widgets[id] = { el: el, opts: opts }; issue(id); return id; },
    reset: function (id) { issue(id); },
    remove: function (id) { var w = widgets[id]; if (w) { clearTimeout(w.timer); w.el.innerHTML = ''; if (w.frame) w.frame.remove(); delete widgets[id]; } },
    getResponse: function () { return ''; }
  };
})();`;

/** Serve the stand-in (and an empty document for its frame) for every request to Cloudflare's host. */
async function routeStandIn(context) {
  await context.route("https://challenges.cloudflare.com/**", (route) => (route.request().resourceType() === "script"
    ? route.fulfill({ status: 200, contentType: "application/javascript", body: TURNSTILE_STUB })
    : route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>stand-in</title>" })));
}

module.exports = { TURNSTILE_STUB, routeStandIn };
