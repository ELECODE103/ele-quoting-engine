#!/usr/bin/env node
/**
 * Second re-review (2026-11-13), F-04's new question: the start now REFUSES on a database it cannot use.
 * Can a full disk put the site into a state where it will not start, or damage the database file?
 *
 *   mkdir /tmp/small && mount -t tmpfs -o size=3m tmpfs /tmp/small     (a 3 MB disk; needs root)
 *   node tools/security/rereview-fixes/r3-full-disk.js /tmp/small
 *
 * The real server (production mode) with its data folder on the small disk:
 *   1. an account is made while there is room
 *   2. the disk is filled to the last few kB (a filler file stands in for uploads, backups, logs)
 *   3. a change that must be saved is asked for (a second account): what is the buyer told, and does
 *      the health check still say "ok"?
 *   4. the database file on the disk: still whole, still holding the first account?
 *   5. the server is stopped and started again WITH THE DISK STILL FULL: does it start? what does it say?
 *   6. the filler is removed and the server started again: is everything from step 1 there?
 */
const fs = require("fs");
const path = require("path");
const live = require("../../../server/testSupport/liveServer");
const initSqlJs = require("../../../node_modules/sql.js");

const DISK = process.argv[2];
if (!DISK || !fs.existsSync(DISK)) { console.error("usage: r3-full-disk.js <folder on a small disk>"); process.exit(2); }

(async () => {
  const SQL = await initSqlJs();
  const tmp = path.join(DISK, "site");
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const dbFile = path.join(tmp, "data", "quoting.db");
  const filler = path.join(tmp, "filler.bin");
  const readDb = () => { const db = new SQL.Database(fs.readFileSync(dbFile)); const ok = db.exec("PRAGMA integrity_check")[0].values[0][0]; const users = db.exec("SELECT email FROM users")[0]; const out = { integrity: ok, users: users ? users.values.map((v) => v[0]) : [] }; db.close(); return out; };
  const fill = () => { const chunk = Buffer.alloc(4096, 1); const fd = fs.openSync(filler, "a"); let n = 0; try { for (;;) { fs.writeSync(fd, chunk); n += chunk.length; } } catch (err) { /* full */ } finally { fs.closeSync(fd); } return n; };
  const out = {};
  let s = await live.start({ tmpDir: tmp, env: { EMAIL_OUTBOX_DIR: path.join(require("os").tmpdir(), `r3-outbox-${process.pid}`) } });
  try {
    await s.register("first@customer.test", { ip: "198.18.5.1" });
    await new Promise((r) => setTimeout(r, 1800));
    out.before = { dbBytes: fs.statSync(dbFile).size, ...readDb() };
    out.fillerBytes = fill();
    // A change that has to reach the file: a second account.
    const r = await s.post("/api/auth/register", { email: "second@customer.test", password: "Aa1-xxxxxxxxxxxx", name: "Second" }, { ip: "198.18.5.2", headers: { "X-Form-Token": s.formToken("register") } });
    out.registerWhenFull = { status: r.status, body: String(r.text).slice(0, 160) };
    const again = await s.post("/api/auth/login", { email: "first@customer.test", password: s.passwords["first@customer.test"] }, { ip: "198.18.5.1" });
    out.loginWhenFull = again.status;
    out.healthWhenFull = (await s.get("/api/health", {})).status;
    out.onDiskWhenFull = { dbBytes: fs.statSync(dbFile).size, tmpFileBytes: fs.existsSync(`${dbFile}.tmp`) ? fs.statSync(`${dbFile}.tmp`).size : null, ...readDb() };
    out.serverSaid = s.log().split("\n").filter((l) => /ENOSPC|no space|could not|save|FATAL|error/i.test(l)).slice(-5).map((l) => l.slice(0, 200));
    await s.stop({ keep: true });
    out.afterStopStillFull = readDb();
    // Start again with the disk still full.
    try {
      s = await live.start({ tmpDir: tmp, env: { EMAIL_OUTBOX_DIR: path.join(require("os").tmpdir(), `r3-outbox-${process.pid}`) } });
      out.startWhenFull = { started: true, health: (await s.get("/api/health", {})).status };
      await s.stop({ keep: true });
    } catch (err) {
      out.startWhenFull = { started: false, exitCode: err.exitCode, said: String(err.output || err.message).split("\n").filter((l) => /FATAL|cannot be used|ENOSPC|no space|Failed to initialize/i.test(l)).slice(0, 3).map((l) => l.slice(0, 420)) };
    }
    out.afterRefusedStart = readDb();
    // Room again.
    fs.rmSync(filler, { force: true });
    try {
      s = await live.start({ tmpDir: tmp, env: { EMAIL_OUTBOX_DIR: path.join(require("os").tmpdir(), `r3-outbox-${process.pid}`) } });
      const login = await s.post("/api/auth/login", { email: "first@customer.test", password: s.passwords ? undefined : undefined }, {});
      out.startWithRoom = { started: true, health: (await s.get("/api/health", {})).status, ...readDb() };
    } catch (err) { out.startWithRoom = { started: false, said: String(err.output || err.message).slice(0, 400) }; }
    console.log(JSON.stringify(out, null, 1));
    const damaged = [out.onDiskWhenFull, out.afterStopStillFull, out.afterRefusedStart].some((d) => d.integrity !== "ok" || !d.users.includes("first@customer.test"));
    console.log(damaged ? "FINDING: the database file was damaged or lost an account when the disk filled" : "HOLDS: the database file stayed whole and kept the first account through a full disk");
    console.log(out.startWhenFull.started ? "HOLDS: the server starts on a full disk" : `NOTE: with the disk full the server does NOT start (exit ${out.startWhenFull.exitCode}); it starts again once there is room: ${Boolean(out.startWithRoom.started)}`);
    process.exitCode = damaged ? 1 : 0;
  } finally { try { await s.stop(); } catch { /* gone */ } }
})().catch((e) => { console.error(e); process.exit(2); });
