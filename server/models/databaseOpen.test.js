/**
 * A database file that is there and cannot be used stops the start (re-review 2026-11-12, F-04).
 * Run: node server/models/databaseOpen.test.js
 *
 * Before: a zero-length file (a volume that came up empty) was opened as a new, empty database and
 * written over; a file cut short was rewritten and was still malformed; a file that was not a
 * database left the server answering "ok" on its health check with every request failing. Each
 * case below fails on that code. The real server is started, in production mode, on a folder
 * prepared here (testSupport/liveServer.js).
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const live = require("../testSupport/liveServer");
const { runner } = require("../testSupport/harness");

const { test, run } = runner("Start-up on a database file that cannot be used");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const folders = [];
const folder = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "se-dbopen-")); folders.push(d); return d; };
const dbOf = (dir) => path.join(dir, "data", "quoting.db");

let good; // the bytes of a database the real server made, with a customer's account in it

/** Start on `bytes` as the database file. Returns { started, code, log, after } (after: the file's bytes afterwards). */
async function startOn(bytes, { env = {} } = {}) {
  const dir = folder();
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  if (bytes) fs.writeFileSync(dbOf(dir), bytes);
  let s = null, code = null, log = "", health = null;
  try {
    s = await live.start({ tmpDir: dir, env });
    health = await s.get("/api/health");
    log = s.log();
    await s.stop({ keep: true });
  } catch (err) {
    code = err.exitCode === undefined ? "no exit code" : err.exitCode;
    log = String(err.output || err.message);
  }
  return { started: Boolean(s), code, log, health, dir, after: fs.existsSync(dbOf(dir)) ? fs.readFileSync(dbOf(dir)) : null, leftovers: fs.readdirSync(path.join(dir, "data")).filter((n) => n !== "quoting.db") };
}
const fatal = (log) => log.split("\n").filter((l) => /^FATAL: the database file /.test(l));

test("setup: a real database with a customer in it", async () => {
  const dir = folder();
  const s = await live.start({ tmpDir: dir });
  await s.register("pat@example.test", { ip: "192.0.2.10" });
  const health = await s.get("/api/health");
  assert.deepStrictEqual([health.status, health.body.status], [200, "ok"]);
  await s.stop({ keep: true });
  good = fs.readFileSync(dbOf(dir));
  assert.ok(good.length > 100000);
});

for (const [label, make, says] of [
  ["a zero-length file (a volume that came up empty)", () => Buffer.alloc(0), /the file is empty \(0 bytes\)/],
  ["the first third of the real file", () => good.subarray(0, Math.floor(good.length / 3)), /integrity check failed|SQLite cannot read it/],
  ["bytes that are not a database", () => Buffer.from("this is not a database".repeat(400)), /the file is not a SQLite database/],
  ["a whole file with a damaged page in the middle", () => { const b = Buffer.from(good); const page = 4096; const at = Math.floor(b.length / page / 2) * page; crypto.randomFillSync(b, at, page * 3); return b; }, /integrity check failed|SQLite cannot read it/],
  ["a file that begins like a database and is 60 bytes long", () => good.subarray(0, 60), /the file is not a SQLite database/],
]) {
  test(`${label}: the start stops with one line that says why, and the file is left exactly as it was`, async () => {
    const bytes = make();
    const r = await startOn(bytes);
    assert.strictEqual(r.started, false, `the server started: health ${r.health && r.health.status}`);
    assert.strictEqual(r.code, 1, `exit code: ${r.code}`);
    const lines = fatal(r.log);
    assert.strictEqual(lines.length, 1, r.log.slice(-1500));
    assert.ok(says.test(lines[0]) && /Nothing was written to it/.test(lines[0]) && /NOT started/.test(lines[0]), lines[0]);
    assert.ok(r.after && r.after.length === bytes.length && sha(r.after) === sha(bytes), `the file is byte for byte what it was (${bytes.length} bytes before, ${r.after ? r.after.length : "gone"} after)`);
    assert.deepStrictEqual(r.leftovers.filter((n) => /quoting\.db/.test(n)), [], "no temporary database file was written beside it");
    assert.ok(!/Seeding materials|Database ready|NO DATABASE WAS FOUND/.test(r.log), "nothing was seeded: no empty database was made in its place");
  });
}

test("no database file at all: a new one is made and the site starts (a first start), and in production that is said loudly", async () => {
  const r = await startOn(null);
  assert.strictEqual(r.started, true, r.log.slice(-800));
  assert.deepStrictEqual([r.health.status, r.health.body.status], [200, "ok"]);
  assert.ok(r.after && r.after.length > 50000, "the new database is on disk");
  assert.ok(/NO DATABASE WAS FOUND at .*quoting\.db: A NEW, EMPTY ONE WAS CREATED/.test(r.log), r.log.slice(0, 1500));
  assert.strictEqual(fatal(r.log).length, 0);
});

test("a good database: the site starts on it, keeps what is in it, and says nothing about a new one", async () => {
  const r = await startOn(good);
  assert.strictEqual(r.started, true, r.log.slice(-800));
  assert.deepStrictEqual([r.health.status, r.health.body.status], [200, "ok"]);
  assert.ok(!/NO DATABASE WAS FOUND|FATAL/.test(r.log), r.log.slice(0, 1500));
  const SQL = await require("sql.js")();
  const db = new SQL.Database(r.after);
  assert.strictEqual(db.exec("SELECT COUNT(*) FROM users WHERE email = 'pat@example.test'")[0].values[0][0], 1, "the customer is still there");
  db.close();
});

test("a half-written temporary file beside a good database is never taken for the database", async () => {
  const dir = folder();
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(dbOf(dir), good);
  fs.writeFileSync(`${dbOf(dir)}.tmp`, good.subarray(0, Math.floor(good.length / 3)));
  const s = await live.start({ tmpDir: dir });
  const health = await s.get("/api/health");
  await s.stop({ keep: true });
  assert.strictEqual(health.status, 200);
  const SQL = await require("sql.js")();
  const db = new SQL.Database(fs.readFileSync(dbOf(dir)));
  assert.strictEqual(db.exec("SELECT COUNT(*) FROM users WHERE email = 'pat@example.test'")[0].values[0][0], 1, "the good database was loaded, with the customer in it");
  db.close();
});

test("the module itself: on an unusable file it opens nothing, says why, answers \"not usable\", and a save writes nothing", async () => {
  const dir = folder();
  const file = path.join(dir, "quoting.db");
  const bytes = good.subarray(0, Math.floor(good.length / 3));
  fs.writeFileSync(file, bytes);
  const script = `
    const database = require(${JSON.stringify(path.join(__dirname, "database.js"))});
    database.ready.then(() => {
      const before = database.openError();
      database.saveToDisk(); database.flush && database.flush();
      console.log(JSON.stringify({ reason: before && before.reason, usable: database.isUsable(), created: database.wasCreated(), handle: database.getDatabase() === null }));
    });`;
  const out = require("child_process").execFileSync(process.execPath, ["-e", script], { env: { ...process.env, QUOTING_DB_PATH: file, QUOTING_DATA_DIR: dir }, encoding: "utf8" });
  const said = JSON.parse(out.trim().split("\n").pop());
  assert.ok(/integrity check failed|SQLite cannot read it/.test(said.reason), out);
  assert.deepStrictEqual([said.usable, said.created, said.handle], [false, false, true]);
  assert.strictEqual(sha(fs.readFileSync(file)), sha(bytes), "the file was not touched");
  assert.ok(!fs.existsSync(`${file}.tmp`));
});

run(() => { for (const d of folders) fs.rmSync(d, { recursive: true, force: true }); });
