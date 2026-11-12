/**
 * Database saves reach the disk (server/models/database.js writeDurably).
 *
 * A save was already atomic — written beside the file, then renamed — but nothing was flushed, so a
 * host crash or power loss at the wrong moment could leave the database name pointing at bytes that
 * were never written. Now: write the temporary file, fsync it, rename it, fsync the folder.
 * This suite holds the order of those four steps, what happens when a flush fails, and that every
 * save the app makes goes through it.
 * Run: node server/models/databaseDurability.test.js
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runner } = require("../testSupport/harness");

const { test, run } = runner("Database saves are flushed to disk");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "se-durable-"));
process.env.QUOTING_DB_PATH = path.join(tmp, "app", "quoting.db");
process.env.QUOTING_DATA_DIR = path.join(tmp, "app");
fs.mkdirSync(path.join(tmp, "app"), { recursive: true });
const database = require("./database");

/** Record what writeDurably does to the file system, in order; optionally make one step fail. */
function watch({ failFileSync, failDirSync } = {}) {
  const real = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync, closeSync: fs.closeSync, writeSync: fs.writeSync };
  const fds = new Map();
  const log = [];
  fs.openSync = (p, flags, ...rest) => { const fd = real.openSync(p, flags, ...rest); fds.set(fd, { path: String(p), dir: fs.statSync(p).isDirectory() }); log.push(`open ${fds.get(fd).dir ? "folder" : path.basename(String(p))} ${flags}`); return fd; };
  fs.writeSync = (fd, ...rest) => { if (fds.has(fd) && log[log.length - 1] !== "write") log.push("write"); return real.writeSync(fd, ...rest); };
  fs.fsyncSync = (fd) => {
    const what = fds.get(fd) || { dir: false, path: "?" };
    log.push(`fsync ${what.dir ? "folder" : path.basename(what.path)}`);
    if (what.dir && failDirSync) throw Object.assign(new Error("folder flush failed"), { code: failDirSync });
    if (!what.dir && failFileSync) throw Object.assign(new Error("file flush failed"), { code: failFileSync });
    return real.fsyncSync(fd);
  };
  fs.renameSync = (a, b) => { log.push(`rename ${path.basename(String(a))} -> ${path.basename(String(b))}`); return real.renameSync(a, b); };
  fs.closeSync = (fd) => { if (fds.has(fd)) { log.push(`close ${fds.get(fd).dir ? "folder" : path.basename(fds.get(fd).path)}`); fds.delete(fd); } return real.closeSync(fd); };
  return { log, restore: () => Object.assign(fs, real), open: () => fds.size };
}

test("a save writes the temporary file, flushes it, renames it over the database, then flushes the folder — in that order", () => {
  const file = path.join(tmp, "one", "quoting.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = crypto.randomBytes(300000);
  const w = watch();
  try { database.writeDurably(file, bytes); } finally { w.restore(); }
  assert.deepStrictEqual(w.log, ["open quoting.db.tmp w", "write", "fsync quoting.db.tmp", "close quoting.db.tmp", "rename quoting.db.tmp -> quoting.db", "open folder r", "fsync folder", "close folder"]);
  assert.strictEqual(w.open(), 0, "no file handle is left open");
  assert.ok(fs.readFileSync(file).equals(bytes), "the database holds exactly what was written");
  assert.ok(!fs.existsSync(`${file}.tmp`), "the temporary file is gone");
});

test("if the file cannot be flushed, the save fails and the old database is left exactly as it was", () => {
  const file = path.join(tmp, "two", "quoting.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = crypto.randomBytes(5000);
  fs.writeFileSync(file, old);
  const w = watch({ failFileSync: "EIO" });
  try { assert.throws(() => database.writeDurably(file, crypto.randomBytes(9000)), /file flush failed/); } finally { w.restore(); }
  assert.ok(!w.log.some((l) => l.startsWith("rename")), `an unflushed file is never renamed over the database: ${w.log.join(", ")}`);
  assert.ok(fs.readFileSync(file).equals(old), "the old database is intact");
  assert.strictEqual(w.open(), 0, "the handle was closed all the same");
});

test("a file system that cannot flush a folder is not an error (the file's own flush happened); a real failure there is", () => {
  const file = path.join(tmp, "three", "quoting.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const code of ["EISDIR", "EPERM", "EINVAL", "ENOTSUP"]) {
    const bytes = crypto.randomBytes(2000);
    const w = watch({ failDirSync: code });
    try { database.writeDurably(file, bytes); } finally { w.restore(); }
    assert.ok(fs.readFileSync(file).equals(bytes), code);
    assert.ok(w.log.includes("fsync quoting.db.tmp") && w.log.includes("fsync folder"), code);
    assert.strictEqual(w.open(), 0, code);
  }
  const w = watch({ failDirSync: "EIO" });
  try { assert.throws(() => database.writeDurably(file, crypto.randomBytes(2000)), /folder flush failed/); } finally { w.restore(); }
  assert.strictEqual(w.open(), 0);
});

test("every save the app makes goes through it: a row written through the model layer is flushed before the call returns", async () => {
  await database.ready;
  const { leadTimesDB } = require("./index");
  const w = watch();
  let row;
  try { row = leadTimesDB.insert({ slug: `durable-${Date.now()}`, name: "Durable", multiplier: 1, active: false }); } finally { w.restore(); }
  assert.ok(row && row.id);
  assert.deepStrictEqual(w.log.filter((l) => /^(fsync|rename)/.test(l)), ["fsync quoting.db.tmp", "rename quoting.db.tmp -> quoting.db", "fsync folder"]);
  // A batch of writes is one save, and so one pair of flushes.
  const b = watch();
  try { database.batch(() => { for (let i = 0; i < 5; i++) leadTimesDB.update(row.id, { name: `Durable ${i}` }); }); } finally { b.restore(); }
  assert.strictEqual(b.log.filter((l) => l === "fsync quoting.db.tmp").length, 1);
  assert.strictEqual(b.log.filter((l) => l === "fsync folder").length, 1);
  // Nothing in the model layer writes the database file any other way.
  const src = fs.readFileSync(path.join(__dirname, "database.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/writeFileSync\s*\(/.test(src), "database.js has no unflushed write");
  assert.strictEqual((src.match(/renameSync\s*\(/g) || []).length, 1, "and one rename, inside writeDurably");
  // (relaunch merge 2) saveToDisk grew when re-priced drafts were allowed to wait a moment for the file (deferred()):
  // what is held is that the function's own body ends in writeDurably, not how many characters come before it.
  const body = (/function saveToDisk\(\) \{([\s\S]*?)\n\}/.exec(src) || [])[1] || "";
  assert.ok(/writeDurably\(DB_PATH, buffer\);\s*dirty = false;\s*$/.test(body), "saveToDisk writes through writeDurably and nothing else");
  assert.strictEqual((src.match(/writeDurably\(/g) || []).length, 2, "one definition, one call");
});

test("what it costs: one flushed save of a 5 MB database, measured here (the full table is scripts/dev/fsync-cost.js)", () => {
  const file = path.join(tmp, "cost", "quoting.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buf = crypto.randomBytes(5 * 1024 * 1024);
  const plain = [], durable = [];
  for (let i = 0; i < 8; i++) {
    let t0 = process.hrtime.bigint(); fs.writeFileSync(`${file}.tmp`, buf); fs.renameSync(`${file}.tmp`, file); plain.push(Number(process.hrtime.bigint() - t0) / 1e6);
    t0 = process.hrtime.bigint(); database.writeDurably(file, buf); durable.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  console.log(`       (5 MB: write + rename ${median(plain).toFixed(1)} ms; with both flushes ${median(durable).toFixed(1)} ms; this folder is ${tmp.startsWith("/tmp") ? "a temporary one — on a memory-backed /tmp a flush costs nothing, so read the numbers in the integration report" : "on disk"})`);
  // Not a performance gate (a shared machine would make it one): only that a save is not pathologically slow.
  assert.ok(median(durable) < 5000, `${median(durable)} ms`);
});

run(() => fs.rmSync(tmp, { recursive: true, force: true }));
