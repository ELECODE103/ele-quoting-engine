const c = require("/home/claude/ele-quoting-engine/.claude/worktrees/sec-review/tools/security/review/lib/common.js");
const show = (label, h) => console.log(`\n== ${label}\n` + ["content-security-policy","x-frame-options","strict-transport-security","referrer-policy","permissions-policy","x-content-type-options","cache-control","content-type","content-disposition","x-robots-tag","access-control-allow-origin"].filter(k=>h[k]!==undefined).map(k=>`  ${k}: ${h[k]}`).join("\n"));
(async () => {
  const s = await c.start({ mailer: true });
  try {
    const ip = "203.0.113.5";
    show("GET /api/health", (await s.get("/api/health", { ip })).headers);
    show("GET / (home HTML)", (await s.get("/", { ip })).headers);
    const nf = await s.get("/no-such-page-xyz", { ip }); console.log("\n404 status:", nf.status); show("GET /no-such-page (404)", nf.headers);
    const api404 = await s.get("/api/nope", { ip }); console.log("\napi404:", api404.status, api404.body); show("api 404", api404.headers);
    show("GET /api/materials (API JSON)", (await s.get("/api/materials", { ip })).headers);
    // admin download content-type/disposition
    const admin = await s.admin({ ip: "203.0.113.1" });
    const A = await s.register("a@example.test", { ip });
    const up = await s.upload([{ name: "x.stl", data: c.boxStl(20) }], { ip, token: A });
    const dl = await s.get(`/api/parts/${up.body.parts[0].partId}/download`, { token: admin, ip: "203.0.113.1" });
    show("admin part download", dl.headers); console.log("  (first bytes):", dl.buffer.slice(0,8).toString("latin1").replace(/[^\x20-\x7e]/g,"."));
    const bk = await s.get("/api/admin/backup/db", { token: admin, ip: "203.0.113.1" }); show("admin backup db", bk.headers);
    // error page / stack leak: force a 500 by bad JSON
    const bad = await s.req({ method: "POST", url: "/api/quote", headers: { "Content-Type": "application/json", "Content-Length": "5" }, body: "{bad", ip });
    console.log("\nbad JSON:", bad.status, bad.text.slice(0, 200));
    // sourcemaps / dotfiles exposed?
    for (const p of ["/.env", "/.git/config", "/data/quoting.db", "/assets/index.js.map", "/server/index.js", "/brand/documents/", "/_prerender/home.html"]) {
      const r = await s.get(p, { ip }); console.log(`static ${p} -> ${r.status}`);
    }
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
