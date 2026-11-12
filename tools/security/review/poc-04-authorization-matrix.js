const c = require("/home/claude/ele-quoting-engine/.claude/worktrees/sec-review/tools/security/review/lib/common.js");
const totp = require("/home/claude/ele-quoting-engine/.claude/worktrees/sec-review/server/security/totp");
const crypto = require("crypto");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
(async () => {
  const s = await c.start({ mailer: true });
  try {
    const ipA = "203.0.113.5", ipB = "203.0.113.6", ipO = "203.0.113.1";
    const A = await s.register("a@example.test", { ip: ipA });
    const B = await s.register("b@example.test", { ip: ipB });
    // fixtures for A
    const up = await s.upload([{ name: "a.stl", data: c.boxStl([60, 40, 20]) }], { ip: ipA, token: A });
    const partA = up.body.parts[0];
    const dx = await s.upload([{ name: "a.dxf", data: c.rectDxf(40, 30, 4) }], { ip: ipA, token: A, fields: { process: "routing" } });
    const dxfA = dx.body.parts[0];
    const qA = (await s.post("/api/quote", { parts: [{ partId: partA.partId, materialSlug: "cnc-delrin", process: "cnc", quantity: 2 }], notes: "A's private note" }, { ip: ipA, token: A })).body;
    const dr = await s.upload([{ field: "drawing", name: "a.pdf", data: PDF }], { ip: ipA, token: A, url: `/api/quote/${qA.quoteId}/drawing` });
    const qA2 = (await s.post("/api/quote", { parts: [{ partId: partA.partId, materialSlug: "cnc-delrin", process: "cnc", quantity: 3 }] }, { ip: ipA, token: A })).body;
    const co = await s.post("/api/orders/checkout-session", { quoteId: qA.quoteId, shippingName: "A", shippingAddress: "1 A St", shippingCity: "C", shippingState: "IL", shippingZip: "60000" }, { ip: ipA, token: A });
    const orderA = co.body.orderId;
    const rfqA = await s.rfq({ contactName: "A", email: "a@example.test", quoteId: qA2.quoteId, notes: "secret rfq" }, [], { ip: ipA, token: A });
    console.log("fixtures", up.status, dx.status, dr.status, co.status, rfqA.status, rfqA.body.rfqId);
    const admin = await s.admin({ ip: ipO, enrol: false }); // unenrolled admin session
    console.log("admin (unenrolled) profile:", (await s.get("/api/auth/profile", { token: admin, ip: ipO })).body);

    const probes = [
      ["GET", `/api/quote/${qA.quoteId}`], ["GET", `/api/quote/${qA.quoteId}/session`],
      ["POST", `/api/quote`, { quoteId: qA2.quoteId, parts: [{ partId: partA.partId, materialSlug: "cnc-delrin", process: "cnc", quantity: 1 }] }],
      ["DELETE", `/api/quote/${qA2.quoteId}/drawing`],
      ["POST", `/api/orders/checkout-session`, { quoteId: qA2.quoteId, shippingName: "x" }],
      ["GET", `/api/orders`], ["GET", `/api/orders/${orderA}`], ["GET", `/api/orders/${orderA}/drawing`], ["POST", `/api/orders/${orderA}/confirm-payment`, {}],
      ["POST", `/api/orders/${orderA}/reorder`, {}], ["GET", `/api/orders/${orderA}/traveler`], ["PUT", `/api/orders/${orderA}/status`, { status: "paid" }],
      ["POST", `/api/orders`, { quoteId: qA2.quoteId }], ["GET", `/api/orders/admin/queue`],
      ["GET", `/api/pdf/traveler/${orderA}`], ["GET", `/api/pdf/packing-list/${orderA}`], ["GET", `/api/pdf/quote/${qA.quoteId}`], ["GET", `/api/pdf/order-confirmation/${orderA}`], ["GET", `/api/pdf/packing-slip/${orderA}`], ["GET", `/api/pdf/coc/${orderA}`], ["GET", `/api/pdf/fai`], ["GET", `/api/pdf/rfq-response/${rfqA.body.rfqId}`],
      ["GET", `/api/rfq/${rfqA.body.rfqId}`], ["GET", `/api/rfq/admin/list`], ["PUT", `/api/rfq/admin/${rfqA.body.rfqId}`, { status: "quoted", quotedTotal: 1, quotedLeadDays: 1 }], ["GET", `/api/rfq/admin/${rfqA.body.rfqId}/drawing`],
      ["GET", `/api/parts/${partA.partId}/download`], ["POST", `/api/parts/${dxfA.partId}/units`, { units: "in" }],
      ["GET", `/api/admin/materials`], ["POST", `/api/admin/materials`, { name: "x", slug: "x" }], ["GET", `/api/admin/finishes`], ["GET", `/api/admin/pricing`], ["PUT", `/api/admin/pricing`, { rules: { minimumOrderTotal: 0 } }],
      ["GET", `/api/admin/pricing/schema`], ["POST", `/api/admin/pricing/preview`, {}], ["GET", `/api/admin/pricing/history`], ["POST", `/api/admin/pricing/reset`, {}], ["GET", `/api/admin/calibration`], ["GET", `/api/admin/lead-times`],
      ["GET", `/api/admin/quotes`], ["GET", `/api/admin/stats`], ["GET", `/api/admin/parts`], ["GET", `/api/admin/backup/db`], ["GET", `/api/admin/backup/json`],
      ["GET", `/api/auth/2fa`],
    ];
    const who = { guest: {}, buyerB: { token: B }, unenrolledAdmin: { token: admin } };
    for (const [m, url, json] of probes) {
      const row = [];
      for (const [name, o] of Object.entries(who)) {
        const r = await s.req({ method: m, url, json, ip: c.randomIp(), ...o });
        const leak = /private note|secret rfq|a@example\.test|1 A St/.test(r.text) ? " LEAK" : "";
        row.push(`${name}=${r.status}${r.body && r.body.code ? "(" + r.body.code + ")" : ""}${leak}`);
      }
      console.log(m.padEnd(6), url.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id").padEnd(40), row.join("  "));
    }
    // What a guest POST /quote with A's quoteId did
    console.log("A's quote2 after probes: status", (await s.get(`/api/quote/${qA2.quoteId}`, { token: A, ip: ipA })).body.status);
    // rfq create against A's quote as B / guest
    const rb = await s.rfq({ contactName: "B", email: "b@example.test", quoteId: qA.quoteId }, [], { ip: ipB, token: B });
    console.log("B rfq on A's quote:", rb.status);
    // part edit key derivation via a quote of one's own
    const qb = await s.post("/api/quote", { parts: [{ partId: dxfA.partId, materialSlug: "rt-hdpe", process: "routing", thicknessMm: 6.35, quantity: 1 }] }, { ip: ipB, token: B });
    const sessB = await s.get(`/api/quote/${qb.body.quoteId}/session`, { ip: ipB, token: B });
    const key = sessB.body.parts && sessB.body.parts[0] && sessB.body.parts[0].editKey;
    console.log("B quoting A's partId:", qb.status, "session gives editKey:", Boolean(key), key === dxfA.editKey ? "(same key the uploader got)" : "");
    const sw = await s.post(`/api/parts/${dxfA.partId}/units`, { units: "in" }, { ip: ipB, token: B, headers: { "X-Part-Key": key } });
    console.log("B changes units of A's part:", sw.status, sw.body.geometry && sw.body.geometry.boundingBox.width);
    console.log("B reads A's mesh via own quote: positions", sessB.body.parts[0].meshPreview && sessB.body.parts[0].meshPreview.positions.length, "fileName", sessB.body.parts[0].fileName);
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
