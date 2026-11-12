/**
 * Per-sender quotas in bytes, and who gives way under pressure (independent re-review 2026-11-12:
 * RR-01, RR-02, RR-08, RR-11).
 *
 * Round 1 limited ROWS and measured the best case (identical lines, one part repeated, no account).
 * Every test here is the worst case the reviewer used: lines that all differ, a confirmed account,
 * several addresses, re-pricing as well as creating.
 *
 *   RR-01  one address and one confirmed account filled the database with 224 large saved quotes;
 *          nothing cleared it for 30 days
 *   RR-02  small drafts grown by re-pricing (never checked) took it to 107 % of the ceiling
 *   RR-08  files on an unanswered request, a saved quote or an unpaid order were never evicted
 *   RR-11  the clean-up pass held the thread for seconds
 * Run: node server/services/senderQuotas.test.js
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { monitorEventLoopDelay } = require("perf_hooks");

process.env.DB_MAX_MB = "8";
process.env.UPLOAD_DIR_MAX_MB = "20";
const { start, runner } = require("../testSupport/harness");
const { solidStl } = require("../testSupport/zip");

const { test, run } = runner("Per-sender quotas and who gives way");
const MB = 1024 * 1024;
const KB = 1024;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const cubeFile = fs.readFileSync(path.join(__dirname, "..", "..", "tools", "vet-quotes", "parts", "cube_20mm.stl"));

let h, models, database, pressure, guards, quoteGuards, dataDir, buyer, buyerId, other;
const dbMb = () => database.liveSize() / MB;
const line = (partId, quantity = 1) => h.cncConfig(partId, quantity);
const withEnv = async (env, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = String(v); }
  try { return await fn(); } finally { for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};
const quietly = async (fn) => { const w = console.warn; const e = console.error; console.warn = () => {}; console.error = () => {}; try { return await fn(); } finally { console.warn = w; console.error = e; } };
const from = async (ip, fn) => { const was = h.ip; h.ip = ip; try { return await fn(); } finally { h.ip = was; } };
const uploadsDir = () => path.join(dataDir, "uploads");

test("setup", async () => {
  h = await start({ mailer: "configured" });
  models = h.models;
  database = require("../models/database");
  pressure = require("./storagePressure");
  guards = require("../security/uploadGuards");
  quoteGuards = require("../security/quoteGuards");
  dataDir = process.env.QUOTING_DATA_DIR;
  buyer = await h.register("heavy@example.test");
  buyerId = models.usersDB.getAll().find((u) => u.email === "heavy@example.test").id;
  other = await h.register("other@example.test");
});

// ─── RR-01 ───────────────────────────────────────────────────

test("RR-01: one address and one confirmed account saving quotes of 100 lines that all differ are stopped by the account's allowance in bytes; nobody else is refused, and another address does not help", async () => {
  quoteGuards.resetForTests();
  const A = "198.51.100.20";
  const partId = await from(A, () => h.uploadCube());
  const big = (n) => ({ parts: Array.from({ length: 100 }, (_, i) => line(partId, 1 + i + n)) }); // 100 different lines, different from quote to quote
  const before = dbMb();
  const made = [];
  let refused = null;
  // The hourly count of new quotes is lifted so that it is the byte allowance being tested (the
  // reviewer's 28 drafts were inside the count as it was).
  await withEnv({ QUOTE_NEW_PER_CLIENT_HOUR: 1000, QUOTE_NEW_PER_ACCOUNT_HOUR: 1000, QUOTE_NEW_PER_CLIENT_DAY: 1000, QUOTE_NEW_PER_ACCOUNT_DAY: 1000 }, async () => {
    for (let n = 0; n < 120 && !refused; n++) {
      const r = await from(n % 2 ? A : "198.51.100.22", () => h.post("/api/quote", big(n), buyer)); // two addresses, one account
      if (r.status === 200) made.push(r.body.quoteId); else refused = r;
    }
    assert.ok(refused, `${made.length} quotes saved and still going`);
    assert.deepStrictEqual([refused.status, refused.body.code], [429, "drafts-full"], refused.text.slice(0, 200));
    assert.ok(/saved quotes/i.test(refused.body.error) && /@/.test(refused.body.error) && !/byte|kB|database|row/i.test(refused.body.error), refused.body.error);
    const held = models.quotesDB.draftBytesHeld({ userId: buyerId }).account;
    assert.ok(held <= 512 * KB, `the account holds ${(held / KB).toFixed(0)} kB of drafts`);
    assert.ok(made.length >= 10 && made.length <= 60, `${made.length} quotes of 100 different lines fit the allowance`);
    assert.ok(dbMb() - before < 1, `the database grew ${(dbMb() - before).toFixed(2)} MB (it was 295 kB a quote: ${(made.length * 0.295).toFixed(1)} MB for these)`);
    assert.ok(dbMb() < 8 * 0.5, `and is at ${dbMb().toFixed(2)} MB of 8: nowhere near a line that affects anyone`);
    // Another address is not a new allowance for the account…
    const elsewhere = await from("198.51.100.21", () => h.post("/api/quote", big(500), buyer));
    assert.strictEqual(elsewhere.body.code, "drafts-full");
    // …and the account can still work on what it has.
    assert.strictEqual((await from(A, () => h.post("/api/quote", { ...big(7), quoteId: made[0] }, buyer))).status, 200, "re-pricing a saved quote at the same size");
  });
  // Everybody else, at that moment:
  const custPart = await from("203.0.113.30", () => h.form("/api/upload", {}, { files: { name: "cube.stl", data: cubeFile } }, other));
  assert.strictEqual(custPart.status, 200, "another customer uploads");
  assert.strictEqual((await from("203.0.113.30", () => h.post("/api/quote", { parts: [line(custPart.body.parts[0].partId, 3)] }, other))).status, 200, "and saves a quote");
  const anon = await from("203.0.113.31", () => h.form("/api/upload", {}, { files: { name: "cube.stl", data: cubeFile } }));
  assert.strictEqual(anon.status, 200, "a visitor without an account uploads");
  assert.strictEqual((await from("203.0.113.31", () => h.post("/api/quote", { parts: [line(anon.body.parts[0].partId, 1)] }))).status, 200);
});

// ─── RR-02 ───────────────────────────────────────────────────

test("RR-02: one-line drafts grown to 25 different lines by re-pricing are held to the address's allowance; an address at its allowance makes room with its own idle drafts first", async () => {
  quoteGuards.resetForTests();
  const A = "198.51.100.40";
  const parts = [];
  for (let i = 0; i < 5; i++) parts.push(await from(A, () => h.uploadCube()));
  const small = [];
  for (let n = 0; n < 30; n++) { const r = await from(A, () => h.post("/api/quote", { parts: [line(parts[0], n + 1)] })); assert.strictEqual(r.status, 200, `draft ${n + 1}: ${r.text.slice(0, 200)}`); small.push(r.body.quoteId); }
  const tag = guards.clientTag(A);
  const startBytes = models.quotesDB.draftBytesHeld({ clientTag: tag }).client;
  const grown = (n) => Array.from({ length: 25 }, (_, i) => line(parts[i % 5], 1 + i + n * 3));
  // QUOTE_DRAFT_KB_PER_CLIENT is 512 by default; 128 here so that thirty drafts of 25 lines do not fit.
  // (relaunch merge 2: it was 96, sized for a stored draft of 2.3 kB at one line and 5.9 kB at 25. With the record of
  // what was priced kept in each quote (services/quoteIntegrity.js) a draft is 2.8 kB at one line and 7.8 kB at 25,
  // measured on the merged tree, so thirty one-line drafts already came to 84 kB of the 96 and only two re-prices fitted.)
  const ALLOWANCE_KB = 128;
  await withEnv({ QUOTE_DRAFT_KB_PER_CLIENT: ALLOWANCE_KB, QUOTE_NEW_PER_CLIENT_HOUR: 100 }, async () => {
    const statuses = [];
    for (let n = 0; n < small.length; n++) statuses.push(await from(A, () => h.post("/api/quote", { quoteId: small[n], parts: grown(n) })));
    const ok = statuses.filter((r) => r.status === 200).length;
    const refused = statuses.filter((r) => r.status !== 200);
    assert.ok(ok >= 3 && refused.length >= 5, `${ok} re-prices accepted, ${refused.length} refused (${[...new Set(refused.map((r) => `${r.status} ${r.body && r.body.code}`))].join(", ")})`);
    assert.ok(refused.every((r) => r.status === 429 && r.body.code === "drafts-full"), refused.map((r) => `${r.status} ${r.body && r.body.code}`).join(", "));
    const held = models.quotesDB.draftBytesHeld({ clientTag: tag }).client;
    assert.ok(held <= ALLOWANCE_KB * KB, `the address holds ${(held / KB).toFixed(0)} kB (it started at ${(startBytes / KB).toFixed(0)} kB)`);
    const untouched = models.quotesDB.getById(small[small.length - 1]);
    assert.strictEqual(untouched.lineItems.length, 1, "a refused re-price changes nothing: the quote is as it was");
    // A visitor somewhere else is not affected by this address being at its allowance.
    assert.strictEqual((await from("203.0.113.41", () => h.post("/api/quote", { parts: grown(99) }))).status, 200);
    // The same address, later: its drafts have sat for twenty minutes. A new quote makes room with the oldest of them instead of being refused.
    database.getDatabase().run("UPDATE quotes SET updated_at = ? WHERE client_tag = ?", [new Date(Date.now() - 20 * MIN).toISOString(), tag]);
    const countBefore = models.quotesDB.ownAnonymousDrafts(tag).length;
    const later = await from(A, () => h.post("/api/quote", { parts: grown(200) }));
    assert.strictEqual(later.status, 200, later.text.slice(0, 200));
    assert.ok(models.quotesDB.ownAnonymousDrafts(tag).length <= countBefore, "room was made from this address's own idle drafts");
    assert.ok(models.quotesDB.draftBytesHeld({ clientTag: tag }).client <= ALLOWANCE_KB * KB);
  });
});

test("RR-02: one quote may be re-priced as often as a person changes it, not without limit", async () => {
  quoteGuards.resetForTests();
  const A = "198.51.100.45";
  const partId = await from(A, () => h.uploadCube());
  const q = await from(A, () => h.post("/api/quote", { parts: [line(partId, 1)] }));
  const second = await from(A, () => h.post("/api/quote", { parts: [line(partId, 2)] }));
  await withEnv({ QUOTE_REPRICE_PER_QUOTE_HOUR: 10 }, async () => {
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push(await from(A, () => h.post("/api/quote", { quoteId: q.body.quoteId, parts: [line(partId, 2 + i)] })));
    assert.deepStrictEqual(statuses.map((r) => r.status), [...Array(10).fill(200), 429, 429]);
    const refused = statuses[10];
    assert.strictEqual(refused.body.code, "reprice-limit");
    assert.ok(Number(refused.headers.get("retry-after")) >= 60 && /few minutes/.test(refused.body.error), refused.body.error);
    assert.strictEqual((await from(A, () => h.post("/api/quote", { quoteId: second.body.quoteId, parts: [line(partId, 5)] }))).status, 200, "another quote of the same visitor is not affected");
  });
});

// ─── RR-01 / RR-02: what the clean-up and the admin button can remove ───

test("RR-01: when the database IS over its line, the admin's button and the pass remove an account's drafts that are on no order or request, heaviest holder first", async () => {
  const db = database.getDatabase();
  const blob = JSON.stringify({ $lines: 2, n: 1, z: crypto.randomBytes(60000).toString("base64") });
  const insert = (userId, n, ageMs) => { for (let i = 0; i < n; i++) db.run("INSERT INTO quotes (id, user_id, client_tag, status, line_items_json, config_json, part_ids, created_at, updated_at, expires_at) VALUES (?, ?, '', 'draft', ?, '{}', '', ?, ?, ?)", [crypto.randomUUID(), userId, blob, new Date(Date.now() - ageMs - i).toISOString(), new Date().toISOString(), new Date(Date.now() + 30 * DAY).toISOString()]); };
  // Rows as round 1 let one account write them (allowances did not exist): 70 saved quotes of 80 kB.
  insert("account-that-flooded", 95, 10 * MIN);
  database.compact();
  assert.ok(dbMb() > 8 * 0.85, `database at ${dbMb().toFixed(2)} MB of 8`);
  const custQuote = models.quotesDB.getAll().find((q) => q.userId === models.usersDB.getAll().find((u) => u.email === "other@example.test").id);
  assert.ok(custQuote, "the other customer has a saved quote");
  const admin = await h.admin();
  const r = await quietly(() => h.post("/api/admin/drafts/purge", { olderThanHours: 0 }, admin));
  assert.strictEqual(r.status, 200, r.text.slice(0, 200));
  assert.ok(r.body.removedUnderPressure >= 20, `the button removed ${r.body.removedUnderPressure} of the account's drafts (it removed 0)`);
  assert.ok(dbMb() < 8 * 0.8, `database back to ${dbMb().toFixed(2)} MB`);
  assert.ok(models.quotesDB.getById(custQuote.id), "the other customer's saved quote was not touched: they hold a few kB");
  assert.ok(models.quotesDB.draftBytesHeld({ userId: buyerId }).account > 0, "nor the first account's, which is inside its allowance");
  db.run("DELETE FROM quotes WHERE user_id = 'account-that-flooded'"); database.compact();
});

// ─── RR-11 ───────────────────────────────────────────────────

test("a pass that came while the flood's rows were too new looks again as soon as they are not (it does not sleep its five minutes on them)", async () => {
  const db = database.getDatabase();
  const pressure = require("./storagePressure");
  const blob = JSON.stringify({ $lines: 2, n: 1, z: crypto.randomBytes(60000).toString("base64") });
  const t0 = Date.now();
  // 95 saved quotes of 80 kB from one account, made 30 seconds ago: over the line, and every one of them still spared for being new.
  for (let i = 0; i < 95; i++) db.run("INSERT INTO quotes (id, user_id, client_tag, status, line_items_json, config_json, part_ids, created_at, updated_at, expires_at) VALUES (?, 'account-that-just-flooded', '', 'draft', ?, '{}', '', ?, ?, ?)", [crypto.randomUUID(), blob, new Date(t0 - 30000 - i).toISOString(), new Date(t0 - 30000 - i).toISOString(), new Date(t0 + 30 * 24 * 3600 * 1000).toISOString()]);
  database.compact();
  assert.ok(dbMb() > 8 * 0.85, `database at ${dbMb().toFixed(2)} MB of 8`);
  pressure.state.databaseQuietUntil = 0;
  const first = await quietly(() => pressure.relieveDatabase(models, {}));
  assert.deepStrictEqual([first.removedDrafts, first.removedParts], [0, 0], "nothing may go yet");
  const wait = pressure.state.databaseQuietUntil - Date.now();
  assert.ok(wait > 60 * 1000 && wait <= 95 * 1000, `the next look is when the first of them is two minutes old (in ${Math.round(wait / 1000)} s), not in five minutes`);
  assert.strictEqual(await pressure.relieveDatabase(models, {}), null, "and not before");
  // Two minutes after they were made:
  pressure.state.databaseQuietUntil = 0;
  const later = await quietly(() => pressure.relieveDatabase(models, { now: t0 + 2 * MIN }));
  assert.ok(later.removedDrafts >= 20, `then they go (${later.removedDrafts} removed)`);
  assert.ok(dbMb() < 8 * 0.8, `database back to ${dbMb().toFixed(2)} MB`);
  db.run("DELETE FROM quotes WHERE user_id = 'account-that-just-flooded'"); database.compact();
  pressure.state.databaseQuietUntil = 0;
});

test("RR-11: a pass over thousands of rows is done in pieces; the thread is never held for long", async () => {
  const db = database.getDatabase();
  const blob = JSON.stringify({ $lines: 2, n: 1, z: crypto.randomBytes(1500).toString("base64") });
  let rows = 0;
  // 400 senders, a few kB each: thousands of small rows, the shape that made the old pass slowest.
  while (dbMb() < 8 * 0.88 && rows < 6000) {
    for (let i = 0; i < 200; i++, rows++) db.run("INSERT INTO quotes (id, user_id, client_tag, status, line_items_json, config_json, part_ids, created_at, updated_at, expires_at) VALUES (?, NULL, ?, 'draft', ?, '{}', '', ?, ?, ?)", [crypto.randomUUID(), `many-${rows % 400}`, blob, new Date(Date.now() - 10 * MIN - rows).toISOString(), new Date().toISOString(), new Date(Date.now() + 30 * DAY).toISOString()]);
  }
  database.compact();
  assert.ok(rows >= 1500, `${rows} rows`);
  const loop = monitorEventLoopDelay({ resolution: 5 });
  await withEnv({ DRAFT_KEEP_KB_PER_HOLDER: 1 }, async () => {
    loop.enable();
    const result = await quietly(() => pressure.relieveDatabase(models));
    loop.disable();
    const load = os.loadavg()[0].toFixed(1);
    assert.ok(result && result.removedDrafts > 500, `${result && result.removedDrafts} of ${rows} rows removed`);
    assert.ok(dbMb() < 8 * 0.8);
    // "About 100 ms" on a quiet machine; the sandbox is shared, so the test allows 250 and prints what it saw.
    assert.ok(result.longestPieceMs < 250, `longest piece of the pass: ${result.longestPieceMs} ms (load ${load})`);
    assert.ok(loop.max / 1e6 < 400, `the event loop was held ${(loop.max / 1e6).toFixed(0)} ms at most during the pass (load ${load})`);
    console.log(`       (${rows} rows, ${result.removedDrafts} removed; longest piece ${result.longestPieceMs} ms; event loop held ${(loop.max / 1e6).toFixed(0)} ms at most; load ${load})`);
  });
  db.run("DELETE FROM quotes WHERE client_tag LIKE 'many-%'"); database.compact();
});

// ─── RR-08 ───────────────────────────────────────────────────

/** A real uploaded cube made to look like a `bytes`-sized upload from `ageMs` ago by this holder. */
async function storedPart(bytes, ageMs, { tag = "", ownerId = "" } = {}) {
  const id = await h.uploadCube();
  const name = models.partsDB.getRow(id).storedName;
  fs.writeFileSync(path.join(uploadsDir(), name), Buffer.alloc(bytes, 1));
  database.getDatabase().run("UPDATE parts SET file_size = ?, created_at = ?, client_tag = ?, owner_id = ? WHERE id = ?", [bytes, new Date(Date.now() - ageMs).toISOString(), tag, ownerId, id]);
  return { id, name };
}
const onDisk = (p) => fs.existsSync(path.join(uploadsDir(), p.name)) && Boolean(models.partsDB.getRow(p.id));

test("RR-08: bytes stored are capped per account as well as per address", async () => {
  await withEnv({ UPLOAD_STORED_MB_PER_ACCOUNT: 1 }, async () => {
    const first = await from("198.51.100.60", () => h.form("/api/upload", {}, { files: { name: "a.stl", data: solidStl(32) } }, buyer)); // 600 kB, plus its preview: over 1 MB kept
    assert.strictEqual(first.status, 200, first.text.slice(0, 200));
    assert.ok(guards.storedBytesForAccount(buyerId) > MB);
    assert.strictEqual(models.partsDB.getRow(first.body.parts[0].partId).ownerId, buyerId);
    // The account at its cap, from a different address:
    const second = await from("198.51.100.61", () => h.form("/api/upload", {}, { files: { name: "b.stl", data: cubeFile } }, buyer));
    assert.deepStrictEqual([second.status, second.body.code], [429, "stored-limit"]);
    assert.ok(/your account/i.test(second.body.error) && /@/.test(second.body.error), second.body.error);
    // That address without the account, and another account, are not affected.
    assert.strictEqual((await from("198.51.100.61", () => h.form("/api/upload", {}, { files: { name: "b.stl", data: cubeFile } }))).status, 200);
    assert.strictEqual((await from("198.51.100.62", () => h.form("/api/upload", {}, { files: { name: "b.stl", data: cubeFile } }, other))).status, 200);
  });
});

test("RR-08: files pinned by unanswered requests, saved quotes and unpaid orders are cleared from the heaviest holder beyond its protected share; paid and answered work is never touched, and nor is anyone lighter", async () => {
  // Start from empty folders.
  for (const dir of guards.STORAGE_DIRS) if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  database.getDatabase().run("DELETE FROM parts"); database.compact();
  guards.storage.invalidate();
  const db = database.getDatabase();
  const ago = (ms) => new Date(Date.now() - ms).toISOString();

  // Sender 1, an address: six 1 MB files, each on its own request that nobody at the shop has opened.
  const pinnedByRequests = [];
  for (let i = 0; i < 6; i++) {
    const p = await storedPart(MB, (6 - i) * HOUR, { tag: "pin-address" });
    models.rfqsDB.insert({ status: "new", contactName: "x", email: "x@example.test", clientTag: "pin-address", parts: [{ partId: p.id }] });
    pinnedByRequests.push(p);
  }
  // Sender 2, an account: three files on saved quotes, three on an order that was never paid (three days old).
  const pinnedByAccount = [];
  for (let i = 0; i < 6; i++) pinnedByAccount.push(await storedPart(MB, (6 - i) * HOUR, { tag: "pin-x", ownerId: "pin-account" }));
  const savedQuotes = [];
  for (const p of pinnedByAccount.slice(0, 3)) {
    const id = crypto.randomUUID();
    db.run("INSERT INTO quotes (id, user_id, client_tag, status, line_items_json, config_json, part_ids, created_at, updated_at, expires_at) VALUES (?, 'pin-account', 'pin-x', 'draft', '[]', '{}', ?, ?, ?, ?)", [id, p.id, ago(5 * HOUR), ago(1000), new Date(Date.now() + 30 * DAY).toISOString()]);
    savedQuotes.push(id);
  }
  // An abandoned checkout: its payment page ran out three days ago less two hours. (relaunch merge 2: an unpaid order
  // with NO payment page is an order the owner took by phone and has yet to mark paid; that one holds its files
  // outright however old it is, see rowRetention.js unpaidOrderIsPayable and rowRetention.test.js.)
  const unpaid = models.ordersDB.insert({ userId: "pin-account", status: "pending_payment", total: 10, stripeSessionId: "cs_test_abandoned", sessionExpiresAt: ago(3 * DAY - 2 * HOUR) });
  db.run("UPDATE orders SET created_at = ? WHERE id = ?", [ago(3 * DAY), unpaid.id]);
  for (const p of pinnedByAccount.slice(3)) models.orderItemsDB.insert({ orderId: unpaid.id, partId: p.id, fileName: "a.stl", quantity: 1 });

  // Everyone else.
  const visitor = await storedPart(MB, 3 * HOUR, { tag: "a-visitor" });                      // one unpriced upload, idle for three hours
  const customerNew = await storedPart(MB, 10 * MIN, { tag: "c", ownerId: buyerId });         // a customer's part, ten minutes old, not priced yet
  const paid = await storedPart(MB, 20 * DAY, { tag: "p1" });
  const paidOrder = models.ordersDB.insert({ userId: "u1", status: "paid", total: 10 });
  models.orderItemsDB.insert({ orderId: paidOrder.id, partId: paid.id, fileName: "a.stl", quantity: 1 });
  const answered = await storedPart(MB, 20 * DAY, { tag: "p2" });
  models.rfqsDB.insert({ status: "in-review", contactName: "y", email: "y@example.test", clientTag: "p2", parts: [{ partId: answered.id }] });
  const youngUnpaid = await storedPart(MB, 30 * MIN, { tag: "p3" });
  const youngOrder = models.ordersDB.insert({ userId: "u3", status: "pending_payment", total: 10 });
  models.orderItemsDB.insert({ orderId: youngOrder.id, partId: youngUnpaid.id, fileName: "a.stl", quantity: 1 });
  // Orders that are over hold nothing (the state names are those of the order-lifecycle branch).
  const onCancelled = await storedPart(64 * KB, 20 * DAY, { tag: "p4" });
  const onExpired = await storedPart(64 * KB, 20 * DAY, { tag: "p5" });
  for (const [p, status] of [[onCancelled, "cancelled"], [onExpired, "expired"]]) { const o = models.ordersDB.insert({ userId: "u4", status, total: 10 }); models.orderItemsDB.insert({ orderId: o.id, partId: p.id, fileName: "a.stl", quantity: 1 }); }

  const refs = require("./rowRetention").references(models);
  assert.ok(refs.partsHard.has(paid.id) && refs.partsHard.has(answered.id) && refs.partsHard.has(youngUnpaid.id), "paid, answered, and unpaid-but-young are held outright");
  assert.ok(refs.partsProtected.has(pinnedByRequests[0].id) && !refs.partsHard.has(pinnedByRequests[0].id), "a file on an unanswered request is held softly");
  assert.ok(refs.partsProtected.has(pinnedByAccount[5].id) && !refs.partsHard.has(pinnedByAccount[5].id), "so is one on an order nobody paid for in three days");
  assert.ok(!refs.partsProtected.has(onCancelled.id) && !refs.partsProtected.has(onExpired.id), "a cancelled or expired order holds nothing");
  const needed = require("./fileRetention").neededUploads(models);
  assert.ok(needed.has(pinnedByRequests[0].name) && !needed.has(onCancelled.name), "the scheduled sweep follows the same rule");

  guards.storage.invalidate();
  const used = guards.storage.scan();
  assert.ok(used > 16.9 * MB && used < 18.5 * MB, `${(used / MB).toFixed(1)} MB of 20 stored: over the line where visitors are refused`);
  const refused = await from("203.0.113.70", () => h.form("/api/upload", {}, { files: { name: "cube.stl", data: cubeFile } }));
  assert.deepStrictEqual([refused.status, refused.body.code], [503, "uploads-paused"]);

  // UPLOAD_PROTECTED_MB_PER_HOLDER: 2 MB here (a third of what a sender may store, by default).
  const r = await withEnv({ UPLOAD_PROTECTED_MB_PER_HOLDER: 2 }, () => quietly(() => pressure.relieveStorage(models)));
  assert.ok(r && r.removedUploads >= 4, JSON.stringify(r));
  assert.ok(r.bytesAfter <= 20 * MB * 0.66, `back under the line with a margin: ${(r.bytesAfter / MB).toFixed(1)} MB`);
  const leftRequests = pinnedByRequests.filter(onDisk).length;
  const leftAccount = pinnedByAccount.filter(onDisk).length;
  assert.ok(leftRequests >= 2 && leftAccount >= 2, `each of the two keeps its protected 2 MB (${leftRequests} and ${leftAccount} files left)`);
  assert.strictEqual(12 - leftRequests - leftAccount + [onCancelled, onExpired].filter((p) => !onDisk(p)).length, r.removedUploads, "everything removed was theirs, or on an order that is over");
  assert.ok(onDisk(pinnedByRequests[5]) && !onDisk(pinnedByRequests[0]), "the oldest went first; the newest are the protected share");
  for (const [what, p] of [["a visitor's one upload, idle for hours", visitor], ["a customer's part ten minutes after upload", customerNew], ["a part on a paid order", paid], ["a part on a request the shop is working on", answered], ["a part on an order made half an hour ago", youngUnpaid]]) {
    assert.ok(onDisk(p), `${what} is untouched`);
  }
  assert.strictEqual(models.rfqsDB.getAll().filter((x) => x.clientTag === "pin-address").length, 6, "the requests themselves stay in the admin's list");
  const quotesLeft = savedQuotes.filter((id) => models.quotesDB.getById(id)).length;
  assert.strictEqual(quotesLeft, pinnedByAccount.slice(0, 3).filter(onDisk).length, "a saved quote whose file was removed goes with it; the others stay");
  assert.strictEqual((await from("203.0.113.70", () => h.form("/api/upload", {}, { files: { name: "cube.stl", data: cubeFile } }))).status, 200, "and visitors can upload again, without the owner deleting anything");
});

run(async () => { if (h) await h.stop(); process.exit(process.exitCode || 0); });
