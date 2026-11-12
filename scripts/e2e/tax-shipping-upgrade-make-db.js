/**
 * Step 1 of the upgrade check (step 2: scripts/e2e/tax-shipping-upgrade.mjs).
 *
 * This file runs on the code of the branch BEFORE the shipping and tax work, not on this one:
 *
 *   mkdir /tmp/base && git archive hardening-2026-11-11 server shared tools/vet-quotes/parts/cube_20mm.stl package.json | tar -x -C /tmp/base
 *   ln -s "$PWD/node_modules" /tmp/base/node_modules
 *   cp scripts/e2e/tax-shipping-upgrade-make-db.js /tmp/base/make-db.js
 *   (cd /tmp/base && node make-db.js /tmp/base-live)
 *
 * It uses that branch's own test harness (Stripe stubbed, emails captured) to make a database the
 * way the previous version made it: a buyer, a paid order, a draft quote with the inspection
 * paperwork, and a firm quote for a shipped-in part accepted on a purchase order. The database and
 * its data folder are copied to the folder named on the command line, with ids.json beside them.
 */
const fs = require("fs");
const path = require("path");
const { start } = require("./server/testSupport/harness");
(async () => {
  const h = await start();
  const owner = await h.admin("Owner");
  const buyer = await h.register("dana@buyer.test", "Dana Buyer");
  const partId = await h.uploadCube();
  const SHIP = { shippingName: "Dana Buyer", shippingAddress: "100 Main St", shippingCity: "Elgin", shippingState: "IL", shippingZip: "60120" };
  const q = await h.post("/api/quote", { parts: [h.cncConfig(partId, 3)], leadTimeSlug: "expedited" }, buyer);
  const c = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, buyer);
  h.pay("cs_test_1");
  await h.post(`/api/orders/${c.body.orderId}/confirm-payment`, {}, buyer);
  const draft = await h.post("/api/quote", { parts: [h.cncConfig(partId, 2)], leadTimeSlug: "standard", paperwork: true }, buyer);
  // A firm quote for a shipped-in part with the original going back, accepted on a PO.
  const rfq = await h.form("/api/rfq", { requestType: "part", contactName: "Pat Purchasing", email: "pat@oem.test", returnPart: "true", notes: "worn guide block" });
  h.sent.length = 0;
  await h.put(`/api/rfq/admin/${rfq.body.rfqId}`, { status: "quoted", quotedTotal: 4250, quotedLeadDays: 15 }, owner);
  const token = (h.sent[0].text.match(/https:\/\/shop\.test\/firm-quote\/(\S+)/) || [])[1];
  await h.post(`/api/rfq/quote/${token}/accept`, { method: "po", poNumber: "PO-OLD-1", ...SHIP });
  const { ordersDB, rfqsDB } = h.models;
  const out = { buyerPassword: h.password, adminSecret: h.adminSecret, orderId: c.body.orderId, quoteId: q.body.quoteId, draftId: draft.body.quoteId, draftTotal: draft.body.orderTotal, draftShipping: draft.body.shippingEstimate, paidTotal: ordersDB.getById(c.body.orderId).total, paidShipping: ordersDB.getById(c.body.orderId).shippingCost, poOrderId: rfqsDB.getById(rfq.body.rfqId).orderId, firmToken: token, partId,
    orderColumns: (() => { const st = require("./server/models/database").getDatabase().prepare("PRAGMA table_info(orders)"); const a = []; while (st.step()) a.push(st.getAsObject().name); st.free(); return a; })() };
  const dest = process.argv[2];
  fs.mkdirSync(path.join(dest, "data"), { recursive: true });
  fs.cpSync(path.join(h.tmp, "data"), path.join(dest, "data"), { recursive: true });
  fs.copyFileSync(path.join(h.tmp, "quoting.db"), path.join(dest, "data", "quoting.db"));
  fs.writeFileSync(path.join(dest, "ids.json"), JSON.stringify(out, null, 2));
  console.log("BASE DB WRITTEN", out.orderColumns.length, "order columns; has shipping_mode:", out.orderColumns.includes("shipping_mode"), "tax_mode:", out.orderColumns.includes("tax_mode"));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
