/**
 * What a visitor can read (re-review 2026-11-12, area 7).
 *
 *   node tools/security/rereview-relaunch/public-surface.js      (needs client/dist: `npm run build` or `npm test` makes it)
 *
 * 1. The built site (client/dist: pages, bundle, JSON-LD) must not hold the shop's street address or ZIP,
 *    a statement that it is a one-person shop, or a test customer's name.
 * 2. Every refusal code the server can send has words in the client's catalogue, or is listed here with
 *    the reason it does not need them.
 * 3. Refusals to hostile input must not carry internals: a path, a stack line, a JavaScript error text.
 */
const fs = require("fs");
const path = require("path");
const { liftPacing, report, rectDxf, SHIP } = require("./lib");
const ROOT = path.join(__dirname, "..", "..", "..");

function walk(dir, out = []) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); } return out; }

(async () => {
  const R = report();
  // ── 1 ──
  const dist = path.join(ROOT, "client", "dist");
  if (!fs.existsSync(dist)) { console.log("client/dist is not built; run `npm run build` first"); process.exit(2); }
  const from = require(path.join(ROOT, "server", "config", "shipFrom.json"));
  const files = walk(dist).filter((f) => /\.(html|js|json|txt|xml|css|md|webmanifest)$/.test(f));
  const hits = (re) => files.filter((f) => re.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(dist, f));
  const street = hits(new RegExp(`${from.address.split(" ")[0]}|${from.address.replace(/^\d+\s+\w\s+/, "").replace(/\s+Rd$/, "")}|${from.zip}`, "i"));
  R.check(street.length === 0, `the street address and ZIP are in none of the ${files.length} built text files`, street.slice(0, 5).join(", "));
  const solo = hits(/one[- ](man|person|woman)\b|solo (shop|operator|machinist)|sole proprietor|owner[- ]operated|single[- ]person shop|just one (guy|person)|one-man-band/i);
  R.check(solo.length === 0, "no statement that it is a one-person shop", solo.slice(0, 5).join(", "));
  const testNames = hits(/Dana Buyer|@buyer\.test|@example\.test|Test Buyer/);
  R.check(testNames.length === 0, "no test customer's name or address", testNames.slice(0, 5).join(", "));
  const ld = files.filter((f) => f.endsWith(".html")).flatMap((f) => [...fs.readFileSync(f, "utf8").matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]));
  const ldStreet = ld.filter((j) => /streetAddress|postalCode/.test(j)).length;
  R.check(ldStreet === 0, `none of the ${ld.length} JSON-LD blocks has a streetAddress or postalCode`);

  // ── 2 ──
  const src = walk(path.join(ROOT, "server")).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js") && !f.includes("testSupport"));
  const codes = new Set();
  for (const f of src) for (const m of fs.readFileSync(f, "utf8").matchAll(/(?:code: ?|[Rr]efusal\(\d+, ?|bad\(|poolError\()"([a-z][a-z0-9-]+)"/g)) codes.add(m[1]);
  const catalogue = fs.readFileSync(path.join(ROOT, "client", "src", "utils", "messageCatalogue.js"), "utf8");
  const pages = walk(path.join(ROOT, "client", "src")).filter((f) => /\.(jsx?|mjs)$/.test(f)).map((f) => fs.readFileSync(f, "utf8")).join("\n");
  const NOT_BUYER = { // why a code needs no entry
    "backup-running": "admin page", "backup-too-large": "admin page", "not-found": "admin page", "request-has-order": "admin page",
    "big-ticket": "gate reason (a phrase the page prints)", "complex-geometry": "gate reason", "dfm-fail": "gate reason", envelope: "gate reason", "legacy-features": "gate reason", "thin-wall": "gate reason", "turning-review": "gate reason", quantity: "gate reason", "shipping-freight": "gate reason",
    "dxf-bad-ellipse": "keeps the server's own sentence (read: written for a customer)", "dxf-too-many-blocks": "keeps the server's own sentence (read: written for a customer)",
    junction: "DFM check id", "open-contour": "DFM check id", overlap: "DFM check id", sliver: "DFM check id", duplicate: "DFM check id", cancelled: "an order state, not a refusal",
  };
  const unworded = [...codes].filter((c) => !new RegExp(`['"]?${c}['"]?\\s*:|['"]${c}['"]`).test(catalogue) && !NOT_BUYER[c]);
  const nowhere = unworded.filter((c) => !new RegExp(`['"]${c}['"]`).test(pages));
  R.check(nowhere.length === 0, `${codes.size} codes in the server: each has words in the catalogue, is handled by a page, or is not a buyer refusal`, `no words and no page: ${nowhere.join(", ") || "none"}; handled by a page without catalogue words: ${unworded.filter((c) => !nowhere.includes(c)).join(", ") || "none"}`);

  // ── 3 ── (the real server in production mode: the in-process test harness has no error handler of its own)
  const s = await require("../../../server/testSupport/liveServer").start({ env: { NODE_OPTIONS: `--require ${path.join(__dirname, "stripe-stub-preload.js")}`, RR_STRIPE_FILE: path.join(require("os").tmpdir(), `rr-stripe-public-${process.pid}.json`) } });
  const buyer = await s.register("probe@buyer.test");
  const INTERNAL = /\/home\/|\/app\/|\/tmp\/|node_modules|\bat [A-Za-z.<>]+ \(|Cannot read prop|is not a function|undefined \(reading|TypeError|ReferenceError|SyntaxError|sqlite|ENOENT|EACCES|<pre>/i;
  const seen = [];
  const say = (what, r) => { const bad = INTERNAL.test(r.text || ""); seen.push({ what, status: r.status, bad, text: (r.text || "").slice(0, 150) }); if (bad) R.finding(`internals in the answer to: ${what}`, (r.text || "").slice(0, 200)); };
  const up = (name, data) => s.upload([{ name, data }]);
  say("an STL that is 80 bytes of zeros", await up("a.stl", Buffer.alloc(80)));
  say("an ASCII STL cut off mid-facet", await up("b.stl", Buffer.from("solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0")));
  say("a STEP file that is not STEP", await up("c.step", Buffer.from("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=FOO(")));
  say("a 3MF that is not a zip", await up("d.3mf", Buffer.from("PK\u0003\u0004 not really")));
  say("a DXF with a NaN coordinate", await up("e.dxf", Buffer.from("0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n0\n10\nNaN\n20\n0\n11\n1e999\n21\n1\n0\nENDSEC\n0\nEOF\n")));
  say("a file name with a path in it", await up("../../etc/passwd.stl", Buffer.alloc(200)));
  say("a quote for a part id that is SQL", await s.post("/api/quote", { parts: [{ partId: "' OR 1=1 --", materialSlug: "x", quantity: 1 }] }, { token: buyer }));
  say("a quote whose parts are not objects", await s.post("/api/quote", { parts: [null, 7, "x", []] }, { token: buyer }));
  say("a quote with a prototype key", await s.req({ method: "POST", url: "/api/quote", token: buyer, body: Buffer.from('{"parts":[{"partId":"x","__proto__":{"a":1},"constructor":{"prototype":{"b":2}}}]}'), headers: { "Content-Type": "application/json" } }));
  say("checkout of a quote id that is an object", await s.post("/api/orders/checkout-session", { quoteId: { $ne: null }, ...SHIP }, { token: buyer }));
  say("a body that is not JSON", await s.req({ method: "POST", url: "/api/quote", token: buyer, body: Buffer.from("{not json"), headers: { "Content-Type": "application/json" } }));
  say("a JSON body of 3 MB", await s.req({ method: "POST", url: "/api/quote", token: buyer, body: Buffer.from(JSON.stringify({ parts: [], pad: "x".repeat(3 * 1024 * 1024) })), headers: { "Content-Type": "application/json" } }));
  say("an order id that is a path", await s.get("/api/orders/..%2F..%2Fetc%2Fpasswd", { token: buyer }));
  say("a firm-quote link that is garbage", await s.get("/api/rfq/quote/not-a-token"));
  say("units for a part that is not there", await s.post("/api/parts/00000000-0000-4000-8000-000000000000/units", { units: "mm" }, { token: buyer }));
  say("a webhook with no signature", await s.req({ method: "POST", url: "/api/stripe/webhook", body: Buffer.from("{}"), headers: { "Content-Type": "application/json" } }));
  say("a page that does not exist under /api", await s.get("/api/nope/../../admin"));
  const ok = seen.filter((x) => !x.bad).length;
  R.check(ok === seen.length, `${seen.length} hostile requests: no answer carries a path, a stack line or a JavaScript error text`, seen.map((x) => `${x.status}`).join(" "));
  for (const x of seen) console.log(`    ${String(x.status).padEnd(4)} ${x.what}: ${x.text.replace(/\s+/g, " ").slice(0, 110)}`);
  const f = R.done();
  await s.stop();
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
