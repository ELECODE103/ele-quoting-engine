#!/usr/bin/env node
/**
 * Item 4 of the review: what can one script create before the server says no?
 *
 *   node tools/security/review-uploads/abuse-limits.js off     bot check not configured (as deployed today)
 *   node tools/security/review-uploads/abuse-limits.js on      bot check on, Cloudflare answered locally (a token starting "pass" passes)
 *
 * Each figure is counted against the running server, from ONE address, until the first refusal;
 * then a second address (and a second /64 of the same IPv6 /48) is tried to show the count is per key.
 * Stripe is a local stub and no email leaves the machine (the server writes them to a folder).
 */
const g = require("./gen");
const { startServer, sleep, ls } = require("./lib");

const cube = g.stlCube();
const pdf = Buffer.from("%PDF-1.4\n%%EOF\n");

(async () => {
  const mode = process.argv[2] === "on" ? "on" : "off";
  const s = await startServer({ stubs: true, mail: true, turnstile: mode === "on" });
  const A = "198.51.100.21", B = "198.51.100.22", V6a = "2001:db8:77:1::5", V6b = "2001:db8:77:2::5", V6a2 = "2001:db8:77:1:abcd::9";
  const res = {};
  const T = mode === "on" ? { "X-Turnstile-Token": "pass-x" } : {};
  let human = "";
  try {
    if (mode === "on") {
      const none = await s.upload([{ name: "c.stl", data: cube }], { ip: A });
      res["upload with no check passed"] = none.status;
      const v = await s.post("/api/human/verify", { turnstileToken: "pass-quote", action: "quote" }, { ip: A });
      human = v.body.humanToken;
      const other = await s.upload([{ name: "c.stl", data: cube }], { ip: "203.0.113.99", headers: { "X-Human-Token": human } });
      res["verified-human token from address A used from another address"] = `${other.status} (${other.body?.parts?.length || 0} part)`;
    }
    const H = human ? { "X-Human-Token": human } : {};

    // 1. parts: uploads of ten 684-byte cubes
    const partsFrom = async (ip, maxReq = 60) => { let parts = 0, reqs = 0, last = 0, ids = []; for (let i = 0; i < maxReq; i++) { const r = await s.upload(Array.from({ length: 10 }, (_, k) => ({ name: `c${k}.stl`, data: cube })), { ip, headers: H }); last = r.status; if (r.status !== 200) break; reqs++; parts += r.body.parts.length; if (ids.length < 100) ids.push(...r.body.parts.map((p) => p.partId)); } return { parts, reqs, last, ids }; };
    const pA = await partsFrom(A);
    res["parts per 15 min, one address"] = `${pA.parts} in ${pA.reqs} requests, then HTTP ${pA.last}`;
    res["parts, second address straight after"] = (await partsFrom(B, 1)).parts;
    res["parts, IPv6 same /64 twice then another /64 of the /48"] = [(await partsFrom(V6a, 60)).parts, (await partsFrom(V6a2, 1)).parts, (await partsFrom(V6b, 1)).parts].join(" / ");

    // 2. quotes (new draft rows): 40 per 10 s, 300 per 15 min
    const mat = (await s.get("/api/materials?process=cnc", { ip: B })).body[0];
    const line = (id) => ({ partId: id, materialSlug: mat.slug, quantity: 1, process: "cnc", subProcess: "milling" });
    let quotes = 0, burst = 0, firstBurst = null, lastStatus = 0, quoteIds = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 200000) {
      const r = await s.post("/api/quote", { parts: [line(pA.ids[0])], leadTimeSlug: "standard" }, { ip: A, headers: H });
      lastStatus = r.status;
      if (r.status === 200) { quotes++; burst++; quoteIds.push(r.body.quoteId); continue; }
      if (r.status === 429 && /faster than/.test(r.body?.error || "")) { if (firstBurst === null) firstBurst = burst; await sleep(2500); continue; }
      break;
    }
    res["draft quotes per 15 min, one address"] = `${quotes} (first burst ${firstBurst} in under 10 s), then HTTP ${lastStatus} after ${Math.round((Date.now() - t0) / 1000)} s`;
    res["draft quote, second address straight after"] = (await s.post("/api/quote", { parts: [line(pA.ids[0])], leadTimeSlug: "standard" }, { ip: B, headers: H })).status;

    // 3. firm-quote requests with an attachment
    const rfqFrom = async (ip, n = 40) => { let ok = 0, last = 0, code = ""; for (let i = 0; i < n; i++) { const r = await s.rfq({ contactName: "Bot", email: `victim${ip.replace(/\W/g, "")}${i}@example.test`, notes: `n${i}` }, [{ name: "d.pdf", data: pdf }], { ip, headers: T }); last = r.status; code = r.body?.code || ""; if (r.status !== 201) break; ok++; } return { ok, last, code }; };
    const rA = await rfqFrom(A);
    res["firm-quote requests (each with an attachment) per hour, one address"] = `${rA.ok}, then HTTP ${rA.last} ${rA.code}`;
    const rB = await rfqFrom(B, 2);
    res["firm-quote requests, second address straight after"] = rB.ok;
    res["firm-quote requests, two /64s of one /48"] = `${(await rfqFrom(V6a, 12)).ok} + ${(await rfqFrom(V6b, 12)).ok}`;
    res["attachments now on disk (never swept while the request is open)"] = ls(s, "rfq-drawings").length;

    // 4. accounts
    const regFrom = async (ip, n = 14) => { let ok = 0, last = 0, code = "", tokens = []; for (let i = 0; i < n; i++) { const r = await s.post("/api/auth/register", { email: `acct${ip.replace(/\W/g, "")}${i}@example.test`, password: `Rv9-${Math.random().toString(36).slice(2)}-x`, name: "Bot" }, { ip, headers: { "X-Form-Token": s.formToken("register"), ...T } }); last = r.status; code = r.body?.code || ""; if (r.status !== 201) break; ok++; tokens.push(r.body.token); } return { ok, last, code, tokens }; };
    const C = "198.51.100.23"; // a fresh address: A has used its form allowance on requests (the two share one counter)
    const aC = await regFrom(C);
    res["accounts per hour, one fresh address"] = `${aC.ok}, then HTTP ${aC.last} ${aC.code}`;
    const aA = await regFrom(A, 2);
    res["accounts from the address that already sent its firm-quote requests"] = `${aA.ok} (HTTP ${aA.last} ${aA.code}: registrations and requests share the per-address form counter)`;

    // 5. email
    await sleep(500);
    const mail = s.mail();
    const shop = mail.filter((m) => (Array.isArray(m.to) ? m.to : [m.to]).includes(s.adminEmail));
    const toTyped = mail.filter((m) => !(Array.isArray(m.to) ? m.to : [m.to]).includes(s.adminEmail));
    const bySubject = {};
    for (const m of toTyped) { const k = m.subject.replace(/[0-9A-F]{6,}/gi, "#").slice(0, 60); bySubject[k] = (bySubject[k] || 0) + 1; }
    res["emails to the shop's inbox so far (one per request)"] = shop.length;
    res["emails to addresses the script typed, by subject"] = JSON.stringify(bySubject);
    // password reset to an address that has an account: per-address and per-IP caps
    let resets = 0;
    for (let i = 0; i < 8; i++) { const r = await s.post("/api/auth/password-reset/request", { email: `acct${C.replace(/\W/g, "")}0@example.test` }, { ip: "198.51.100.24", headers: { "X-Form-Token": s.formToken("password-reset"), ...T } }); if (r.status !== 200) break; resets++; }
    await sleep(300);
    res["password-reset emails to one account's address from one address"] = `${s.mail(`acct${C.replace(/\W/g, "")}0@example.test`, /password/i).length} sent for ${resets} accepted requests`;

    // 6. Stripe checkout sessions (stub): one account, one quote, asked again and again
    const buyer = await s.register("checkout-bot@example.test", { ip: "198.51.100.25", headers: T });
    const q = await s.post("/api/quote", { parts: [line(pA.ids[1])], leadTimeSlug: "standard" }, { ip: "198.51.100.25", headers: H });
    let sessions = 0, lastCo = 0, orders = new Set();
    for (let i = 0; i < 230; i++) { const r = await s.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, shippingName: "B", shippingAddress: "1 Test St", shippingCity: "T", shippingState: "IL", shippingZip: "60000" }, { token: buyer, ip: "198.51.100.25" }); lastCo = r.status; if (r.status !== 200) break; sessions++; orders.add(r.body.orderId); }
    res["Stripe checkout sessions per 15 min, one account and address (stub)"] = `${sessions} sessions on ${orders.size} order(s), then HTTP ${lastCo}`;
    // different quotes → different pending orders in the admin queue
    const buyer2 = await s.register("checkout-bot2@example.test", { ip: "198.51.100.26", headers: T });
    let pendingOrders = 0;
    for (let i = 0; i < 60; i++) { const qq = await s.post("/api/quote", { parts: [line(pA.ids[2])], leadTimeSlug: "standard" }, { ip: "198.51.100.26", headers: H }); if (qq.status !== 200) break; const r = await s.post("/api/orders/checkout-session", { quoteId: qq.body.quoteId, shippingName: "B", shippingAddress: "1 Test St", shippingCity: "T", shippingState: "IL", shippingZip: "60000" }, { token: buyer2, ip: "198.51.100.26" }); if (r.status !== 200) break; pendingOrders++; }
    res["unpaid orders created in the admin's list (60 tried, one account)"] = pendingOrders;

    // 7. PDFs: every document route is admin-only
    const p1 = await s.get(`/api/pdf/quote/${q.body.quoteId}`, { token: buyer, ip: "198.51.100.25" });
    const p2 = await s.get(`/api/pdf/quote/${q.body.quoteId}`, { ip: "198.51.100.25" });
    res["PDF generation as a customer / anonymous"] = `${p1.status} / ${p2.status}`;

    console.log(`\n=== bot check ${mode.toUpperCase()} ===`);
    for (const [k, v] of Object.entries(res)) console.log(`${k}: ${v}`);
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
