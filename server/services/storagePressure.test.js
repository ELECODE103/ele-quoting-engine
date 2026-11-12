/**
 * The database and the file folders give way by themselves, least valuable
 * first, and come back without anyone editing a database by hand
 * (independent review 2026-11-11, H3, H4, H5, L2, L6).
 *
 * Before: 925 draft quotes with no upload at all took the database to its
 * ceiling; uploads were then refused for every customer for up to 30 days, a
 * restart did not help, and nothing in the admin panel cleared it. The file
 * ceiling could be filled in under two minutes and request attachments were
 * never freed. CAD files were deleted at 7 days while the quote stayed
 * orderable for 30.
 * Run: node server/services/storagePressure.test.js
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// A test-sized database and file store: the ceilings are settings.
process.env.DB_MAX_MB = "4";
process.env.UPLOAD_DIR_MAX_MB = "10";
const { start, runner } = require("../testSupport/harness");

const { test, run } = runner("Storage pressure, retention and clean-up");
const partsDir = path.join(__dirname, "..", "..", "tools", "vet-quotes", "parts");
const cubeFile = fs.readFileSync(path.join(partsDir, "cube_20mm.stl"));
const MB = 1024 * 1024;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let h, models, database, pressure, guards, dataDir, buyer, admin;
const dbMb = () => database.fileSize() / MB;
const uploadsDir = () => path.join(dataDir, "uploads");
const cncLine = (partId, quantity = 1) => h.cncConfig(partId, quantity);

/**
 * A real uploaded part (the 20 mm cube) made to look like a `bytes`-sized upload from `ageMs` ago:
 * its stored file is grown to that size and its row back-dated. (Uploading megabytes of real geometry
 * nine times over would only make the suite slow; what is tested here is which files are let go.)
 */
async function storedPart(bytes, ageMs) {
  const id = await h.uploadCube();
  const name = models.partsDB.getRow(id).storedName;
  fs.writeFileSync(path.join(uploadsDir(), name), Buffer.alloc(bytes, 1));
  require("../models/database").getDatabase().run("UPDATE parts SET file_size = ?, created_at = ? WHERE id = ?", [bytes, new Date(Date.now() - ageMs).toISOString(), id]);
  return { id, name };
}
const onDisk = (p) => fs.existsSync(path.join(uploadsDir(), p.name));

test("setup", async () => {
  h = await start({ mailer: "configured" });
  models = h.models;
  database = require("../models/database");
  pressure = require("./storagePressure");
  guards = require("../security/uploadGuards");
  dataDir = process.env.QUOTING_DATA_DIR;
  buyer = await h.register("customer@example.test");
  admin = await h.admin();
});

// ─── H3: quotes and the database ─────────────────────────────

test("a client cannot choose a quote id: the server makes it, and a made-up id never becomes a row", async () => {
  const partId = await h.uploadCube();
  const mine = crypto.randomUUID();
  const r = await h.post("/api/quote", { quoteId: mine, parts: [cncLine(partId)] });
  assert.strictEqual(r.status, 200);
  assert.notStrictEqual(r.body.quoteId, mine);
  assert.strictEqual(models.quotesDB.getById(mine), null);
  // resuming works with the id the server gave: the same row is re-priced
  const again = await h.post("/api/quote", { quoteId: r.body.quoteId, parts: [cncLine(partId, 3)] });
  assert.strictEqual(again.body.quoteId, r.body.quoteId);
  // a signed-in customer's quote cannot be resumed by someone else holding its id: they get a row of their own
  const owned = await h.post("/api/quote", { parts: [cncLine(partId)] }, buyer);
  const stranger = await h.post("/api/quote", { quoteId: owned.body.quoteId, parts: [cncLine(partId, 9)] });
  assert.notStrictEqual(stranger.body.quoteId, owned.body.quoteId);
  assert.strictEqual(models.quotesDB.getById(owned.body.quoteId).lineItems[0].quantity, 1, "the customer's quote is untouched");
});

test("new draft rows are limited per client and per account; re-pricing a quote that is open is not", async () => {
  const partId = await h.uploadCube();
  const saved = { ...process.env };
  process.env.QUOTE_NEW_PER_CLIENT_HOUR = "3";
  process.env.QUOTE_NEW_PER_ACCOUNT_HOUR = "2";
  require("../security/quoteGuards").resetForTests();
  try {
    h.ip = "203.0.113.30";
    const made = [];
    for (let i = 0; i < 3; i++) { const r = await h.post("/api/quote", { parts: [cncLine(partId)] }); assert.strictEqual(r.status, 200); made.push(r.body.quoteId); }
    assert.strictEqual(new Set(made).size, 3);
    const fourth = await h.post("/api/quote", { parts: [cncLine(partId)] });
    assert.strictEqual(fourth.status, 429);
    assert.strictEqual(fourth.body.code, "quote-limit");
    assert.ok(Number(fourth.headers.get("retry-after")) >= 60);
    assert.ok(/email|call/i.test(fourth.body.error) && !/row|database|limit of \d/i.test(fourth.body.error), fourth.body.error);
    // the buyer working on one of their quotes is not counted
    for (let i = 0; i < 5; i++) assert.strictEqual((await h.post("/api/quote", { quoteId: made[0], parts: [cncLine(partId, i + 2)] })).status, 200);
    // per account, whatever address it comes from
    h.ip = "";
    assert.strictEqual((await h.post("/api/quote", { parts: [cncLine(partId)] }, buyer)).status, 200);
    assert.strictEqual((await h.post("/api/quote", { parts: [cncLine(partId)] }, buyer)).status, 200);
    assert.strictEqual((await h.post("/api/quote", { parts: [cncLine(partId)] }, buyer)).body.code, "quote-limit");
  } finally {
    h.ip = "";
    for (const k of ["QUOTE_NEW_PER_CLIENT_HOUR", "QUOTE_NEW_PER_ACCOUNT_HOUR"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    require("../security/quoteGuards").resetForTests();
  }
});

test("a quote's lines are stored deflated: 100 lines that ALL DIFFER are about 15 kB (they were 282), and read back exactly", async () => {
  const partId = await h.uploadCube();
  // The worst case for storage, not the best: every line a different quantity, so no two lines are equal.
  const lines = Array.from({ length: 100 }, (_, i) => cncLine(partId, i + 1));
  const r = await h.post("/api/quote", { parts: lines }, buyer);
  assert.strictEqual(r.status, 200);
  const raw = models.quotesDB.table.getById(r.body.quoteId);
  const storedBytes = models.quotesDB.rowBytes(r.body.quoteId);
  assert.ok(JSON.stringify(r.body.lineItems).length > 250 * 1024, "the lines are a quarter of a megabyte of JSON");
  assert.ok(storedBytes < 32 * 1024, `the whole row takes ${storedBytes} bytes`);
  assert.strictEqual(raw.lineItems.$lines, 2);
  const back = models.quotesDB.getById(r.body.quoteId);
  assert.strictEqual(back.lineItems.length, 100);
  assert.deepStrictEqual(back.lineItems, JSON.parse(JSON.stringify(r.body.lineItems)), "what is read back is what was priced, line for line");
  assert.strictEqual(back.config.parts.length, 100, "the buyer's inputs read back too");
  assert.deepStrictEqual(back.config.parts.map((c) => c.quantity), lines.map((l) => l.quantity));
  assert.deepStrictEqual([raw.partCount, raw.totalUnits], [100, 5050], "the counts the admin list shows are stored with the quote");
  // beside the row: which parts it names and which client made it (a keyed hash, not the address)
  assert.strictEqual(raw.partIds, partId);
  assert.ok(/^[0-9a-f]{24}$/.test(raw.clientTag), raw.clientTag);
  // a line refers to its part; nothing of the part is copied into the quote
  assert.ok(!/"boundingBox"|"positions"|"checks"/.test(JSON.stringify(back)), "no geometry or DFM in the quote row");
  // mixed lines keep their order
  const mixed = [cncLine(partId, 1), cncLine(partId, 2), cncLine(partId, 1), cncLine(partId, 5), cncLine(partId, 2)];
  const m = await h.post("/api/quote", { parts: mixed }, buyer);
  assert.deepStrictEqual(models.quotesDB.getById(m.body.quoteId).lineItems.map((li) => li.quantity), [1, 2, 1, 5, 2]);
  // rows written before this — a plain array, and the pooled form of 2026-11-11 — read as they always did
  const line = back.lineItems[0];
  const plain = models.quotesDB.table.insert({ status: "draft", lineItems: [line, line], config: { parts: [lines[0], lines[0]] } });
  const pooled = models.quotesDB.table.insert({ status: "draft", lineItems: { $lines: 1, pool: [line], use: [0, 0, 0] }, config: { parts: [lines[0]] } });
  assert.deepStrictEqual(models.quotesDB.getById(plain.id).lineItems, [line, line]);
  assert.deepStrictEqual(models.quotesDB.getById(pooled.id).lineItems, [line, line, line]);
  assert.deepStrictEqual(models.quotesDB.meta().find((q) => q.id === pooled.id).partIds, [partId], "an older row's part ids are worked out once…");
  assert.strictEqual(models.quotesDB.table.getById(pooled.id).partIds, partId, "…and kept beside the row from then on");
  models.quotesDB.delete(plain.id); models.quotesDB.delete(pooled.id);
});

test("the admin's quote list is a list: totals and counts, capped, never every line of every quote", async () => {
  const list = await h.get("/api/admin/quotes", admin);
  assert.strictEqual(list.status, 200);
  assert.ok(list.body.length >= 5);
  const big = list.body.find((q) => q.partCount === 100);
  assert.ok(big && big.totalUnits === 5050 && big.orderTotal > 0 && !("lineItems" in big) && !("config" in big));
  assert.ok(list.text.length / list.body.length < 600, `${Math.round(list.text.length / list.body.length)} bytes per quote in the list`);
  assert.strictEqual((await h.get("/api/admin/quotes?limit=2", admin)).body.length, 2);
  assert.ok(Number(list.headers.get("x-total-count")) >= list.body.length);
  assert.strictEqual((await h.get("/api/admin/quotes", buyer)).status, 403);
});

/** Draft rows written straight into the table, as if `tag` (or the account `userId`) had made them through the quote tool. */
function insertDrafts(n, { tag = "", userId = null, bytesEach = 40000, createdAgoMs = 3 * MIN, touchedAgoMs = 0 } = {}) {
  const db = database.getDatabase();
  const lines = JSON.stringify({ $lines: 2, n: 1, z: crypto.randomBytes(Math.ceil(bytesEach * 0.74)).toString("base64") });
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = crypto.randomUUID();
    db.run("INSERT INTO quotes (id, user_id, client_tag, status, line_items_json, config_json, part_ids, created_at, updated_at, expires_at) VALUES (?, ?, ?, 'draft', ?, '{}', '', ?, ?, ?)",
      [id, userId, tag, lines, new Date(Date.now() - createdAgoMs - i).toISOString(), new Date(Date.now() - touchedAgoMs).toISOString(), new Date(Date.now() + 30 * DAY).toISOString()]);
    ids.push(id);
  }
  database.compact();
  return ids;
}
const draftsLeft = (where, arg) => database.getDatabase().exec(`SELECT COUNT(*) FROM quotes WHERE ${where}`, [arg])[0].values[0][0];

test("database nearly full: visitors without an account are asked to sign in first; customers, re-pricing, sign-in and checkout go on; the clean-up then takes from whoever holds the most, however busy they keep their rows", async () => {
  require("../security/quoteGuards").resetForTests();
  const partIds = [];
  for (let i = 0; i < 4; i++) partIds.push(await h.uploadCube());
  // (relaunch merge 2) The customer prices parts of their own: a part priced by a signed-in account becomes that
  // account's (security/partAccess.js), and the visitor's requests below would then be refused for that, not for the database.
  const custParts = [];
  for (let i = 0; i < 2; i++) { const up = await h.form("/api/upload", {}, { files: { name: "cube.stl", data: cubeFile } }, buyer); assert.strictEqual(up.status, 200, up.text.slice(0, 200)); custParts.push(up.body.parts[0].partId); }
  const mine = await h.post("/api/quote", { parts: [cncLine(partIds[0], 2)] });           // a real visitor's draft…
  const customers = await h.post("/api/quote", { parts: [cncLine(custParts[0], 4)] }, buyer); // …and a customer's saved quote
  assert.strictEqual(mine.status, 200);
  // The visitor priced it six hours ago and has not been back: by idle time theirs is the oldest row there is.
  database.getDatabase().run("UPDATE quotes SET created_at = ?, updated_at = ? WHERE id = ?", [new Date(Date.now() - 6 * HOUR).toISOString(), new Date(Date.now() - 6 * HOUR).toISOString(), mine.body.quoteId]);
  // The flood: six addresses and two accounts, every draft re-priced a moment ago (a script keeps
  // them fresh; that used to make them untouchable while the visitor's quote was deleted).
  const ceiling = 4;
  const holders = [...Array.from({ length: 6 }, (_, i) => ({ tag: `flood-${i}` })), { userId: "flood-account-a", tag: "flood-x" }, { userId: "flood-account-b", tag: "flood-y" }];
  let made = 0;
  while (dbMb() < ceiling * 0.9 && made < 400) { for (const who of holders) { insertDrafts(1, who); made++; } }
  assert.ok(dbMb() >= ceiling * 0.85 && dbMb() <= ceiling, `the flood took the database to ${dbMb().toFixed(2)} MB of ${ceiling} with ${made} drafts`);

  // While it is in that state:
  const refused = await h.post("/api/quote", { parts: [cncLine(partIds[1], 1)] });
  assert.deepStrictEqual([refused.status, refused.body.code], [503, "quotes-paused"]);
  assert.ok(/sign in/i.test(refused.body.error) && /email/i.test(refused.body.error), refused.body.error);
  const anonUpload = await h.form("/api/upload", {}, { files: { name: "cube.stl", data: cubeFile } });
  assert.deepStrictEqual([anonUpload.status, anonUpload.body.code], [503, "uploads-paused"], "a visitor without an account cannot add parts either");
  assert.strictEqual((await h.post("/api/quote", { quoteId: mine.body.quoteId, parts: [cncLine(partIds[0], 3)] })).status, 200, "a visitor can still change the quote they have open");
  const grow = await h.post("/api/quote", { quoteId: mine.body.quoteId, parts: Array.from({ length: 25 }, (_, i) => cncLine(partIds[i % 4], i + 1)) });
  assert.deepStrictEqual([grow.status, grow.body.code], [503, "quotes-paused"], "but not grow it from one line to twenty-five: a re-price that makes the row bigger is asked what a new row is asked");
  const custUpload = await h.form("/api/upload", {}, { files: { name: "cube.stl", data: cubeFile } }, buyer);
  assert.strictEqual(custUpload.status, 200, "a customer with a confirmed email still uploads");
  assert.strictEqual((await h.post("/api/quote", { parts: [cncLine(custParts[1], 1)] }, buyer)).status, 200, "and starts a new quote");
  assert.strictEqual(typeof (await h.login("customer@example.test")), "string", "sign-in works");
  const checkout = await h.post("/api/orders/checkout-session", { quoteId: customers.body.quoteId, shippingName: "A Buyer", shippingAddress: "1 Test St", shippingCity: "Elgin", shippingState: "IL", shippingZip: "60120" }, buyer);
  assert.strictEqual(checkout.status, 200, `checkout works: ${checkout.text.slice(0, 120)}`);
  assert.ok(models.ordersDB.getAll().some((o) => o.quoteId === customers.body.quoteId), "the order was written");

  // Recovery, with nobody doing anything: the pass that runs on a timer and after every refusal.
  const before = dbMb();
  const floodBefore = draftsLeft("client_tag LIKE ?", "flood-%");
  const quiet = console.warn; console.warn = () => {};
  let result;
  try { result = await pressure.relieveDatabase(models); } finally { console.warn = quiet; }
  const floodAfter = draftsLeft("client_tag LIKE ?", "flood-%");
  assert.ok(result && result.removedDrafts >= 10, `${result && result.removedDrafts} drafts removed`);
  assert.strictEqual(floodBefore - floodAfter, result.removedDrafts, "every one of them the flood's, although the flood's were the most recently touched rows in the database");
  assert.ok(draftsLeft("user_id = ?", "flood-account-a") < made / holders.length, "an account's drafts are not exempt: anyone with a mailbox has an account");
  // levelled: no flood sender is left holding much more than another
  // levelled from the top: the senders that lost rows are left holding the same, and none was emptied
  const left = holders.map((who) => (who.userId ? draftsLeft("user_id = ?", who.userId) : draftsLeft("client_tag = ?", who.tag)));
  const each = made / holders.length;
  // (relaunch merge 2) Rows are whole: taking each sender to the level frees a little more than was needed, so the
  // last sender reached may be cut only part of the way (storagePressure.js levelDown says so). The assertion used to
  // require that every sender that lost anything ended within one row of the others, which held only while the amount
  // to free happened to divide evenly; with the merged database a few rows larger it left "6 6 6 6 6 6 6 10". What is
  // held: all but at most two senders are at the same level, nobody was emptied, and nobody was left with more than they had.
  const lowest = Math.min(...left);
  const atLevel = left.filter((n) => n - lowest <= 1);
  assert.ok(atLevel.length >= holders.length - 2 && lowest >= 1 && lowest < each && Math.max(...left) <= each, `drafts left per flood sender (each had ${each}): ${left.join(" ")}`);
  assert.ok(models.quotesDB.getById(mine.body.quoteId), "the visitor's quote, idle for six hours, is still there");
  assert.strictEqual((await h.get(`/api/quote/${mine.body.quoteId}`)).status, 200);
  assert.ok(models.quotesDB.getById(customers.body.quoteId), "so is the customer's");
  assert.ok(dbMb() < ceiling * 0.8 && dbMb() < before, `database ${before.toFixed(2)} MB → ${dbMb().toFixed(2)} MB`);
  assert.ok(result.longestPieceMs < 150, `the longest piece of the pass held the thread ${result.longestPieceMs} ms (load ${require("os").loadavg()[0].toFixed(1)})`);
  const anonAgain = await h.post("/api/quote", { parts: [cncLine(partIds[2], 1)] });
  assert.strictEqual(anonAgain.status, 200, "visitors without an account can start quotes again");
  assert.strictEqual((await h.form("/api/upload", {}, { files: { name: "cube.stl", data: cubeFile } })).status, 200, "and upload again");
  assert.strictEqual(pressure.status().database.lastRelief.removedDrafts, result.removedDrafts);

  // A pass that finds nothing it may remove is not run again at every new row (it used to be, and held the thread seconds each time).
  database.getDatabase().run("DELETE FROM quotes WHERE client_tag LIKE 'flood-%'"); database.compact();
  let looked = 0;
  const realRefs = require("./rowRetention").references;
  require("./rowRetention").references = (...args) => { looked++; return realRefs(...args); };
  try {
    assert.strictEqual((await pressure.relieveDatabase(models, { force: true })).removedDrafts, 0);
    pressure.state.databaseQuietUntil = Date.now() + 5 * MIN;
    process.env.DB_SWEEP_PERCENT = "20"; // "over the line" for the sake of the check
    const n = looked;
    assert.strictEqual(await pressure.relieveDatabase(models), null);
    assert.strictEqual(looked, n, "nothing was read for it");
  } finally { require("./rowRetention").references = realRefs; delete process.env.DB_SWEEP_PERCENT; pressure.state.databaseQuietUntil = 0; }
});

test("admin: 'clear old drafts' deletes idle no-account drafts and nothing else", async () => {
  require("../security/quoteGuards").resetForTests();
  const partId = await h.uploadCube();
  const idle = await h.post("/api/quote", { parts: [cncLine(partId, 7)] });
  const fresh = await h.post("/api/quote", { parts: [cncLine(partId, 8)] });
  const sent = await h.post("/api/quote", { parts: [cncLine(partId, 10)] });
  // (relaunch merge 2: the customer comes after the visitor's last request; pricing the part signed in makes it the customer's.)
  const customers = await h.post("/api/quote", { parts: [cncLine(partId, 9)] }, buyer);
  const rfq = await h.form("/api/rfq", { quoteId: sent.body.quoteId, contactName: "Lead", email: "lead@example.test", notes: "quote please" });
  assert.strictEqual(rfq.status, 201, rfq.text);
  // age the idle one by three days
  models.quotesDB.table.update(idle.body.quoteId, {});
  require("../models/database").getDatabase().run("UPDATE quotes SET updated_at = ?, created_at = ? WHERE id = ?", [new Date(Date.now() - 3 * DAY).toISOString(), new Date(Date.now() - 3 * DAY).toISOString(), idle.body.quoteId]);
  assert.strictEqual((await h.post("/api/admin/drafts/purge", { olderThanHours: 48 }, buyer)).status, 403, "admin only");
  assert.strictEqual((await h.post("/api/admin/drafts/purge", { olderThanHours: "soon" }, admin)).status, 400);
  const r = await h.post("/api/admin/drafts/purge", { olderThanHours: 48 }, admin);
  assert.strictEqual(r.status, 200, r.text);
  assert.ok(r.body.removedDrafts >= 1);
  assert.strictEqual(models.quotesDB.getById(idle.body.quoteId), null, "the idle no-account draft is gone");
  for (const [what, id] of [["a fresh draft", fresh.body.quoteId], ["a customer's quote", customers.body.quoteId], ["a quote that became a request", sent.body.quoteId]]) {
    assert.ok(models.quotesDB.getById(id), `${what} is kept`);
  }
});

test("L6: uploads that are never quoted fill the database with part rows — the relief pass lets those go, the busiest network first; parts on a quote stay", async () => {
  const quiet = console.warn; console.warn = () => {};
  const ceiling = 8; // MB, for this test: room for a flood that is larger than what has to be cleared
  process.env.DB_MAX_MB = String(ceiling);
  try {
    const db = database.getDatabase();
    const tenMinutesAgo = new Date(Date.now() - 10 * MIN).toISOString();
    const quoted = await h.uploadCube();
    const q = await h.post("/api/quote", { parts: [cncLine(quoted, 1)] }, buyer);
    assert.strictEqual(q.status, 200, q.text);
    const waiting = await h.uploadCube(); // a visitor's part they have not chosen a material for yet
    db.run("UPDATE parts SET created_at = ?, client_tag = ? WHERE id IN (?, ?)", [tenMinutesAgo, "a-visitor", quoted, waiting]);
    // The flood: small files, each leaving a 40 kB row (what a 4 kB DXF with 150 holes left), none ever priced.
    const geometry = JSON.stringify({ boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 } }, is2D: true, filler: "x".repeat(40000) });
    let flood = 0;
    while (dbMb() < ceiling * 0.9 && flood < 400) {
      for (let i = 0; i < 10; i++, flood++) db.run("INSERT INTO parts (id, file_name, stored_name, file_size, geometry_json, dfm_json, created_at, client_tag) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [crypto.randomUUID(), "plate.dxf", `${crypto.randomUUID()}.dxf`, 4400, geometry, "{}", tenMinutesAgo, "a-script"]);
      database.compact();
    }
    assert.ok(dbMb() >= ceiling * 0.85, `the flood took the database to ${dbMb().toFixed(2)} MB of ${ceiling} with ${flood} unquoted parts`);
    assert.strictEqual(guards.database.hasRoom({ reserved: false }), false, "visitors without an account are being turned away");
    const before = dbMb();
    const result = await pressure.relieveDatabase(models);
    const left = db.exec("SELECT COUNT(*) FROM parts WHERE client_tag = 'a-script'")[0].values[0][0];
    assert.ok(result.removedParts >= 20 && left > 0 && left === flood - result.removedParts, `${result.removedParts} of the ${flood} unquoted parts removed, all of them the script's (${left} left)`);
    assert.ok(dbMb() < ceiling * 0.8 && dbMb() < before, `database ${before.toFixed(2)} MB → ${dbMb().toFixed(2)} MB`);
    assert.strictEqual(guards.database.hasRoom({ reserved: false }), true, "and visitors can upload again");
    assert.ok(models.partsDB.getRow(quoted), "a part on a customer's quote is never touched");
    assert.ok(models.partsDB.getRow(waiting), "the one part a visitor has not priced yet outlives the script's hundreds");
    assert.ok(models.quotesDB.getById(q.body.quoteId), "and so does the quote");
    db.run("DELETE FROM parts WHERE client_tag = 'a-script'"); database.compact();
  } finally { console.warn = quiet; process.env.DB_MAX_MB = "4"; }
});

// ─── H5: retention keeps what can still be ordered ───────────

test("a file on a saved quote that can still be ordered is never swept; when one is missing, the request form asks for it again", async () => {
  const { neededUploads, partFilesPresent, sweepOnce } = require("./fileRetention");
  const upload = async (token) => { const r = await h.form("/api/upload", {}, { files: { name: "bracket.stl", data: cubeFile } }, token); return r.body.parts[0].partId; };
  const mineId = await upload(buyer);
  const anonId = await upload();
  const looseId = await upload();
  const mineQuote = await h.post("/api/quote", { parts: [cncLine(mineId)] }, buyer);
  const anonQuote = await h.post("/api/quote", { parts: [cncLine(anonId)] });
  const nameOf = (id) => models.partsDB.getRow(id).storedName;
  // Eight days pass for the files (the quotes are inside their hold).
  const old = new Date(Date.now() - 8 * DAY);
  for (const id of [mineId, anonId, looseId]) fs.utimesSync(path.join(uploadsDir(), nameOf(id)), old, old);
  const keep = neededUploads(models);
  assert.ok(keep.has(nameOf(mineId)) && keep.has(nameOf(anonId)), "files behind live quotes are on the keep list");
  assert.ok(!keep.has(nameOf(looseId)));
  sweepOnce(uploadsDir(), 7 * DAY, keep);
  assert.ok(fs.existsSync(path.join(uploadsDir(), nameOf(mineId))), "the customer's quote can still be ordered, so its CAD file is still here on day 8");
  assert.ok(fs.existsSync(path.join(uploadsDir(), nameOf(anonId))));
  assert.ok(!fs.existsSync(path.join(uploadsDir(), nameOf(looseId))), "an upload nothing refers to still goes after the window");
  assert.deepStrictEqual(partFilesPresent([mineId, anonId]), { ok: true, missing: [] });

  // The no-account draft nobody reopened lapses at 48 hours; then its file is no longer kept.
  const later = require("./rowRetention").references(models, { now: Date.now() + 49 * HOUR });
  assert.ok(later.expiredQuotes.includes(anonQuote.body.quoteId));
  assert.ok(!later.expiredQuotes.includes(mineQuote.body.quoteId), "the customer's quote keeps its 30-day hold");
  assert.ok(later.partsProtected.has(mineId) && !later.partsProtected.has(anonId));

  // A file that is gone anyway (lost with a volume, deleted by hand): no order or request is taken without it.
  fs.unlinkSync(path.join(uploadsDir(), nameOf(mineId)));
  const check = partFilesPresent([mineId, anonId]);
  assert.strictEqual(check.ok, false);
  assert.deepStrictEqual(check.missing, [{ partId: mineId, fileName: "bracket.stl" }]);
  assert.strictEqual(check.code, "part-file-missing");
  assert.ok(/upload the file again/i.test(check.message) && /bracket\.stl/.test(check.message), check.message);
  const rfq = await h.form("/api/rfq", { quoteId: mineQuote.body.quoteId, contactName: "Buyer", email: "customer@example.test", notes: "500 of these" }, {}, buyer);
  assert.strictEqual(rfq.status, 409, rfq.text);
  assert.strictEqual(rfq.body.code, "part-file-missing");
  assert.strictEqual(models.rfqsDB.getAll().filter((r) => r.quoteId === mineQuote.body.quoteId).length, 0, "no request without its file");
});

// ─── H4: the file folders ────────────────────────────────────

test("files nearly full, every sender holding the same: the oldest uploads nothing refers to go first, then those only a no-account draft refers to; orders, open requests and customers' quotes inside their protected share are not touched", async () => {
  require("../security/quoteGuards").resetForTests();
  // Start from empty folders (earlier tests left small files and their rows behind; those rows are minutes old and are not candidates).
  for (const dir of guards.STORAGE_DIRS) if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  guards.storage.invalidate();
  const mat = models.materialsDB.getAll().find((m) => m.process === "cnc" && m.active);
  const line = (id) => ({ partId: id, materialSlug: mat.slug, quantity: 1, process: "cnc", subProcess: "milling" });
  // 10 MB ceiling. Nine 1 MB uploads, oldest first:
  const loose1 = await storedPart(MB, 10 * HOUR);
  const loose2 = await storedPart(MB, 9 * HOUR);
  const onOrder = await storedPart(MB, 8 * HOUR);
  const onRequest = await storedPart(MB, 7 * HOUR);
  const onCustomerQuote = await storedPart(MB, 6 * HOUR);
  const onAnonDraft = await storedPart(MB, 5 * HOUR);
  const onReopenedDraft = await storedPart(MB, 4 * HOUR);
  const looseNew = await storedPart(MB, 1 * MIN);       // just uploaded: someone is still choosing a material
  const onFreshDraft = await storedPart(MB, 3 * HOUR);
  const order = models.ordersDB.insert({ userId: "u1", status: "paid", total: 10 });
  models.orderItemsDB.insert({ orderId: order.id, partId: onOrder.id, fileName: "a.stl", quantity: 1 });
  models.rfqsDB.insert({ status: "new", contactName: "x", email: "x@example.test", parts: [{ partId: onRequest.id }] });
  assert.strictEqual((await h.post("/api/quote", { parts: [line(onCustomerQuote.id)] }, buyer)).status, 200);
  const anonDraft = await h.post("/api/quote", { parts: [line(onAnonDraft.id)] });
  const reopened = await h.post("/api/quote", { parts: [line(onReopenedDraft.id)] });
  assert.strictEqual((await h.get(`/api/quote/${reopened.body.quoteId}`)).status, 200); // the visitor came back to it
  const freshDraft = await h.post("/api/quote", { parts: [line(onFreshDraft.id)] });
  // the two older drafts were last touched hours ago
  const db = require("../models/database").getDatabase();
  db.run("UPDATE quotes SET updated_at = ?, created_at = ? WHERE id = ?", [new Date(Date.now() - 5 * HOUR).toISOString(), new Date(Date.now() - 5 * HOUR).toISOString(), anonDraft.body.quoteId]);
  guards.storage.invalidate();
  const used = guards.storage.scan();
  assert.ok(used >= 9 * MB && used < 10 * MB, `${(used / MB).toFixed(1)} MB of 10 stored`);

  // In this state a visitor without an account is turned away up front, in words; a customer is not.
  const anon = await h.form("/api/upload", {}, { files: { name: "cube.stl", data: cubeFile } });
  assert.deepStrictEqual([anon.status, anon.body.code], [503, "uploads-paused"]);
  assert.ok(/sign in/i.test(anon.body.error) && /email/i.test(anon.body.error), anon.body.error);
  const cust = await h.form("/api/upload", {}, { files: { name: "cube.stl", data: cubeFile } }, buyer);
  assert.strictEqual(cust.status, 200, "the reserved share: a customer with a confirmed email still uploads");

  const quiet = console.warn; console.warn = () => {};
  let r;
  try { r = await pressure.relieveStorage(models); } finally { console.warn = quiet; }
  assert.ok(r && r.removedUploads >= 2, JSON.stringify(r));
  assert.ok(r.bytesAfter <= 10 * MB * 0.66, `back under the line with a margin: ${(r.bytesAfter / MB).toFixed(1)} MB`);
  // first the uploads nothing refers to, oldest first …
  assert.ok(!onDisk(loose1) && !onDisk(loose2) && models.partsDB.getRow(loose1.id) === null, "unreferenced uploads went, rows and all");
  // … then the one only an idle no-account draft referred to, with that draft
  assert.ok(!onDisk(onAnonDraft));
  assert.strictEqual(models.quotesDB.getById(anonDraft.body.quoteId), null, "its draft went with it");
  assert.strictEqual(r.removedDrafts, 1);
  // never:
  for (const [what, p] of [["a part on an order", onOrder], ["a part on an open request", onRequest], ["a part on a customer's saved quote", onCustomerQuote], ["a part on a draft its visitor came back to", onReopenedDraft], ["an upload from two minutes ago", looseNew]]) {
    assert.ok(onDisk(p) && models.partsDB.getRow(p.id), `${what} is untouched`);
  }
  assert.ok(models.quotesDB.getById(freshDraft.body.quoteId) && onDisk(onFreshDraft), "a draft touched a moment ago is left alone while older things can go");
  // and the door is open again for everyone
  assert.strictEqual((await h.form("/api/upload", {}, { files: { name: "cube.stl", data: cubeFile } })).status, 200);
});

test("bytes stored per client are capped, not just bytes sent per day", async () => {
  const saved = process.env.UPLOAD_STORED_MB_PER_IP;
  process.env.UPLOAD_STORED_MB_PER_IP = "1";
  h.ip = "203.0.113.44";
  try {
    const { solidStl } = require("../testSupport/zip");
    const first = await h.form("/api/upload", {}, { files: { name: "a.stl", data: solidStl(32) } }); // 600 kB, plus its preview: over 1 MB kept
    assert.strictEqual(first.status, 200, first.text.slice(0, 200));
    assert.ok(guards.storedBytesFor("203.0.113.44") > MB);
    const second = await h.form("/api/upload", {}, { files: { name: "b.stl", data: cubeFile } });
    assert.strictEqual(second.status, 429);
    assert.strictEqual(second.body.code, "stored-limit");
    assert.ok(/email/i.test(second.body.error) && /1 MB/.test(second.body.error), second.body.error);
    h.ip = "203.0.113.45";
    assert.strictEqual((await h.form("/api/upload", {}, { files: { name: "b.stl", data: cubeFile } })).status, 200, "another client is not affected");
    // the address itself is not what is stored
    assert.ok(!JSON.stringify(models.partsDB.table.getAll().map((p) => p.clientTag)).includes("203.0.113"), "a keyed hash, never the address");
  } finally { h.ip = ""; if (saved === undefined) delete process.env.UPLOAD_STORED_MB_PER_IP; else process.env.UPLOAD_STORED_MB_PER_IP = saved; }
});

test("requests: the attachment of a closed request is deleted after the grace period; an open one never; the admin can delete a request and its file", async () => {
  const pdf = Buffer.from("%PDF-1.4\n% drawing\n%%EOF\n");
  const rfqDir = path.join(dataDir, "rfq-drawings");
  const make = async (email) => {
    const r = await h.form("/api/rfq", { contactName: "Lead", email, notes: `request from ${email}` }, { drawing: { name: "print.pdf", data: pdf } });
    assert.strictEqual(r.status, 201, r.text);
    return models.rfqsDB.getById(r.body.rfqId);
  };
  const declined = await make("declined@example.test");
  const open = await make("open@example.test");
  const junk = await make("junk@example.test");
  assert.strictEqual(declined.drawingBytes, pdf.length);
  assert.strictEqual((await h.put(`/api/rfq/admin/${declined.id}`, { status: "declined" }, admin)).status, 200);
  const has = (r) => fs.existsSync(models.rfqsDB.getById(r.id)?.drawingPath || path.join(rfqDir, "none"));
  // inside the grace period: kept
  pressure.sweepClosedRequestAttachments(models);
  assert.ok(has(declined) && has(open));
  // fifteen days on
  const log = console.log; console.log = () => {};
  let swept;
  try { swept = pressure.sweepClosedRequestAttachments(models, { now: Date.now() + 15 * DAY }); } finally { console.log = log; }
  assert.strictEqual(swept.removed, 1);
  assert.ok(!fs.existsSync(declined.drawingPath), "the declined request's attachment is off the disk");
  const row = models.rfqsDB.getById(declined.id);
  assert.ok(row && row.drawingPath === "" && row.attachmentRemovedAt, "the request itself stays, marked");
  assert.ok(has(open), "an open request keeps its attachment however old");

  // The admin's delete.
  assert.strictEqual((await h.del(`/api/admin/requests/${junk.id}`, buyer)).status, 403);
  assert.strictEqual((await h.del("/api/admin/requests/not-an-id", admin)).status, 404);
  const del = await h.del(`/api/admin/requests/${junk.id}`, admin);
  assert.deepStrictEqual([del.status, del.body], [200, { deleted: true, attachmentRemoved: true }]);
  assert.strictEqual(models.rfqsDB.getById(junk.id), null);
  assert.ok(!fs.existsSync(junk.drawingPath));
  assert.strictEqual((await h.del(`/api/admin/requests/${junk.id}`, admin)).status, 404);
  // only the attachment
  const only = await h.del(`/api/admin/requests/${open.id}/attachment`, admin);
  assert.deepStrictEqual(only.body, { deleted: true, attachmentRemoved: true });
  assert.ok(models.rfqsDB.getById(open.id) && !fs.existsSync(open.drawingPath));
  // a request that became an order is the order's record
  const won = await make("won@example.test");
  models.rfqsDB.update(won.id, { orderId: "some-order" });
  const refused = await h.del(`/api/admin/requests/${won.id}`, admin);
  assert.deepStrictEqual([refused.status, refused.body.code], [409, "request-has-order"]);
  // Every one of those actions is in the admin change log, by the request's short reference and with nothing the customer typed.
  const changeLog = (await h.get("/api/admin/audit", admin)).body;
  const entries = changeLog.filter((e) => e.area === "request" || e.action === "purge-drafts");
  const ref = (id) => String(id).slice(0, 8).toUpperCase();
  assert.ok(entries.some((e) => e.area === "request" && e.action === "delete" && e.target === ref(junk.id)), JSON.stringify(entries).slice(0, 400));
  assert.ok(entries.some((e) => e.area === "request" && e.action === "delete-attachment" && e.target === ref(open.id)));
  assert.ok(entries.some((e) => e.area === "quotes" && e.action === "purge-drafts"), "and so is 'clear old drafts' (the case above)");
  assert.ok(!entries.some((e) => e.target === ref(won.id)), "a refused delete writes nothing");
  assert.ok(!/example\.test|won@|junk/i.test(JSON.stringify(entries.map((e) => [e.target, e.changes, e.note]))), "no name, address or note of a customer is in the log");
  // The same protection as every admin route: a session cookie without that session's CSRF token changes nothing…
  const signIn = await h.raw("POST", "/api/auth/login", { json: { email: "customer@example.test", password: h.password }, browser: true });
  const cookie = (signIn.headers.get("set-cookie") || "").split(";")[0];
  assert.ok(cookie, "a browser session");
  for (const [method, url] of [["POST", "/api/admin/drafts/purge"], ["DELETE", `/api/admin/requests/${won.id}`], ["DELETE", `/api/admin/requests/${won.id}/attachment`]]) {
    const noToken = await h.raw(method, url, { json: method === "POST" ? { olderThanHours: 0 } : undefined, headers: { Cookie: cookie }, browser: true });
    assert.deepStrictEqual([noToken.status, noToken.body.code], [403, "csrf"], `${method} ${url} from a cookie session without its token`);
  }
  // …and an admin who has not turned on two-step sign-in gets nothing either (routes/authorization.test.js walks every admin route for that).
  assert.strictEqual((await h.get("/api/admin/storage")).status, 401, "no session");
  assert.strictEqual((await h.get("/api/admin/storage", buyer)).status, 403, "a customer");
  // the status figures the admin (and the deploy status page) can read
  const status = await h.get("/api/admin/storage", admin);
  assert.strictEqual(status.status, 200);
  assert.ok(status.body.database.maxBytes === 4 * MB && status.body.files.maxBytes === 10 * MB && status.body.mail.unconfirmed.capPerHour > 0);
});

test("an upload left on disk with no part row (the process died mid-parse) is swept after a few minutes; one being read now is not", async () => {
  const orphanOld = path.join(uploadsDir(), `${crypto.randomUUID()}.dxf`);
  const orphanNew = path.join(uploadsDir(), `${crypto.randomUUID()}.step`);
  fs.writeFileSync(orphanOld, "0\nSECTION\n");
  fs.writeFileSync(orphanNew, "ISO-10303-21;");
  const sixteenMinutesAgo = new Date(Date.now() - 16 * MIN);
  fs.utimesSync(orphanOld, sixteenMinutesAgo, sixteenMinutesAgo);
  const kept = models.partsDB.table.getAll().map((p) => p.storedName).filter(Boolean).length;
  const log = console.log; console.log = () => {};
  let r;
  try { r = pressure.sweepOrphanUploads(models); } finally { console.log = log; }
  assert.strictEqual(r.removed, 1);
  assert.ok(!fs.existsSync(orphanOld) && fs.existsSync(orphanNew));
  assert.strictEqual(models.partsDB.table.getAll().map((p) => p.storedName).filter(Boolean).length, kept, "no part lost its file");
  for (const p of models.partsDB.table.getAll()) if (p.storedName && fs.existsSync(path.join(uploadsDir(), p.storedName))) assert.ok(true);
  fs.unlinkSync(orphanNew);
});

run(async () => { if (h) await h.stop(); process.exit(process.exitCode || 0); });
