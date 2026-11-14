#!/usr/bin/env node
/**
 * Review conditions (2026-11-13), N-08: a full disk is visible and says what it is.
 * The reviewer's r3-full-disk.js records what happens; this one says what SHOULD happen and checks it.
 *
 *   mkdir /tmp/small && mount -t tmpfs -o size=3m tmpfs /tmp/small     (a 3 MB disk; needs root)
 *   node tools/security/rereview-fixes/r4-full-disk.js /tmp/small
 *
 * The real server (production mode) with its data folder on the small disk, then:
 *   1. an account is made while there is room
 *   2. the disk is filled to the last few kB
 *   3. a second account is asked for: it must NOT be answered "created"; the words must be plain
 *   4. the health check must stop answering "ok"; a page that only reads must still answer
 *   5. room is made WITHOUT a restart: the health check must answer "ok" again by itself, and the
 *      second account can then be made and is in the file
 *   6. the disk is filled again and the server restarted: the start must be refused with a message
 *      that says the disk is full and to free space, and must not say "restore"
 *   7. room is made and the server started: both accounts are there
 * Exit code 0 when every check holds.
 */
const fs = require("fs");
const path = require("path");
const live = require("../../../server/testSupport/liveServer");
const initSqlJs = require("../../../node_modules/sql.js");

const DISK = process.argv[2];
if (!DISK || !fs.existsSync(DISK)) { console.error("usage: r4-full-disk.js <folder on a small disk>"); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const SQL = await initSqlJs();
  const tmp = path.join(DISK, "site");
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const dbFile = path.join(tmp, "data", "quoting.db");
  const filler = path.join(tmp, "filler.bin");
  const env = { EMAIL_OUTBOX_DIR: path.join(require("os").tmpdir(), `r4-outbox-${process.pid}`), DB_SAVE_RETRY_MS: "1000" };
  const readDb = () => { const db = new SQL.Database(fs.readFileSync(dbFile)); const ok = db.exec("PRAGMA integrity_check")[0].values[0][0]; const users = db.exec("SELECT email FROM users")[0]; const out = { integrity: ok, users: users ? users.values.map((v) => v[0]) : [] }; db.close(); return out; };
  const fill = () => { const chunk = Buffer.alloc(4096, 1); const fd = fs.openSync(filler, "a"); let n = 0; try { for (;;) { fs.writeSync(fd, chunk); n += chunk.length; } } catch (err) { /* full */ } finally { fs.closeSync(fd); } return n; };
  const register = (s, email, ip) => s.post("/api/auth/register", { email, password: "Aa1-xxxxxxxxxxxx", name: "Second" }, { ip, headers: { "X-Form-Token": s.formToken("register") } });
  let held = 0, failed = 0;
  const check = (ok, what, detail = "") => { if (ok) held++; else failed++; console.log(`  ${ok ? "HOLDS  " : "FINDING"}  ${what}${detail ? ` :: ${detail}` : ""}`); };

  let s = await live.start({ tmpDir: tmp, env });
  try {
    await s.register("first@customer.test", { ip: "198.18.5.1" });
    await sleep(1800);
    const fileBefore = fs.readFileSync(dbFile);
    const filled = fill();
    console.log(`\nthe disk is full (${filled} bytes of filler; database ${fileBefore.length} bytes)`);
    const r = await register(s, "second@customer.test", "198.18.5.2");
    check(r.status === 503 && r.body && r.body.code === "save-failed", "an account that cannot be saved is not answered 'created'", `${r.status} ${String(r.text).slice(0, 170)}`);
    check(!/ENOSPC|node:|\bat \/|stack/i.test(r.text), "the answer is plain words: no error code of the system, no stack trace");
    const health = await s.get("/api/health", {});
    check(health.status === 503, "the health check stops answering 'ok'", `${health.status} ${health.text.slice(0, 80)}`);
    const read = await s.get("/api/materials", {});
    check(read.status === 200, "a page that only reads still answers", `${read.status}`);
    check(fs.readFileSync(dbFile).equals(fileBefore) && !fs.existsSync(`${dbFile}.tmp`), "the database file is byte for byte what it was, and no part-written copy is left on the disk");
    check(/THE DISK IS FULL/.test(s.log()), "the log says the disk is full", (s.log().split("\n").find((l) => /DATABASE NOT SAVED/.test(l)) || "").slice(0, 200));

    // Room, without a restart.
    fs.rmSync(filler, { force: true });
    let back = null;
    const t0 = Date.now();
    for (let i = 0; i < 60; i++) { back = await s.get("/api/health", {}); if (back.status === 200) break; await sleep(250); }
    check(back.status === 200, "with room again the health check answers 'ok' by itself (no restart, no request needed)", `after ${Date.now() - t0} ms (retry every 1 s in this run; 15 s in production)`);
    const r2 = await register(s, "second@customer.test", "198.18.5.3");
    check(r2.status === 201 && readDb().users.includes("second@customer.test"), "the second account can now be made and is in the file", `${r2.status}; in the file: ${readDb().users.join(", ")}`);
    await s.stop({ keep: true });

    // Full again, and a restart.
    fill();
    const fileFull = fs.readFileSync(dbFile);
    let refused = null;
    try { s = await live.start({ tmpDir: tmp, env }); await s.stop({ keep: true }); } catch (err) { refused = err; }
    const fatal = refused ? String(refused.output || refused.message).split("\n").filter((l) => /^FATAL/.test(l)) : [];
    check(Boolean(refused) && refused.exitCode === 1, "a restart with the disk full is refused (exit 1): the site does not start on a disk it cannot write");
    check(fatal.length === 1 && /THE DISK IS FULL/.test(fatal[0]) && /Free space on the volume/.test(fatal[0]) && /make the volume larger/.test(fatal[0]) && !/Restore the volume from its backup/.test(fatal[0]), "the refusal says the disk is full and to free space or enlarge the volume, and does not say 'restore'", (fatal[0] || "").slice(0, 700));
    check(fs.readFileSync(dbFile).equals(fileFull) && readDb().integrity === "ok", "the database file is untouched and whole after the refused start");

    // Room again.
    fs.rmSync(filler, { force: true });
    s = await live.start({ tmpDir: tmp, env });
    const end = readDb();
    check((await s.get("/api/health", {})).status === 200 && end.users.includes("first@customer.test") && end.users.includes("second@customer.test"), "with room the server starts and both accounts are there", end.users.join(", "));
    console.log(`\n${held} held, ${failed} findings`);
    process.exitCode = failed ? 1 : 0;
  } finally { try { await s.stop(); } catch { /* gone */ } }
})().catch((e) => { console.error(e); process.exit(2); });
