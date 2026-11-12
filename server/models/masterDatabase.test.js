/**
 * The migrations of the availability fixes are additive: a database created by
 * the code on origin/master opens under this code with nothing lost.
 *
 * The fixture (security/fixtures/master-db-2026-11-11.db.gz) is a database file
 * written by origin/master's own server (255753c) on 2026-11-11: its seeded
 * catalog, two uploaded parts (a cube and a DXF, geometry and mesh in the row as
 * master stored them), two draft quotes — one saved under an id the CLIENT chose,
 * which master allowed — an account and a firm-quote request. See the README
 * beside it for how it was made.
 * Run: node server/models/masterDatabase.test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const initSqlJs = require("sql.js");
const { runner } = require("../testSupport/harness");
const live = require("../testSupport/liveServer");

const { test, run } = runner("A database created by origin/master");
const fixture = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, "..", "security", "fixtures", "master-db-2026-11-11.db.gz")));
const CLIENT_CHOSEN = "11111111-2222-4333-8444-555555555555";
const ip = "203.0.113.150";
let SQL, s, tmp, before;

const open = (bytes) => new SQL.Database(bytes);
const rows = (db, sql, params = []) => { const st = db.prepare(sql); st.bind(params); const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out; };
const columns = (db, table) => rows(db, `PRAGMA table_info(${table})`).map((r) => r.name);

test("the fixture is what master wrote: none of the new columns, lines as a plain array, a client-chosen quote id", async () => {
  SQL = await initSqlJs();
  const db = open(fixture);
  for (const [table, cols] of [["quotes", ["last_opened_at", "part_count", "total_units"]], ["parts", ["client_tag"]], ["rfqs", ["client_tag", "drawing_bytes", "attachment_removed_at"]]]) {
    for (const c of cols) assert.ok(!columns(db, table).includes(c), `${table}.${c} is not in master's schema`);
  }
  const q = rows(db, "SELECT * FROM quotes WHERE id = ?", [CLIENT_CHOSEN])[0];
  assert.ok(q && Array.isArray(JSON.parse(q.line_items_json)) && JSON.parse(q.line_items_json).length === 3);
  before = {
    counts: Object.fromEntries(["users", "quotes", "parts", "rfqs", "orders", "materials", "finishes", "lead_times", "pricing_rules"].map((t) => [t, rows(db, `SELECT COUNT(*) AS n FROM ${t}`)[0].n])),
    quote: { orderTotal: q.order_total, subtotal: q.subtotal, lines: JSON.parse(q.line_items_json) },
    parts: rows(db, "SELECT id, file_name FROM parts"),
    user: rows(db, "SELECT email, password_hash FROM users")[0],
    rfq: rows(db, "SELECT id, email, notes, quote_id FROM rfqs")[0],
  };
  assert.deepStrictEqual([before.counts.users, before.counts.quotes, before.counts.parts, before.counts.rfqs], [1, 2, 2, 1]);
  db.close();
});

test("this code starts on it; the old quote reads, reopens and re-prices; old parts price; new work goes on beside it", async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "se-master-db-"));
  fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "data", "quoting.db"), fixture);
  s = await live.start({ tmpDir: tmp });
  assert.ok(!/no such column|SQLITE_ERROR|Failed to initialize/i.test(s.log()), s.log().slice(-600));

  // The quote master saved under a client-chosen id is still there, line for line.
  const old = await s.get(`/api/quote/${CLIENT_CHOSEN}`, { ip });
  assert.strictEqual(old.status, 200, old.text.slice(0, 200));
  assert.strictEqual(old.body.orderTotal, before.quote.orderTotal);
  assert.deepStrictEqual(old.body.lineItems, before.quote.lines, "an array of lines written by master reads back unchanged");
  // It reopens: three lines, the part described once, its small preview with it.
  const session = await s.get(`/api/quote/${CLIENT_CHOSEN}/session`, { ip });
  assert.strictEqual(session.status, 200);
  assert.strictEqual(session.body.parts.length, 3);
  const cubeId = session.body.parts[0].partId;
  assert.deepStrictEqual(Object.keys(session.body.partsById), [cubeId]);
  const mesh = await s.get(session.body.partsById[cubeId].mesh.url, { ip, headers: { "X-Part-Key": session.body.partsById[cubeId].editKey } });
  assert.strictEqual(mesh.status, 200);
  assert.ok(mesh.body.positions.length >= 108);
  // It re-prices in place (an id that names an existing quote still resumes it) and its lines are then stored compactly.
  const mats = (await s.get("/api/materials?process=cnc", { ip })).body;
  // (relaunch merge 2) A part belongs to whoever uploaded it (security/partAccess.js). Master's parts have no account,
  // so they are used with their edit key, which the reopened quote hands to the browser that holds the quote.
  const line = { partId: cubeId, editKey: session.body.partsById[cubeId].editKey, materialSlug: mats[0].slug, quantity: 3, process: "cnc", subProcess: "milling" };
  const again = await s.post("/api/quote", { quoteId: CLIENT_CHOSEN, parts: [line, line, { ...line, quantity: 10 }] }, { ip });
  assert.strictEqual(again.status, 200, again.text.slice(0, 200));
  assert.strictEqual(again.body.quoteId, CLIENT_CHOSEN);
  // (master kept fractions of a cent in a total; totals have been whole cents since the hardening branch)
  assert.ok(Math.abs(again.body.orderTotal - before.quote.orderTotal) < 0.01, `the same price it had under master: ${again.body.orderTotal} vs ${before.quote.orderTotal}`);
  assert.strictEqual((await s.get(`/api/quote/${CLIENT_CHOSEN}`, { ip })).body.lineItems.length, 3);
  // Master's DXF part prices for routing.
  const dxfId = before.parts.find((p) => /\.dxf$/.test(p.file_name)).id;
  const rmat = (await s.get("/api/materials?process=routing", { ip })).body[0];
  // (relaunch merge 2) This drawing is on none of master's quotes, so no browser was ever handed a key for it: after
  // the upgrade a visitor who only knows its id is told it is not there (they upload it again), and the owner can
  // still price it (a phone order). Its measurements, as master stored them, price for routing.
  const dxfLine = { partId: dxfId, materialSlug: rmat.slug, quantity: 2, process: "routing", thicknessMm: rmat.thicknesses[0].mm };
  const stranger = await s.post("/api/quote", { parts: [dxfLine] }, { ip });
  assert.deepStrictEqual([stranger.status, stranger.body.code], [400, "part-not-found"], stranger.text.slice(0, 200));
  const admin = await s.admin();
  const dq = await s.post("/api/quote", { parts: [dxfLine] }, { ip, token: admin });
  assert.strictEqual(dq.status, 200, dq.text.slice(0, 200));
  // New work: an upload and a quote; the admin lists show old and new together.
  const cube = fs.readFileSync(path.join(live.ROOT, "tools", "vet-quotes", "parts", "cube_20mm.stl"));
  const up = await s.upload([{ name: "new.stl", data: cube }], { ip });
  assert.strictEqual(up.body.parts.length, 1);
  const fresh = await s.post("/api/quote", { parts: [{ ...line, partId: up.body.parts[0].partId, editKey: up.body.parts[0].editKey }] }, { ip });
  assert.strictEqual(fresh.status, 200);
});

test("after it: every row master wrote is still there, and the new columns have been added beside the old", async () => {
  await s.stop({ keep: true });
  const db = open(fs.readFileSync(path.join(tmp, "data", "quoting.db")));
  for (const [table, cols] of [["quotes", ["last_opened_at", "part_count", "total_units"]], ["parts", ["client_tag", "mesh_bytes", "detail_bytes"]], ["rfqs", ["client_tag", "drawing_bytes", "attachment_removed_at"]]]) {
    for (const c of cols) assert.ok(columns(db, table).includes(c), `${table}.${c} was added`);
  }
  const count = (t) => rows(db, `SELECT COUNT(*) AS n FROM ${t}`)[0].n;
  for (const t of ["rfqs", "orders"]) assert.strictEqual(count(t), before.counts[t], `${t}: nothing lost, nothing added`);
  assert.strictEqual(count("users"), before.counts.users + 1, "master's account, plus the owner's admin account made by the one-time setup in the case above");
  // The catalog is re-seeded at every start (rows the current catalog adds appear; none goes missing).
  for (const t of ["materials", "finishes", "lead_times", "pricing_rules"]) assert.ok(count(t) >= before.counts[t], `${t}: ${count(t)} rows, was ${before.counts[t]}`);
  assert.strictEqual(count("quotes"), before.counts.quotes + 2, "master's two quotes plus the two made here");
  assert.strictEqual(count("parts"), before.counts.parts + 1);
  assert.deepStrictEqual(rows(db, "SELECT email, password_hash FROM users")[0], before.user, "the account is untouched");
  assert.deepStrictEqual(rows(db, "SELECT id, email, notes, quote_id FROM rfqs")[0], before.rfq, "so is the request");
  for (const p of before.parts) assert.strictEqual(rows(db, "SELECT file_name FROM parts WHERE id = ?", [p.id])[0].file_name, p.file_name);
  // The re-priced quote: same id, counts stored, the three lines stored deflated, the part ids and the client beside the row.
  const q = rows(db, "SELECT * FROM quotes WHERE id = ?", [CLIENT_CHOSEN])[0];
  const stored = JSON.parse(q.line_items_json);
  assert.deepStrictEqual([q.part_count, q.total_units, stored.$lines, stored.n], [3, 16, 2, 3]);
  assert.strictEqual(require("./quotesStore").unpackLines(stored).length, 3);
  assert.ok(/^[0-9a-f-]{36}(,[0-9a-f-]{36})*$/.test(q.part_ids) && /^[0-9a-f]{24}$/.test(q.client_tag), "round-2 columns are filled when the row is next written");
  // The other quote master wrote was never touched: still a plain array.
  const untouched = rows(db, "SELECT line_items_json FROM quotes WHERE id != ? ORDER BY created_at LIMIT 1", [CLIENT_CHOSEN])[0];
  assert.ok(Array.isArray(JSON.parse(untouched.line_items_json)));
  db.close();
});

run(async () => { if (s) await s.stop().catch(() => {}); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); process.exit(process.exitCode || 0); });
