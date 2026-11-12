/**
 * Browser security headers on the real server, and a scan of the built pages
 * for anything the policy would have to be loosened for. The in-browser proof
 * (every page, zero violations) is tools/security/csp-browser-check.js.
 * Run: node server/security/headers.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { runner } = require("../testSupport/harness");
const live = require("../testSupport/liveServer");

const { test, run } = runner("Security headers (live server)");
let s;
const directives = (csp) => Object.fromEntries(csp.split(";").map((d) => d.trim()).filter(Boolean).map((d) => { const [name, ...rest] = d.split(/\s+/); return [name, rest]; }));

test("Content-Security-Policy: no inline script, no eval, no Google Fonts, frames denied — on pages and on the API", async () => {
  s = await live.start({});
  for (const url of ["/", "/quote", "/admin", "/materials/peek", "/no-such-page", "/api/health", "/api/materials", "/api/nope"]) {
    const r = await s.get(url);
    const csp = r.headers["content-security-policy"];
    assert.ok(csp, `${url} has a Content-Security-Policy`);
    assert.ok(!r.headers["content-security-policy-report-only"], "enforced, not report-only");
    const d = directives(csp);
    assert.deepStrictEqual(d["default-src"], ["'self'"]);
    assert.deepStrictEqual(d["script-src"], ["'self'", "https://challenges.cloudflare.com"], `${url}: script-src is ${d["script-src"]}`);
    assert.deepStrictEqual(d["script-src-attr"], ["'none'"]);
    // Stylesheets from /assets only. (A served static page with its own <style> block would add that block's
    // SHA-256; the only such pages, the internal brand sheets, are no longer served, so there is none.)
    assert.deepStrictEqual(d["style-src-elem"], ["'self'"], `${url}: style-src-elem is ${d["style-src-elem"]}`);
    assert.deepStrictEqual([...new Set(d["font-src"])], ["'self'"], `${url}: font-src is ${d["font-src"]}`);
    assert.deepStrictEqual(d["connect-src"], ["'self'"]);
    assert.deepStrictEqual(d["frame-src"], ["https://challenges.cloudflare.com"]);
    assert.deepStrictEqual(d["frame-ancestors"], ["'none'"]);
    assert.deepStrictEqual(d["object-src"], ["'none'"]);
    assert.deepStrictEqual(d["base-uri"], ["'self'"]);
    assert.deepStrictEqual(d["form-action"], ["'self'"]);
    assert.ok("upgrade-insecure-requests" in d);
    for (const [name, sources] of Object.entries(d)) {
      assert.ok(!sources.includes("'unsafe-eval'") && !sources.includes("'wasm-unsafe-eval'"), `${name} allows eval`);
      if (name.startsWith("script")) assert.ok(!sources.includes("'unsafe-inline'"), `${name} allows inline script`);
      assert.ok(!sources.some((x) => /googleapis|gstatic|\*/.test(x)), `${name} lists a host that is no longer used: ${sources}`);
    }
    // 'unsafe-inline' survives in exactly two places: style attributes, and the style-src fallback old browsers read.
    assert.deepStrictEqual(Object.entries(d).filter(([, v]) => v.includes("'unsafe-inline'")).map(([k]) => k).sort(), ["style-src", "style-src-attr"]);
  }
});

test("Referrer-Policy, Permissions-Policy, frame, sniffing and transport headers", async () => {
  const r = await s.get("/");
  assert.strictEqual(r.headers["referrer-policy"], "strict-origin-when-cross-origin");
  assert.strictEqual(r.headers["x-frame-options"], "DENY");
  assert.strictEqual(r.headers["x-content-type-options"], "nosniff");
  assert.ok(/max-age=31536000/.test(r.headers["strict-transport-security"]) && /includeSubDomains/.test(r.headers["strict-transport-security"]));
  assert.strictEqual(r.headers["cross-origin-opener-policy"], "same-origin");
  assert.ok(!r.headers["x-powered-by"], "the framework is not advertised");
  const pp = r.headers["permissions-policy"];
  for (const feature of ["camera", "microphone", "geolocation", "payment", "usb"]) assert.ok(new RegExp(`${feature}=\\(\\)`).test(pp), `${feature} is switched off`);
});

test("API answers are never cached; hashed assets still are", async () => {
  for (const url of ["/api/materials", "/api/health", "/api/quote/00000000-0000-4000-8000-000000000000"]) {
    assert.strictEqual((await s.get(url)).headers["cache-control"], "no-store", url);
  }
  const html = (await s.get("/")).text;
  const asset = (html.match(/\/assets\/[^"]+\.js/) || [])[0];
  assert.ok(asset, "the page references a hashed script");
  assert.ok(/immutable/.test((await s.get(asset)).headers["cache-control"]));
});

test("CORS: another site's origin gets no access; the site's own origin does", async () => {
  const evil = await s.get("/api/materials", { headers: { Origin: "https://evil.example" } });
  assert.strictEqual(evil.headers["access-control-allow-origin"], undefined, "no CORS grant for a foreign origin");
  const pre = await s.req({ url: "/api/quote", method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
  assert.strictEqual(pre.headers["access-control-allow-origin"], undefined);
  const own = await s.get("/api/materials", { headers: { Origin: s.base } });
  assert.strictEqual(own.headers["access-control-allow-origin"], s.base);
  const nullOrigin = await s.get("/api/materials", { headers: { Origin: "null" } });
  assert.strictEqual(nullOrigin.headers["access-control-allow-origin"], undefined, "a sandboxed frame or file:// page is not trusted");
});

test("CORS for cookie sessions: our own origin may send credentials and the app's headers; nobody else is granted anything", async () => {
  const wanted = ["Content-Type", "Authorization", "X-CSRF-Token", "X-Human-Token", "X-Form-Token", "X-Turnstile-Token", "X-Part-Key"];
  const own = await s.req({ url: "/api/auth/profile", method: "OPTIONS", headers: { Origin: s.base, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "content-type,x-csrf-token" } });
  assert.strictEqual(own.headers["access-control-allow-origin"], s.base);
  assert.strictEqual(own.headers["access-control-allow-credentials"], "true");
  const allowed = String(own.headers["access-control-allow-headers"]).split(",").map((h) => h.trim().toLowerCase());
  for (const h of wanted) assert.ok(allowed.includes(h.toLowerCase()), `${h} is not in Access-Control-Allow-Headers (${own.headers["access-control-allow-headers"]})`);
  assert.ok(!allowed.includes("*"));
  assert.ok(/\bOrigin\b/i.test(own.headers.vary || ""), "answers vary by Origin, so a cache cannot hand one origin's grant to another");
  // The same host over another scheme or port is another origin.
  for (const origin of [s.base.replace("http://", "https://"), `http://127.0.0.1:${s.port + 1}`, `http://localhost:${s.port}`, "https://evil.example", "https://straightedgemfg.com.evil.example", "null"]) {
    for (const method of ["OPTIONS", "GET"]) {
      const r = await s.req({ url: "/api/auth/session", method, headers: { Origin: origin, ...(method === "OPTIONS" ? { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-csrf-token" } : {}) } });
      for (const h of ["access-control-allow-origin", "access-control-allow-credentials", "access-control-allow-headers", "access-control-allow-methods"]) {
        assert.strictEqual(r.headers[h], undefined, `${method} from ${origin}: ${h} = ${r.headers[h]}`);
      }
    }
  }
});

test("a page on another site cannot make a signed-in visitor's browser change anything", async () => {
  const cube = fs.readFileSync(path.join(live.ROOT, "tools", "vet-quotes", "parts", "cube_20mm.stl"));
  const victim = await s.register("victim@example.com", { ip: "203.0.113.60" });
  const evil = { Origin: "https://evil.example", Referer: "https://evil.example/win-a-prize" };
  // 1. The session cookie is one a browser will not attach to a cross-site request at all.
  const login = await s.post("/api/auth/login", { email: "victim@example.com", password: s.passwords["victim@example.com"] }, { ip: "203.0.113.60" });
  const setCookie = [].concat(login.headers["set-cookie"] || []).join("\n");
  assert.ok(/^__Host-se_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/m.test(setCookie), setCookie.replace(/=[^;]+;/, "=…;"));
  // 2. Suppose a browser sent it anyway (an old one, or a bug). Everything the other site can
  //    send without a preflight — a form post, a text/plain body, a bodyless request — is refused,
  //    with or without a made-up CSRF header, and nothing changes.
  const cookie = await s.browser(login.body.token, { csrf: false });
  const profile = () => s.get("/api/auth/profile", { token: victim }).then((r) => r.body);
  const before = await profile();
  const up = await s.upload([{ name: "cube.stl", data: cube }], { ip: "203.0.113.60", token: victim });
  const mats = (await s.get("/api/materials?process=cnc")).body;
  const quote = await s.post("/api/quote", { parts: [{ partId: up.body.parts[0].partId, materialSlug: mats[0].slug, quantity: 1, process: "cnc", subProcess: "milling" }] }, { token: victim });
  const attempts = [
    ["PUT", "/api/auth/profile", "application/x-www-form-urlencoded", "name=Pwned&company=Evil"],
    ["PUT", "/api/auth/profile", "text/plain", JSON.stringify({ name: "Pwned" })],
    ["PUT", "/api/auth/profile", "application/json", JSON.stringify({ name: "Pwned" })],
    ["POST", "/api/auth/logout-all", "text/plain", ""],
    ["POST", "/api/auth/verify-email/resend", "text/plain", ""],
    ["POST", "/api/orders/checkout-session", "application/x-www-form-urlencoded", `quoteId=${quote.body.quoteId}&shippingName=Evil&shippingAddress=1+Evil+St&shippingCity=X&shippingState=IL&shippingZip=60000`],
    ["POST", "/api/orders/checkout-session", "text/plain", JSON.stringify({ quoteId: quote.body.quoteId, shippingName: "Evil", shippingAddress: "1 Evil St", shippingCity: "X", shippingState: "IL", shippingZip: "60000" })],
    ["DELETE", `/api/quote/${quote.body.quoteId}/drawing`, "text/plain", ""],
  ];
  for (const [method, url, type, body] of attempts) {
    for (const extra of [{}, { "X-CSRF-Token": "guessed" }]) {
      const r = await s.req({ method, url, ip: "203.0.113.61", headers: { ...cookie, ...evil, "Content-Type": type, ...extra }, body: Buffer.from(body) });
      assert.ok([401, 403, 404, 415].includes(r.status), `${method} ${url} as ${type} from another site → ${r.status} ${r.text.slice(0, 100)}`);
      assert.strictEqual(r.headers["access-control-allow-origin"], undefined);
      assert.strictEqual(r.headers["access-control-allow-credentials"], undefined);
    }
  }
  assert.deepStrictEqual(await profile(), before, "the profile is unchanged");
  assert.deepStrictEqual((await s.get("/api/orders", { token: victim })).body, [], "no order was created");
  assert.strictEqual((await s.get("/api/auth/profile", { token: victim })).status, 200, "the victim's sessions were not ended");
  // 3. A form-encoded body is not parsed into fields at all any more (the global urlencoded parser is gone).
  const form = await s.req({ method: "POST", url: "/api/quote", ip: "203.0.113.62", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: Buffer.from(`parts[0][partId]=${up.body.parts[0].partId}&parts[0][materialSlug]=${mats[0].slug}`) });
  assert.deepStrictEqual([form.status, form.body.error], [400, "No parts configured"], "a form post reaches the JSON route with an empty body");
  // 4. The other site cannot read the CSRF token either: the session answer carries no CORS grant for it.
  const peek = await s.req({ url: "/api/auth/session", headers: { ...cookie, ...evil } });
  assert.strictEqual(peek.headers["access-control-allow-origin"], undefined, "the answer is not readable from another origin");
  // 5. And the page's own request, with the token it was given, works.
  const own = await s.req({ method: "PUT", url: "/api/auth/profile", headers: { ...(await s.browser(login.body.token)), Origin: s.base, "Content-Type": "application/json" }, body: Buffer.from(JSON.stringify({ name: "Victim Renamed" })) });
  assert.deepStrictEqual([own.status, own.body.name], [200, "Victim Renamed"]);
});

test("internal brand pages and sample documents answer 404; the brand assets pages use are still served; none of it is in the sitemap", async () => {
  const dist = path.join(live.ROOT, "client", "dist");
  if (!fs.existsSync(path.join(dist, "index.html"))) { console.log("       (client/dist not built — skipped; run npm run build)"); return; }
  const internal = ["/brand/brand-guide.html", "/brand/kit-sheet.html", "/brand/review-sheet.html", "/brand/review-sheet-2.html", "/brand/review-sheet-3.html",
    "/brand/brand-guide.pdf", "/brand/brand-guide.png", "/brand/kit-sheet.png", "/brand/review-sheet.png", "/brand/README.md", "/brand/RATIONALE.md",
    "/brand/documents/sample-quote.pdf", "/brand/documents/sample-quote.png", "/brand/documents/sample-order-confirmation.pdf", "/brand/documents/sample-packing-slip.pdf",
    "/brand/documents/sample-certificate-of-conformance.pdf", "/brand/documents/sample-fai-report-blank.pdf", "/brand/documents/sample-rfq-response.pdf",
    // the same files asked for another way
    "/brand/Brand-Guide.HTML", "/brand/%62rand-guide.html", "/brand/brand-guide%2Ehtml", "/brand//brand-guide.html", "/brand/./kit-sheet.html", "/brand/og/../brand-guide.html", "/brand/documents/"];
  for (const url of internal) {
    assert.ok(fs.existsSync(path.join(dist, "brand")), "the brand folder is in the build");
    const r = await s.get(url);
    assert.ok(r.status === 404 || (r.status === 301 && (await s.get(r.headers.location)).status === 404), `${url} → ${r.status}`);
    assert.ok(!/<html|%PDF|STRAIGHTEDGE BRAND|# /.test(r.text.slice(0, 400)) || r.status === 301, `${url} returned content: ${r.text.slice(0, 60)}`);
  }
  for (const f of fs.readdirSync(path.join(dist, "brand")).filter((n) => /\.html$/.test(n))) assert.strictEqual((await s.get(`/brand/${f}`)).status, 404, `/brand/${f}`);
  // (2026-11-12) The sample documents and the contact sheet that shows them are no longer in the build at all: they
  // print the shop's ship-from address, so they live in docs/brand/ (scripts/dist-address-check.js keeps them out).
  // Their old addresses still answer 404, as asserted above; this was a listing of dist/brand/documents.
  assert.ok(!fs.existsSync(path.join(dist, "brand", "documents")), "client/dist has no brand/documents folder");
  assert.ok(!fs.existsSync(path.join(live.ROOT, "client", "public", "brand", "documents")), "client/public has no brand/documents folder");
  for (const f of ["kit-sheet.html", "kit-sheet.png"]) assert.ok(!fs.existsSync(path.join(dist, "brand", f)), `${f} is not in the build`);
  for (const f of fs.readdirSync(path.join(live.ROOT, "docs", "brand", "samples"))) assert.strictEqual((await s.get(`/brand/documents/${f}`)).status, 404, `/brand/documents/${f}`);
  // Assets the pages themselves use stay public.
  const manifest = JSON.parse(fs.readFileSync(path.join(dist, "site.webmanifest"), "utf8"));
  const assets = ["/brand/og-default.png", ...manifest.icons.map((i) => i.src), ...fs.readdirSync(path.join(dist, "brand", "og")).slice(0, 3).map((f) => `/brand/og/${f}`),
    ...fs.readdirSync(path.join(dist, "brand")).filter((n) => /\.svg$/.test(n)).slice(0, 3).map((f) => `/brand/${f}`)];
  for (const url of assets) assert.strictEqual((await s.get(url)).status, 200, url);
  const home = (await s.get("/")).text;
  for (const m of home.matchAll(/(?:href|src|content)="(?:https:\/\/straightedgemfg\.com)?(\/brand\/[^"]+)"/g)) assert.strictEqual((await s.get(m[1])).status, 200, `the home page uses ${m[1]}`);
  // Not advertised anywhere.
  const sitemap = (await s.get("/sitemap.xml")).text;
  assert.ok(/<urlset/.test(sitemap) && !/\/brand\//.test(sitemap), "the sitemap lists no /brand/ URL");
  const robots = (await s.get("/robots.txt")).text;
  assert.ok(!/brand-guide|review-sheet|kit-sheet|documents/.test(robots));
  for (const page of fs.readdirSync(path.join(dist, "_prerender")).filter((f) => f.endsWith(".html")).map((f) => fs.readFileSync(path.join(dist, "_prerender", f), "utf8"))) {
    assert.ok(!/\/brand\/[a-z0-9-]+\.html|\/brand\/documents\//.test(page), "a public page links to an internal brand page");
  }
});

test("the built pages need nothing looser: no inline script, no <style>, no on*= handlers, no third-party hosts", async () => {
  const dist = path.join(live.ROOT, "client", "dist");
  if (!fs.existsSync(path.join(dist, "index.html"))) { console.log("       (client/dist not built — skipped; run npm run build)"); return; }
  const pages = [];
  (function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".html")) pages.push(p); } })(dist);
  assert.ok(pages.length >= 20, `${pages.length} built pages`);
  let staticWithStyle = 0;
  for (const p of pages) {
    const html = fs.readFileSync(p, "utf8");
    const rel = path.relative(dist, p);
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const attrs = m[1], body = m[2].trim();
      if (/type="application\/ld\+json"/.test(attrs)) { JSON.parse(body); continue; } // data, not code
      assert.ok(/\bsrc="\/assets\/[^"]+"/.test(attrs) && body === "", `${rel}: a script that is not an external /assets file: <script${attrs}>`);
    }
    const generated = rel === "index.html" || rel.startsWith("_prerender");
    const blocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
    if (generated) {
      assert.strictEqual(blocks.length, 0, `${rel}: the app's pages must not need a <style> block`);
    } else if (blocks.length) {
      // A hand-written static page with its own <style> block. The only ones are the internal brand
      // sheets, which the live site does not serve: 404, and no allowance for their styles in the policy.
      const r = await s.get(`/${rel.split(path.sep).join("/")}`);
      assert.strictEqual(r.status, 404, `${rel}: a static page with a <style> block is being served`);
      for (const css of blocks) {
        const hash = `'sha256-${require("crypto").createHash("sha256").update(css, "utf8").digest("base64")}'`;
        assert.ok(!r.headers["content-security-policy"].includes(hash), `${rel}: the policy still carries its <style> hash`);
      }
      staticWithStyle++;
    }
    assert.ok(!/<[a-z][^>]*\son[a-z]+\s*=/i.test(html), `${rel}: has an inline event handler`);
    assert.ok(!/javascript:/i.test(html), `${rel}: has a javascript: URL`);
    for (const m of html.matchAll(/<(?:script|link|img|iframe|source|video|audio)\b[^>]*?(?:src|href)="(https?:)?\/\/([^"/]+)/gi)) {
      assert.ok(/^(straightedgemfg\.com|www\.straightedgemfg\.com)$/.test(m[2]), `${rel}: loads from ${m[2]}`);
    }
  }
  const js = fs.readdirSync(path.join(dist, "assets")).filter((f) => f.endsWith(".js"));
  for (const f of js) {
    const code = fs.readFileSync(path.join(dist, "assets", f), "utf8");
    assert.ok(!/\beval\(|new Function\(/.test(code), `${f} uses eval or new Function`);
    assert.ok(!/fonts\.googleapis|fonts\.gstatic|js\.stripe\.com/.test(code), `${f} references a third-party host`);
  }
  const css = fs.readdirSync(path.join(dist, "assets")).filter((f) => f.endsWith(".css")).map((f) => fs.readFileSync(path.join(dist, "assets", f), "utf8")).join("\n");
  assert.ok(!/@import|fonts\.googleapis|fonts\.gstatic/.test(css), "fonts are self-hosted");
  assert.ok(!/url\(["']?https?:/.test(css), "the stylesheet loads nothing from another host");
});

run(async () => { if (s) await s.stop(); });
