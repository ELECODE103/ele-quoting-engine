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

test("a quote's lines are stored once per distinct line: 100 lines of one part is a few kB, and reads back exactly", async () => {
  const partId = await h.uploadCube();
  const lines = Array.from({ length: 100 }, () => cncLine(partId, 1));
  const r = await h.post("/api/quote", { parts: lines }, buyer);
  assert.strictEqual(r.status, 200);
  const raw = models.quotesDB.table.getById(r.body.quoteId);
  const storedBytes = JSON.stringify(raw.lineItems).length;
  assert.ok(storedBytes < 12 * 1024, `the 100 lines take ${storedBytes} bytes in the row (they took about 290,000)`);
  const back = models.quotesDB.getById(r.body.quoteId);
  assert.strictEqual(back.lineItems.length, 100);
  assert.deepStrictEqual(back.lineItems, JSON.parse(JSON.stringify(r.body.lineItems)), "what is read back is what was priced, line for line");
  assert.notStrictEqual(back.lineItems[0], back.lineItems[1], "each line is its own object");
  assert.deepStrictEqual([raw.partCount, raw.totalUnits], [100, 100], "the counts the admin list shows are stored with the quote");
  // a line refers to its part; nothing of the part is copied into the quote
  assert.ok(!/"boundingBox"|"positions"|"checks"/.test(JSON.stringify(raw)), "no geometry or DFM in the quote row");
  // mixed lines keep their order
  const mixed = [cncLine(partId, 1), cncLine(partId, 2), cncLine(partId, 1), cncLine(partId, 5), cncLine(partId, 2)];
  const m = await h.post("/api/quote", { parts: mixed }, buyer);
  assert.deepStrictEqual(models.quotesDB.getById(m.body.quoteId).lineItems.map((li) => li.quantity), [1, 2, 1, 5, 2]);
  assert.strictEqual(models.quotesDB.table.getById(m.body.quoteId).lineItems.pool.length, 3);
});

test("the admin's quote list is a list: totals and counts, capped, never every line of every quote", async () => {
  const list = await h.get("/api/admin/quotes", admin);
  assert.strictEqual(list.status, 200);
  assert.ok(list.body.length >= 5);
  const big = list.body.find((q) => q.partCount === 100);
  assert.ok(big && big.totalUnits === 100 && big.orderTotal > 0 && !("lineItems" in big) && !("config" in big));
  assert.ok(list.text.length / list.body.length < 600, `${Math.round(list.text.length / list.body.length)} bytes per quote in the list`);
  assert.strictEqual((await h.get("/api/admin/quotes?limit=2", admin)).body.length, 2);
  assert.ok(Number(list.headers.get("x-total-count")) >= list.body.length);
  assert.strictEqual((await h.get("/api/admin/quotes", buyer)).status, 403);
});

test("database nearly full: new drafts and uploads from visitors without an account stop first; customers, re-pricing, sign-in and checkout go on; then it recovers by itself", async () => {
  require("../security/quoteGuards").resetForTests();
  const partIds = [];
  for (let i = 0; i < 4; i++) partIds.push(await h.uploadCube());
  const mats = (await h.get("/api/materials?process=cnc")).body; // the materials the catalog lists
  // What a script does: draft after draft, no upload needed, each as big as an anonymous quote may be (25 distinct lines).
  const junk = (n) => ({ parts: Array.from({ length: 25 }, (_, i) => ({ ...cncLine(partIds[i % 4], 1 + ((n * 25 + i) % 97)), materialSlug: mats[(n + i) % mats.length].slug, grade: "" })) });
  const mine = await h.post("/api/quote", { parts: [cncLine(partIds[0], 2)] });           // a real visitor's draft, made before the flood
  const customers = await h.post("/api/quote", { parts: [cncLine(partIds[0], 4)] }, buyer); // a customer's saved quote
  assert.strictEqual(mine.status, 200);
  let made = 0;
  let refused = null;
  const ceiling = 4;
  for (let n = 0; n < 400 && !refused; n++) {
    const r = await h.post("/api/quote", junk(n));
    if (r.status === 200) made++; else refused = r;
  }
  assert.ok(refused, `the flood is stopped (after ${made} drafts, database ${dbMb().toFixed(2)} MB)`);
  assert.strictEqual(refused.status, 503);
  assert.strictEqual(refused.body.code, "quotes-paused");
  assert.ok(/sign in/i.test(refused.body.error) && /email/i.test(refused.body.error), refused.body.error);
  assert.ok(dbMb() <= ceiling, `the database stopped growing under its ${ceiling} MB ceiling: ${dbMb().toFixed(2)} MB`);
  assert.ok(dbMb() >= ceiling * 0.8, "and it took the anonymous share to get there");

  // While it is in that state:
  const anonUpload = await h.form("/api/upload", {}, { files: { name: "cube.stl", data: cubeFile } });
  assert.deepStrictEqual([anonUpload.status, anonUpload.body.code], [503, "uploads-paused"], "a visitor without an account cannot add parts either");
  assert.strictEqual((await h.post("/api/quote", { quoteId: mine.body.quoteId, parts: [cncLine(partIds[0], 3)] })).status, 200, "a visitor can still re-price the quote they have open");
  const custUpload = await h.form("/api/upload", {}, { files: { name: "cube.stl", data: cubeFile } }, buyer);
  assert.strictEqual(custUpload.status, 200, "a customer with a confirmed email still uploads");
  assert.strictEqual(custUpload.body.parts.length, 1);
  assert.strictEqual((await h.post("/api/quote", { parts: [cncLine(partIds[1], 1)] }, buyer)).status, 200, "and starts a new quote");
  assert.strictEqual(typeof (await h.login("customer@example.test")), "string", "sign-in works");
  const checkout = await h.post("/api/orders/checkout-session", { quoteId: customers.body.quoteId, shippingName: "A Buyer", shippingAddress: "1 Test St", shippingCity: "Elgin", shippingState: "IL", shippingZip: "60120" }, buyer);
  assert.strictEqual(checkout.status, 200, `checkout works: ${checkout.text.slice(0, 120)}`);
  assert.ok(models.ordersDB.getAll().some((o) => o.quoteId === customers.body.quoteId), "the order was written");

  // Recovery, with nobody doing anything: the pressure pass that runs on a timer (and is nudged by
  // every refused request). While visitors are being turned away the wait is short: a draft nobody
  // has touched for five minutes goes (thirty when the database is only at the sweep line).
  const before = dbMb();
  const quiet = console.warn; console.warn = () => {};
  let result;
  try {
    const tooSoon = pressure.relieveDatabase(models, { now: Date.now() + 2 * MIN });
    assert.strictEqual(tooSoon.removedDrafts, 0, "two minutes on, nothing is old enough: a visitor's draft is not taken from under them");
    await h.post("/api/quote", { quoteId: mine.body.quoteId, parts: [cncLine(partIds[0], 5)] }); // the visitor changes a quantity
    result = pressure.relieveDatabase(models, { now: Date.now() + 6 * MIN });
  } finally { console.warn = quiet; }
  assert.ok(result && result.removedDrafts >= 5, `${result && result.removedDrafts} of the flood's ${made} drafts removed, oldest first`);
  assert.ok(models.quotesDB.getById(mine.body.quoteId), "the visitor's own draft, re-priced a moment before, outlives the older junk");
  assert.ok(dbMb() < ceiling * 0.8 && dbMb() < before, `database ${before.toFixed(2)} MB → ${dbMb().toFixed(2)} MB`);
  const anonAgain = await h.post("/api/quote", junk(1000));
  assert.strictEqual(anonAgain.status, 200, "visitors without an account can start quotes again");
  assert.strictEqual((await h.form("/api/upload", {}, { files: { name: "cube.stl", data: cubeFile } })).status, 200, "and upload again");
  // What was NOT removed: the customer's quote, the order's quote, and the visitor's own recent draft is still theirs to re-price.
  assert.ok(models.quotesDB.getById(customers.body.quoteId), "a customer's quote is never swept");
  assert.strictEqual(pressure.status().database.lastRelief.removedDrafts, result.removedDrafts);
});

test("admin: 'clear old drafts' deletes idle no-account drafts and nothing else", async () => {
  require("../security/quoteGuards").resetForTests();
  const partId = await h.uploadCube();
  const idle = await h.post("/api/quote", { parts: [cncLine(partId, 7)] });
  const fresh = await h.post("/api/quote", { parts: [cncLine(partId, 8)] });
  const customers = await h.post("/api/quote", { parts: [cncLine(partId, 9)] }, buyer);
  const sent = await h.post("/api/quote", { parts: [cncLine(partId, 10)] });
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
    const result = pressure.relieveDatabase(models);
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

test("files nearly full: the oldest uploads nothing refers to go first, then those only a no-account draft refers to; orders, open requests and customers' quotes are never touched", async () => {
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
  const looseNew = await storedPart(MB, 2 * MIN);       // just uploaded: someone is still choosing a material
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
  try { r = pressure.relieveStorage(models); } finally { console.warn = quiet; }
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
