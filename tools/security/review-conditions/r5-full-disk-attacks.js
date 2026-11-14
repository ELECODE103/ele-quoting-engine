#!/usr/bin/env node
/**
 * Review of the review-conditions fixes (2026-11-13), N-08: what the site does about MONEY while the
 * database file cannot be written, and what is left when it is restarted or when room comes back.
 *
 *   node tools/security/review-conditions/r5-full-disk-attacks.js restart   (stop while full, make room, start)
 *   node tools/security/review-conditions/r5-full-disk-attacks.js recover   (make room, no restart)
 *   R5_ERRNO=EDQUOT node …/r5-full-disk-attacks.js restart                  (the "quota exceeded" error instead of "no space")
 *
 * The real server (production mode, a child process), the persistent Stripe stand-in of the earlier
 * re-review, and a disk that is "full" for the database file while a flag file exists (the author's
 * server/testSupport/fullDiskPreload.js, or r5-edquot-preload.js for EDQUOT). No root needed.
 *
 * Lines are HOLDS / FINDING / INFO. Exit code 1 when there is a finding.
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..", "..");
const { report, sleep, SHIP } = require(path.join(ROOT, "tools/security/rereview-relaunch/lib"));
const live = require(path.join(ROOT, "server/testSupport/liveServer"));
const initSqlJs = require(path.join(ROOT, "node_modules/sql.js"));

const MODE = process.argv[2] === "recover" ? "recover" : "restart";
const ERRNO = process.env.R5_ERRNO === "EDQUOT" ? "EDQUOT" : "ENOSPC";
const cube = fs.readFileSync(path.join(ROOT, "tools/vet-quotes/parts/cube_20mm.stl"));

(async () => {
  const SQL = await initSqlJs();
  const R = report();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r5-disk-"));
  const flag = path.join(tmp, "disk-is-full.flag");
  const stripeFile = path.join(tmp, "stripe.json");
  const whsec = `whsec_${crypto.randomBytes(24).toString("hex")}`;
  const preload = ERRNO === "EDQUOT" ? path.join(__dirname, "r5-edquot-preload.js") : path.join(ROOT, "server/testSupport/fullDiskPreload.js");
  const env = {
    NODE_OPTIONS: `--require ${path.join(ROOT, "tools/security/rereview-relaunch/stripe-stub-preload.js")} --require ${preload}`,
    RR_STRIPE_FILE: stripeFile, SE_TEST_DISK_FULL_FLAG: flag, DB_SAVE_RETRY_MS: "500", DB_DRAFT_FLUSH_MS: "100",
    JWT_SECRET: crypto.randomBytes(32).toString("hex"), STRIPE_WEBHOOK_SECRET: whsec, STRIPE_SECRET_KEY: "sk_test_local_only",
    EMAIL_OUTBOX_DIR: path.join(tmp, "outbox"),
    CHECKOUT_PER_ACCOUNT_15MIN: "1000", QUOTE_NEW_PER_CLIENT_HOUR: "100000", QUOTE_NEW_PER_CLIENT_DAY: "100000", QUOTE_NEW_PER_ACCOUNT_HOUR: "100000", QUOTE_NEW_PER_ACCOUNT_DAY: "100000",
    ORDERS_UNPAID_PER_ACCOUNT: "50", ORDERS_UNPAID_PER_CLIENT: "50", ORDERS_UNPAID_NEW_PER_ACCOUNT_DAY: "100", ORDERS_UNPAID_NEW_PER_CLIENT_DAY: "100",
  };
  let s = await live.start({ env, tmpDir: tmp });
  const dbFile = path.join(s.dataDir, "quoting.db");
  const fill = () => fs.writeFileSync(flag, "full");
  const free = () => fs.rmSync(flag, { force: true });
  const markPaid = (id) => { const j = JSON.parse(fs.readFileSync(stripeFile, "utf8")); Object.assign(j.sessions[id], { status: "complete", payment_status: "paid", payment_intent: `pi_${id}` }); fs.writeFileSync(stripeFile, JSON.stringify(j)); return j.sessions[id]; };
  const stripeSessions = () => JSON.parse(fs.readFileSync(stripeFile, "utf8")).sessions;
  const signed = (event) => { const payload = JSON.stringify(event), t = Math.floor(Date.now() / 1000); const v1 = crypto.createHmac("sha256", whsec).update(`${t}.${payload}`).digest("hex"); return { body: Buffer.from(payload), headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)), "Stripe-Signature": `t=${t},v1=${v1}` } }; };
  const webhook = (event) => { const w = signed(event); return s.req({ url: "/api/stripe/webhook", method: "POST", body: w.body, headers: w.headers }); };
  const disk = () => {
    const db = new SQL.Database(fs.readFileSync(dbFile));
    const q = (sql, p = []) => { const st = db.prepare(sql); st.bind(p); const rows = []; while (st.step()) rows.push(st.getAsObject()); st.free(); return rows; };
    return { q, order: (id) => q("SELECT status, paid_at, amount_paid, refunded_amount, attention, dispute_status FROM orders WHERE id = ?", [id])[0] || null, close: () => db.close() };
  };
  const onDisk = (fn) => { const d = disk(); try { return fn(d); } finally { d.close(); } };
  const sid = (c) => String(c.body.sessionUrl).split("/").pop();

  // ── setup, with room ──
  const owner = await s.admin();
  const buyer = await s.register("dana@buyer.test");
  const up = await s.upload([{ name: "cube.stl", data: cube }], { token: buyer });
  const partId = up.body.parts[0].partId;
  const mat = (await s.get("/api/materials")).body.filter((m) => m.process === "cnc")[0];
  const line = (qty) => ({ partId, materialSlug: mat.slug, grade: (mat.grades && mat.grades[0] && mat.grades[0].name) || "", finishSlug: "", quantity: qty, process: "cnc", subProcess: "milling" });
  const newQuote = async (qty) => { const q = await s.post("/api/quote", { parts: [line(qty)], leadTimeSlug: "standard" }, { token: buyer }); if (q.status !== 200) throw new Error(`quote: ${q.status} ${q.text}`); return q.body; };
  const checkout = (quoteId) => s.post("/api/orders/checkout-session", { quoteId, ...SHIP }, { token: buyer });
  const placed = async (qty) => { const q = await newQuote(qty); const c = await checkout(q.quoteId); if (c.status !== 200) throw new Error(`checkout: ${c.status} ${c.text}`); return { quoteId: q.quoteId, orderId: c.body.orderId, session: sid(c) }; };
  const paidOrder = async (qty, evt) => { const o = await placed(qty); const w = await webhook({ id: evt, type: "checkout.session.completed", data: { object: markPaid(o.session) } }); if (w.status !== 200) throw new Error(`pay: ${w.status} ${w.text}`); return { ...o, pi: `pi_${o.session}`, cents: stripeSessions()[o.session].amount_total }; };

  const waiting = await placed(2);              // its payment page is open when the disk fills
  const toRefund = await paidOrder(3, "evt_r5_pay_refund");
  const toDispute = await paidOrder(4, "evt_r5_pay_dispute");
  const toLapse = await placed(5);
  const draft = await newQuote(6);              // priced with room; checked out when full
  // a firm quote, priced and sent, to be accepted on a purchase order when full
  const fq = await newQuote(7);
  const rfq = await s.rfq({ quoteId: fq.quoteId, contactName: "Dana Buyer", email: "dana@buyer.test", notes: "please quote", shippingName: "Dana Buyer", shippingAddress: "100 Main St", shippingCity: "Columbus", shippingState: "OH", shippingZip: "43215", shippingCountry: "US" }, [], { token: buyer });
  if (rfq.status !== 201) throw new Error(`rfq: ${rfq.status} ${rfq.text}`);
  const priced = await s.req({ method: "PUT", url: `/api/rfq/admin/${rfq.body.rfqId}`, json: { quotedTotal: 480, quotedLeadDays: 7, status: "quoted" }, token: owner });
  if (priced.status !== 200) throw new Error(`price rfq: ${priced.status} ${priced.text}`);
  const firmMail = s.mail("dana@buyer.test").reverse().find((m) => /firm-quote\//.test(m.text || ""));
  const firmToken = (firmMail.text.match(/firm-quote\/([A-Za-z0-9._~-]+)/) || [])[1];
  await sleep(400);
  const mailBefore = s.mail().length;
  const before = onDisk((d) => ({ waiting: d.order(waiting.orderId), refund: d.order(toRefund.orderId), dispute: d.order(toDispute.orderId), orders: d.q("SELECT COUNT(*) n FROM orders")[0].n }));
  console.log(`setup: ${before.orders} orders on disk; waiting ${before.waiting.status}, to-refund ${before.refund.status}, to-dispute ${before.dispute.status}; mode ${MODE}; error ${ERRNO}`);

  // ── the disk fills ──
  fill();
  console.log(`\n1. while the database file cannot be written (${ERRNO})`);
  const c1 = await checkout(draft.quoteId);
  R.check(c1.status === 503 && c1.body.code === "save-failed", "a new checkout is refused in plain words", `${c1.status} ${c1.body && c1.body.code}`);
  R.check((await s.get("/api/health")).status === 503, "the health check answers 'unavailable'");
  const listFull = (await s.get("/api/orders", { token: buyer })).body;
  const ghost = Array.isArray(listFull) ? listFull.filter((o) => o.quoteId === draft.quoteId || (o.status === "pending_payment" && ![waiting.orderId, toLapse.orderId].includes(o.id))) : [];
  if (ghost.length) R.finding("the checkout that was refused is nevertheless shown to the buyer in Your orders as an order waiting for payment", `${ghost.length} order(s): ${ghost.map((o) => `${String(o.id).slice(0, 8)} ${o.status}`).join(", ")}`);
  else R.holds("the refused checkout is not shown to the buyer as an order");
  const stripeBefore = Object.keys(stripeSessions()).length;

  // The buyer goes back to the order whose page was open before the disk filled, and pays.
  const resume = await checkout(waiting.quoteId);
  R.info("going back to pay for an order made before the disk filled", `${resume.status}${resume.body && resume.body.sessionUrl ? " (sent to the card page)" : ` ${resume.body && resume.body.code}`}`);
  const payEvent = { id: "evt_r5_pay_full", type: "checkout.session.completed", data: { object: markPaid(waiting.session) } };
  const w1 = await webhook(payEvent);
  R.check(w1.status >= 500, "a payment that cannot be saved is NOT acknowledged to Stripe (so Stripe sends it again)", `webhook answered ${w1.status}`);
  const seen = await s.get(`/api/orders/${waiting.orderId}`, { token: buyer });
  const confirm = await s.post(`/api/orders/${waiting.orderId}/confirm-payment`, {}, { token: buyer });
  const queue = await s.get("/api/orders/admin/queue", { token: owner });
  const inQueue = JSON.stringify(queue.body || "").includes(waiting.orderId);
  const diskNow = onDisk((d) => d.order(waiting.orderId));
  R.info("that order, while the disk is full", `the buyer's order page says "${seen.body && seen.body.status}"; confirm-payment answers ${confirm.status} "${confirm.body && (confirm.body.status || confirm.body.code)}"; in the owner's work queue: ${inQueue}; on the disk it is "${diskNow.status}"`);
  if (seen.body && seen.body.status === "paid" && diskNow.status !== "paid") R.info("so: the buyer (and the owner) are shown PAID for an order that is not paid on the disk. Whether that is ever lost is checked below");
  const w1b = await webhook(payEvent);
  R.check(w1b.status === 503, "Stripe's second delivery of that payment is not acknowledged from memory", `${w1b.status}`);
  const paidMail = s.mail().slice(mailBefore).filter((m) => /paid|payment received|order confirm|new order/i.test(m.subject || ""));
  R.info("emails about that payment written while the disk was full", `${paidMail.length}`);

  // A refund, a dispute and a lapsed page reported by Stripe while the disk is full.
  const refundEvent = { id: "evt_r5_refund", type: "charge.refunded", data: { object: { id: "ch_r5_1", object: "charge", payment_intent: toRefund.pi, amount: toRefund.cents, amount_captured: toRefund.cents, amount_refunded: toRefund.cents, refunded: true, metadata: { orderId: toRefund.orderId } } } };
  const w2 = await webhook(refundEvent);
  const disputeEvent = { id: "evt_r5_dispute", type: "charge.dispute.created", data: { object: { id: "dp_r5_1", object: "dispute", payment_intent: toDispute.pi, amount: toDispute.cents, status: "needs_response", reason: "fraudulent" } } };
  const w3 = await webhook(disputeEvent);
  const lapseEvent = { id: "evt_r5_lapse", type: "checkout.session.expired", data: { object: { ...stripeSessions()[toLapse.session], status: "expired" } } };
  const w4 = await webhook(lapseEvent);
  const d2 = onDisk((d) => ({ refund: d.order(toRefund.orderId), dispute: d.order(toDispute.orderId), lapse: d.order(toLapse.orderId), events: d.q("SELECT event_id FROM payment_events WHERE event_id IN ('evt_r5_refund','evt_r5_dispute','evt_r5_lapse')").length }));
  const acked = [["a full refund", w2, d2.refund.status === "refunded"], ["a dispute", w3, d2.dispute.attention === "dispute"], ["a lapsed payment page", w4, d2.lapse.status === "expired"]];
  for (const [what, w, saved] of acked) {
    if (w.status >= 200 && w.status < 300 && !saved) R.finding(`${what} reported by Stripe while the disk is full is ACKNOWLEDGED (${w.status}) although nothing of it is on the disk: Stripe will not send it again`, `answer ${w.status} ${String(w.text).slice(0, 80)}`);
    else R.holds(`${what} reported while the disk is full is not acknowledged unless it was saved`, `${w.status}`);
  }
  const shopMail = s.mail().slice(mailBefore).filter((m) => /refund|dispute/i.test(m.subject || ""));
  R.info("emails to the shop about the refund and the dispute, written while nothing was saved", `${shopMail.length}: ${shopMail.map((m) => m.subject).join(" | ").slice(0, 200)}`);

  // A new firm-quote request, and a purchase-order acceptance of the quote already sent.
  const mailAt = s.mail().length;
  const rq2 = await s.rfq({ quoteId: draft.quoteId, contactName: "Dana Buyer", email: "dana@buyer.test", notes: "second", shippingName: "Dana Buyer", shippingAddress: "100 Main St", shippingCity: "Columbus", shippingState: "OH", shippingZip: "43215", shippingCountry: "US" }, [], { token: buyer });
  await sleep(300);
  const rq2Mail = s.mail().slice(mailAt);
  R.check(rq2.status === 503, "a firm-quote request that cannot be saved is refused", `${rq2.status} ${rq2.body && rq2.body.code}`);
  if (rq2Mail.length) R.finding("…but emails went out for the request that was refused", `${rq2Mail.length}: ${rq2Mail.map((m) => `${Array.isArray(m.to) ? m.to.join(",") : m.to}: ${m.subject}`).join(" | ").slice(0, 300)}`);
  else R.holds("no email went out for the refused request");
  const mailAt2 = s.mail().length;
  const po = await s.post(`/api/rfq/quote/${firmToken}/accept`, { method: "po", poNumber: "PO-R5-1", shippingName: "Dana Buyer", seenTotal: 480 });
  await sleep(300);
  const poMail = s.mail().slice(mailAt2);
  R.check(po.status === 503, "a purchase-order acceptance that cannot be saved is refused", `${po.status} ${po.body && po.body.code}`);
  if (poMail.length) R.finding("…but emails went out for the acceptance that was refused", `${poMail.length}: ${poMail.map((m) => `${Array.isArray(m.to) ? m.to.join(",") : m.to}: ${m.subject}`).join(" | ").slice(0, 300)}`);
  else R.holds("no email went out for the refused acceptance");
  const po2 = await s.post(`/api/rfq/quote/${firmToken}/accept`, { method: "po", poNumber: "PO-R5-1", shippingName: "Dana Buyer", seenTotal: 480 });
  const pageFull = await s.get(`/api/rfq/quote/${firmToken}`);
  R.info("the buyer presses Accept again, disk still full", `${po2.status} ${po2.body && (po2.body.code || po2.body.status || "")}; the quote page now says status "${pageFull.body && pageFull.body.status}"`);
  if (po2.status >= 200 && po2.status < 300) R.finding("the second press is answered as ACCEPTED while nothing is on the disk", `${po2.status} ${String(po2.text).slice(0, 120)}`);
  const ownerOrders = await s.get("/api/orders", { token: owner });
  const ownerSees = Array.isArray(ownerOrders.body) ? ownerOrders.body.filter((o) => o.rfqId === rfq.body.rfqId) : [];
  if (ownerSees.length && onDisk((d) => d.q("SELECT COUNT(*) n FROM orders WHERE rfq_id = ?", [rfq.body.rfqId])[0].n) === 0) R.finding("the owner's order list shows a purchase-order order (to build) that is not on the disk and that the buyer was told had not gone through", `${ownerSees.map((o) => `${String(o.id).slice(0, 8)} ${o.status}`).join(", ")}`);

  // The owner works on while it is full.
  const mark = await s.req({ method: "PUT", url: `/api/orders/${toDispute.orderId}/status`, json: { status: "in_production" }, token: owner });
  R.check(mark.status === 503, "the owner's own change is refused the same way", `${mark.status} ${mark.body && mark.body.code}`);
  R.info("payment pages opened at Stripe while the disk was full", `${Object.keys(stripeSessions()).length - stripeBefore}`);

  if (MODE === "restart") {
    // ── stopped while full (a deploy, a crash, "make the volume larger"), room made, started ──
    console.log("\n2. the server is stopped while the disk is still full, room is made, and it is started again");
    await s.stop({ keep: true });
    free();
    const keys = s.editKeys, pw = s.passwords, sec = s.adminSecret;
    s = await live.start({ env, tmpDir: tmp }); s.editKeys = keys; s.passwords = pw; s.adminSecret = sec;
    const d = onDisk((x) => ({ waiting: x.order(waiting.orderId), refund: x.order(toRefund.orderId), dispute: x.order(toDispute.orderId), lapse: x.order(toLapse.orderId), po: x.q("SELECT COUNT(*) n FROM orders WHERE rfq_id = ?", [rfq.body.rfqId])[0].n, rfq: x.q("SELECT status FROM rfqs WHERE id = ?", [rfq.body.rfqId])[0], ghost: x.q("SELECT COUNT(*) n FROM orders WHERE quote_id = ?", [draft.quoteId])[0].n }));
    R.info("after the restart, on the disk", `paid-while-full order: ${d.waiting.status}; refunded order: ${d.refund.status}, refunded $${d.refund.refunded_amount || 0}; disputed order: attention ${d.dispute.attention || "none"}; lapsed order: ${d.lapse.status}; PO order rows ${d.po}, request ${d.rfq.status}; refused checkout rows ${d.ghost}`);
    // Stripe sends again only what was NOT acknowledged.
    const again = await webhook(payEvent);
    await sleep(500);
    const after = onDisk((x) => x.order(waiting.orderId));
    const told = s.mail("dana@buyer.test").filter((m) => m.text && m.text.includes(String(waiting.orderId).slice(0, 8).toUpperCase())).length;
    R.check(again.status === 200 && after.status === "paid", "the payment taken while the disk was full is settled when Stripe sends it again: the customer is not charged for nothing", `${again.status}; order ${after.status}; emails to the buyer naming it: ${told}`);
    const lost = [];
    if (w2.status < 300 && d.refund.status !== "refunded") lost.push(`the refund of $${(toRefund.cents / 100).toFixed(2)}: the order is "${d.refund.status}" and still in the work queue`);
    if (w3.status < 300 && d.dispute.attention !== "dispute") lost.push("the dispute: the order carries no flag");
    if (w4.status < 300 && d.lapse.status !== "expired") lost.push(`the lapsed page: the order is "${d.lapse.status}" (the sweep closes it later)`);
    if (lost.length) R.finding("LOST for good at the restart, because Stripe had been answered 'received'", lost.join("; "));
    else R.holds("nothing Stripe was told 'received' for is missing after the restart");
    const login = await s.post("/api/auth/login", { email: "dana@buyer.test", password: s.passwords["dana@buyer.test"] }, {});
    const po3 = await s.post(`/api/rfq/quote/${firmToken}/accept`, { method: "po", poNumber: "PO-R5-1", shippingName: "Dana Buyer", seenTotal: 480 });
    R.check(po3.status === 201, "the firm quote the buyer could not accept can be accepted now", `${po3.status} ${po3.body && po3.body.code || ""}`);
    const c3 = await s.post("/api/orders/checkout-session", { quoteId: draft.quoteId, ...SHIP }, { token: login.body.token });
    R.check(c3.status === 200 && onDisk((x) => x.q("SELECT COUNT(*) n FROM orders WHERE quote_id = ?", [draft.quoteId])[0].n) === 1, "the checkout that was refused works now and makes one order", `${c3.status}`);
  } else {
    // ── room comes back without a restart ──
    console.log("\n2. room is made; the server is NOT restarted");
    free();
    let h = null;
    for (let i = 0; i < 40; i++) { h = await s.get("/api/health"); if (h.status === 200) break; await sleep(250); }
    R.check(h.status === 200, "the health check answers 'ok' again by itself");
    const d = onDisk((x) => ({ waiting: x.order(waiting.orderId), refund: x.order(toRefund.orderId), dispute: x.order(toDispute.orderId), lapse: x.order(toLapse.orderId), po: x.q("SELECT id, status FROM orders WHERE rfq_id = ?", [rfq.body.rfqId]), rfq: x.q("SELECT status FROM rfqs WHERE id = ?", [rfq.body.rfqId])[0], ghost: x.q("SELECT id, status, stripe_session_id FROM orders WHERE quote_id = ?", [draft.quoteId]), events: x.q("SELECT event_id FROM payment_events WHERE event_id IN ('evt_r5_refund','evt_r5_dispute','evt_r5_lapse')").map((e) => e.event_id) }));
    R.info("after the first write that succeeded, on the disk", `paid-while-full order: ${d.waiting.status}; refunded order: ${d.refund.status}; disputed order: attention ${d.dispute.attention || "none"}; lapsed order: ${d.lapse.status}; PO order rows ${d.po.length} (${d.po.map((o) => o.status).join(",")}), request ${d.rfq.status}; rows for the refused checkout ${d.ghost.length} (${d.ghost.map((o) => `${o.status}, page ${o.stripe_session_id || "none"}`).join(";")}); Stripe events on record: ${d.events.join(",") || "none"}`);
    if (d.po.length) R.finding("the purchase-order acceptance the buyer was told had 'not gone through' IS an order now (written by the next save)", `order ${String(d.po[0].id).slice(0, 8)} ${d.po[0].status}; request ${d.rfq.status}`);
    else R.holds("the refused acceptance left no order");
    if (d.ghost.length) R.info("the checkout the buyer was told had 'not gone through' is an order row now, waiting, with no payment page", `${d.ghost.length}`);
    const again = await webhook(payEvent);
    await sleep(600);
    const told = s.mail("dana@buyer.test").filter((m) => m.text && m.text.includes(String(waiting.orderId).slice(0, 8).toUpperCase())).length;
    R.check(again.status === 200 && onDisk((x) => x.order(waiting.orderId)).status === "paid", "Stripe's next delivery of the payment is acknowledged and the order is paid on the disk", `${again.status}; emails to the buyer naming the order: ${told}`);
    const poAgain = await s.post(`/api/rfq/quote/${firmToken}/accept`, { method: "po", poNumber: "PO-R5-1", shippingName: "Dana Buyer", seenTotal: 480 });
    R.info("the buyer, told to try again, presses Accept", `${poAgain.status} ${poAgain.body && (poAgain.body.code || poAgain.body.status || "")}: ${String(poAgain.body && poAgain.body.error || "").slice(0, 120)}`);
    await sleep(500);
    const poTold = s.mail().slice(mailAt2).filter((m) => /PO-R5-1|purchase order|accepted|8D0CA396|pending PO/i.test(`${m.subject} ${m.text || ""}`) && !/refund|dispute|paid/i.test(m.subject || ""));
    if (d.po.length && poTold.length === 0) R.finding("…and NOBODY was emailed about that purchase-order order: not the owner (who must confirm the PO), not the buyer. The second press is answered from the order that exists and sends nothing", `emails since the first press that mention the PO or the acceptance: ${poTold.length}`);
    else R.info("emails about the purchase-order order since the first press", `${poTold.length}: ${poTold.map((m) => m.subject).join(" | ").slice(0, 200)}`);
    const c3 = await checkout(draft.quoteId);
    const rows = onDisk((x) => x.q("SELECT COUNT(*) n FROM orders WHERE quote_id = ?", [draft.quoteId])[0].n);
    R.check(c3.status === 200 && rows === 1, "the buyer, told to try again, checks out: one order, not two", `${c3.status}; rows ${rows}`);
    const missing = ["evt_r5_refund", "evt_r5_dispute", "evt_r5_lapse"].filter((e) => !d.events.includes(e));
    if (missing.length) R.info("Stripe events answered 'received' whose record never reached the disk (their effect on the order did)", missing.join(", "));
  }

  const findings = R.done();
  try { await s.stop(); } catch { /* gone */ }
  process.exit(findings ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
