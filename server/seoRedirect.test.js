#!/usr/bin/env node
/**
 * Redirects stay on the site (independent review 2026-11-11, F9).
 *
 * On the canonical host, `GET //evil.example/` used to be answered
 * `301 Location: //evil.example` — a protocol-relative URL a browser follows
 * to another site. Every Location the path-normalising code sends must be a
 * path that starts with exactly one "/" followed by a character that is not
 * "/" or "\". Requests go out on a raw socket, so the path arrives exactly as
 * written (an HTTP client library would tidy it first).
 *
 * Run: node server/seoRedirect.test.js
 */
const assert = require("assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const express = require("express");
const { createSeoRouter, normalize, isLocalPath, CANONICAL_HOST } = require("./seo");

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ok   ${name}`); };

function raw(port, target, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    let data = "";
    sock.on("data", (d) => { data += d; });
    const done = () => {
      const head = data.split("\r\n\r\n")[0].split("\r\n");
      const status = Number((head[0] || "").split(" ")[1]);
      const location = (head.find((l) => /^location:/i.test(l)) || "").replace(/^location:\s*/i, "") || null;
      resolve({ status, location });
    };
    sock.on("end", done);
    sock.on("error", done);
  });
}

/** Where a browser on https://straightedgemfg.com would end up after following `location`. */
function landsOn(location) {
  return new URL(location, `https://${CANONICAL_HOST}/`).host;
}

(async () => {
  console.log("Redirects stay on the site");
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "se-redirect-"));
  fs.mkdirSync(path.join(dist, "_prerender"), { recursive: true });
  fs.writeFileSync(path.join(dist, "index.html"), "<html><head><!--seo:head--><!--/seo:head--></head><body><div id=\"root\"></div></body></html>");
  fs.writeFileSync(path.join(dist, "_prerender", "about.html"), "<html><body>about</body></html>");
  fs.writeFileSync(path.join(dist, "seo-manifest.json"), JSON.stringify({ routes: { "/": { file: null }, "/about": { file: "_prerender/about.html" }, "/materials/peek": { file: null } }, appRoutes: ["^/quote$"], appHead: {}, notFound: { file: null, head: "" } }));
  const app = express();
  app.set("trust proxy", 1);
  app.use(createSeoRouter(dist));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const port = server.address().port;
  try {
    // The cases from the review, and their variants: each with and without a query string.
    const hostile = ["//evil.example", "//evil.example/", "/\\evil.example", "/\\evil.example/", "///evil.example", "///evil.example//", "/%2f/evil.example", "/%2f/evil.example/", "/%2F%2Fevil.example/", "/%5cevil.example", "/%5Cevil.example/", "/\\/evil.example/", "//\\evil.example/", "/\\\\evil.example/", "////evil.example/a/", "//evil.example/%2f..", "//evil.example\\@good/", "/\t/evil.example/"];
    let redirects = 0;
    for (const base of hostile) {
      for (const qs of ["", "?next=https://evil.example/&x=//evil.example"]) {
        const target = base + qs;
        const r = await raw(port, target.replace(/\t/g, "%09"));
        if (r.location !== null) {
          redirects++;
          assert.ok(/^\/(?![/\\])/.test(r.location), `${target} → Location ${r.location}: not a single-slash local path`);
          assert.ok(!/^\/(%2f|%5c)/i.test(r.location), `${target} → Location ${r.location}: starts with an encoded slash`);
          assert.ok(!r.location.includes("\\"), `${target} → Location ${r.location}: carries a backslash`);
          assert.strictEqual(landsOn(r.location), CANONICAL_HOST, `${target} → Location ${r.location} leaves the site`);
          assert.strictEqual(r.status, 301);
        } else {
          assert.ok(r.status === 404 || r.status === 400, `${target} → ${r.status} with no Location`);
        }
      }
    }
    assert.ok(redirects > 0, "some of them are still tidied by a redirect — to a local path");
    assert.deepStrictEqual(await raw(port, "//evil.example/"), { status: 301, location: "/evil.example" });
    assert.deepStrictEqual(await raw(port, "/\\evil.example/"), { status: 301, location: "/evil.example" });
    assert.deepStrictEqual(await raw(port, "///evil.example//?a=1"), { status: 301, location: "/evil.example?a=1" });
    assert.strictEqual((await raw(port, "/%2f/evil.example/")).location, null);
    assert.strictEqual((await raw(port, "/%5cevil.example/")).location, null);
    ok("//host, /\\host, ///host, /%2f/host, /%5chost and their variants never produce an off-site Location, with or without a query string");

    // The redirects the site wants still happen, and still carry the query string.
    assert.deepStrictEqual(await raw(port, "/about/"), { status: 301, location: "/about" });
    assert.deepStrictEqual(await raw(port, "/about/?utm=1"), { status: 301, location: "/about?utm=1" });
    assert.deepStrictEqual(await raw(port, "/home?next=https://evil.example"), { status: 301, location: "/?next=https://evil.example" });
    assert.deepStrictEqual(await raw(port, "/Materials/PEEK"), { status: 301, location: "/materials/peek" });
    assert.deepStrictEqual(await raw(port, "/cnc"), { status: 301, location: "/machining" });
    assert.strictEqual((await raw(port, "/about")).status, 200);
    assert.strictEqual((await raw(port, "/constructor")).location, null, "an Object.prototype name is not a legacy redirect");
    assert.strictEqual((await raw(port, "/__proto__/")).location, "/__proto__");
    ok("trailing slash, legacy and mixed-case redirects still work and keep the query string");

    // www → apex is an absolute URL on the known host, whatever the path says.
    const www = await raw(port, "//evil.example/x", `www.${CANONICAL_HOST}`);
    assert.strictEqual(www.status, 301);
    assert.strictEqual(new URL(www.location).host, CANONICAL_HOST);
    assert.ok(www.location.startsWith(`https://${CANONICAL_HOST}/`));
    ok("the www → apex redirect is an absolute URL on the canonical host");

    // The two helpers, directly.
    for (const [input, want] of [["/", "/"], ["/a/", "/a"], ["//a", "/a"], ["/\\a", "/a"], ["\\\\a", "/a"], ["///", "/"], ["/a//", "/a"], ["/a/b/", "/a/b"]]) assert.strictEqual(normalize(input), want, input);
    for (const good of ["/", "/a", "/a/b", "/quote", "/firm-quote/abc.def-ghi_jkl", "/a%20b"]) assert.strictEqual(isLocalPath(good), true, good);
    for (const bad of ["", "a", "//a", "/\\a", "\\a", "/%2fa", "/%2Fa", "/%5ca", "/%5Ca", "/a\\b", "/a\r\nSet-Cookie: x=1", "https://evil.example", "/" + "a".repeat(3000), null, undefined, 7]) assert.strictEqual(isLocalPath(bad), false, String(bad).slice(0, 30));
    ok("normalize collapses leading slash and backslash runs; isLocalPath accepts only a single-slash local path");
  } finally {
    server.close();
    fs.rmSync(dist, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed`);
})().catch((err) => { console.error(`  FAIL ${err.stack || err.message}`); process.exit(1); });
