/**
 * Stopping cleanly on SIGTERM: the order of the steps, a request in progress
 * is allowed to finish, the database on disk is whole and holds the last
 * completed write, and nothing is cut mid-save.
 * Run: node server/ops/shutdown.test.js
 */
const assert = require("assert");
const { spawn } = require("child_process");
const EventEmitter = require("events");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { runner } = require("../testSupport/harness");
const live = require("../testSupport/liveServer");
const shutdown = require("./shutdown");

const { test, run } = runner("Shutdown");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "se-shutdown-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Open a database file the way the server does and read one value from it. */
async function readDb(file, sql) {
  const SQL = await require("sql.js")();
  const db = new SQL.Database(fs.readFileSync(file));
  try { const r = db.exec(sql); return r.length ? r[0].values : []; } finally { db.close(); }
}
const isSqlite = (file) => fs.readFileSync(file).subarray(0, 15).toString("latin1") === "SQLite format 3";

function fakeServer() {
  const s = { closed: false, idleCloses: 0, closeCb: null };
  s.close = (cb) => { s.closed = true; s.closeCb = cb; };
  s.closeIdleConnections = () => { s.idleCloses++; };
  return s;
}

test("order: stop accepting, wait for open requests, save and flush the database, record the stop, exit 0", async () => {
  const proc = new EventEmitter();
  const server = fakeServer();
  const steps = [];
  const h = shutdown.install(server, {
    proc, graceMs: 5000,
    flush: () => { steps.push("flush"); return { saved: true, synced: true, bytes: 2048 }; },
    onStopped: () => steps.push("recorded"),
    exit: (code) => steps.push(`exit ${code}`),
    log: (l) => steps.push(`log: ${l}`),
  });
  proc.emit("SIGTERM");
  assert.strictEqual(server.closed, true, "no new connections");
  assert.ok(server.idleCloses >= 1, "idle keep-alive connections are closed");
  assert.deepStrictEqual(steps.filter((s) => !s.startsWith("log")), [], "nothing is flushed while requests are still open");
  server.closeCb(); // the last open request has finished
  assert.deepStrictEqual(steps.filter((s) => !s.startsWith("log")), ["flush", "recorded", "exit 0"]);
  assert.ok(steps.some((s) => /SIGTERM received/.test(s)) && steps.some((s) => /all requests finished; database saved and flushed/.test(s)));
  // Further signals after the exit path has run do nothing more.
  proc.emit("SIGTERM");
  assert.strictEqual(steps.filter((s) => s.startsWith("exit")).length, 1);
  h.uninstall();
});

test("requests that never finish are given the grace time and no longer; a second signal skips the wait; SIGINT is handled the same", async () => {
  // Grace time.
  let proc = new EventEmitter(); let server = fakeServer(); let exits = [];
  let h = shutdown.install(server, { proc, graceMs: 120, flush: () => ({ saved: true, synced: true }), exit: (c) => exits.push(c), log: () => {} });
  const t0 = Date.now();
  proc.emit("SIGTERM");
  await sleep(60);
  assert.deepStrictEqual(exits, [], "still waiting inside the grace time");
  await sleep(140);
  assert.deepStrictEqual(exits, [0]);
  assert.ok(Date.now() - t0 < 1000);
  h.uninstall();

  // Second signal.
  proc = new EventEmitter(); server = fakeServer(); exits = [];
  const logs = [];
  h = shutdown.install(server, { proc, graceMs: 60000, flush: () => ({ saved: true, synced: true }), exit: (c) => exits.push(c), log: (l) => logs.push(l) });
  proc.emit("SIGTERM");
  assert.deepStrictEqual(exits, []);
  proc.emit("SIGTERM");
  assert.deepStrictEqual(exits, [0]);
  assert.ok(logs.some((l) => /second SIGTERM/.test(l)));
  h.uninstall();

  // SIGINT (Ctrl-C when run by hand).
  proc = new EventEmitter(); server = fakeServer(); exits = [];
  h = shutdown.install(server, { proc, graceMs: 1000, flush: () => ({ saved: true, synced: true }), exit: (c) => exits.push(c), log: () => {} });
  proc.emit("SIGINT");
  server.closeCb();
  assert.deepStrictEqual(exits, [0]);
  h.uninstall();
});

test("a save that fails at shutdown is said plainly and the exit code is not 0", async () => {
  const proc = new EventEmitter(); const server = fakeServer(); const exits = []; const logs = [];
  const h = shutdown.install(server, { proc, graceMs: 1000, flush: () => ({ saved: false, error: "ENOSPC" }), exit: (c) => exits.push(c), log: (l) => logs.push(l) });
  proc.emit("SIGTERM");
  server.closeCb();
  assert.deepStrictEqual(exits, [1]);
  assert.ok(logs.some((l) => /database save FAILED \(ENOSPC\)/.test(l)));
  h.uninstall();
  assert.strictEqual(shutdown.graceMs({}), 10000);
  assert.strictEqual(shutdown.graceMs({ SHUTDOWN_GRACE_MS: "2500" }), 2500);
  assert.strictEqual(shutdown.graceMs({ SHUTDOWN_GRACE_MS: "soon" }), 10000);
  assert.strictEqual(shutdown.graceMs({ SHUTDOWN_GRACE_MS: "-5" }), 10000);
});

test("live server: SIGTERM exits 0, the log says what happened, and the database on disk is whole and has the last write", async () => {
  const s = await live.start({ env: { SHUTDOWN_GRACE_MS: "4000" } });
  const email = "last-write@buyer.test";
  await s.register(email, { verify: false }); // a row written moments before the stop
  const exited = new Promise((resolve) => s.child.once("exit", (code, signal) => resolve({ code, signal })));
  const t0 = Date.now();
  s.child.kill("SIGTERM");
  const result = await exited;
  const took = Date.now() - t0;
  try {
    assert.deepStrictEqual(result, { code: 0, signal: null }, `exit: ${JSON.stringify(result)}\n${s.log().slice(-600)}`);
    assert.ok(took < 3000, `an idle server stops at once, not after the grace time (took ${took} ms)`);
    assert.ok(/SIGTERM received: no new connections/.test(s.log()));
    assert.ok(/Shutdown: all requests finished; database saved and flushed to disk/.test(s.log()));
    const dbFile = path.join(s.dataDir, "quoting.db");
    assert.ok(isSqlite(dbFile), "the file is a SQLite database");
    assert.ok(!fs.existsSync(`${dbFile}.tmp`), "no half-written temporary file is left");
    const rows = await readDb(dbFile, `SELECT email FROM users WHERE email = '${email}'`);
    assert.strictEqual(rows.length, 1, "the account created just before the stop is in the file");
    // The stop is on record for the next start.
    const state = JSON.parse(fs.readFileSync(path.join(s.dataDir, "ops", "state.json"), "utf8"));
    assert.strictEqual(state["run.current"].ended, "clean");
    // No new connection is accepted after the stop.
    await assert.rejects(live.request(s.port, { url: "/api/health", timeoutMs: 1000 }));
  } finally { await s.stop(); }
});

test("live server: a request in progress when SIGTERM arrives is answered before the process exits", async () => {
  const s = await live.start({ env: { SHUTDOWN_GRACE_MS: "8000" } });
  try {
    // A request whose body is still arriving: headers sent, half the body sent.
    const body = JSON.stringify({ email: "nobody@buyer.test", password: "not-the-password-1A" });
    const sock = net.connect(s.port, "127.0.0.1");
    await new Promise((r) => sock.once("connect", r));
    let answer = "";
    sock.on("data", (d) => { answer += d; });
    sock.write(`POST /api/auth/login HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body.slice(0, 10)}`);
    await sleep(150);
    const exited = new Promise((resolve) => s.child.once("exit", (code, signal) => resolve({ code, signal })));
    s.child.kill("SIGTERM");
    await sleep(400);
    assert.strictEqual(s.exited(), null, "the server waits for the open request");
    // New connections are refused while it waits.
    await assert.rejects(live.request(s.port, { url: "/api/health", timeoutMs: 1000 }));
    sock.write(body.slice(10)); // the rest of the body arrives
    const result = await exited;
    assert.ok(/^HTTP\/1\.1 401 /.test(answer), `the open request got its answer: ${answer.split("\r\n")[0]}`);
    assert.deepStrictEqual(result, { code: 0, signal: null });
    assert.ok(/Shutdown: all requests finished/.test(s.log()));
    sock.destroy();
  } finally { await s.stop(); }
});

// A process that saves a multi-megabyte database in a tight loop, the way the server does on every write.
const HAMMER = `
const fs = require("fs");
const database = require(${JSON.stringify(path.join(__dirname, "..", "models", "database"))});
(async () => {
  await database.ready;
  const db = database.getDatabase();
  db.run("CREATE TABLE IF NOT EXISTS hammer_marker (id INTEGER PRIMARY KEY, n INTEGER)");
  db.run("CREATE TABLE IF NOT EXISTS hammer_bulk (id INTEGER PRIMARY KEY, body TEXT)");
  db.run("INSERT OR REPLACE INTO hammer_marker (id, n) VALUES (1, 0)");
  const chunk = "x".repeat(1024 * 1024);
  for (let i = 0; i < 12; i++) db.run("INSERT INTO hammer_bulk (body) VALUES (?)", [chunk + i]);
  database.saveToDisk();
  let n = 0;
  if (process.env.HAMMER_HOOK === "1") {
    require(${JSON.stringify(path.join(__dirname, "shutdown"))}).install({ close: (cb) => setImmediate(cb), closeIdleConnections() {} }, {
      onStopped: () => fs.writeFileSync(process.env.HAMMER_OUT, String(n)),
      log: () => {},
    });
  }
  process.stdout.write("ready\\n");
  const step = () => {
    db.run("UPDATE hammer_marker SET n = ? WHERE id = 1", [n + 1]);
    database.saveToDisk(); // export + write to quoting.db.tmp + rename: all synchronous
    n += 1;
    setImmediate(step);
  };
  step();
})();
`;

function hammer({ hook, delayMs }) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(tmp, "hammer-"));
    const out = path.join(dir, "stopped-at.txt");
    const env = { ...process.env, QUOTING_DB_PATH: path.join(dir, "quoting.db"), QUOTING_DATA_DIR: dir, HAMMER_OUT: out, HAMMER_HOOK: hook ? "1" : "0", NODE_ENV: "test" };
    const child = spawn(process.execPath, ["-e", HAMMER], { env, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    child.stdout.on("data", (d) => { if (String(d).includes("ready")) setTimeout(() => child.kill("SIGTERM"), delayMs); });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ dir, code, signal, err, stoppedAt: fs.existsSync(out) ? Number(fs.readFileSync(out, "utf8")) : null }));
  });
}

test("SIGTERM during back-to-back saves of a 12 MB database: with the handler, the file always holds the last completed write", async () => {
  let saves = 0;
  for (const delayMs of [15, 40, 65, 90, 120, 160, 210, 260]) {
    const r = await hammer({ hook: true, delayMs });
    assert.deepStrictEqual({ code: r.code, signal: r.signal }, { code: 0, signal: null }, `delay ${delayMs}: ${r.err}`);
    const file = path.join(r.dir, "quoting.db");
    assert.ok(isSqlite(file), `delay ${delayMs}: a whole SQLite file`);
    assert.ok(!fs.existsSync(`${file}.tmp`), `delay ${delayMs}: no temporary file left behind`);
    const [[n]] = await readDb(file, "SELECT n FROM hammer_marker WHERE id = 1");
    assert.strictEqual(n, r.stoppedAt, `delay ${delayMs}: the file holds write ${r.stoppedAt}, the last one the process completed`);
    const [[bulk]] = await readDb(file, "SELECT COUNT(*) FROM hammer_bulk");
    assert.strictEqual(bulk, 12);
    saves += n;
  }
  assert.ok(saves >= 8, `the loop was really saving while it was stopped (${saves} saves across the runs)`);
});

test("without a handler the process dies wherever it is; the rename still leaves a whole (if older) database", async () => {
  let leftovers = 0;
  for (const delayMs of [20, 55, 95, 140, 190, 240]) {
    const r = await hammer({ hook: false, delayMs });
    assert.strictEqual(r.signal, "SIGTERM", "killed by the signal: nothing ran, nothing was flushed, no exit code");
    assert.strictEqual(r.stoppedAt, null);
    const file = path.join(r.dir, "quoting.db");
    assert.ok(isSqlite(file), `delay ${delayMs}: the previous save is still a whole file`);
    const [[n]] = await readDb(file, "SELECT n FROM hammer_marker WHERE id = 1");
    assert.ok(Number.isInteger(n) && n >= 0);
    if (fs.existsSync(`${file}.tmp`)) leftovers++; // a save was cut off mid-write
  }
  console.log(`       (${leftovers} of 6 kills landed inside a save and left a partial quoting.db.tmp behind)`);
});

run(() => fs.rmSync(tmp, { recursive: true, force: true }));
