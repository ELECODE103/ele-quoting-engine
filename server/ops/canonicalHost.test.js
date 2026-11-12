/**
 * One canonical host: redirects from the old domains and www, what is never
 * redirected, no open redirect, no-index on Railway's host, HSTS on the
 * canonical host only until HSTS_ALL_HOSTS is set.
 *
 * Unit cases on the functions, then the real server (server/index.js) in
 * production mode with the settings the owner will enter.
 * Run: node server/ops/canonicalHost.test.js
 */
const assert = require("assert");
const { runner } = require("../testSupport/harness");
const live = require("../testSupport/liveServer");
const ch = require("./canonicalHost");

const { test, run } = runner("Canonical host");

const CANON = "straightedgemfg.com";
const OLD = ["www.straightedgemfg.com", "nordmfg.com", "www.nordmfg.com"];
const RAILWAY = "se-web-production.up.railway.app";
const ENV = { CANONICAL_HOST: CANON, REDIRECT_HOSTS: OLD.join(","), RAILWAY_PUBLIC_DOMAIN: RAILWAY };

// The paths the reviewer named, plus neighbours: each must come out as one "/" followed by something
// that is neither a slash nor a backslash, raw or percent-encoded.
const HOSTILE = [
  "//evil.example/", "/\\evil.example", "///evil.example", "/%2f/evil.example", "/%5cevil.example",
  "/%2F%2Fevil.example", "/%5C%5Cevil.example", "/\\/evil.example", "//\\evil.example", "/%2f%5c/evil.example",
  "////evil.example/a/b", "/%2f", "//", "/\\", "/%5c%2f%5c%2fevil.example",
];
const QUERIES = ["", "?next=//evil.example", "?a=1&b=%2f%2fevil.example"];

function assertSafeLocation(location, label) {
  assert.ok(typeof location === "string" && location.startsWith(`https://${CANON}/`), `${label}: Location must start with https://${CANON}/ — got ${location}`);
  const u = new URL(location);
  assert.strictEqual(u.protocol, "https:", label);
  assert.strictEqual(u.host, CANON, `${label}: host`);
  assert.strictEqual(u.username + u.password, "", `${label}: no credentials in the URL`);
  const afterHost = location.slice(`https://${CANON}`.length);
  assert.ok(/^\/(?![/\\]|%2f|%5c)/i.test(afterHost), `${label}: the path must start with one "/" and then no slash or backslash — got ${afterHost}`);
}

test("settings: host names are cleaned; junk is ignored with a reason; www of the brand domain is refused as canonical", () => {
  assert.strictEqual(ch.cleanHost(" HTTPS://StraightEdgeMfg.com/ "), CANON);
  assert.strictEqual(ch.cleanHost("straightedgemfg.com:443"), CANON);
  assert.strictEqual(ch.cleanHost("straightedgemfg.com."), CANON);
  for (const bad of ["", "localhost", "evil.example/@straightedgemfg.com x", "a b.com", "-bad.com", "exa_mple.com", "http://", "1.2.3.4", "com"]) {
    assert.strictEqual(ch.cleanHost(bad), "", `"${bad}" is not a host name`);
  }
  const cfg = ch.readConfig(ENV);
  assert.strictEqual(cfg.canonical, CANON);
  assert.deepStrictEqual([...cfg.redirects], OLD);
  assert.ok(cfg.noindex.has(RAILWAY));
  assert.strictEqual(cfg.hstsAllHosts, false);
  assert.deepStrictEqual(cfg.problems, []);

  // The canonical host is never in its own redirect list.
  assert.deepStrictEqual([...ch.readConfig({ CANONICAL_HOST: CANON, REDIRECT_HOSTS: `${CANON}, nordmfg.com` }).redirects], ["nordmfg.com"]);
  // Redirect hosts with nowhere to go: nothing is redirected, and it says so.
  const orphan = ch.readConfig({ REDIRECT_HOSTS: "nordmfg.com" });
  assert.strictEqual(orphan.redirects.size, 0);
  assert.ok(orphan.problems.some((p) => /CANONICAL_HOST is not/.test(p)));
  // server/seo.js sends www.<brand> to the bare domain: the opposite setting would loop, so it is refused.
  const loop = ch.readConfig({ CANONICAL_HOST: `www.${CANON}`, REDIRECT_HOSTS: CANON });
  assert.strictEqual(loop.canonical, "");
  assert.strictEqual(loop.redirects.size, 0);
  assert.ok(loop.problems.some((p) => /already redirected/.test(p)));
  // A typed value that is not a host.
  assert.ok(ch.readConfig({ CANONICAL_HOST: "not a host" }).problems.length === 1);
  // FRONTEND_URL on another host is called out.
  assert.ok(ch.readConfig({ ...ENV, FRONTEND_URL: "https://nordmfg.com" }).problems.some((p) => /FRONTEND_URL/.test(p)));
  assert.deepStrictEqual(ch.readConfig({ ...ENV, FRONTEND_URL: `https://${CANON}` }).problems, []);
  // Once a custom domain is attached Railway may report it as the public domain: it is not marked noindex.
  assert.strictEqual(ch.readConfig({ CANONICAL_HOST: CANON, RAILWAY_PUBLIC_DOMAIN: CANON }).noindex.size, 0);
});

test("the redirect target: always https://<canonical>/…, path and query kept, never another host", () => {
  assert.strictEqual(ch.redirectLocation(CANON, "/materials/uhmw?x=1&y=two%20words"), `https://${CANON}/materials/uhmw?x=1&y=two%20words`);
  assert.strictEqual(ch.redirectLocation(CANON, "/"), `https://${CANON}/`);
  assert.strictEqual(ch.redirectLocation(CANON, ""), `https://${CANON}/`);
  assert.strictEqual(ch.redirectLocation(CANON, "/firm-quote/abc.def.ghi"), `https://${CANON}/firm-quote/abc.def.ghi`);
  // An absolute-form request target, an authority-form one, "*": the root, never the named host.
  for (const t of ["http://evil.example/x", "https://evil.example", "evil.example:443", "*", "@evil.example", "?x=1"]) {
    assertSafeLocation(ch.redirectLocation(CANON, t), t);
    assert.ok(!new URL(ch.redirectLocation(CANON, t)).pathname.includes("evil.example") || t.startsWith("?") === false, t);
  }
  assert.strictEqual(ch.redirectLocation(CANON, "http://evil.example/x"), `https://${CANON}/`);
  // Control characters and whitespace never reach the header.
  assert.strictEqual(ch.redirectLocation(CANON, "/a\r\nSet-Cookie: x=1"), `https://${CANON}/aSet-Cookie:x=1`);
  for (const p of HOSTILE) for (const q of QUERIES) {
    const loc = ch.redirectLocation(CANON, p + q);
    assertSafeLocation(loc, p + q);
    assert.ok(loc.endsWith(q), `${p + q}: the query string is kept as sent`);
  }
});

test("exempt paths: the health check and the Stripe webhook, in any case and with a trailing slash; nothing that merely looks like them", () => {
  for (const p of ["/api/health", "/api/health/", "/API/Health", "/api/stripe/webhook", "/api/stripe/webhook/", "/Api/Stripe/Webhook"]) assert.ok(ch.isExemptPath(p), p);
  for (const p of ["/api/healthz", "/api/health-check", "/api/stripe/webhooks", "/api/stripe", "/", "/api/quote", "/x/api/health"]) assert.ok(!ch.isExemptPath(p), p);
});

test("live server: every old host answers 301 to the same path and query on the canonical host", async () => {
  const s = await live.start({ env: ENV });
  try {
    for (const host of OLD) {
      for (const url of ["/", "/materials/uhmw", "/quote?process=routing&q=a%20b", "/firm-quote/tok.en.value", "/assets/missing.js", "/api/materials", "/robots.txt", "/sitemap.xml"]) {
        const r = await s.get(url, { headers: { Host: host } });
        assert.strictEqual(r.status, 301, `${host}${url}`);
        assert.strictEqual(r.headers.location, `https://${CANON}${url}`, `${host}${url}`);
        assert.strictEqual(r.headers["strict-transport-security"], undefined, `${host}${url}: no HSTS on an old host`);
      }
      // HEAD too; a method with a body keeps its method (308), still to the canonical host.
      const head = await s.req({ method: "HEAD", url: "/about", headers: { Host: host } });
      assert.strictEqual(head.status, 301);
      assert.strictEqual(head.headers.location, `https://${CANON}/about`);
      const post = await s.post("/api/quote", { parts: [] }, { headers: { Host: host } });
      assert.strictEqual(post.status, 308, "a POST is not turned into a GET");
      assert.strictEqual(post.headers.location, `https://${CANON}/api/quote`);
      // The host name with a port, upper case, and a trailing dot are the same host.
      for (const variant of [`${host}:443`, host.toUpperCase(), `${host}.`]) {
        const r = await s.get("/about", { headers: { Host: variant } });
        assert.strictEqual(r.status, 301, variant);
        assert.strictEqual(r.headers.location, `https://${CANON}/about`, variant);
      }
    }
  } finally { await s.stop(); }
});

test("live server: no open redirect — hostile paths on every redirecting host, with and without a query string", async () => {
  const s = await live.start({ env: ENV });
  try {
    let checked = 0;
    for (const host of OLD) for (const p of HOSTILE) for (const q of QUERIES) {
      const r = await s.get(p + q, { headers: { Host: host } });
      assert.strictEqual(r.status, 301, `${host} ${p + q}`);
      assertSafeLocation(r.headers.location, `${host} ${p + q}`);
      assert.ok(r.headers.location.endsWith(q), `${host} ${p + q}: query kept`);
      checked++;
    }
    assert.strictEqual(checked, OLD.length * HOSTILE.length * QUERIES.length);
    // A forged X-Forwarded-Host cannot choose the destination, and cannot switch the redirect off or on.
    const forged = await s.get("/about", { headers: { Host: "nordmfg.com", "X-Forwarded-Host": "evil.example" } });
    assert.strictEqual(forged.headers.location, `https://${CANON}/about`);
    const forged2 = await s.get("/about", { headers: { Host: CANON, "X-Forwarded-Host": "nordmfg.com" } });
    assert.strictEqual(forged2.status, 200, "the canonical host is served, whatever X-Forwarded-Host says");
    // An absolute-form request line naming another site.
    const abs = await s.get("http://evil.example/x", { headers: { Host: "nordmfg.com" } });
    assert.strictEqual(abs.status, 301);
    assertSafeLocation(abs.headers.location, "absolute-form target");
    assert.ok(!abs.headers.location.includes("evil.example"));
  } finally { await s.stop(); }
});

test("live server: the health check and the Stripe webhook are never redirected, on any host", async () => {
  const s = await live.start({ env: ENV });
  try {
    for (const host of [...OLD, CANON, RAILWAY, "healthcheck.railway.app", "203.0.113.10"]) {
      const h = await s.get("/api/health", { headers: { Host: host } });
      assert.strictEqual(h.status, 200, `health on ${host}`);
      assert.strictEqual(h.body.status, "ok");
      assert.strictEqual(h.headers.location, undefined);
      // The webhook reaches its own handler (which refuses an unsigned event) instead of being bounced:
      // Stripe counts any redirect as a failed delivery.
      const w = await s.req({ method: "POST", url: "/api/stripe/webhook", headers: { Host: host, "Content-Type": "application/json" }, body: Buffer.from("{}") });
      assert.ok(w.status !== 301 && w.status !== 308 && w.status !== 302, `webhook on ${host} must not redirect (got ${w.status})`);
      assert.strictEqual(w.headers.location, undefined);
      assert.ok(w.body && typeof w.body.error === "string", "answered by the webhook route itself");
    }
  } finally { await s.stop(); }
});

test("live server: the canonical host is served with HSTS; Railway's host is served, noindex, without HSTS; an unlisted host is left alone", async () => {
  const s = await live.start({ env: ENV });
  try {
    const canon = await s.get("/", { headers: { Host: CANON } });
    assert.strictEqual(canon.status, 200);
    assert.ok(/max-age=\d+/.test(canon.headers["strict-transport-security"] || ""), "HSTS on the canonical host");
    assert.strictEqual(canon.headers["x-robots-tag"], undefined, "the canonical home page is indexable");
    assert.ok(canon.text.includes(`<link rel="canonical" href="https://${CANON}/"`), "the page names the canonical URL");

    for (const url of ["/", "/materials/uhmw", "/api/materials", "/robots.txt", "/sitemap.xml"]) {
      const r = await s.get(url, { headers: { Host: RAILWAY } });
      assert.strictEqual(r.status, 200, `Railway host ${url}`);
      assert.ok(/noindex/.test(r.headers["x-robots-tag"] || ""), `Railway host ${url}: noindex`);
      assert.strictEqual(r.headers["strict-transport-security"], undefined, `Railway host ${url}: no HSTS`);
    }
    // A second Railway-style host that is not the one in RAILWAY_PUBLIC_DOMAIN (a renamed service, a preview): still noindex.
    const other = await s.get("/", { headers: { Host: "something-else.up.railway.app" } });
    assert.ok(/noindex/.test(other.headers["x-robots-tag"] || ""));

    // A host nobody listed (a typo in DNS, a scanner): served as before, not redirected, no HSTS promise made for it.
    const unknown = await s.get("/about", { headers: { Host: "unlisted.example" } });
    assert.strictEqual(unknown.status, 200);
    assert.strictEqual(unknown.headers.location, undefined);
    assert.strictEqual(unknown.headers["strict-transport-security"], undefined);

    // Admin → System can show which host names requests arrived for: the canonical host must be among them after cutover.
    const admin = await s.admin();
    const seen = (await s.get("/api/admin/system/status", { token: admin, headers: { Host: CANON } })).body.hosts.seen;
    const names = seen.map((x) => x.host);
    for (const h of [CANON, RAILWAY, "something-else.up.railway.app", "unlisted.example"]) assert.ok(names.includes(h), `${h} in ${names}`);
    assert.ok(seen.find((x) => x.host === CANON).requests >= 2);

    // The startup log says what is in force, in one line.
    assert.ok(s.log().includes(`[hosts] canonical host ${CANON}; redirecting to it: ${OLD.join(", ")}`), s.log().split("\n").filter((l) => l.includes("[hosts]")).join("\n"));
  } finally { await s.stop(); }
});

test("live server: HSTS_ALL_HOSTS=true sends the header everywhere; with no CANONICAL_HOST nothing is redirected and headers are as before", async () => {
  const all = await live.start({ env: { ...ENV, HSTS_ALL_HOSTS: "true" } });
  try {
    const old = await all.get("/about", { headers: { Host: "nordmfg.com" } });
    assert.strictEqual(old.status, 301);
    assert.ok(/max-age=\d+/.test(old.headers["strict-transport-security"] || ""), "HSTS on the redirect once verified");
    const rw = await all.get("/", { headers: { Host: RAILWAY } });
    assert.ok(/max-age=\d+/.test(rw.headers["strict-transport-security"] || ""));
    assert.ok(/noindex/.test(rw.headers["x-robots-tag"] || ""), "still noindex");
  } finally { await all.stop(); }

  const none = await live.start({ env: { RAILWAY_PUBLIC_DOMAIN: RAILWAY } });
  try {
    for (const host of ["nordmfg.com", "www.nordmfg.com", CANON]) {
      const r = await none.get("/about", { headers: { Host: host } });
      assert.strictEqual(r.status, 200, `${host} is served while CANONICAL_HOST is unset`);
      assert.ok(/max-age=\d+/.test(r.headers["strict-transport-security"] || ""), "HSTS untouched while CANONICAL_HOST is unset");
    }
    // www.<brand domain> → the bare domain is seo.js's own rule and still applies.
    const www = await none.get("/about", { headers: { Host: `www.${CANON}` } });
    assert.strictEqual(www.status, 301);
    assert.strictEqual(www.headers.location, `https://${CANON}/about`);
    const rw = await none.get("/", { headers: { Host: RAILWAY } });
    assert.ok(/noindex/.test(rw.headers["x-robots-tag"] || ""), "Railway's host is noindex with or without a canonical host");
    assert.ok(none.log().includes("[hosts] CANONICAL_HOST is not set"));
  } finally { await none.stop(); }
});

run();
