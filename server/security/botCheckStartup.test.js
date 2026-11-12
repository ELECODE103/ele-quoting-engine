/**
 * Start-up requirement for the robot check, against the real server (server/index.js) in
 * production mode, and the rule itself. Run: `node server/security/botCheckStartup.test.js`
 *
 * Independent re-review 2026-11-12: with Turnstile off, three addresses could close the request
 * form and the per-address limits were only as good as the attacker's supply of addresses. In
 * production the server now refuses to start without the two keys, unless
 * ALLOW_LAUNCH_WITHOUT_BOT_CHECK=1 says the owner means it.
 */
const assert = require("assert");
const live = require("../testSupport/liveServer");
const { runner } = require("../testSupport/harness");
const { check } = require("./botCheckStartup");

const { test, run } = runner("Startup requirement for the robot check");

(async () => {
  test("the rule: production needs both keys or the explicit waiver; development and tests need neither", () => {
    const keys = { TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret" };
    assert.strictEqual(check({ NODE_ENV: "production", ...keys }).ok, true);
    assert.deepStrictEqual(check({ NODE_ENV: "production" }).missing, ["TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY"]);
    assert.strictEqual(check({ NODE_ENV: "production" }).ok, false);
    assert.strictEqual(check({ NODE_ENV: "production", TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "  " }).ok, false, "a blank value is not a key");
    for (const v of ["1", "true", "yes", "on"]) assert.strictEqual(check({ NODE_ENV: "production", ALLOW_LAUNCH_WITHOUT_BOT_CHECK: v }).ok, true);
    for (const v of ["", "0", "false", "no", "maybe"]) assert.strictEqual(check({ NODE_ENV: "production", ALLOW_LAUNCH_WITHOUT_BOT_CHECK: v }).ok, false, `"${v}" is not a yes`);
    assert.ok(/ROBOT CHECK IS OFF/.test(check({ NODE_ENV: "production", ALLOW_LAUNCH_WITHOUT_BOT_CHECK: "1" }).warning));
    for (const mode of [undefined, "development", "test"]) assert.deepStrictEqual([check({ NODE_ENV: mode }).ok, check({ NODE_ENV: mode }).warning], [true, ""], `NODE_ENV=${mode}`);
  });

  test("production refuses to start without the Turnstile keys, and says what to do in plain words", async () => {
    for (const env of [{ ALLOW_LAUNCH_WITHOUT_BOT_CHECK: "" }, { ALLOW_LAUNCH_WITHOUT_BOT_CHECK: "", TURNSTILE_SITE_KEY: "only-the-site-key" }]) {
      let error = null;
      try { const s = await live.start({ env }); await s.stop(); } catch (err) { error = err; }
      assert.ok(error, "the server started without the robot check");
      assert.strictEqual(error.exitCode, 1);
      assert.ok(/FATAL: Missing required environment variables: (TURNSTILE_SITE_KEY, )?TURNSTILE_SECRET_KEY/.test(error.output), error.output);
      assert.ok(/will not start/.test(error.output) && /Cloudflare dashboard/.test(error.output) && /ALLOW_LAUNCH_WITHOUT_BOT_CHECK=1/.test(error.output), "a plain explanation, with where to get the keys and how to waive it");
      assert.ok(!/only-the-site-key/.test(error.output), "no value of a variable is printed");
    }
  });

  test("with the waiver it starts and the log says, in capitals, that the check is off; with both keys it starts and says nothing of the kind", async () => {
    const waived = await live.start();
    try { assert.ok(/WARNING: THE ROBOT CHECK IS OFF/.test(waived.log())); assert.strictEqual((await waived.get("/api/health")).status, 200); } finally { await waived.stop(); }
    const keyed = await live.start({ env: { ALLOW_LAUNCH_WITHOUT_BOT_CHECK: "", TURNSTILE_SITE_KEY: "test-site-key-0123456789", TURNSTILE_SECRET_KEY: "test-secret-key-0123456789abcdef" } });
    try {
      const log = keyed.log();
      assert.ok(!/ROBOT CHECK IS OFF/.test(log) && !/test-secret-key/.test(log));
      assert.strictEqual((await keyed.get("/api/health")).status, 200);
    } finally { await keyed.stop(); }
  });

  await run();
  process.exit(process.exitCode || 0);
})();
