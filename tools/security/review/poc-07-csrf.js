const c = require("./lib/common");
(async () => {
  const s = await c.start({ mailer: true });
  try {
    const ip = "203.0.113.5", ipO = "203.0.113.1";
    const A = await s.register("a@example.test", { ip });
    const admin = await s.admin({ ip: ipO });
    const cookieOnly = await s.browser(A, { csrf: false });
    const adminCookieOnly = await s.browser(admin, { csrf: false });
    const up = await s.upload([{ name: "a.stl", data: c.boxStl(20) }], { ip, token: A });
    const partId = up.body.parts[0].partId;
    const q = (await s.post("/api/quote", { parts: [{ partId, materialSlug: "cnc-delrin", process: "cnc", quantity: 1 }] }, { ip, token: A })).body;
    console.log("== state-changing routes with a cookie session but NO X-CSRF-Token (cross-site forgery check)");
    const routes = [
      ["PUT", "/api/auth/profile", { name: "changed" }, cookieOnly, "buyer"],
      ["POST", "/api/auth/logout-all", {}, cookieOnly, "buyer"],
      ["POST", "/api/auth/verify-email/resend", {}, cookieOnly, "buyer"],
      ["POST", "/api/orders/checkout-session", { quoteId: q.quoteId }, cookieOnly, "buyer"],
      ["POST", `/api/orders/${"x"}/reorder`, {}, cookieOnly, "buyer"],
      ["PUT", "/api/admin/pricing", { rules: { minimumOrderTotal: 0 }, note: "x" }, adminCookieOnly, "admin"],
      ["GET", "/api/admin/backup/db", null, adminCookieOnly, "admin"],
    ];
    for (const [m, url, json, hdr, who] of routes) {
      const r = await s.req({ method: m, url, json, ip: c.randomIp(), headers: hdr });
      console.log(`${who.padEnd(6)} ${m.padEnd(5)} ${url.padEnd(38)} -> ${r.status} ${r.body && r.body.code ? r.body.code : ""}`);
    }
    // the same with the CSRF header present, proving the route works for the real page
    const good = await s.browser(A);
    const ok = await s.req({ method: "PUT", url: "/api/auth/profile", json: { name: "ok" }, headers: good, ip });
    console.log("control: profile PUT with cookie + CSRF ->", ok.status);
    // bearer token: does it bypass the CSRF requirement? (yes by design — note it)
    const bearer = await s.req({ method: "PUT", url: "/api/auth/profile", json: { name: "viaBearer" }, token: A, ip });
    console.log("bearer PUT profile (no cookie, no CSRF) ->", bearer.status);
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
