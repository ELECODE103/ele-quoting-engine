/**
 * What is on the disk after the server is KILLED (SIGKILL: an out-of-memory kill, a host crash)?
 *
 *   node tools/security/rereview-relaunch/durability-kill.js [rounds=12] [lines=20]
 *
 * A real production-mode server (server/index.js as a child), a persistent Stripe stand-in, and the
 * database file read back with sql.js after every kill.
 *
 *   A. acknowledged = on disk: an account, a confirmed email, a new quote, an order, a settled
 *      payment, an admin price edit. The process is killed the instant the answer arrives.
 *   B. a re-priced draft: how much is lost, and that nothing else rides with it.
 *   C. killed DURING checkout of a multi-line quote, at a random moment: is a partial order left on
 *      disk, and what happens when the buyer comes back and pays for it?
 *   D. killed DURING the "paid" webhook: after the restart Stripe sends the event again. Is the order
 *      paid once, and are the buyer and the shop told?
 *   E. the file: after every kill it opens, passes SQLite's integrity check, and a stray .tmp never wins.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { report, sleep, SHIP } = require("./lib");
const live = require("../../../server/testSupport/liveServer");
const initSqlJs = require("../../../node_modules/sql.js");

const ROUNDS = Number(process.argv[2]) || 12;
const LINES = Number(process.argv[3]) || 20;
const cube = fs.readFileSync(path.join(__dirname, "..", "..", "vet-quotes", "parts", "cube_20mm.stl"));

(async () => {
  const SQL = await initSqlJs();
  const R = report();
  const stripeFile = path.join(require("os").tmpdir(), `rr-stripe-${crypto.randomBytes(4).toString("hex")}.json`);
  const jwt = crypto.randomBytes(32).toString("hex"), whsec = `whsec_${crypto.randomBytes(24).toString("hex")}`;
  const env = {
    NODE_OPTIONS: `--require ${path.join(__dirname, "stripe-stub-preload.js")}`, RR_STRIPE_FILE: stripeFile,
    JWT_SECRET: jwt, STRIPE_WEBHOOK_SECRET: whsec, STRIPE_SECRET_KEY: "sk_test_local_only",
    CHECKOUT_PER_ACCOUNT_15MIN: "1000", QUOTE_NEW_PER_CLIENT_HOUR: "100000", QUOTE_NEW_PER_CLIENT_DAY: "100000", QUOTE_NEW_PER_ACCOUNT_HOUR: "100000", QUOTE_NEW_PER_ACCOUNT_DAY: "100000",
    QUOTE_DRAFT_KB_PER_CLIENT: "100000", QUOTE_DRAFT_KB_PER_ACCOUNT: "100000", QUOTE_PRICE_SECONDS_PER_CLIENT_HOUR: "3600", QUOTE_PRICE_SECONDS_PER_ACCOUNT_HOUR: "3600",
  };
  let s = await live.start({ env });
  const tmp = s.tmp;
  const dbFile = path.join(s.dataDir, "quoting.db");
  const stripeSessions = () => { try { return JSON.parse(fs.readFileSync(stripeFile, "utf8")).sessions; } catch { return {}; } };
  const markPaid = (id) => { const j = JSON.parse(fs.readFileSync(stripeFile, "utf8")); Object.assign(j.sessions[id], { status: "complete", payment_status: "paid", payment_intent: `pi_${id}` }); fs.writeFileSync(stripeFile, JSON.stringify(j)); return j.sessions[id]; };
  const signed = (event) => {
    const payload = JSON.stringify(event), t = Math.floor(Date.now() / 1000);
    const v1 = crypto.createHmac("sha256", whsec).update(`${t}.${payload}`).digest("hex");
    return { body: Buffer.from(payload), headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)), "Stripe-Signature": `t=${t},v1=${v1}` } };
  };
  const webhook = (event) => { const w = signed(event); return s.req({ url: "/api/stripe/webhook", method: "POST", body: w.body, headers: w.headers }); };
  const kill = async () => { s.child.kill("SIGKILL"); await new Promise((r) => (s.exited() ? r() : s.child.once("exit", r))); };
  const restart = async () => { const keys = s.editKeys, pw = s.passwords, sec = s.adminSecret; s = await live.start({ env, tmpDir: tmp }); s.editKeys = keys; s.passwords = pw; s.adminSecret = sec; };
  /** The database as it is on the disk right now. */
  const disk = () => {
    const tmpLeft = fs.existsSync(`${dbFile}.tmp`);
    const db = new SQL.Database(fs.readFileSync(dbFile));
    const q = (sql, p = []) => { const st = db.prepare(sql); st.bind(p); const rows = []; while (st.step()) rows.push(st.getAsObject()); st.free(); return rows; };
    const integrity = q("PRAGMA integrity_check")[0].integrity_check;
    return { q, integrity, tmpLeft, close: () => db.close() };
  };
  const login = async (email) => (await s.post("/api/auth/login", { email, password: s.passwords[email] }, {})).body.token;

  // ── setup ──
  let buyer = await s.register("dana@buyer.test");
  const up = await s.upload([{ name: "cube.stl", data: cube }], { token: buyer });
  const partId = up.body.parts[0].partId;
  const mats = (await s.get("/api/materials")).body.filter((m) => m.process === "cnc");
  const mat = mats[0];
  const line = (qty) => ({ partId, materialSlug: mat.slug, grade: (mat.grades && mat.grades[0] && mat.grades[0].name) || "", finishSlug: "", quantity: qty, process: "cnc", subProcess: "milling" });
  const newQuote = async (lines = 1) => s.post("/api/quote", { parts: Array.from({ length: lines }, (_, i) => line(1 + (i % 3))), leadTimeSlug: "standard" }, { token: buyer });

  // ── A. acknowledged = on disk ──
  console.log("\nA. killed the instant the answer arrives: is what was acknowledged on the disk?");
  {
    const q = await newQuote(2);
    await kill();
    let d = disk();
    R.check(d.q("SELECT id FROM quotes WHERE id = ?", [q.body.quoteId]).length === 1 && d.integrity === "ok", "a new quote", `integrity ${d.integrity}`); d.close();
    await restart(); buyer = await login("dana@buyer.test");
    const q2 = await newQuote(3);
    const c = await s.post("/api/orders/checkout-session", { quoteId: q2.body.quoteId, ...SHIP }, { token: buyer });
    await kill();
    d = disk();
    const items = d.q("SELECT COUNT(*) n FROM order_items WHERE order_id = ?", [c.body.orderId])[0].n;
    const ord = d.q("SELECT status, total, stripe_session_id FROM orders WHERE id = ?", [c.body.orderId])[0];
    const qs = d.q("SELECT status FROM quotes WHERE id = ?", [q2.body.quoteId])[0];
    const ps = d.q("SELECT COUNT(*) n FROM payment_sessions WHERE order_id = ?", [c.body.orderId])[0].n;
    R.check(c.status === 200 && ord && items === 3 && qs.status === "ordered" && ps === 1 && Boolean(ord.stripe_session_id), "an order with its lines, its quote marked ordered and its payment session", `order ${ord && ord.status} $${ord && ord.total}, items ${items}, quote ${qs.status}, sessions ${ps}`); d.close();
    await restart(); buyer = await login("dana@buyer.test");
    const sid = String(c.body.sessionUrl).split("/").pop();
    const w = await webhook({ id: "evt_rr_A1", type: "checkout.session.completed", data: { object: markPaid(sid) } });
    await kill();
    d = disk();
    const paid = d.q("SELECT status, amount_paid, paid_at FROM orders WHERE id = ?", [c.body.orderId])[0];
    const ev = d.q("SELECT kind FROM payment_events WHERE order_id = ? OR event_id = 'evt_rr_A1'", [c.body.orderId]).map((x) => x.kind).join(",");
    R.check(w.status === 200 && paid.status === "paid" && Number(paid.amount_paid) > 0, "a settled payment (webhook answered 200)", `order ${paid.status}, paid $${paid.amount_paid}; events: ${ev}`); d.close();
    await restart();
    const email = `new-${crypto.randomBytes(3).toString("hex")}@buyer.test`;
    await s.register(email);
    await kill();
    d = disk();
    const u = d.q("SELECT email_verified_at, email FROM users WHERE email = ?", [email])[0];
    R.check(Boolean(u && u.email_verified_at), "a new account with its email confirmed", JSON.stringify(u || null)); d.close();
    await restart();
    const owner = await s.admin();
    const mAll = (await s.get("/api/admin/materials", { token: owner })).body;
    const target = mAll[0];
    const price = target.pricePerKg ? { pricePerKg: Number(target.pricePerKg) + 1.23 } : { pricePerCm3: Number(target.pricePerCm3) + 0.0123 };
    const put = await s.req({ method: "PUT", url: `/api/admin/materials/${target.id}`, json: { ...target, ...price }, token: owner });
    await kill();
    d = disk();
    const row = d.q("SELECT price_per_kg, price_per_cm3 FROM materials WHERE id = ?", [target.id])[0];
    const onDisk = Math.abs(Number(row.price_per_kg) - Number(price.pricePerKg)) < 1e-9 || Math.abs(Number(row.price_per_cm3) - Number(price.pricePerCm3)) < 1e-9;
    const aud = d.q("SELECT COUNT(*) n FROM admin_audit").length ? d.q("SELECT COUNT(*) n FROM admin_audit")[0].n : "?";
    R.check(put.status === 200 && onDisk, "an admin price edit (and the owner's account and two-step enrolment)", `PUT ${put.status}; on disk ${JSON.stringify(row)}; audit rows ${aud}`); d.close();
    await restart(); buyer = await login("dana@buyer.test");
  }

  // ── B. a re-priced draft ──
  console.log("\nB. a re-priced draft may wait up to 1.5 s for the file: what is lost with it?");
  {
    const q = await newQuote(1);
    const before = q.body.orderTotal;
    const re = await s.post("/api/quote", { quoteId: q.body.quoteId, parts: [line(9)], leadTimeSlug: "standard" }, { token: buyer });
    await kill();
    const d = disk();
    const row = d.q("SELECT order_total FROM quotes WHERE id = ?", [q.body.quoteId])[0];
    R.info("re-price acknowledged, killed at once", `the browser was told $${re.body.orderTotal}; the disk holds $${row.order_total} (the price before: $${before}). The last re-price is lost, as the code says it may be.`); d.close();
    await restart(); buyer = await login("dana@buyer.test");
    // Does an order made right after a re-price carry the re-price to disk with it?
    const q3 = await newQuote(1);
    const re3 = await s.post("/api/quote", { quoteId: q3.body.quoteId, parts: [line(7)], leadTimeSlug: "standard" }, { token: buyer });
    const c3 = await s.post("/api/orders/checkout-session", { quoteId: q3.body.quoteId, ...SHIP, confirmedTotal: re3.body.orderTotal }, { token: buyer });
    await kill();
    const d3 = disk();
    const o3 = d3.q("SELECT total FROM orders WHERE id = ?", [c3.body.orderId])[0];
    const qr = d3.q("SELECT order_total, status FROM quotes WHERE id = ?", [q3.body.quoteId])[0];
    R.check(o3 && Math.abs(o3.total - re3.body.orderTotal) < 0.005 && Math.abs(qr.order_total - re3.body.orderTotal) < 0.005, "re-price then checkout then kill: the order and the re-priced quote are both on disk", `order $${o3 && o3.total}, quote $${qr.order_total} (${qr.status})`); d3.close();
    await restart(); buyer = await login("dana@buyer.test");
  }

  // ── C. killed during checkout ──
  console.log(`\nC. killed at a random moment during the checkout of a ${LINES}-line quote (${ROUNDS} rounds)`);
  const partial = [];
  {
    let whole = 0, none = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const q = await newQuote(LINES);
      if (q.status !== 200) { console.log(`  quote: ${q.status} ${q.text.slice(0, 120)}`); break; }
      await sleep(1700); // let the draft reach the file, so only the checkout is in play
      const t0 = Date.now();
      const p = s.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, { token: buyer }).catch(() => null);
      const wait = 4 + Math.floor(Math.random() * (Number(process.env.RR_KILL_WINDOW_MS) || 120));
      await sleep(wait);
      await kill();
      await p;
      const d = disk();
      const orders = d.q("SELECT id, status, total FROM orders WHERE quote_id = ?", [q.body.quoteId]);
      const items = orders.length ? d.q("SELECT COUNT(*) n FROM order_items WHERE order_id = ?", [orders[0].id])[0].n : 0;
      const qs = d.q("SELECT status FROM quotes WHERE id = ?", [q.body.quoteId])[0].status;
      const sess = orders.length ? d.q("SELECT COUNT(*) n FROM payment_sessions WHERE order_id = ?", [orders[0].id])[0].n : 0;
      if (d.integrity !== "ok") R.finding("the database file failed SQLite's integrity check after a kill", d.integrity);
      d.close();
      if (!orders.length) none++;
      else if (items === LINES && qs === "ordered") whole++;
      else partial.push({ quoteId: q.body.quoteId, orderId: orders[0].id, items, quote: qs, sessions: sess, killedAfterMs: wait, total: orders[0].total, quoted: q.body.orderTotal });
      await restart(); buyer = await login("dana@buyer.test");
    }
    console.log(`  no order on disk: ${none}; whole order: ${whole}; PARTIAL order on disk: ${partial.length}`);
    for (const p of partial) console.log(`    killed after ${p.killedAfterMs} ms: order ${p.orderId.slice(0, 8)} has ${p.items} of ${LINES} lines, quote still '${p.quote}', sessions ${p.sessions}`);
    if (partial.length) {
      // The buyer comes back, presses pay again, and pays.
      const p = partial[0];
      const again = await s.post("/api/orders/checkout-session", { quoteId: p.quoteId, ...SHIP }, { token: buyer });
      let line2 = `second checkout: ${again.status} ${again.body && (again.body.code || "")}`;
      if (again.status === 200) {
        const sid = String(again.body.sessionUrl).split("/").pop();
        const sess = stripeSessions()[sid];
        await webhook({ id: `evt_rr_C_${Date.now()}`, type: "checkout.session.completed", data: { object: markPaid(sid) } });
        const o = (await s.get(`/api/orders/${again.body.orderId}`, { token: buyer })).body;
        line2 += `; same order: ${again.body.orderId === p.orderId}; Stripe was asked for ${sess.amount_total / 100} (“${sess.items[0]}”); order now ${o.status}, paid $${o.amountPaid}, lines on the order: ${o.items.length} of ${LINES}`;
        if (o.status === "paid" && o.items.length < LINES) R.finding("a buyer PAID IN FULL for an order that holds only some of its lines", line2);
        else R.holds("the partial order was not sold short", line2);
      } else R.info("the partial order after the restart", line2);
    } else R.info("no kill landed inside the window this run", `window tried: 4 to ${4 + (Number(process.env.RR_KILL_WINDOW_MS) || 120)} ms after the request was sent; run again or raise the line count`);
  }

  // ── D. killed during the 'paid' webhook ──
  console.log(`\nD. killed during the 'paid' webhook, then Stripe sends it again (${ROUNDS} rounds)`);
  {
    let lostMail = 0, notPaid = 0, flagged = 0, okRounds = 0, killedBeforeAnswer = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const q = await newQuote(2);
      const c = await s.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, { token: buyer });
      const sid = String(c.body.sessionUrl).split("/").pop();
      const event = { id: `evt_rr_D_${i}_${Date.now()}`, type: "checkout.session.completed", data: { object: markPaid(sid) } };
      let answered = false;
      const p = webhook(event).then((r) => { answered = r.status === 200; }).catch(() => null);
      await sleep(1 + Math.floor(Math.random() * (Number(process.env.RR_WEBHOOK_WINDOW_MS) || 25)));
      await kill();
      await p;
      if (!answered) killedBeforeAnswer++;
      await restart(); buyer = await login("dana@buyer.test");
      const r2 = await webhook(event); // Stripe retries an event that was not answered
      await sleep(300);
      const o = (await s.get(`/api/orders/${c.body.orderId}`, { token: buyer })).body;
      const ref = c.body.orderId.slice(0, 8).toUpperCase();
      const toBuyer = s.mail("dana@buyer.test").filter((m) => (m.subject + m.text).toUpperCase().includes(ref)).length;
      const toShop = s.mail(s.adminEmail).filter((m) => (m.subject + m.text).toUpperCase().includes(ref)).length;
      if (o.status !== "paid") { notPaid++; console.log(`    round ${i}: order ${o.status} after the retry (${r2.status} ${JSON.stringify(r2.body)})`); }
      else if (o.paymentUnderReview) flagged++;
      else if (!answered && (toBuyer === 0 || toShop === 0)) { lostMail++; console.log(`    round ${i}: order paid, retry answered ${JSON.stringify(r2.body)}; emails about it: buyer ${toBuyer}, shop ${toShop}`); }
      else okRounds++;
    }
    console.log(`  killed before the 200: ${killedBeforeAnswer} of ${ROUNDS}; clean: ${okRounds}; paid but nobody emailed: ${lostMail}; not paid after the retry: ${notPaid}; flagged: ${flagged}`);
    R.check(notPaid === 0, "after the retry every order is paid (no payment lost)");
    if (lostMail) R.finding("an order can be PAID with neither the buyer nor the shop ever emailed", `${lostMail} of ${killedBeforeAnswer} kills that landed before the answer: the first delivery marked it paid on disk and died before the emails; the retry is a 'replay' and sends nothing`);
    else R.info("no kill landed between 'paid on disk' and 'emails sent' this run", `${killedBeforeAnswer} kills landed before the answer`);
  }

  // ── E. the file ──
  console.log("\nE. the file itself");
  {
    await kill();
    const good = fs.readFileSync(dbFile);
    // A half-written temporary file beside a good database (the crash writeDurably is built for).
    fs.writeFileSync(`${dbFile}.tmp`, good.subarray(0, Math.floor(good.length / 3)));
    await restart();
    const users = (new SQL.Database(fs.readFileSync(dbFile))).exec("SELECT COUNT(*) FROM users")[0].values[0][0];
    R.check(users >= 2, "a half-written quoting.db.tmp beside a good database: the good one is loaded", `users on disk after the restart: ${users}`);
    await kill();
    // What does a start do with a database it cannot read? (A volume that came up damaged or empty.)
    const keep = fs.readFileSync(dbFile);
    for (const [label, bytes] of [["zero-length file", Buffer.alloc(0)], ["first third of the file", keep.subarray(0, Math.floor(keep.length / 3))], ["not a database", Buffer.from("this is not a database".repeat(400))]]) {
      fs.writeFileSync(dbFile, bytes);
      let outcome;
      try {
        s = await live.start({ env, tmpDir: tmp });
        const health = await s.get("/api/health");
        await s.stop({ keep: true });
        const now = fs.readFileSync(dbFile);
        let usersNow = "?";
        try { usersNow = (new SQL.Database(now)).exec("SELECT COUNT(*) FROM users")[0].values[0][0]; } catch (e) { usersNow = `unreadable (${e.message.slice(0, 40)})`; }
        outcome = `the server STARTED (health ${health.status}) and the file is now ${now.length} bytes with ${usersNow} users`;
        if (typeof usersNow === "number" && usersNow === 0) R.finding(`start-up with a damaged database (${label}): the server starts on an EMPTY database and writes it over the file`, outcome);
        else R.info(`start-up with a damaged database (${label})`, outcome);
      } catch (err) {
        outcome = `the server refused to start: ${String(err.message).split("\n").slice(0, 3).join(" | ").slice(0, 200)}`;
        R.holds(`start-up with a damaged database (${label}): refused, the file is left alone`, outcome);
      }
    }
    fs.writeFileSync(dbFile, keep);
  }

  const f = R.done();
  fs.rmSync(tmp, { recursive: true, force: true });
  try { fs.rmSync(stripeFile); } catch { /* gone */ }
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
