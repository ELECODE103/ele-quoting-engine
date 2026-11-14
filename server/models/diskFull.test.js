/**
 * A full disk is visible and says what it is (review of 2026-11-13, N-08).
 * Run: node server/models/diskFull.test.js
 *
 * Before: with the disk full the site answered 201 "created" for an account it could not save, the
 * health check said "ok", and after a restart the start-up check refused to start and told the
 * owner to restore a backup. Each case below fails on that code.
 *
 * The real server (server/index.js, production mode) as a child process. The disk is made "full"
 * for the database file by testSupport/fullDiskPreload.js while a flag file exists, so no real
 * small disk (and no root) is needed; tools/security/rereview-fixes/r4-full-disk.js runs the same
 * steps on a real 3 MB disk.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const live = require("../testSupport/liveServer");
const initSqlJs = require("sql.js");
const { runner } = require("../testSupport/harness");

const { test, run } = runner("A full disk: visible, named, and nothing acknowledged that was not saved");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const SQL = await initSqlJs();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "se-diskfull-"));
  const flag = path.join(tmp, "disk-is-full.flag");
  const dbFile = path.join(tmp, "data", "quoting.db");
  const env = {
    NODE_OPTIONS: `--require ${path.join(__dirname, "..", "testSupport", "fullDiskPreload.js")}`,
    SE_TEST_DISK_FULL_FLAG: flag,
    DB_SAVE_RETRY_MS: "300",     // how often a failed write is tried again (15 s in production)
    DB_DRAFT_FLUSH_MS: "100",
    EMAIL_OUTBOX_DIR: path.join(tmp, "outbox"),
  };
  const fill = () => fs.writeFileSync(flag, "full");
  const free = () => fs.rmSync(flag, { force: true });
  const onDisk = () => { const db = new SQL.Database(fs.readFileSync(dbFile)); try { const ok = db.exec("PRAGMA integrity_check")[0].values[0][0]; const u = db.exec("SELECT email FROM users")[0]; return { integrity: ok, users: u ? u.values.map((v) => v[0]) : [] }; } finally { db.close(); } };
  const registerRaw = (s, email, ip) => s.post("/api/auth/register", { email, password: "Aa1-xxxxxxxxxxxx", name: "Second" }, { ip, headers: { "X-Form-Token": s.formToken("register") } });
  let s;

  test("setup: the real server with one account saved while there is room", async () => {
    s = await live.start({ tmpDir: tmp, env });
    await s.register("first@customer.test", { ip: "198.18.5.1" });
    assert.deepStrictEqual(onDisk().users.includes("first@customer.test"), true);
    assert.strictEqual((await s.get("/api/health")).status, 200);
  });

  let bytesBefore;
  test("the disk fills: an account that cannot be saved is NOT answered 'created' (it was 201), in plain words and with no stack trace", async () => {
    bytesBefore = fs.readFileSync(dbFile);
    fill();
    const r = await registerRaw(s, "second@customer.test", "198.18.5.2");
    assert.deepStrictEqual([r.status, r.body && r.body.code], [503, "save-failed"], r.text.slice(0, 300));
    assert.strictEqual(r.body.error, "We could not save that just now, so it has not gone through. That is a fault on our side. Please try again in a few minutes.");
    assert.strictEqual(r.headers["retry-after"], "120");
    assert.ok(!/ENOSPC|\bat \/|node:|Error:|stack/i.test(r.text), r.text);
    assert.ok(!r.body.token, "no session is handed out for an account that was not saved");
    // The database file is byte for byte what it was, and holds no trace of the second account.
    assert.ok(fs.readFileSync(dbFile).equals(bytesBefore), "the database file was not touched");
    assert.deepStrictEqual(onDisk(), { integrity: "ok", users: ["first@customer.test"] });
    assert.strictEqual(fs.existsSync(`${dbFile}.tmp`), false, "no part-written temporary file is left holding the last free space");
    assert.ok(/DATABASE NOT SAVED/.test(s.log()) && /THE DISK IS FULL/.test(s.log()) && /The volume is full/.test(s.log()), "the log says what it is and where to read");
  });

  test("the health check stops saying 'ok' after a failed save (it said 200 'ok')", async () => {
    const h = await s.get("/api/health");
    assert.deepStrictEqual([h.status, h.body.status, h.headers["retry-after"]], [503, "unavailable", "30"]);
  });

  test("while it is full: pages that only read still answer; anything that has to be saved is refused the same way", async () => {
    assert.strictEqual((await s.get("/api/materials")).status, 200, "reading still works");
    // Signing in writes the time of the sign-in: refused, with the same sentence.
    const login = await s.post("/api/auth/login", { email: "first@customer.test", password: s.passwords["first@customer.test"] }, { ip: "198.18.5.1" });
    assert.deepStrictEqual([login.status, login.body.code], [503, "save-failed"], login.text.slice(0, 200));
    // The refused account was taken back out of memory too: asking again is refused again, not "already exists".
    const again = await registerRaw(s, "second@customer.test", "198.18.5.3");
    assert.deepStrictEqual([again.status, again.body.code], [503, "save-failed"], again.text.slice(0, 200));
    assert.strictEqual(s.exited(), null, "the server is still running");
  });

  test("space is freed: the site recovers by itself, the health check says 'ok' again, and a new account is saved", async () => {
    free();
    let h;
    for (let i = 0; i < 40; i++) { h = await s.get("/api/health"); if (h.status === 200) break; await sleep(100); }
    assert.strictEqual(h.status, 200, "health is 'ok' again within a few retries, with no restart and no request needed");
    assert.ok(/DATABASE SAVED AGAIN/.test(s.log()));
    const r = await registerRaw(s, "second@customer.test", "198.18.5.4");
    assert.strictEqual(r.status, 201, r.text.slice(0, 200));
    assert.ok(onDisk().users.includes("second@customer.test"), "and it is in the file");
  });

  test("a restart with the disk still full: the start is refused, the message says THE DISK IS FULL and to free space (it said 'restore the volume from its backup'), and the file is untouched", async () => {
    await s.stop({ keep: true });
    const before = fs.readFileSync(dbFile);
    fill();
    let refused = null;
    try { s = await live.start({ tmpDir: tmp, env }); await s.stop({ keep: true }); } catch (err) { refused = err; }
    assert.ok(refused, "the server does not start on a full disk");
    assert.strictEqual(refused.exitCode, 1);
    const fatal = String(refused.output).split("\n").filter((l) => /^FATAL/.test(l));
    assert.strictEqual(fatal.length, 1, String(refused.output).slice(-600));
    assert.ok(/THE DISK IS FULL/.test(fatal[0]) && /Free space on the volume/.test(fatal[0]) && /make the volume larger/.test(fatal[0]), fatal[0]);
    assert.ok(/was read and is whole/.test(fatal[0]) && /Do NOT restore from a backup and do NOT delete the database file/.test(fatal[0]), fatal[0]);
    assert.ok(!/Restore the volume from its backup/.test(fatal[0]), "it no longer tells the owner to restore");
    assert.ok(fs.readFileSync(dbFile).equals(before), "the database file is byte for byte what it was");
    assert.strictEqual(fs.existsSync(`${dbFile}.tmp`), false);
  });

  test("the earlier fix is not weakened: with the disk full, a zero-length or truncated database is still refused as unusable and is never written over", async () => {
    const good = fs.readFileSync(dbFile);
    for (const [label, bytes, said] of [["zero-length", Buffer.alloc(0), /the file is empty \(0 bytes\)/], ["truncated", good.subarray(0, Math.floor(good.length / 3)), /cannot be used/]]) {
      fs.writeFileSync(dbFile, bytes);
      for (const full of [true, false]) {
        if (full) fill(); else free();
        let refused = null;
        try { const x = await live.start({ tmpDir: tmp, env }); await x.stop({ keep: true }); } catch (err) { refused = err; }
        assert.ok(refused && refused.exitCode === 1, `${label}, disk ${full ? "full" : "with room"}: refused`);
        const fatal = String(refused.output).split("\n").filter((l) => /^FATAL/.test(l)).join("\n");
        assert.ok(said.test(fatal) && /Restore the volume from its backup; do not delete the file/.test(fatal) && !/THE DISK IS FULL/.test(fatal), `${label}: ${fatal}`);
        assert.ok(fs.readFileSync(dbFile).equals(bytes), `${label}: the file was not written over`);
      }
    }
    fs.writeFileSync(dbFile, good);
  });

  test("room again: the server starts, the health check is 'ok', and both accounts are there", async () => {
    free();
    s = await live.start({ tmpDir: tmp, env });
    assert.strictEqual((await s.get("/api/health")).status, 200);
    assert.deepStrictEqual(onDisk().users.sort(), ["first@customer.test", "second@customer.test"]);
  });

  await run(async () => { try { await s.stop(); } catch { /* gone */ } fs.rmSync(tmp, { recursive: true, force: true }); });
})().catch((err) => { console.error(err); process.exit(1); });
