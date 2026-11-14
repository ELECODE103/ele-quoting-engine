#!/usr/bin/env node
/**
 * Review of the review-conditions fixes (2026-11-13), F-12 and N-07: WHEN does the storage clean-up
 * close an honest buyer's unpaid card order, what does the buyer see, and what can it never close?
 *
 *   node tools/security/review-conditions/r5-pressure-honest.js
 *
 * The author saw the reviewer's r3-pressure-collateral.js close two honest orders in 2 runs of 4 and
 * explained which way a run goes from reading the code only. Here the same clean-up
 * (services/storagePressure.js relieveStorage) is run in-process on a store built to order, one
 * condition changed at a time. Store ceiling 10 MB in this run (2,048 MB in production); the
 * percentages and the ages are what decide, and they are the production ones:
 *   the clean-up starts at 80 % · unpaid orders are closed only at 85 % or over · a signed-in
 *   customer's file is protected for its first 60 minutes · a payment page stays open 120 minutes.
 *
 *   1  the grid: how full the store is × how old the honest buyer's file is × how old the flood's files are
 *   2  the "quiet" time after a pass that found nothing: why two runs of the same script differ
 *   3  what the buyer whose order was closed sees, and a payment that arrives afterwards
 *   4  what is never closed, with every payment-method value I could store by hand
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..", "..");

process.env.UPLOAD_DIR_MAX_MB = "10";
process.env.UPLOAD_STORED_MB_PER_IP = "9";
process.env.UPLOAD_STORED_MB_PER_ACCOUNT = "9";
process.env.CHECKOUT_PER_ACCOUNT_15MIN = "1000";
for (const k of ["QUOTE_NEW_PER_ACCOUNT_HOUR", "QUOTE_NEW_PER_ACCOUNT_DAY", "QUOTE_NEW_PER_CLIENT_HOUR", "QUOTE_NEW_PER_CLIENT_DAY"]) process.env[k] = "100000";
const { report } = require(path.join(ROOT, "tools/security/rereview-relaunch/lib"));
const { start } = require(path.join(ROOT, "server/testSupport/harness"));

const MB = 1024 * 1024;
const MINUTE = 60 * 1000;
const SHIP = { shippingName: "Pat Buyer", shippingAddress: "1 Main St", shippingCity: "Springfield", shippingState: "IL", shippingZip: "62701" };

(async () => {
  const h = await start({ mailer: "configured" });
  const R = report();
  const models = h.models;
  const pressure = require(path.join(ROOT, "server/services/storagePressure"));
  const guards = require(path.join(ROOT, "server/security/uploadGuards"));
  const lifecycle = require(path.join(ROOT, "server/services/orderLifecycle"));
  const database = require(path.join(ROOT, "server/models/database"));
  const limits = require(path.join(ROOT, "server/security/limits")).limits;
  const dataDir = process.env.QUOTING_DATA_DIR;
  const owner = await h.admin();
  const uploadsDir = path.join(dataDir, "uploads");
  const storedPct = () => { guards.storage.invalidate(); return Math.round((guards.storage.scan() / (10 * MB)) * 100); };
  const order = (id) => models.ordersDB.getById(id);
  let n = 0;
  async function storedPart(token, bytes, ageMs) {
    const data = fs.readFileSync(path.join(ROOT, "tools/vet-quotes/parts/cube_20mm.stl"));
    const up = await h.form("/api/upload", {}, { files: { name: "cube_20mm.stl", data } }, token);
    assert.strictEqual(up.status, 200, up.text.slice(0, 200));
    const id = up.body.parts[0].partId;
    const name = models.partsDB.getRow(id).storedName;
    fs.writeFileSync(path.join(uploadsDir, name), Buffer.alloc(Math.round(bytes), 1));
    database.getDatabase().run("UPDATE parts SET file_size = ?, created_at = ? WHERE id = ?", [Math.round(bytes), new Date(Date.now() - ageMs).toISOString(), id]);
    return { id, name };
  }
  const quoteOf = async (token, part) => { const q = await h.post("/api/quote", { parts: [h.cncConfig(part.id, 1)], leadTimeSlug: "standard" }, token); assert.strictEqual(q.status, 200, q.text.slice(0, 200)); return q.body.quoteId; };
  async function cardCheckout(token, part) {
    const quoteId = await quoteOf(token, part);
    const c = await h.post("/api/orders/checkout-session", { quoteId, ...SHIP }, token);
    assert.strictEqual(c.status, 200, c.text.slice(0, 200));
    return { orderId: c.body.orderId, quoteId, sessionId: String(c.body.sessionUrl).split("/").pop() };
  }
  function emptyStore() {
    database.batch(() => { models.orderItemsDB.clear(); models.ordersDB.clear(); models.quotesDB.clear(); models.rfqsDB.clear(); models.partsDB.clear(); });
    for (const f of fs.readdirSync(uploadsDir)) fs.unlinkSync(path.join(uploadsDir, f));
    guards.storage.invalidate();
    pressure.state.storageQuietUntil = 0;
    pressure.state.databaseQuietUntil = 0;
  }
  /** One cell: an honest buyer on the card page with a 0.5 MB file `honestAge` old; flood accounts hold the rest up to `fillPct`, their files `floodAge` old. */
  async function cell({ fillPct, honestAgeMin, floodAgeMin, force = true }) {
    emptyStore();
    const honest = await h.register(`honest-${++n}@buyer.test`);
    const hp = await storedPart(honest, 0.5 * MB, honestAgeMin * MINUTE);
    const ho = await cardCheckout(honest, hp);
    const floodBytes = (fillPct / 100) * 10 * MB - 0.5 * MB;
    const accounts = 3;
    for (let a = 0; a < accounts; a++) { const t = await h.register(`flood-${n}-${a}@example.test`); await storedPart(t, floodBytes / accounts, floodAgeMin * MINUTE); }
    const before = storedPct();
    h.sent.length = 0;
    const r = await pressure.relieveStorage(models, { force });
    return { before, after: storedPct(), honest: order(ho.orderId).status, removed: r ? r.removedUploads : null, closed: r ? r.closedUnpaidOrders : null, ran: Boolean(r), ho, honestToken: honest, emails: h.sent.filter((m) => /honest-/.test(String(m.to))).map((m) => m.subject) };
  }

  console.log(`\n1. when is an honest buyer's unpaid order closed? (clean-up starts at ${Math.round(limits.storageWarnFraction * 100)} %, unpaid orders closed at ${Math.round((1 - limits.storageReservedFraction) * 100)} % or over, customer files protected ${limits.customerPartKeepMinutes} minutes)`);
  const grid = [];
  for (const fillPct of [78, 83, 86, 97]) for (const honestAgeMin of [30, 59, 61, 110]) for (const floodAgeMin of [5, 90]) {
    const c = await cell({ fillPct, honestAgeMin, floodAgeMin });
    grid.push({ fillPct, honestAgeMin, floodAgeMin, ...c });
    console.log(`     store ${String(c.before).padStart(3)} %, buyer's file ${String(honestAgeMin).padStart(3)} min old, flood's files ${String(floodAgeMin).padStart(2)} min old → buyer's order ${c.honest === "expired" ? "CLOSED" : "kept  "}  (flood files removed: ${c.removed}; store afterwards ${c.after} %)`);
  }
  const closedCells = grid.filter((g) => g.honest === "expired");
  const rule = (g) => g.before >= 85 && g.honestAgeMin > 60 && g.floodAgeMin < 60;
  R.check(grid.every((g) => (g.honest === "expired") === rule(g)), `in ${grid.length} of ${grid.length} cells the order was closed exactly when ALL THREE held: the store was at 85 % or over, the buyer's file was over 60 minutes old, and the files filling the store were still in their protected first hour`, `closed in ${closedCells.length} of ${grid.length} cells`);
  R.info("so at launch volumes", "an honest buyer loses an unpaid order to the clean-up only if they sit on the card page with a file uploaded more than an hour before, while the 2 GB store is 85 % full of files less than an hour old. Ordinary old files do not do it: they are removed first");

  console.log("\n2. why the reviewer's script comes out both ways: the quiet time after a pass that found nothing");
  {
    // A pass while the flood is still at 82 %: nothing may be removed (all too new), nothing is closed (under 85 %).
    emptyStore();
    const honest = await h.register(`honest-${++n}@buyer.test`);
    const ho = await cardCheckout(honest, await storedPart(honest, 0.5 * MB, 90 * MINUTE));
    const flood = [];
    for (let a = 0; a < 3; a++) flood.push(await h.register(`flood-${n}-${a}@example.test`));
    for (const t of flood) await storedPart(t, 2.55 * MB, 1 * MINUTE);
    const at82 = storedPct();
    const first = await pressure.relieveStorage(models, {});
    const quietFor = Math.round((pressure.state.storageQuietUntil - Date.now()) / 1000);
    // The flood goes on to 97 %.
    for (const t of flood.slice(0, 2)) await storedPart(t, 0.75 * MB, 1 * MINUTE);
    const at97 = storedPct();
    const second = await pressure.relieveStorage(models, {});
    R.check(first && first.closedUnpaidOrders === 0 && second === null && order(ho.orderId).status === "pending_payment" && quietFor > 60, `a pass that ran while the flood was at ${at82} % found nothing and closed nothing; the clean-up then stands down for ${quietFor} seconds, so with the store at ${at97} % the next pass does not run and the order is still open`, `first pass: ${JSON.stringify(first && { closed: first.closedUnpaidOrders, removed: first.removedUploads })}; second pass: ${second === null ? "did not run (quiet)" : JSON.stringify(second)}`);
    pressure.state.storageQuietUntil = 0;
    const third = await pressure.relieveStorage(models, {});
    R.check(third && third.closedUnpaidOrders === 1 && order(ho.orderId).status === "expired", "when the quiet time is over (set to now here) the same store closes the order", JSON.stringify(third && { closed: third.closedUnpaidOrders }));
    R.info("that is the whole difference between a run that closes the honest orders and one that does not", "whether a pass happened to run between 80 % and 85 % on the flood's way up. The reviewer's script watches for 96 seconds after the flood; the quiet time is longer than that");
  }

  console.log("\n3. what the buyer whose order was closed sees, and a payment that arrives afterwards");
  {
    const c = await cell({ fillPct: 97, honestAgeMin: 90, floodAgeMin: 5 });
    assert.strictEqual(c.honest, "expired");
    const mail = h.sent.find((m) => /honest-/.test(String(m.to)));
    R.check(c.emails.length === 1 && Boolean(mail) && /nothing (was|has been) charged/i.test(mail.text), "the buyer is emailed once, and the email says nothing was charged", `"${c.emails[0]}"`);
    console.log(`     the email says: ${String(mail.text).replace(/\s+/g, " ").slice(0, 420)}…`);
    const list = (await h.get("/api/orders", c.honestToken)).body.find((o) => o.id === c.ho.orderId);
    R.info("in Your orders it reads", `status "${list.status}", can cancel: ${list.canCancel}, can reorder: ${list.canReorder}`);
    R.check(h.stripe.sessions[c.ho.sessionId].status === "expired", "its payment page was expired at Stripe before the order was closed (so it cannot be paid by mistake)");
    const again = await h.post("/api/orders/checkout-session", { quoteId: c.ho.quoteId, ...SHIP }, c.honestToken);
    pressure.state.storageQuietUntil = 0;
    const next = await pressure.relieveStorage(models, { force: true });
    R.check(again.status === 200, "the buyer can press pay again at once (the quote was given back)", `${again.status}; a new order ${again.body.orderId && again.body.orderId !== c.ho.orderId ? "is made" : "?"}`);
    R.info("…and at the next pass, store still full, that NEW order", `${order(again.body.orderId).status}${order(again.body.orderId).status === "expired" ? " (closed again: the buyer's file is still over an hour old and the store still full, so the buyer is closed out on every pass until the flood's files are an hour old)" : ""}; pass closed ${next ? next.closedUnpaidOrders : 0}`);
    await h.webhook("checkout.session.completed", { ...h.stripe.sessions[c.ho.sessionId], status: "complete", payment_status: "paid", payment_intent: "pi_late_r5" });
    const o = order(c.ho.orderId);
    R.check(o.status === "expired" && o.attention === "late-payment", "a payment that still arrives on the closed order's page is flagged 'late payment' for the owner: not accepted silently, not lost", `${o.status} / ${o.attention}`);
    // Paid at Stripe a moment before the pass.
    const d = await cell({ fillPct: 97, honestAgeMin: 90, floodAgeMin: 5, force: false }).catch(() => null);
    emptyStore();
    const honest = await h.register(`honest-${++n}@buyer.test`);
    const ho = await cardCheckout(honest, await storedPart(honest, 0.5 * MB, 90 * MINUTE));
    for (let a = 0; a < 3; a++) await storedPart(await h.register(`flood-${n}-${a}@example.test`), 3.1 * MB, 5 * MINUTE);
    h.pay(ho.sessionId);
    const r = await pressure.relieveStorage(models, { force: true });
    R.check(order(ho.orderId).status === "paid" && r.closedUnpaidOrders === 0, "an order whose page was PAID a moment before the pass (webhook not yet here) is settled, not closed", `${order(ho.orderId).status}`);
    void d;
  }

  console.log("\n4. what the clean-up can never close: every payment-method value stored by hand");
  {
    emptyStore();
    const who = await h.register(`odd-${++n}@buyer.test`);
    const values = [["NULL (a phone order)", null], ["'' (empty)", ""], ["'Card'", "Card"], ["'CARD'", "CARD"], ["' card'", " card"], ["'card '", "card "], ["'po'", "po"], ["'phone'", "phone"], ["'manual'", "manual"], ["'cheque'", "cheque"], ["'card\\n'", "card\n"], ["'0'", "0"]];
    const made = [];
    for (const [label, value] of values) {
      const o = await cardCheckout(who, await storedPart(who, 0.7 * MB, 90 * MINUTE));
      database.getDatabase().run("UPDATE orders SET payment_method = ? WHERE id = ?", [value, o.orderId]);
      made.push({ label, ...o });
    }
    const control = await cardCheckout(who, await storedPart(who, 0.7 * MB, 90 * MINUTE));
    for (let a = 0; a < 1; a++) await storedPart(await h.register(`flood-${n}-${a}@example.test`), 0.6 * MB, 5 * MINUTE);
    const full = storedPct();
    let passes = 0;
    for (let i = 0; i < 3; i++) { pressure.state.storageQuietUntil = 0; await pressure.relieveStorage(models, { force: true }); passes++; }
    const huge = limits.databaseMaxBytes * 3;
    const fake = { ...database, liveSize: () => huge, usedSize: () => huge, fileSize: () => huge };
    for (let i = 0; i < 2; i++) { pressure.state.databaseQuietUntil = 0; await pressure.relieveDatabase(models, { force: true, sync: true, database: fake }); }
    const closed = made.filter((m) => order(m.orderId).status !== "pending_payment");
    const direct = [];
    for (const m of made) { const r = await lifecycle.closeUnderPressure(m.orderId); const c = await lifecycle.cancelByBuyer(m.orderId); if (r.outcome !== "kept" || c.outcome !== "kept") direct.push(m.label); }
    R.check(order(control.orderId).status === "expired", "the control beside them (payment method exactly 'card') WAS closed, so the passes did reach the closing step", `store ${full} %, ${passes} file passes and 2 database passes`);
    R.check(closed.length === 0 && direct.length === 0, `none of ${made.length} orders with any other payment-method value was closed by the clean-up, nor when the closing step or the buyer's cancel was asked directly`, closed.length || direct.length ? `CLOSED: ${[...closed.map((m) => m.label), ...direct].join(", ")}` : values.map((v) => v[0]).join(", "));
    const lines = made.filter((m) => models.orderItemsDB._query("SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?", [m.orderId])[0].n === 0);
    R.check(lines.length === 0, "and every one still has its lines");
    // flagged, firm-quote, and paid orders with method 'card'
    emptyStore();
    const p2 = await h.register(`odd-${++n}@buyer.test`);
    const flagged = await cardCheckout(p2, await storedPart(p2, 1 * MB, 90 * MINUTE));
    await h.webhook("checkout.session.completed", { ...h.stripe.sessions[flagged.sessionId], status: "complete", payment_status: "paid", payment_intent: "pi_x", amount_total: 100, amount_subtotal: 100 });
    const paid = await cardCheckout(p2, await storedPart(p2, 1 * MB, 90 * MINUTE));
    await h.completed(paid.sessionId);
    const firm = await cardCheckout(p2, await storedPart(p2, 1 * MB, 90 * MINUTE));
    database.getDatabase().run("UPDATE orders SET rfq_id = ? WHERE id = ?", ["11111111-1111-4111-8111-111111111111", firm.orderId]);
    const ctl = await cardCheckout(p2, await storedPart(p2, 1 * MB, 90 * MINUTE));
    await storedPart(await h.register(`flood-${n}-x@example.test`), 5.5 * MB, 5 * MINUTE);
    for (let i = 0; i < 3; i++) { pressure.state.storageQuietUntil = 0; await pressure.relieveStorage(models, { force: true }); }
    R.check(order(ctl.orderId).status === "expired" && order(flagged.orderId).status === "pending_payment" && order(paid.orderId).status === "paid" && order(firm.orderId).status === "pending_payment", "a flagged order, a paid order and a firm-quote order (all 'card') are left alone beside a plain unpaid one that is closed", `flagged ${order(flagged.orderId).status}/${order(flagged.orderId).attention}; paid ${order(paid.orderId).status}; firm ${order(firm.orderId).status}; plain ${order(ctl.orderId).status}`);
  }

  const findings = R.done();
  await h.stop();
  process.exit(findings ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
