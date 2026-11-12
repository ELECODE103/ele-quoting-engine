/**
 * Independent review 2026-11-11 — what the production server exposes and how it fails.
 * Static paths that must not be served, redirects that must stay on-site, error answers that
 * must not carry a stack, a path or a library name. Local server only.
 */
const net = require("net");
const c = require("./lib/common");

/** One raw request on a socket (Node's client would normalise the path); returns the response head. */
function raw(port, text) {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write(text));
    let data = "";
    sock.on("data", (d) => { data += d; });
    sock.on("end", () => resolve(data));
    sock.on("error", () => resolve(data));
    setTimeout(() => { sock.destroy(); resolve(data); }, 2500);
  });
}
const head = (r) => r.split("\r\n\r\n")[0].split("\r\n").filter((l) => /^(HTTP|location|content-type|x-powered-by|server)/i.test(l)).join(" | ");

(async () => {
  const s = await c.start({ mailer: true });
  try {
    const ip = "203.0.113.5";
    console.log("== static paths that must not be served");
    const paths = ["/.env", "/.env.example", "/.git/config", "/.git/HEAD", "/data/quoting.db", "/data/uploads/", "/server/index.js", "/server/config/shipFrom.json",
      "/package.json", "/package-lock.json", "/railway.toml", "/docs/security/hardening-2026-11-11-server.md", "/shared/brand.json", "/shared/shop-facts.json",
      "/assets/index.js.map", "/seo-manifest.json", "/_prerender/index.html", "/brand/brand-guide.html", "/brand/documents/", "/brand/kit-sheet.pdf",
      "/..%2f..%2fpackage.json", "/assets/..%2f..%2f..%2fpackage.json", "/%2e%2e/%2e%2e/package.json", "/assets/%2e%2e/%2e%2e/server/index.js"];
    for (const p of paths) {
      const r = await s.get(p, { ip: c.randomIp() });
      const sensitive = /JWT_SECRET|STRIPE|"dependencies"|password_hash|express\(\)/.test(r.text);
      console.log(`${String(r.status).padEnd(4)} ${p.padEnd(52)} ${String(r.headers["content-type"] || "").padEnd(28)} ${r.buffer.length} bytes${sensitive ? "  <-- SENSITIVE CONTENT" : ""}`);
    }
    console.log("== raw traversal (path sent exactly as written)");
    for (const p of ["/../../package.json", "/assets/../../package.json", "/assets/..\\..\\package.json", "/brand/..%5c..%5cpackage.json"]) {
      console.log(p.padEnd(40), head(await raw(s.port, `GET ${p} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`)));
    }
    console.log("== redirects");
    for (const [p, host] of [["//evil.example/", "127.0.0.1"], ["//evil.example/%2f..", "127.0.0.1"], ["/\\evil.example/", "127.0.0.1"], ["///evil.example//", "127.0.0.1"], ["/Materials/PEEK", "127.0.0.1"],
      ["/home?next=https://evil.example", "127.0.0.1"], ["/x", "www.straightedgemfg.com"], ["//evil.example/x", "www.straightedgemfg.com"], ["/contact/", "evil.example"]]) {
      console.log(`${p.padEnd(34)} Host: ${host.padEnd(26)} ${head(await raw(s.port, `GET ${p} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`))}`);
    }
    console.log("== error answers (no stack, path or library name)");
    const leaky = (t) => /node_modules|at [A-Za-z.<>]+ \(|\/home\/|\/app\/|SyntaxError|TypeError|sql\.js|express|multer/i.test(t);
    const cases = [
      ["bad JSON", { method: "POST", url: "/api/quote", headers: { "Content-Type": "application/json", "Content-Length": "4" }, body: "{bad" }],
      ["JSON null", { method: "POST", url: "/api/quote", headers: { "Content-Type": "application/json", "Content-Length": "4" }, body: "null" }],
      ["JSON array to login", { method: "POST", url: "/api/auth/login", headers: { "Content-Type": "application/json", "Content-Length": "2" }, body: "[]" }],
      ["login with object fields", { method: "POST", url: "/api/auth/login", json: { email: { $ne: "" }, password: { $ne: "" } } }],
      ["register with array fields", { method: "POST", url: "/api/auth/register", json: { email: ["a@b.test"], password: ["x"] } }],
      ["bad percent-encoding", { method: "GET", url: "/api/quote/%E0%A4%A" }],
      ["bad percent-encoding (page)", { method: "GET", url: "/%E0%A4%A" }],
      ["3000-char id", { method: "GET", url: `/api/quote/${"a".repeat(3000)}` }],
      ["NUL in id", { method: "GET", url: "/api/quote/%00" }],
      ["TRACE", { method: "TRACE", url: "/api/health" }],
      ["wrong content type to auth", { method: "POST", url: "/api/auth/login", headers: { "Content-Type": "text/plain", "Content-Length": "2" }, body: "{}" }],
      ["2 MB JSON", { method: "POST", url: "/api/quote", json: { parts: [], pad: "x".repeat(2 * 1024 * 1024) } }],
      ["deep JSON", { method: "POST", url: "/api/quote", headers: { "Content-Type": "application/json" }, body: "[".repeat(200000) + "]".repeat(200000) }],
      ["__proto__ body", { method: "POST", url: "/api/quote", headers: { "Content-Type": "application/json" }, body: '{"__proto__":{"admin":true},"constructor":{"prototype":{"role":"admin"}},"parts":[{"partId":"x","__proto__":{"quantity":5}}]}' }],
      ["verify-email with object token", { method: "POST", url: "/api/auth/verify-email", json: { token: { a: 1 } } }],
      ["reset confirm with array token", { method: "POST", url: "/api/auth/password-reset/confirm", json: { token: ["x"], password: 5 } }],
      ["firm-quote garbage token", { method: "GET", url: "/api/rfq/quote/" + "A".repeat(5000) }],
    ];
    for (const [name, o] of cases) {
      if (o.body && o.headers && !o.headers["Content-Length"]) o.headers["Content-Length"] = String(Buffer.byteLength(o.body));
      const r = await s.req({ ...o, ip: c.randomIp(), timeoutMs: 15000 }).catch((e) => ({ status: "ERR", text: e.message, headers: {} }));
      console.log(`${String(r.status).padEnd(4)} ${name.padEnd(30)} ${String(r.text).slice(0, 90).replace(/\s+/g, " ")}${leaky(String(r.text)) ? "  <-- LEAK" : ""}`);
    }
    console.log("== is the process still healthy, and did Object.prototype stay clean?");
    console.log((await s.get("/api/health")).status, "x-powered-by:", (await s.get("/api/health")).headers["x-powered-by"] || "(absent)");
    console.log("== what the server logged for those requests (stack traces are expected only for real 500s)");
    const log = s.log().split("\n").filter((l) => /→ 5\d\d|Error|error/.test(l)).slice(-12);
    console.log(log.join("\n") || "(nothing)");
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
