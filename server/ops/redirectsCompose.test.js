/**
 * The two redirect layers together, on the real server (relaunch integration, 2026-11-12).
 *
 *   server/ops/canonicalHost.js   old domains and www → https://<canonical>/same-path   (deploy-runbook)
 *   server/seo.js                 trailing slash, mixed case, legacy paths, www → apex   (open-redirect fix, review F9)
 *
 * Each was proven on its own branch (ops/canonicalHost.test.js; seoRedirect.test.js). Merged, a request can
 * pass through both: an old host answers with a redirect to the canonical host, and the canonical host may
 * then tidy the path. This follows every hop the way a browser would — on every host the site can be reached
 * by — and holds the whole chain to one rule: it never leaves the site, and it ends.
 *
 * Requests go out on a raw socket so the path arrives exactly as written.
 * Run: node server/ops/redirectsCompose.test.js   (needs client/dist: npm run build)
 */
const assert = require("assert");
const net = require("net");
const { runner } = require("../testSupport/harness");
const live = require("../testSupport/liveServer");

const { test, run } = runner("Redirects compose: canonical host + path normaliser");

const CANON = "straightedgemfg.com";
const OLD = ["www.straightedgemfg.com", "nordmfg.com", "www.nordmfg.com"];
const RAILWAY = "se-web-production.up.railway.app";
const UNKNOWN = "203.0.113.9"; // a request by address, or with a Host that is none of ours
const ENV = { CANONICAL_HOST: CANON, REDIRECT_HOSTS: OLD.join(","), RAILWAY_PUBLIC_DOMAIN: RAILWAY };
const OURS = new Set([CANON, ...OLD, RAILWAY, UNKNOWN]);

const HOSTILE = [
  "//evil.example/", "//evil.example", "/\\evil.example/", "///evil.example//", "////evil.example/a/b/",
  "/%2f/evil.example/", "/%2F%2Fevil.example/", "/%5cevil.example/", "/%5C%5Cevil.example", "/\\/evil.example/", "//\\evil.example/",
  "/%2f%5c/evil.example", "//evil.example/%2f..", "//evil.example\\@" + CANON + "/", "//evil.example:443/", "/.//evil.example/", "//@evil.example/",
  "//", "/\\", "/%2f",
];
const QUERIES = ["", "?next=//evil.example/", "?a=1&b=%2f%2fevil.example"];

function raw(port, target, host) {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nX-Forwarded-Proto: https\r\nConnection: close\r\n\r\n`));
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

/**
 * Follow a request the way a browser does. Every Location is resolved against the URL that
 * answered it; a hop that would leave our hosts ends the walk and is reported.
 * @returns {{hops: Array<{host, target, status, location}>, left: string|null, ended: boolean}}
 */
async function follow(port, host, target, maxHops = 6) {
  const hops = [];
  let at = { host, target };
  for (let i = 0; i < maxHops; i++) {
    const r = await raw(port, at.target, at.host);
    hops.push({ ...at, status: r.status, location: r.location });
    if (!(r.status >= 300 && r.status < 400) || r.location === null) return { hops, left: null, ended: true };
    // What the Location header may look like at all.
    if (/[\r\n\\]/.test(r.location)) return { hops, left: `a Location with a backslash or line break: ${JSON.stringify(r.location)}`, ended: false };
    if (/^\/[/\\]/.test(r.location) || /^\/(%2f|%5c)/i.test(r.location)) return { hops, left: `a protocol-relative Location: ${r.location}`, ended: false };
    let next;
    try { next = new URL(r.location, `https://${at.host}${at.target.startsWith("/") ? at.target : "/"}`); } catch { return { hops, left: `an unparseable Location: ${r.location}`, ended: false }; }
    if (next.protocol !== "https:" || next.username || next.password) return { hops, left: `Location ${r.location}`, ended: false };
    if (!OURS.has(next.hostname)) return { hops, left: `Location ${r.location} → host ${next.hostname}`, ended: false };
    at = { host: next.host, target: `${next.pathname}${next.search}` };
  }
  return { hops, left: null, ended: false };
}
const chain = (w) => w.hops.map((h) => `${h.host}${h.target} → ${h.status}${h.location ? ` ${h.location}` : ""}`).join("  |  ");

let s;

test("hostile paths on every host: the chain of redirects never leaves the site, and it ends", async () => {
  s = await live.start({ env: ENV });
  let walked = 0, redirected = 0;
  for (const host of [CANON, ...OLD, RAILWAY, UNKNOWN]) {
    for (const p of HOSTILE) for (const q of QUERIES) {
      const w = await follow(s.port, host, p + q);
      walked++;
      assert.strictEqual(w.left, null, `${host} ${p + q}: ${w.left}\n  ${chain(w)}`);
      assert.ok(w.ended, `${host} ${p + q}: still redirecting after ${w.hops.length} hops\n  ${chain(w)}`);
      assert.ok(w.hops.length <= 3, `${host} ${p + q}: ${w.hops.length} hops\n  ${chain(w)}`);
      const last = w.hops[w.hops.length - 1];
      assert.ok([200, 400, 404].includes(last.status), `${host} ${p + q}: ended on ${last.status}\n  ${chain(w)}`);
      if (w.hops.length > 1) redirected++;
      // An old host's first answer is always the canonical host, absolute, https.
      if (OLD.includes(host)) {
        assert.ok(w.hops[0].status === 301 && w.hops[0].location.startsWith(`https://${CANON}/`), `${host} ${p + q}: first hop\n  ${chain(w)}`);
        assert.ok(/^\/(?![/\\]|%2f|%5c)/i.test(w.hops[0].location.slice(`https://${CANON}`.length)), `${host} ${p + q}: the path after the host\n  ${chain(w)}`);
      }
      // Wherever the walk ends, it is on the canonical host — or on a host that never redirects (Railway's own, an address).
      assert.ok(last.host === CANON || ((host === RAILWAY || host === UNKNOWN) && last.host === host), `${host} ${p + q}: ended on ${last.host}\n  ${chain(w)}`);
    }
  }
  assert.strictEqual(walked, 6 * HOSTILE.length * QUERIES.length);
  assert.ok(redirected > 100, `${redirected} of ${walked} walks were redirected at least once`);
  console.log(`       (${walked} walks over ${6} hosts; ${redirected} redirected; every chain stayed on the site and ended within 3 hops)`);
});

test("the review's own example, hop by hop, on each kind of host", async () => {
  // On the canonical host the path normaliser answers: a local path, one slash.
  assert.deepStrictEqual(await raw(s.port, "//evil.example/", CANON), { status: 301, location: "/evil.example" });
  assert.strictEqual((await raw(s.port, "/evil.example", CANON)).status, 404);
  // On an old host the canonical-host layer answers first, with the leading run already reduced to one slash…
  for (const host of OLD) {
    const first = await raw(s.port, "//evil.example/", host);
    assert.strictEqual(first.status, 301, host);
    assert.ok(first.location.startsWith(`https://${CANON}/`) && new URL(first.location).host === CANON, `${host}: ${first.location}`);
    // …and what the canonical host then does with that path is again local.
    const u = new URL(first.location);
    const second = await raw(s.port, `${u.pathname}${u.search}`, CANON);
    assert.ok(second.location === null || /^\/(?![/\\])/.test(second.location), `${host}: second hop ${second.location}`);
  }
  // The encoded forms are not redirected by the path normaliser at all.
  for (const p of ["/%2f/evil.example/", "/%5cevil.example/"]) assert.strictEqual((await raw(s.port, p, CANON)).location, null, p);
});

test("the redirects the site wants still compose: an old host with a messy path lands on the tidy page of the canonical host", async () => {
  for (const [host, target, want] of [
    ["nordmfg.com", "/Materials/PEEK/?utm=1", "/materials/peek?utm=1"],
    ["www.nordmfg.com", "/about/", "/about"],
    ["www.straightedgemfg.com", "/home", "/"],
    ["nordmfg.com", "/cnc", "/machining"],
  ]) {
    const w = await follow(s.port, host, target);
    assert.strictEqual(w.left, null, chain(w));
    const last = w.hops[w.hops.length - 1];
    assert.deepStrictEqual([last.host, last.target, last.status], [CANON, want, 200], chain(w));
    assert.ok(w.hops.length <= 3, chain(w));
  }
  // The health check and the Stripe webhook are never redirected, on any host (Stripe treats a redirect as a failure).
  for (const host of [CANON, ...OLD, RAILWAY]) {
    assert.strictEqual((await raw(s.port, "/api/health", host)).status, 200, host);
    const hook = await raw(s.port, "/api/stripe/webhook", host);
    assert.ok(hook.location === null && hook.status !== 301 && hook.status !== 308, `${host}: webhook path answered ${hook.status} ${hook.location || ""}`);
  }
});

run(async () => { if (s) await s.stop(); });
