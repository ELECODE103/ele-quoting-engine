/**
 * Data layer and request bodies: SQL is parameterised, identifiers cannot come
 * from a request, and a JSON body cannot assign fields it was not meant to.
 * Run: node server/security/dataLayer.test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "se-data-"));
process.env.QUOTING_DATA_DIR = dataDir; // uploads of this suite stay out of the repo's data folder
const { start, runner } = require("../testSupport/harness");
const { test, run } = runner("Data layer and request bodies");

let h, admin, buyer;
const root = path.join(__dirname, "..", "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const silently = (fn) => { const { error } = console; const lines = []; console.error = (...a) => lines.push(a.join(" ")); try { return { result: fn(), lines }; } finally { console.error = error; } };

test("every SQL statement is built from bound parameters; only vetted identifiers are interpolated", async () => {
  h = await start();
  const src = read("server/models/SqliteDB.js");
  const statements = [...src.matchAll(/`((?:SELECT|INSERT|UPDATE|DELETE|PRAGMA)[^`]*)`/g)].map((m) => m[1]);
  assert.ok(statements.length >= 6, `found ${statements.length} statements`);
  const allowed = new Set(["this.tableName", 'columns.join(", ")', "placeholders", "setClauses"]);
  for (const sql of statements) {
    for (const m of sql.matchAll(/\$\{([^}]+)\}/g)) assert.ok(allowed.has(m[1].trim()), `statement interpolates ${m[1]}: ${sql}`);
  }
  // The column migrations (server/models/accountMigration.js, partPayloadMigration.js) name tables and
  // columns from their own constant lists, vetted against an identifier pattern before use.
  for (const file of fs.readdirSync(path.join(root, "server", "models")).filter((f) => /Migration\.js$/.test(f))) {
    const m = read(`server/models/${file}`);
    const ddl = [...m.matchAll(/`((?:SELECT|INSERT|UPDATE|DELETE|PRAGMA|ALTER)[^`]*)`/g)].map((x) => x[1]);
    for (const sql of ddl) {
      for (const x of sql.matchAll(/\$\{([^}]+)\}/g)) assert.ok(["table", "name", "type"].includes(x[1].trim()), `${file} interpolates ${x[1]}: ${sql}`);
    }
    if (ddl.some((sql) => /\$\{/.test(sql))) assert.ok(/function vetted\(/.test(m) && /vetted\(table/.test(m), `${file} checks its identifiers before interpolating them`);
  }
  const ran = [];
  const fakeDb = { prepare: () => ({ step: () => false, free() {} }), run: (sql) => ran.push(sql), getRowsModified: () => 0 };
  assert.throws(() => require("../models/accountMigration").apply(fakeDb, { users: [["x; DROP TABLE users", "TEXT"]] }), /not a plain identifier/);
  assert.throws(() => require("../models/accountMigration").apply(fakeDb, { users: [["fine_name", "TEXT; DROP TABLE users"]] }), /not a plain identifier/);
  assert.deepStrictEqual(ran, [], "nothing was run for a name or type that is not a plain identifier");
  // values never appear in the text: every write uses placeholders
  assert.ok(/const placeholders = columns\.map\(\(\) => "\?"\)/.test(src) && /`\$\{col\} = \?`/.test(src));
  // nothing outside the model layer talks to the database handle
  const offenders = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "fixtures") walk(p); continue; }
      if (!e.name.endsWith(".js") || e.name.endsWith(".test.js") || p.includes(`${path.sep}models${path.sep}`)) continue;
      if (/getDatabase\(\)|\.prepare\(|dbInstance|\bdb\.(run|exec)\(/.test(fs.readFileSync(p, "utf8"))) offenders.push(path.relative(root, p));
    }
  })(path.join(root, "server"));
  assert.deepStrictEqual(offenders, [], "raw SQL outside server/models");
});

test("delete says whether it deleted (it used to answer false for a row it had just removed)", async () => {
  const { leadTimesDB, materialsDB } = h.models;
  const row = leadTimesDB.insert({ slug: "delete-me", name: "Delete me", multiplier: 1, active: false });
  assert.strictEqual(leadTimesDB.delete(row.id), true, "a row that was there");
  assert.strictEqual(leadTimesDB.getById(row.id), null);
  assert.strictEqual(leadTimesDB.delete(row.id), false, "a row that is not");
  assert.strictEqual(leadTimesDB.delete("no-such-id"), false);
  assert.strictEqual(materialsDB.delete(null), false);
});

test("a table or column name can never come from data", () => {
  const { SqliteDB } = require("../models/SqliteDB");
  for (const name of ["users; DROP TABLE users", "quotes--", "nope", "", "QUOTES", "quotes q", null, undefined, "__proto__", "constructor"]) {
    assert.throws(() => new SqliteDB(name), /unknown table/, `table ${JSON.stringify(name)}`);
  }
  const { quotesDB, usersDB } = h.models;
  const usersBefore = usersDB.getAll().length;
  const hostile = JSON.parse('{"notes":"kept","status = \'ordered\' --":"x","id) VALUES (1); DROP TABLE users; --":"x","notes = (SELECT password_hash FROM users) --":"x","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"password_hash":"x","nonexistent_column":"x"}');
  const row = quotesDB.insert(hostile);
  const back = quotesDB.getById(row.id);
  assert.strictEqual(back.notes, "kept");
  assert.strictEqual(back.status, "draft", "the hostile key did not set a column");
  assert.strictEqual(usersDB.getAll().length, usersBefore, "users table untouched");
  assert.strictEqual({}.polluted, undefined, "Object.prototype untouched");
  quotesDB.update(row.id, JSON.parse('{"notes":"again","status\' = \'x":"y","updated_at = NULL --":"z"}'));
  assert.strictEqual(quotesDB.getById(row.id).notes, "again");
  // if a table's columns cannot be read, nothing is written (fail closed), not everything
  const blind = new SqliteDB("quotes");
  blind._getColumns = () => new Set();
  assert.deepStrictEqual(blind._filterColumns({ notes: "x", "evil) --": "y" }), {});
});

test("values are data, whatever they contain", () => {
  const { quotesDB, partsDB } = h.models;
  const nasty = "'; DROP TABLE quotes; --  \" OR 1=1 \u0000 \\ %_ <script>";
  const row = quotesDB.insert({ notes: nasty, lineItems: [{ fileName: nasty }] });
  const back = quotesDB.getById(row.id);
  assert.strictEqual(back.notes, nasty.replace(/\u0000/g, ""), "stored whole (minus the NUL byte SQLite text cannot hold)");
  assert.strictEqual(back.lineItems[0].fileName, nasty, "JSON columns keep every character");
  // SQLite text stops at a NUL: without the guard "owner@shop.test\0.example" would be stored as the owner's address.
  const { usersDB } = h.models;
  const u = usersDB.insert({ email: "owner@shop.test\u0000.example.com", passwordHash: "x", role: "customer" });
  assert.strictEqual(usersDB.getById(u.id).email, "owner@shop.test.example.com", "never truncated to a different address");
  assert.ok(!usersDB.getAll().some((x) => x.email === "owner@shop.test"), "no account under the owner's address was created");
  usersDB.delete(u.id);
  assert.strictEqual(quotesDB.getById(`${row.id}\u0000anything`), null, "an id with a NUL suffix is not that id");
  assert.ok(quotesDB.getAll().length >= 1 && partsDB.getAll() !== null);
  // an id that is not a string is no id: no query, no logged error
  for (const id of [{ $ne: null }, ["a"], { toString: () => "x" }, null, undefined, "x".repeat(500), true]) {
    const { result, lines } = silently(() => [quotesDB.getById(id), quotesDB.update(id, { notes: "x" }), quotesDB.delete(id)]);
    assert.deepStrictEqual(result, [null, null, false], `id ${JSON.stringify(id)}`);
    assert.deepStrictEqual(lines, [], "no SQL error was provoked");
  }
  assert.strictEqual(quotesDB.getById("' OR '1'='1"), null);
  // objects and arrays in a plain column are stored as text, never handed to the driver raw
  const { result: odd, lines } = silently(() => quotesDB.insert({ notes: ["a", { b: 1 }], status: { x: 1 }, subtotal: NaN }));
  assert.deepStrictEqual(lines, []);
  const stored = quotesDB.getById(odd.id);
  assert.strictEqual(stored.notes, '["a",{"b":1}]');
  assert.strictEqual(stored.subtotal, null);
});

test("quote pricing: a body cannot set the price, the status or the owner, and odd shapes are refused", async () => {
  buyer = await h.register("buyer@example.com");
  const partId = await h.uploadCube();
  const config = h.cncConfig(partId, 2);
  const honest = await h.post("/api/quote", { parts: [config] });
  assert.strictEqual(honest.status, 200, honest.text);

  const stuffed = await h.post("/api/quote", {
    parts: [{ ...config, unitPrice: 0.01, lineTotal: 0.01, perUnit: { final: 0.01 }, meta: { x: 1 }, __proto__: { quantity: 999 } }],
    orderTotal: 0.01, subtotal: 0.01, status: "ordered", userId: "someone-else", gate: { requiresRfq: false }, expiresAt: "2099-01-01", paperworkFee: -500, id: "chosen-id",
    lineItems: [{ lineTotal: 0.01 }], config: { evil: true }, createdAt: "1999-01-01",
  });
  assert.strictEqual(stuffed.status, 200, stuffed.text);
  assert.strictEqual(stuffed.body.orderTotal, honest.body.orderTotal, "the price is the engine's");
  const stored = h.models.quotesDB.getById(stuffed.body.quoteId);
  assert.strictEqual(stored.status, "draft");
  assert.strictEqual(stored.userId, null);
  assert.notStrictEqual(stored.id, "chosen-id");
  assert.strictEqual(stored.orderTotal, honest.body.orderTotal);
  assert.deepStrictEqual(Object.keys(stored.config.parts[0]).sort(), ["finishSlug", "grade", "materialSlug", "partId", "process", "quantity", "subProcess"].sort(), "only the known configuration fields are kept");
  assert.ok(new Date(stored.expiresAt).getFullYear() < 2090);

  const bad = [
    { parts: [{ ...config, materialSlug: ["cnc-delrin"] }] },
    { parts: [{ ...config, partId: { $ne: null } }] },
    { parts: [{ ...config, grade: { toString: "x" } }] },
    { parts: [{ ...config, quantity: "lots" }] },
    { parts: [{ ...config, process: "x".repeat(500) }] },
    { parts: ["not an object"] },
    { parts: [null] },
    { parts: [[config]] },
    { parts: [config], leadTimeSlug: { $gt: "" } },
    { parts: { length: 1, 0: config } },
    { parts: "all of them" },
  ];
  for (const body of bad) {
    const r = await h.post("/api/quote", body);
    assert.strictEqual(r.status, 400, `${JSON.stringify(body).slice(0, 80)} → ${r.status} ${r.text.slice(0, 120)}`);
    assert.ok(!/at \w|node_modules|\.js:\d/.test(r.text));
  }
  const many = await h.post("/api/quote", { parts: Array.from({ length: 101 }, () => config) });
  assert.strictEqual(many.status, 400);
  assert.strictEqual(many.body.code, "too-many-lines");
  assert.ok(/firm quote/i.test(many.body.error));
  assert.strictEqual((await h.post("/api/quote", { parts: Array.from({ length: 100 }, () => config) })).status, 200, "one hundred lines is still an instant quote");
  // a quantity beyond reason is clamped, not multiplied through to infinity
  const huge = await h.post("/api/quote", { parts: [{ ...config, quantity: 1e300 }] });
  assert.strictEqual(huge.status, 200, huge.text);
  assert.ok(Number.isFinite(huge.body.orderTotal));
});

test("admin records: only the listed fields, only in their types — a blank multiplier can no longer null out the price", async () => {
  admin = await h.admin();
  const { leadTimesDB, finishesDB, materialsDB } = h.models;
  // Deleting through the admin route answers that it worked (it used to answer 404 after deleting), and a second try is a 404.
  const made = await h.post("/api/admin/materials", { name: "Scrap test material", slug: "scrap-test-material", process: "cnc" }, admin);
  assert.strictEqual(made.status, 201, made.text);
  const del = await h.del(`/api/admin/materials/${made.body.id}`, admin);
  assert.deepStrictEqual([del.status, del.body], [200, { success: true }]);
  assert.strictEqual(materialsDB.getById(made.body.id), null);
  assert.strictEqual((await h.del(`/api/admin/materials/${made.body.id}`, admin)).status, 404);
  const lt = leadTimesDB.getAll().find((x) => x.slug === "expedited");
  for (const multiplier of [null, "abc", 0, 0.5, -1, 1e9, [], {}, "", true]) {
    const r = await h.put(`/api/admin/lead-times/${lt.id}`, { multiplier }, admin);
    assert.strictEqual(r.status, 400, `multiplier ${JSON.stringify(multiplier)} → ${r.status}`);
  }
  assert.strictEqual(leadTimesDB.getById(lt.id).multiplier, lt.multiplier, "unchanged after the refused edits");
  const ok = await h.put(`/api/admin/lead-times/${lt.id}`, { multiplier: 1.4, days: "3-5 business days", id: "x", createdAt: "1999", slug: "expedited", rogue: 1 }, admin);
  assert.strictEqual(ok.status, 200, ok.text);
  assert.strictEqual(ok.body.multiplier, 1.4);
  assert.strictEqual(ok.body.id, lt.id);
  assert.strictEqual(ok.body.createdAt, lt.createdAt);
  await h.put(`/api/admin/lead-times/${lt.id}`, { multiplier: lt.multiplier }, admin);

  const fin = finishesDB.getAll()[0];
  assert.strictEqual((await h.put(`/api/admin/finishes/${fin.id}`, { name: ["x"] }, admin)).status, 400);
  assert.strictEqual((await h.put(`/api/admin/finishes/${fin.id}`, { slug: "Bad Slug; --" }, admin)).status, 400);
  assert.strictEqual((await h.put(`/api/admin/finishes/${fin.id}`, { minCost: "free" }, admin)).status, 400);
  const toggled = await h.put(`/api/admin/finishes/${fin.id}`, { active: !fin.active, id: "other", name: "<b>Bold</b> finish" }, admin);
  assert.strictEqual(toggled.status, 200);
  assert.strictEqual(toggled.body.id, fin.id);
  // Text is stored as typed (it is escaped where it is shown: textRoundTrip.test.js); only non-text characters go.
  assert.strictEqual(toggled.body.name, "<b>Bold</b> finish");
  const ctl = await h.put(`/api/admin/finishes/${fin.id}`, { name: "Bead\u0000 blast\u202E <ok>" }, admin);
  assert.strictEqual(ctl.body.name, "Bead blast <ok>", "control and bidi-override characters removed, nothing else");
  await h.put(`/api/admin/finishes/${fin.id}`, { active: fin.active, name: fin.name }, admin);

  const mat = materialsDB.getAll()[0];
  const m = await h.put(`/api/admin/materials/${mat.id}`, { description: "note", id: "other", createdAt: "1999", password_hash: "x", __proto__: { active: false } }, admin);
  assert.strictEqual(m.status, 200);
  assert.deepStrictEqual([m.body.id, m.body.createdAt, m.body.active], [mat.id, mat.createdAt, mat.active]);

  const pricing = await h.put("/api/admin/pricing", JSON.parse('{"rules":{"__proto__":{"x":1},"constructor":1,"notARule":5},"note":"x"}'), admin);
  assert.strictEqual(pricing.status, 400, pricing.text);
  assert.strictEqual({}.x, undefined);
  // and none of it is reachable without the admin role
  for (const [method, url] of [["put", `/api/admin/lead-times/${lt.id}`], ["put", `/api/admin/finishes/${fin.id}`], ["put", `/api/admin/materials/${mat.id}`], ["put", "/api/admin/pricing"]]) {
    assert.strictEqual((await h[method](url, { active: false })).status, 401);
    assert.strictEqual((await h[method](url, { active: false }, buyer)).status, 403);
  }
});

test("order status: the body sets status, tracking and notes — never the total or the owner", async () => {
  const partId = await h.uploadCube();
  const q = await h.post("/api/quote", { parts: [h.cncConfig(partId, 1)] }, buyer);
  const session = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, shippingName: "A Buyer", shippingAddress: "1 Test St", shippingCity: "Wauconda", shippingState: "IL", shippingZip: "60084", total: 0.01, status: "paid", userId: "x" }, buyer);
  assert.strictEqual(session.status, 200, session.text);
  const order = h.models.ordersDB.getAll().find((o) => o.quoteId === q.body.quoteId);
  assert.strictEqual(order.status, "pending_payment", "a buyer cannot mark their own order paid");
  assert.ok(Math.abs(order.total - q.body.orderTotal) < 0.005, "the total is the quote's");
  // An unpaid order cannot be jumped into production; the owner marks it paid first, and has to say how it was paid.
  const jump = await h.put(`/api/orders/${order.id}/status`, { status: "in_production", total: 0 }, admin);
  assert.deepStrictEqual([jump.status, jump.body.code], [409, "transition-not-allowed"]);
  const noReason = await h.put(`/api/orders/${order.id}/status`, { status: "paid", paidAt: "1999" }, admin);
  assert.deepStrictEqual([noReason.status, noReason.body.code], [400, "reason-required"]);
  assert.strictEqual((await h.put(`/api/orders/${order.id}/status`, { status: "paid", reason: "cheque 1042 received", paidVia: "cheque", paidAt: "1999", total: 0 }, admin)).status, 200);
  assert.notStrictEqual(h.models.ordersDB.getById(order.id).paidAt, "1999", "the payment date is the server's");
  const r = await h.put(`/api/orders/${order.id}/status`, { status: "in_production", total: 0, subtotal: 0, userId: "someone-else", stripePaymentId: "x", paidAt: "1999", notes: "<img src=x onerror=alert(1)>ok" }, admin);
  assert.strictEqual(r.status, 200, r.text);
  const after = h.models.ordersDB.getById(order.id);
  assert.deepStrictEqual([after.status, after.total, after.userId, after.stripePaymentId || null], ["in_production", order.total, order.userId, order.stripePaymentId || null]);
  assert.strictEqual(after.notes, "<img src=x onerror=alert(1)>ok", "the note is stored as typed; it is data, and is escaped wherever it is shown");
  assert.strictEqual((await h.put(`/api/orders/${order.id}/status`, { status: "paid" }, buyer)).status, 403);
  assert.strictEqual((await h.put(`/api/orders/${order.id}/status`, { status: "free" }, admin)).status, 400);
});

test("a DXF's units cannot be changed once the part is on an order (the shop builds from that geometry)", async () => {
  const dxf = fs.readFileSync(path.join(root, "tools", "vet-quotes", "parts", "dxf_inch_guard.dxf"));
  const up = await h.form("/api/upload", { process: "routing" }, { files: { name: "guard.dxf", data: dxf } });
  assert.strictEqual(up.status, 200, up.text);
  const partId = up.body.parts[0].partId;
  // The browser that uploaded the part holds its edit key; without it the part is not found.
  const key = { "X-Human-Token": h.humanToken, "X-Part-Key": up.body.parts[0].editKey };
  const units = (body, headers = key, id = partId) => h.raw("POST", `/api/parts/${id}/units`, { json: body, headers });
  assert.strictEqual((await units({ units: "in" }, { "X-Human-Token": h.humanToken })).status, 404, "no edit key: not found");
  assert.strictEqual((await units({ units: "in" }, { "X-Part-Key": up.body.parts[0].editKey })).status, 403, "no verified-human token while the bot check is on");
  assert.strictEqual((await units({ units: "in" })).status, 200, "before an order: allowed");
  const mat = h.models.materialsDB.getAll().find((m) => m.process === "routing" && m.active && m.thicknesses?.length);
  const q = await h.post("/api/quote", { parts: [{ partId, materialSlug: mat.slug, thicknessMm: mat.thicknesses[0].mm, quantity: 1, process: "routing" }] }, buyer);
  assert.strictEqual(q.status, 200, q.text);
  const before = h.models.partsDB.getById(partId).geometry.boundingBox.width;
  h.models.orderItemsDB.insert({ orderId: h.models.ordersDB.getAll()[0].id, partId, fileName: "guard.dxf", quantity: 1 });
  const r = await units({ units: "mm" });
  assert.strictEqual(r.status, 409, r.text);
  assert.strictEqual(r.body.code, "part-locked");
  assert.strictEqual(h.models.partsDB.getById(partId).geometry.boundingBox.width, before, "the stored geometry did not move");
  // The route itself refuses too, wherever it is mounted (the gate in security/index.js is not its only guard).
  {
    const express = require("express");
    const bare = express();
    bare.use(express.json());
    bare.use("/api", require("../routes/api"));
    const srv = await new Promise((resolve) => { const x = bare.listen(0, () => resolve(x)); });
    try {
      const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/parts/${partId}/units`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ units: "mm" }) });
      assert.strictEqual(res.status, 409);
      assert.strictEqual((await res.json()).code, "part-locked");
    } finally { await new Promise((resolve) => srv.close(resolve)); }
  }
  assert.strictEqual(h.models.partsDB.getById(partId).geometry.boundingBox.width, before);
  assert.strictEqual((await units({ units: "mm" }, key, "not-a-uuid")).status, 404);
  // A wrong unit on a part that can still be edited is a plain 400.
  const up2 = await h.form("/api/upload", { process: "routing" }, { files: { name: "guard2.dxf", data: dxf } });
  const p2 = up2.body.parts[0];
  assert.strictEqual((await units({ units: "furlongs" }, { "X-Human-Token": h.humanToken, "X-Part-Key": p2.editKey }, p2.partId)).status, 400);
});

run(async () => {
  await h.stop();
  await require("../parsers/parsePool").pool.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
