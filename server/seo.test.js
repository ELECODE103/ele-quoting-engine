#!/usr/bin/env node
/**
 * SEO plumbing checks that do not need a client build:
 *  - the committed public catalog matches server/config/defaults.js
 *  - legacy redirects are well-formed and never chain
 *  - the router serves per-route HTML, noindex app shells and real 404s from a manifest
 */
const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const express = require("express");
const { createSeoRouter, LEGACY_REDIRECTS } = require("./seo");

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: p, headers }, (res) => {
      let body = ""; res.on("data", (d) => (body += d)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on("error", reject);
  });
}

(async () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "seo", "gen-catalog.js"), "--check"], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  ok("catalog.generated.json matches defaults.js");

  for (const [from, to] of Object.entries(LEGACY_REDIRECTS)) {
    assert.ok(from.startsWith("/") && to.startsWith("/"), `${from} -> ${to}`);
    assert.strictEqual(from, from.toLowerCase());
    assert.ok(!LEGACY_REDIRECTS[to], `redirect chain: ${from} -> ${to} -> ${LEGACY_REDIRECTS[to]}`);
  }
  ok("legacy redirects are single-hop");

  // Minimal fake dist
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "seo-test-"));
  fs.mkdirSync(path.join(dist, "_prerender"));
  fs.mkdirSync(path.join(dist, "assets"));
  fs.writeFileSync(path.join(dist, "index.html"), "<html><head><!--seo:head--><title>shell</title><!--/seo:head--></head><body><div id=\"root\"></div></body></html>");
  fs.writeFileSync(path.join(dist, "_prerender", "about.html"), "<html><head><title>About</title></head><body>about body</body></html>");
  fs.writeFileSync(path.join(dist, "_prerender", "404.html"), "<html><head><title>nf</title></head><body>not found body</body></html>");
  fs.writeFileSync(path.join(dist, "assets", "app-abc123.js"), "console.log(1)");
  fs.writeFileSync(path.join(dist, "seo-manifest.json"), JSON.stringify({
    appRoutes: ["^/quote$", "^/orders/[^/]+$"],
    routes: { "/about": { head: "<title>About</title>", file: "_prerender/about.html" }, "/quality": { head: "<title>Quality head</title>", file: null } },
    appHead: { "^/quote$": "<title>Quote</title><meta name=\"robots\" content=\"noindex, follow\" />" },
    notFound: { head: "<title>nf</title>", file: "_prerender/404.html" },
  }));
  const app = express();
  app.use(createSeoRouter(dist));
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const port = server.address().port;
  try {
    let x = await get(port, "/about");
    assert.strictEqual(x.status, 200); assert.ok(x.body.includes("about body")); assert.strictEqual(x.headers["cache-control"], "no-cache");
    ok("public route serves its prerendered file");

    x = await get(port, "/quality");
    assert.strictEqual(x.status, 200); assert.ok(x.body.includes("<title>Quality head</title>") && !x.body.includes("<title>shell</title>"));
    ok("public route without a prerendered file gets its head injected into the shell");

    x = await get(port, "/quote?process=cnc");
    assert.strictEqual(x.status, 200); assert.ok(x.body.includes("noindex")); assert.strictEqual(x.headers["x-robots-tag"], "noindex");
    x = await get(port, "/orders/abc");
    assert.strictEqual(x.status, 200);
    ok("app routes return the shell, 200, noindex");

    x = await get(port, "/does-not-exist");
    assert.strictEqual(x.status, 404); assert.ok(x.body.includes("not found body"));
    x = await get(port, "/assets/missing.js");
    assert.strictEqual(x.status, 404); assert.ok(!x.body.includes("<html"));
    x = await get(port, "/_prerender/about.html");
    assert.strictEqual(x.status, 404);
    ok("unknown URLs and missing files return 404");

    x = await get(port, "/about/");
    assert.strictEqual(x.status, 301); assert.strictEqual(x.headers.location, "/about");
    x = await get(port, "/cnc-machining?utm=1");
    assert.strictEqual(x.status, 301); assert.strictEqual(x.headers.location, "/machining?utm=1");
    x = await get(port, "/about", { Host: "www.straightedgemfg.com" });
    assert.strictEqual(x.status, 301); assert.strictEqual(x.headers.location, "https://straightedgemfg.com/about");
    ok("trailing slash, legacy path and www host redirect with 301");

    x = await get(port, "/assets/app-abc123.js");
    assert.ok(/immutable/.test(x.headers["cache-control"]));
    ok("hashed assets are cached immutably");
  } finally {
    server.close();
    fs.rmSync(dist, { recursive: true, force: true });
  }
  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
