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
    // 'self' plus, at most, SHA-256 hashes of the static pages' own <style> blocks (never 'unsafe-inline')
    assert.strictEqual(d["style-src-elem"][0], "'self'");
    assert.ok(d["style-src-elem"].slice(1).every((x) => /^'sha256-[A-Za-z0-9+/]{43}='$/.test(x)), `style-src-elem is ${d["style-src-elem"]}`);
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
      // A hand-written static page (the brand guide): each block is allowed by its exact hash, nothing wider.
      const csp = (await s.get(`/${rel.split(path.sep).join("/")}`)).headers["content-security-policy"];
      for (const css of blocks) {
        const hash = `'sha256-${require("crypto").createHash("sha256").update(css, "utf8").digest("base64")}'`;
        assert.ok(csp.includes(hash), `${rel}: its <style> block's hash is not in the policy`);
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
