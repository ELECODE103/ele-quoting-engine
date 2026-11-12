#!/usr/bin/env node
/**
 * RR-09 / RR-10: parts priced from measurements that are finite but wrong.
 * A passing fix: in `volume` every hostile row is refused (or sent to a person) instead of priced with
 * checkout open; in `units` the checkout of a quote whose part changed size after pricing is refused.
 *
 *   node tools/security/rereview-availability/geometry-price.js volume   STL volume tricks against assertSaneGeometry
 *   node tools/security/rereview-availability/geometry-price.js units    price a DXF in millimetres, switch it to inches, check out at the millimetre price
 *   node tools/security/rereview-availability/geometry-price.js small    the smallest and thinnest things that still price
 *
 * Stripe is the repository's local stand-in. Limits are the defaults.
 */
const c = require("./common");
const mode = process.argv[2] || "volume";

const cubeTris = (s, o = 0, flip = false) => {
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]].map((p) => p.map((x) => x + o));
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return t.map((f) => (flip ? [f[0], f[2], f[1]] : f).map((i) => v[i]));
};
const boxTris = (w, d, h, o = [0, 0, 0], flip = false) => cubeTris(1, 0, flip).map((t) => t.map((p) => [o[0] + p[0] * w, o[1] + p[1] * d, o[2] + p[2] * h]));

async function priceBoth(s, ip, token, name, data) {
  const up = await s.upload([{ name, data }], { ip, token, timeoutMs: 120000 });
  const part = up.body && up.body.parts && up.body.parts[0];
  if (!part) return { upload: (up.body && (up.body.code || (up.body.errors && up.body.errors[0] && up.body.errors[0].code))) || up.status };
  const g = part.geometry;
  const out = { upload: "accepted", box: [g.boundingBox.width, g.boundingBox.height, g.boundingBox.depth].map((n) => Number(n.toFixed(2))), volumeMm3: Math.round(g.volume), volumeOverBox: Number((g.volume / (g.boundingBox.width * g.boundingBox.height * g.boundingBox.depth)).toFixed(4)) };
  for (const [label, process, sub] of [["print", "3d-printing", "fdm"], ["cnc", "cnc", "milling"]]) {
    const { line } = await c.lineFor(s, part.partId, process, ip);
    let q;
    for (let i = 0; i < 5; i++) { q = await s.post("/api/quote", { parts: [{ ...line, subProcess: sub }], leadTimeSlug: "standard" }, { ip, token }); if (q.status !== 429) break; await c.sleep(1500); }
    out[label] = q.status === 200
      ? { each: Number(q.body.lineItems[0].perUnit.final.toFixed(2)), checkoutOpen: !(q.body.gate && q.body.gate.requiresRfq), ...(q.body.gate && q.body.gate.requiresRfq ? { why: (q.body.gate.reasons || []).map((r) => r.code || r.id || r.title || r).slice(0, 2) } : {}) }
      : { refused: (q.body && q.body.code) || q.status };
  }
  return out;
}

async function volume() {
  const s = await c.startServer({ stubs: true });
  try {
    const ip = "192.0.2.150";
    const token = await s.register("geo@example.test", { ip });
    const S = 100;
    const cases = [
      ["honest 100 mm cube", c.g.stl(cubeTris(S))],
      ["honest hollow cube, 10 mm walls (control)", c.g.stl([...cubeTris(S), ...cubeTris(80, 10, true)])],
      ["100 mm cube + its inside-out copy (the reviewer's case, volume 0)", c.g.stl([...cubeTris(S), ...cubeTris(S, 0, true)])],
      ["100 mm cube + an inside-out cube 0.2 mm smaller (walls of 0.1 mm: volume 0.6 % of a solid)", c.g.stl([...cubeTris(S), ...cubeTris(S - 0.2, 0.1, true)])],
      ["100 mm cube + an inside-out cube 0.002 mm smaller (walls of a micrometre)", c.g.stl([...cubeTris(S), ...cubeTris(S - 0.002, 0.001, true)])],
      ["100 mm cube with five more cubes nested inside, all facing out (volume 4.6 x the box)", c.g.stl([...cubeTris(S), ...[98, 96, 94, 92, 90].flatMap((k) => cubeTris(k, (S - k) / 2))])],
      ["thin frame 100 x 100 x 50, 4 mm bars (honest, 2 % of its box)", c.g.stl([...boxTris(100, 4, 4), ...boxTris(4, 100, 4, [0, 0, 0.01]), ...boxTris(4, 4, 50, [0.01, 0.01, 0.01])])],
      ["the same frame + 60 closed shells hidden inside one of its bars (the bar's volume counted 60 times over)", c.g.stl([...boxTris(100, 4, 4), ...boxTris(4, 100, 4, [0, 0, 0.01]), ...boxTris(4, 4, 50, [0.01, 0.01, 0.01]), ...Array.from({ length: 60 }, (_, i) => boxTris(99 - i * 0.001, 3.9 - i * 0.001, 3.9 - i * 0.001, [0.05, 0.05, 0.05])).flat()])],
      ["the same frame + 330 hidden shells (counted volume = the whole bounding box)", c.g.stl([...boxTris(100, 4, 4), ...boxTris(4, 100, 4, [0, 0, 0.01]), ...boxTris(4, 4, 50, [0.01, 0.01, 0.01]), ...Array.from({ length: 330 }, (_, i) => boxTris(99 - i * 0.001, 3.9 - i * 0.001, 3.9 - i * 0.001, [0.05, 0.05, 0.05])).flat()])],
    ];
    const rows = [];
    for (const [label, data] of cases) { const r = { model: label, ...(await priceBoth(s, ip, token, "model.stl", data)) }; rows.push(r); c.log(JSON.stringify(r)); }
    c.result({ test: "geometry-price volume", rows });
  } finally { await s.stop(); }
}

async function small() {
  const s = await c.startServer({ stubs: true });
  try {
    const ip = "192.0.2.151";
    const token = await s.register("small@example.test", { ip });
    const rows = [];
    for (const [label, data] of [
      ["1 mm cube", c.g.stl(cubeTris(1))],
      ["0.99 mm cube", c.g.stl(cubeTris(0.99))],
      ["100 x 100 x 0.011 mm sheet (11 micrometres thick)", c.g.stl(boxTris(100, 100, 0.011))],
      ["100 x 100 x 0.009 mm sheet", c.g.stl(boxTris(100, 100, 0.009))],
      ["1,000 x 1,000 x 0.011 mm sheet", c.g.stl(boxTris(1000, 1000, 0.011))],
      ["9,999 mm cube", c.g.stl(cubeTris(9999))],
      ["20 mm cube 99 m from the origin", c.g.stl(cubeTris(20, 99000))],
    ]) { const r = { model: label, ...(await priceBoth(s, ip, token, "model.stl", data)) }; rows.push(r); c.log(JSON.stringify(r)); }
    c.result({ test: "geometry-price small", rows });
  } finally { await s.stop(); }
}

async function units() {
  const s = await c.startServer({ stubs: true });
  try {
    const ip = "192.0.2.152";
    const token = await s.register("units@example.test", { ip });
    // A plain 20 x 15 outline with two holes. (This one even declares millimetres in its header; the route lets any DXF be switched.)
    const dxf = Buffer.from(c.g.dxfDoc({ entities: c.g.dxfRect(0, 0, 20, 15) + c.g.dxfCircle(5, 7.5, 2) + c.g.dxfCircle(15, 7.5, 2) }));
    const up = await s.upload([{ name: "plate.dxf", data: dxf }], { ip, token, fields: { process: "routing" } });
    const part = up.body.parts[0];
    const key = part.editKey;
    const setUnits = (u) => s.post(`/api/parts/${part.partId}/units`, { units: u }, { ip, token, headers: { "X-Part-Key": key } });
    const mats = (await s.get("/api/materials?process=routing", { ip })).body;
    const QTY = Number(process.argv[3]) || 10;
    const price = async (line, quoteId) => { let q; for (let i = 0; i < 8; i++) { q = await s.post("/api/quote", { parts: [line], leadTimeSlug: "standard", ...(quoteId ? { quoteId } : {}) }, { ip, token }); if (q.status !== 429) break; await c.sleep(1500); } return q; };
    const size = (b) => b && b.geometry ? [b.geometry.boundingBox.width, b.geometry.boundingBox.height].map((n) => Number(n.toFixed(1))) : null;
    const open = (q) => q.status === 200 && !(q.body.gate && q.body.gate.requiresRfq);
    // Honest reference: QTY of the inch-sized plate, in the listed material and thickness where that costs most with checkout open.
    const inch = await setUnits("in");
    let best = null;
    for (const m of mats) {
      const th = (m.thicknesses || []).map((t) => t.mm).sort((x, y) => y - x)[0];
      if (!th) continue;
      const line = { partId: part.partId, materialSlug: m.slug, quantity: QTY, process: "routing", thicknessMm: th };
      const q = await price(line);
      if (open(q) && (!best || q.body.orderTotal > best.total)) best = { line, total: q.body.orderTotal, material: m.name, thicknessMm: th };
    }
    if (!best) throw new Error("no routing material prices the inch-sized plate with checkout open");
    // The trick: say millimetres, price it, then say inches, then pay the millimetre price.
    const mm = await setUnits("mm");
    const cheap = await price(best.line);
    const back = await setUnits("in");
    const stored = (await s.get(`/api/quote/${cheap.body.quoteId}`, { ip, token })).body;
    const co = await s.post("/api/orders/checkout-session", { quoteId: cheap.body.quoteId, shippingName: "B", shippingAddress: "1 Test St", shippingCity: "T", shippingState: "IL", shippingZip: "60000" }, { ip, token });
    let order = null; let lockedAfter = null; let nowSize = null;
    if (co.status === 200) {
      order = (await s.get(`/api/orders/${co.body.orderId}`, { ip, token })).body;
      lockedAfter = (await setUnits("mm")).status;
      const sess = (await s.get(`/api/quote/${cheap.body.quoteId}/session`, { ip, token })).body;
      nowSize = sess && sess.partsById && sess.partsById[part.partId] ? size(sess.partsById[part.partId]) : null;
    }
    c.result({
      test: "geometry-price units", material: `${best.material}, ${best.thicknessMm} mm`, quantity: QTY,
      honestInchPlate: { setUnits: inch.status, sizeMm: size(inch.body), orderTotal: best.total, checkoutOpen: true },
      pricedAsMillimetres: { setUnits: mm.status, sizeMm: size(mm.body), orderTotal: cheap.status === 200 ? cheap.body.orderTotal : cheap.body, checkoutOpen: open(cheap) },
      switchedToInchesAfterPricing: { status: back.status, sizeMm: size(back.body) },
      storedQuoteStillSays: stored.orderTotal,
      checkout: { status: co.status, code: (co.body && co.body.code) || "", orderTotal: order && order.total, orderStatus: order && order.status },
      partOnTheOrderIsNowMm: nowSize, unitsLockedOnceOrdered: lockedAfter,
      underpricedBy: order ? Number((best.total - order.total).toFixed(2)) : null,
    });
  } finally { await s.stop(); }
}

({ volume, units, small }[mode] || volume)().catch((e) => { console.error(e); process.exit(1); });
