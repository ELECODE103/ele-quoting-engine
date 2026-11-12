/**
 * An existing shop database keeps its admin (independent review 2026-11-11, F3).
 * Run: node server/routes/adminExisting.test.js
 *
 * The admin account is now made by a one-time setup. A shop that already has one — created by the
 * code on origin/master, where registering the ADMIN_EMAIL address gave the role — must come through
 * the upgrade untouched: same role, same password, straight into the forced two-step enrolment, and
 * the setup route closed even to someone holding the right code.
 *
 * The database is built here in master's own schema (testSupport/masterSchema.js, read back from a
 * database that code created) with passwords made at run time, then the real server is started on it.
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const initSqlJs = require("sql.js");
const { runner } = require("../testSupport/harness");
const live = require("../testSupport/liveServer");
const masterSchema = require("../testSupport/masterSchema");

const { test, run } = runner("Admin account: an existing database is left alone (live server)");
const pw = () => `Aa1-${crypto.randomBytes(9).toString("base64url")}`;
const ADMIN = "owner@shop.test"; // the address liveServer sets as ADMIN_EMAIL
const BUYER = "buyer@example.test";
const adminPassword = pw();
const buyerPassword = pw();
const rows = {};

async function readUsers(dataDir) {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(path.join(dataDir, "quoting.db")));
  const r = db.exec("SELECT * FROM users ORDER BY email")[0];
  db.close();
  return Object.fromEntries(r.values.map((v) => { const o = Object.fromEntries(r.columns.map((c, i) => [c, v[i]])); return [o.email, o]; }));
}

async function masterDatabase(dataDir) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  for (const sql of masterSchema) db.run(sql);
  const at = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  for (const [email, password, role, name] of [[ADMIN, adminPassword, "admin", "Owner"], [BUYER, buyerPassword, "customer", "Buyer"]]) {
    rows[email] = { id: crypto.randomUUID(), hash: bcrypt.hashSync(password, 10) };
    db.run("INSERT INTO users (id, email, password_hash, name, company, phone, role, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      [rows[email].id, email, rows[email].hash, name, "", "", role, at, at]);
  }
  fs.writeFileSync(path.join(dataDir, "quoting.db"), Buffer.from(db.export()));
  db.close();
}

(async () => {
  let s;
  const ip = "203.0.113.61";

  test("the server starts on a database made by the old code and says the admin is there and setup is closed", async () => {
    s = await live.start({ prepare: masterDatabase });
    assert.strictEqual(s.exited(), null, s.log());
    const log = s.log();
    assert.match(log, /Admin account .* present/);
    assert.match(log, /ADMIN_SETUP_CODE is still set[^\n]*remove it/i);
    assert.doesNotMatch(log, /setup is OPEN/i);
    assert.ok(!log.includes(s.setupCode), "the setup code is never written to the log");
  });

  test("the admin signs in with the password he already had, is still the admin, and is taken to two-step enrolment as before", async () => {
    const r = await s.post("/api/auth/login", { email: ADMIN, password: adminPassword }, { ip });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.body.user.role, r.body.user.twoFactorEnabled, r.body.user.twoFactorRequired], ["admin", false, true]);
    const admin = await s.get("/api/admin/materials", { token: r.body.token, ip });
    assert.deepStrictEqual([admin.status, admin.body.code], [403, "two-factor-enrolment-required"]);
    const begin = await s.post("/api/auth/2fa/setup", { password: adminPassword }, { token: r.body.token, ip });
    assert.strictEqual(begin.status, 200, `enrolment is reachable: ${begin.text.slice(0, 200)}`);
  });

  test("an ordinary customer from the old database signs in as before and is not an admin", async () => {
    const r = await s.post("/api/auth/login", { email: BUYER, password: buyerPassword }, { ip });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.user.role, "customer");
    const admin = await s.get("/api/admin/materials", { token: r.body.token, ip });
    assert.strictEqual(admin.status, 403);
  });

  test("the setup route is closed while that admin exists: the right code gets the same refusal as a wrong one, and changes nothing", async () => {
    const right = await s.post("/api/auth/admin-setup", { code: s.setupCode, password: pw() }, { ip: "203.0.113.62" });
    const wrong = await s.post("/api/auth/admin-setup", { code: `setup-${crypto.randomBytes(18).toString("base64url")}`, password: pw() }, { ip: "203.0.113.63" });
    assert.deepStrictEqual([right.status, right.body.code], [403, "setup-refused"]);
    assert.deepStrictEqual([wrong.status, wrong.body], [right.status, right.body]);
    const again = await s.post("/api/auth/login", { email: ADMIN, password: adminPassword }, { ip });
    assert.strictEqual(again.status, 200, "the old password still works after the attempts");
  });

  test("on disk the two accounts are what they were: same ids, same roles, same password hashes, no setup mark", async () => {
    await s.stop({ keep: true });
    const users = await readUsers(s.dataDir);
    assert.deepStrictEqual(Object.keys(users).sort(), [BUYER, ADMIN].sort());
    for (const [email, role] of [[ADMIN, "admin"], [BUYER, "customer"]]) {
      assert.strictEqual(users[email].id, rows[email].id);
      assert.strictEqual(users[email].role, role);
      assert.strictEqual(users[email].password_hash, rows[email].hash);
      assert.ok(!users[email].setup_code_mac, "no setup code was ever used on this account");
    }
    fs.rmSync(s.tmp, { recursive: true, force: true });
  });

  await run();
})().catch((e) => { console.error(e); process.exit(1); });
