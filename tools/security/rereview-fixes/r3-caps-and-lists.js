#!/usr/bin/env node
/**
 * Second re-review (2026-11-13): the ceilings on unpaid orders as production runs them (F-09, F-12),
 * and who can read what through the paged order list and the single-order route (F-09).
 *
 *   node tools/security/rereview-fixes/r3-caps-and-lists.js
 *
 * In-process harness started with { orderCaps: true } (the real ceilings: 3 unpaid at once and 8 new a
 * day per account, 5 and 16 per address), Stripe stand-in, mail captured.
 *
 *   1. An HONEST customer: reaches the card page, goes back, changes a quantity, tries again. How many
 *      times before the site refuses them, what they are told, and what gets them going again.
 *   2. Two buyers behind one office address.
 *   3. What does not count: a paid order; going back to pay for the same order.
 *   4. The daily ceiling after the unpaid orders have lapsed.
 *   5. The order list and the single-order route: another customer's order, odd page values.
 *   6. How large one order's own answer can get (100 lines).
 */
const assert = require("assert");
const { report, SHIP } = require("../rereview-relaunch/lib");
const { start } = require("../../../server/testSupport/harness");

(async () => {
  for (const k of ["QUOTE_NEW_PER_CLIENT_HOUR", "QUOTE_NEW_PER_CLIENT_DAY", "QUOTE_NEW_PER_ACCOUNT_HOUR", "QUOTE_NEW_PER_ACCOUNT_DAY"]) process.env[k] = "100000";
  // (The per-account checkout pacing is left at its production value of 12 per 15 minutes for sections 1 to 3.)
  const h = await start({ mailer: "configured", orderCaps: true });
  const R = report();
  const { ordersDB } = h.models;
  const limits = require("../../../server/security/limits").limits;
  R.info("ceilings in force in this run", `per account ${limits.ordersUnpaidPerAccount} at once / ${limits.ordersUnpaidNewPerAccountDay} a day; per address ${limits.ordersUnpaidPerClient} at once / ${limits.ordersUnpaidNewPerClientDay} a day; payment page open ${require("../../../server/services/orderLifecycle").sessionMinutes()} minutes`);
  // Each buyer uploads their own cube: a part belongs to the account that first orders it.
  const partOf = new Map();
  const quote = async (token, qty, extra = {}) => {
    if (!partOf.has(token)) partOf.set(token, await h.uploadCube());
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partOf.get(token), qty)], leadTimeSlug: "standard", ...extra }, token);
    assert.strictEqual(q.status, 200, `quote: ${q.text}`);
    return q;
  };
  const pay = (token, quoteId, ip, body = {}) => h.raw("POST", "/api/orders/checkout-session", { json: { quoteId, ...SHIP, ...body }, token, ip });

  console.log("\n1. an honest customer who goes back and changes the quantity");
  const dana = await h.register("dana@buyer.test", "Dana Buyer");
  {
    let quoteId = null;
    let refusedAt = null;
    let refusal = null;
    for (let attempt = 1; attempt <= 6; attempt++) {
      // The builder: the quote that was sent to checkout is no longer a draft, so a change makes a new quote.
      const q = await quote(dana, 1 + attempt, quoteId ? { quoteId } : {});
      assert.strictEqual(q.status, 200, q.text);
      quoteId = q.body.quoteId;
      const c = await pay(dana, quoteId, "203.0.113.50");
      if (c.status !== 200) { refusedAt = attempt; refusal = c; break; }
    }
    const waiting = ordersDB.query((o) => o.status === "pending_payment").length;
    if (refusedAt) {
      R.finding(`an honest buyer is refused at checkout on change number ${refusedAt} (after ${refusedAt - 1} visits to the card page)`, `${refusal.status} ${refusal.body.code}: "${refusal.body.error}" Retry-After ${refusal.headers.get("retry-after")} s; ${waiting} orders waiting`);
    } else R.holds("six changes of quantity, six checkouts: never refused");
    // What gets them going again: there is no route by which a buyer can close their own unpaid order.
    const mine = (await h.get("/api/orders", dana)).body;
    const cancel = await h.put(`/api/orders/${mine[0].id}/status`, { status: "cancelled" }, dana);
    const del = await h.del(`/api/orders/${mine[0].id}`, dana);
    R.info("can the buyer close one of their own unpaid orders to free a place?", `PUT status → ${cancel.status}; DELETE → ${del.status} (no such route for a customer: they must pay for an old one, wait for its page to lapse, or phone)`);
    // Paying for the old one: does going back to the OLDEST unpaid order work while at the ceiling?
    const oldest = mine[mine.length - 1];
    const resume = await pay(dana, oldest.quoteId, "203.0.113.50");
    R.check(resume.status === 200 && resume.body.orderId === oldest.id, "at the ceiling, going back to pay for an order that already exists still works", `${resume.status} ${resume.body.code || ""}`);
    // The sweep closes them when their pages lapse: how long is the buyer locked out?
    await h.sweep(Date.now() + (require("../../../server/services/orderLifecycle").sessionMinutes() + 11) * 60 * 1000);
    const q = await quote(dana, 9);
    const after = await pay(dana, q.body.quoteId, "203.0.113.50");
    R.info("after the payment pages have lapsed and the sweep has run", `checkout answers ${after.status} ${after.body.code || ""}; so the lock-out lasts until the oldest page lapses (page lifetime + up to 10 minutes of sweep)`);
  }

  console.log("\n2. two buyers behind one office address");
  {
    const OFFICE = "198.18.7.7";
    const a = await h.register("ann@office.test", "Ann");
    const b = await h.register("bob@office.test", "Bob");
    const results = [];
    for (const [who, token] of [["Ann", a], ["Ann", a], ["Ann", a], ["Bob", b], ["Bob", b], ["Bob", b]]) {
      const q = await quote(token, 2 + results.length);
      const c = await pay(token, q.body.quoteId, OFFICE);
      results.push(`${who}: ${c.status}${c.body.code ? " " + c.body.code : ""}`);
    }
    const bobRefused = results.filter((r) => r.startsWith("Bob") && !r.includes("200")).length;
    R.info("Ann opens 3 unpaid orders, then Bob (another account, same address) opens his", results.join(" | "));
    if (bobRefused) R.finding(`a second buyer behind the same address is refused ${bobRefused} of his 3 checkouts because of the first buyer's unpaid orders`, "the per-address ceiling (5) is reached by two accounts that are each inside their own ceiling (3)");
    else R.holds("a second buyer behind the same address is not refused");
    // From another address Bob is fine.
    const q = await quote(b, 8);
    const elsewhere = await pay(b, q.body.quoteId, "198.18.9.9");
    R.info("Bob from another address", `${elsewhere.status} ${elsewhere.body.code || ""}`);
  }

  console.log("\n3. what does not count");
  {
    const eve = await h.register("eve@buyer.test", "Eve");
    const ip = "198.18.20.1";
    for (let i = 0; i < 5; i++) {
      const q = await quote(eve, 2 + i);
      const c = await pay(eve, q.body.quoteId, ip);
      assert.strictEqual(c.status, 200, `paying customer refused on order ${i + 1}: ${c.text}`);
      await h.completed(String(c.body.sessionUrl).split("/").pop());
    }
    R.holds("five orders in a row, each paid: never refused (a paid order is not counted)");
    const q = await quote(eve, 9);
    const first = await pay(eve, q.body.quoteId, ip);
    const again = await pay(eve, q.body.quoteId, ip);
    const third = await pay(eve, q.body.quoteId, ip, { shippingAddress: "200 Other St" });
    R.check(first.status === 200 && again.status === 200 && third.status === 200 && first.body.orderId === again.body.orderId && again.body.orderId === third.body.orderId, "pressing pay three times on one quote is one order and one place");
  }

  console.log("\n4. the daily ceiling");
  {
    process.env.CHECKOUT_PER_ACCOUNT_15MIN = "1000";
    const sam = await h.register("sam@buyer.test", "Sam");
    const ip = "198.18.30.1";
    let made = 0; let refusal = null;
    for (let i = 0; i < 12; i++) {
      const q = await quote(sam, 2 + i);
      const c = await pay(sam, q.body.quoteId, ip);
      if (c.status === 200) { made++; await h.sweep(Date.now() + 26 * 60 * 60 * 1000); } // each lapses before the next
      else { refusal = c; break; }
    }
    R.info("one account, each unpaid order lapsing before the next is started", `${made} started, then ${refusal ? `${refusal.status} ${refusal.body.code}: "${refusal.body.error}"` : "never refused"}`);
    R.check(Boolean(refusal) && refusal.body.code === "unpaid-orders-daily-limit" && made === limits.ordersUnpaidNewPerAccountDay, `the daily ceiling refuses the ${limits.ordersUnpaidNewPerAccountDay + 1}th unpaid checkout in 24 hours`);
  }

  console.log("\n5. the order list and the single-order route");
  {
    const mallory = await h.register("mallory@buyer.test", "Mallory");
    const danaOrders = (await h.get("/api/orders", dana)).body;
    const target = danaOrders[0];
    const tries = [
      ["GET", `/api/orders/${target.id}`], ["GET", `/api/orders/${target.id}/traveler`], ["GET", `/api/orders/${target.id}/drawing`], ["GET", `/api/orders/${target.id}/tax-certificate`],
      ["POST", `/api/orders/${target.id}/reorder`], ["POST", `/api/orders/${target.id}/confirm-payment`],
      ["GET", `/api/pdf/order-confirmation/${target.id}`], ["GET", `/api/pdf/packing-slip/${target.id}`], ["GET", `/api/pdf/traveler/${target.id}`], ["GET", `/api/pdf/coc/${target.id}`],
    ];
    const leaks = [];
    for (const [method, url] of tries) {
      for (const [who, token] of [["another customer", mallory], ["nobody", undefined]]) {
        const r = await h.raw(method, url, { token, json: method === "POST" ? {} : undefined });
        if (r.status < 400 || /dana|100 Main|Columbus/i.test(r.text)) leaks.push(`${who} ${method} ${url} → ${r.status}`);
      }
    }
    R.check(leaks.length === 0, `another customer and a visitor cannot read, reorder, confirm or print Dana's order (${tries.length * 2} tries)`, leaks.join("; "));
    // Paging values.
    const odd = ["page=-1", "page=0", "page=1e99", "page=abc", "page=1.5", "page=999999999999999999999", "pageSize=0", "pageSize=-5", "pageSize=100000", "pageSize=abc", "page[]=1&page[]=2", "pageSize[a]=1",
      "attention=1", `userId=${target.userId}`, `user_id=${target.userId}`, "page=1%27%20OR%201=1--", "pageSize=1;DROP%20TABLE%20orders"];
    const bad = [];
    for (const qs of odd) {
      const r = await h.get(`/api/orders?${qs}`, mallory);
      const rows = Array.isArray(r.body) ? r.body : null;
      if (r.status !== 200 || !rows || rows.some((o) => o.userId !== undefined && o.userId !== null && o.customerEmail === "dana@buyer.test") || rows.length > 100) bad.push(`${qs} → ${r.status} rows ${rows ? rows.length : "?"}`);
    }
    R.check(bad.length === 0, `${odd.length} odd page values as another customer: always 200, never anybody else's order, never more than 100 rows`, bad.join("; "));
    const mine = await h.get("/api/orders?pageSize=100000", dana);
    R.check(mine.status === 200 && mine.body.every((o) => o.items === undefined && o.clientTag === undefined && o.notes === undefined && o.attentionNote === undefined), "a customer's list rows carry no lines, no address tag, no shop notes", `keys: ${Object.keys(mine.body[0] || {}).length}`);
    const one = await h.get(`/api/orders/${target.id}`, dana);
    const leaked = ["clientTag", "notes", "attentionNote", "shipAccountEnc", "taxCertPath", "drawingPath", "paymentEvents"].filter((k) => one.body[k] !== undefined);
    R.check(one.status === 200 && leaked.length === 0 && Array.isArray(one.body.items), "the customer's own single-order answer carries its lines and none of the shop's own fields", leaked.join(", "));
    const geometryInLines = (one.body.items || []).some((it) => it.geometry || it.dfm);
    R.check(!geometryInLines, "…and no part measurements on the lines");
  }

  console.log("\n6. how large one order's own answer gets");
  {
    process.env.ORDERS_UNPAID_PER_ACCOUNT = "100"; process.env.ORDERS_UNPAID_PER_CLIENT = "100";
    const big = await h.register("big@buyer.test", "Big");
    const partId = await h.uploadCube();
    const lines = Array.from({ length: 100 }, () => ({ partId }));
    const mats = (await h.get("/api/materials?process=3d-printing")).body;
    let q = await h.post("/api/quote", { parts: lines.map((l) => ({ partId: l.partId, materialSlug: mats[0].slug, quantity: 1, process: "3d-printing" })), leadTimeSlug: "standard" }, big);
    if (q.status === 200 && !(q.body.gate && q.body.gate.requiresRfq)) {
      const c = await pay(big, q.body.quoteId, "198.18.40.1");
      const t0 = Date.now();
      const one = await h.get(`/api/orders/${c.body.orderId}`, big);
      R.info("a 100-line order read through the single-order route", `checkout ${c.status}; answer ${one.status}, ${(one.text.length / 1024).toFixed(0)} kB, ${Date.now() - t0} ms`);
      R.check(one.status === 200 && one.text.length < 2 * 1024 * 1024, "a 100-line order's own answer is well under the 16 MB ceiling");
    } else R.info("100-line quote not made", `${q.status} ${q.text.slice(0, 160)}`);
  }

  const findings = R.done();
  await h.stop();
  process.exit(findings ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
