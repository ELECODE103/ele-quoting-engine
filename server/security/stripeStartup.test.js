/**
 * Startup requirements for payments, against the real server (server/index.js) in production
 * mode. Run: `node server/security/stripeStartup.test.js`
 *
 * Review F-18: the server used to start in production without STRIPE_WEBHOOK_SECRET, so a buyer
 * who paid and closed the tab stayed "awaiting payment" and the shop was never told. It now
 * refuses to start, says why in plain words, and never prints the value of a secret.
 * Also here: the startup log says plainly when the shop will get no order emails, and the
 * webhook, with a secret set, takes only events signed with it.
 */
const assert = require("assert");
const live = require("../testSupport/liveServer");
const { runner } = require("../testSupport/harness");

const { test, run } = runner("Startup requirements for payments (live server, production mode)");

(async () => {
  test("production refuses to start without STRIPE_WEBHOOK_SECRET, and says what to do", async () => {
    for (const value of ["", "   "]) {
      let error = null;
      try { const s = await live.start({ env: { STRIPE_WEBHOOK_SECRET: value } }); await s.stop(); } catch (err) { error = err; }
      assert.ok(error, `the server started with STRIPE_WEBHOOK_SECRET=${JSON.stringify(value)}`);
      assert.strictEqual(error.exitCode, 1);
      assert.ok(/FATAL: Missing required environment variables: STRIPE_WEBHOOK_SECRET/.test(error.output), error.output);
      assert.ok(/will not start/.test(error.output) && /Developers > Webhooks/.test(error.output) && /\/api\/stripe\/webhook/.test(error.output), "a plain explanation, with where to get the secret");
      assert.ok(!/sk_test_[0-9a-f]{8}/.test(error.output), "no secret value is printed");
    }
  });

  test("with the secret set it starts; the secret's value is never in the log; the log says the shop will get no order emails", async () => {
    const s = await live.start();
    try {
      const log = s.log();
      assert.ok(s.webhookSecret && s.webhookSecret.length > 20);
      assert.ok(!log.includes(s.webhookSecret) && !log.includes(s.webhookSecret.slice(6, 30)), "the signing secret is not logged");
      assert.ok(/THE SHOP WILL RECEIVE NO ORDER EMAILS/.test(log), "said plainly when the mailer is not configured");
      assert.ok(/New paid orders, purchase-order orders, payments that need attention, refunds and disputes/.test(log));
      assert.ok(/Payments: card checkout sessions stay open 120 minutes; promotion codes at checkout are off\./.test(log));

      // The webhook takes signed events only.
      const stripe = require("stripe")("sk_test_not_a_key_for_signing_only");
      const event = { id: "evt_startup_1", type: "checkout.session.completed", data: { object: { id: "cs_other_product", amount_total: 500, currency: "usd", payment_status: "paid", metadata: {} } } };
      const payload = JSON.stringify(event);
      const post = (headers) => s.req({ method: "POST", url: "/api/stripe/webhook", body: Buffer.from(payload), headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)), ...headers }, ip: "198.51.100.90" });
      assert.strictEqual((await post({})).status, 400, "unsigned");
      assert.strictEqual((await post({ "Stripe-Signature": stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_someone_elses_secret" }) })).status, 400, "signed with another secret");
      const good = await post({ "Stripe-Signature": stripe.webhooks.generateTestHeaderString({ payload, secret: s.webhookSecret }) });
      assert.deepStrictEqual([good.status, good.body.received, good.body.ignored], [200, true, "no-order-id"], "a signed event that is not one of our orders is acknowledged and ignored");
      const again = await post({ "Stripe-Signature": stripe.webhooks.generateTestHeaderString({ payload, secret: s.webhookSecret }) });
      assert.deepStrictEqual([again.status, again.body.duplicate], [200, true], "the same event id is not run twice");
      assert.ok(!s.log().includes(s.webhookSecret));
    } finally { await s.stop(); }
  });

  test("with the mailer configured the no-order-emails warning is not printed; a secret of the wrong shape is warned about by name only", async () => {
    const odd = "not-a-stripe-secret-0123456789abcdef";
    const s = await live.start({ env: { EMAIL_API_KEY: "re_test_not_a_key", EMAIL_FROM: "Straightedge <quotes@shop.test>", STRIPE_WEBHOOK_SECRET: odd, STRIPE_PROMOTION_CODES: "on", CHECKOUT_SESSION_MINUTES: "45" } });
    try {
      const log = s.log();
      assert.ok(!/NO ORDER EMAILS/.test(log));
      assert.ok(/STRIPE_WEBHOOK_SECRET does not look like a Stripe signing secret/.test(log));
      assert.ok(!log.includes(odd), "its value is not printed");
      assert.ok(/stay open 45 minutes; promotion codes at checkout are ON/.test(log), "the two payment switches are stated at startup");
    } finally { await s.stop(); }
  });

  test("outside production the server still starts without the secret, and refuses every webhook", async () => {
    const s = await live.start({ production: false, env: { STRIPE_WEBHOOK_SECRET: "", SE_TEST_HOOKS: "" } });
    try {
      const r = await s.req({ method: "POST", url: "/api/stripe/webhook", body: Buffer.from("{}"), headers: { "Content-Type": "application/json", "Content-Length": "2" }, ip: "198.51.100.91" });
      assert.strictEqual(r.status, 503);
    } finally { await s.stop(); }
  });

  await run();
})().catch((err) => { console.error(err); process.exit(1); });
