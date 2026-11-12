#!/usr/bin/env node
/**
 * Does a model with NaN / Infinity / cancelling geometry get a real price and an open checkout?
 *
 *   node tools/security/review-uploads/price-nan.js
 *
 * Uploads a solid 400 x 400 x 400 mm block (a part far outside what the instant quote should sell
 * by the click) four ways and prints what each is quoted at, for CNC and for 3D printing, and
 * whether the quote is open for card checkout (gate.requiresRfq false) or sent to a person.
 * Then, with Stripe stubbed locally, buys the doctored one.
 */
const g = require("./gen");
const { startServer } = require("./lib");

const cubeTris = (s) => { const b = g.stlCube(s); const t = []; for (let i = 0; i < 12; i++) { const o = 84 + i * 50 + 12; t.push([0, 1, 2].map((k) => [b.readFloatLE(o + k * 12), b.readFloatLE(o + k * 12 + 4), b.readFloatLE(o + k * 12 + 8)])); } return t; };

(async () => {
  const s = await startServer({ stubs: true });
  try {
    const ip = "198.51.100.70";
    const big = cubeTris(400);
    const nan = [[NaN, NaN, NaN], [0, 0, 0], [1, 0, 0]];
    const inf = [[Infinity, Infinity, Infinity], [0, 0, 0], [1, 0, 0]];
    const variants = [
      ["honest 400 mm block", g.stl(big)],
      ["same block + one stray triangle with a NaN corner", g.stl([...big, nan])],
      ["same block + one stray triangle with an Infinity corner", g.stl([...big, inf])],
      ["same block + its inside-out copy (volume cancels)", g.stlCancellingCube(400)],
      ["same block, ASCII STL, one coordinate written as 'e'", Buffer.from(g.stlAsciiCube(400).toString().replace("vertex 400 400 400", "vertex e e e"))],
    ];
    const procs = [["cnc", { process: "cnc", subProcess: "milling" }], ["3d-printing", { process: "3d-printing" }]];
    const mats = {};
    for (const [p] of procs) mats[p] = (await s.get(`/api/materials?process=${p}`, { ip })).body[0];
    let doctored = null;
    for (const [label, data] of variants) {
      const u = await s.upload([{ name: "block.stl", data }], { ip });
      const part = u.body?.parts?.[0];
      if (!part) { console.log(`${label}: upload refused — ${u.body?.errors?.[0]?.error || u.text.slice(0, 100)}`); continue; }
      const geo = part.geometry;
      const row = [`${label}`, `  measured: box ${[geo.boundingBox.width, geo.boundingBox.height, geo.boundingBox.depth].join(" x ")} mm, volume ${geo.volume}, area ${geo.surfaceArea}`];
      for (const [p, extra] of procs) {
        const q = await s.post("/api/quote", { parts: [{ partId: part.partId, materialSlug: mats[p].slug, quantity: 1, subProcess: mats[p].subProcess || extra.subProcess || "", ...extra }], leadTimeSlug: "standard" }, { ip });
        if (q.status !== 200) { row.push(`  ${p}: refused (${q.status}) ${q.body?.error || ""}`); continue; }
        const open = !q.body.gate.requiresRfq;
        row.push(`  ${p} (${mats[p].name}): $${q.body.lineItems[0].perUnit.final.toFixed(2)} each, order total $${q.body.orderTotal}; ${open ? "OPEN FOR CARD CHECKOUT" : `sent to a person (${q.body.gate.reasons.map((r) => r.code).join(", ")})`}`);
        if (open && /stray|inside-out|ASCII/.test(label) && !doctored) doctored = { quoteId: q.body.quoteId, total: q.body.orderTotal, process: p };
      }
      console.log(row.join("\n"));
    }
    if (doctored) {
      const buyer = await s.register("nan-buyer@example.test", { ip });
      const co = await s.post("/api/orders/checkout-session", { quoteId: doctored.quoteId, shippingName: "B", shippingAddress: "1 Test St", shippingCity: "T", shippingState: "IL", shippingZip: "60000" }, { token: buyer, ip });
      console.log(`\ncheckout for the doctored 400 mm block (${doctored.process}, $${doctored.total}): HTTP ${co.status} ${co.body?.sessionUrl ? "→ a Stripe checkout session was created (stub)" : co.text.slice(0, 120)}`);
    }
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
