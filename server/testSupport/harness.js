/**
 * Test harness for the route suites: a throwaway SQLite file, the real routes
 * on an ephemeral port, Stripe stubbed at the boundary (services/stripeClient)
 * and every email captured instead of sent.
 *
 *   const h = await require("../testSupport/harness").start();
 *   const r = await h.post("/api/quote", { parts: [...] }, token);
 *   h.sent      → emails captured: [{ to, subject, text, html, replyTo }]
 *   h.stripe    → { created: [...sessions.create args], sessions: { id: session }, failNext,
 *                   customers: [...customers.create args], taxRate (for sessions with automatic_tax), failCustomer }
 *   await h.stop();
 *
 * Bot check: Cloudflare Turnstile is switched on with throwaway keys made at
 * start-up and the siteverify call stubbed (h.turnstile). The helpers behave
 * like a person using the site: h.register passes the check, waits out the
 * minimum form time (with a back-dated form token) and confirms the emailed
 * link; uploads and pricing carry a verified-human token; h.form("/api/rfq")
 * carries a passed check. `h.raw(...)` sends exactly what it is given, for the
 * tests of what happens without those.
 *
 *   start({ turnstile: "off" })       no keys: the bot check is not configured
 *   start({ mailer: "configured" })   EMAIL_* set (sends are still captured), so
 *                                     email confirmation is enforced
 *   h.turnstile → { calls: [...], mode: "pass" | "fail" | "down" }
 *   h.admin()                         the owner's account as the owner sets it up: registered, email
 *                                     confirmed, two-step sign-in switched on (it is required for the
 *                                     admin role). Returns a session token with the admin role.
 *   h.adminLogin()                    sign in to that account again: password and a current code
 *   h.ip = "203.0.113.7"              pin the caller's address (default: a new one per call)
 *   h.limits = true                   keep the form limits counting across h.form("/api/rfq") calls
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const totp = require("../security/totp");

// A password that passes the rules in server/security/passwords.js. Made per run; not a real credential.
const PASSWORD = `Tt9-${crypto.randomBytes(9).toString("base64url")}`;

async function start(opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "se-test-"));
  process.env.QUOTING_DB_PATH = path.join(tmp, "quoting.db");
  // Uploads, drawings and part payload files of a suite go to its own throwaway folder (removed by
  // h.stop()), not to the repository's data folder. A suite that set its own folder keeps it.
  if (!process.env.QUOTING_DATA_DIR) process.env.QUOTING_DATA_DIR = path.join(tmp, "data");
  process.env.JWT_SECRET = "test-secret";
  process.env.ADMIN_EMAIL = "owner@shop.test";
  process.env.FRONTEND_URL = "https://shop.test";
  delete process.env.EMAIL_API_KEY;
  delete process.env.EMAIL_FROM;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.ADMIN_RECOVERY;
  process.env.NODE_ENV = "test";
  // The explicit test switch (security/testHooks.js): the suites post Stripe webhooks without a signature.
  process.env.SE_TEST_HOOKS = "1";
  if (opts.mailer === "configured") {
    // Nothing is sent: mailer.send is replaced below. This only makes mailer.configured() true.
    process.env.EMAIL_API_KEY = "test-not-a-key";
    process.env.EMAIL_FROM = "Straightedge <quotes@shop.test>";
  }

  // Turnstile: throwaway keys and a stubbed siteverify.
  const turnstileStub = { calls: [], mode: "pass" };
  const turnstileOn = opts.turnstile !== "off";
  if (turnstileOn) {
    process.env.TURNSTILE_SITE_KEY = `test-site-${crypto.randomBytes(6).toString("hex")}`;
    process.env.TURNSTILE_SECRET_KEY = `test-secret-${crypto.randomBytes(12).toString("hex")}`;
  } else {
    delete process.env.TURNSTILE_SITE_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
  }
  require("../security/turnstile").setFetchForTests(async (url, init) => {
    const body = new URLSearchParams(String(init.body));
    const token = body.get("response");
    turnstileStub.calls.push({ url, token, remoteip: body.get("remoteip"), secretSent: body.get("secret") === process.env.TURNSTILE_SECRET_KEY });
    if (turnstileStub.mode === "down") throw new Error("network down");
    const pass = turnstileStub.mode === "pass" && token.startsWith("pass");
    return { ok: true, json: async () => (pass ? { success: true, hostname: "shop.test" } : { success: false, "error-codes": ["invalid-input-response"] }) };
  });

  // Captured mail.
  const mailer = require("../services/mailer");
  const sent = [];
  mailer.send = async (m) => { sent.push(m); return false; };

  // Stripe stub: records what would be sent to Stripe, hands back a fake session.
  // Stripe Tax, as far as this code can tell: a session created with automatic_tax gets tax at
  // stripe.taxRate (7% unless a test sets another) on every line that is not sent as nontaxable,
  // and none for a Customer marked exempt. stripe.customers holds the Customers "created";
  // stripe.failCustomer makes the next one fail the way Stripe refuses an address it cannot place.
  const stripe = { created: [], sessions: {}, failNext: false, customers: [], taxRate: 0.07, failCustomer: false };
  require("../services/stripeClient").setForTests({
    customers: {
      create: async (args) => {
        if (stripe.failCustomer) { stripe.failCustomer = false; throw Object.assign(new Error("customer location invalid"), { code: "customer_tax_location_invalid" }); }
        const customer = { id: `cus_test_${stripe.customers.length + 1}`, ...args };
        stripe.customers.push(customer);
        return customer;
      },
    },
    checkout: {
      sessions: {
        create: async (args) => {
          if (stripe.failNext) { stripe.failNext = false; throw new Error("stripe unavailable"); }
          const id = `cs_test_${stripe.created.length + 1}`;
          stripe.created.push(args);
          // What Stripe would charge: every line (the order, plus the inspection paperwork when it was ordered).
          const amount = args.line_items.reduce((sum, li) => sum + li.price_data.unit_amount * (li.quantity || 1), 0);
          stripe.sessions[id] = { id, url: `https://checkout.stripe.test/${id}`, payment_status: "unpaid", currency: "usd", amount_total: amount, amount_subtotal: amount, metadata: args.metadata };
          if (args.automatic_tax && args.automatic_tax.enabled) {
            const customer = stripe.customers.find((c) => c.id === args.customer);
            const taxable = args.line_items.filter((li) => li.price_data.product_data.tax_code !== "txcd_00000000").reduce((sum, li) => sum + li.price_data.unit_amount * (li.quantity || 1), 0);
            const tax = customer && customer.tax_exempt === "exempt" ? 0 : Math.round(taxable * stripe.taxRate);
            Object.assign(stripe.sessions[id], { amount_total: amount + tax, customer: args.customer, total_details: { amount_tax: tax, amount_discount: 0, amount_shipping: 0 } });
          }
          return stripe.sessions[id];
        },
        retrieve: async (id) => stripe.sessions[id],
      },
    },
  });

  const express = require("express");
  const { ready } = require("../models/database");
  await ready;
  require("../config/seed").seedDatabase();
  const api = require("../routes/api");
  api.loadPricingRules();

  const app = express();
  app.set("trust proxy", 1); // one proxy hop, as in production: each call can come from its own address (X-Forwarded-For)
  app.use("/api/stripe/webhook", express.raw({ type: "application/json" }), require("../routes/stripeWebhook"));
  app.use(express.json());
  require("../security").mount(app);
  app.use("/api", api);
  app.use("/api/auth", require("../routes/auth"));
  app.use("/api/orders", require("../routes/orders"));
  app.use("/api/rfq", require("../routes/rfq"));
  app.use("/api/pdf", require("../routes/pdf"));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const botGuard = require("../security/botGuard");
  let ipSeq = 0;
  const nextIp = () => { ipSeq++; return `198.51.${Math.floor(ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`; };
  /** A form token issued ten seconds ago, as if a person had been filling the form in. */
  const formToken = (form, agoMs = 10000) => botGuard.issueFormToken(form, { now: Date.now() - agoMs });

  /** Send exactly this request: no token, header or address is added. */
  async function raw(method, url, { headers = {}, json, body, token, ip } = {}) {
    const hdrs = { "X-Forwarded-For": ip || h.ip || nextIp(), ...headers };
    if (token) hdrs.Authorization = `Bearer ${token}`;
    let payload = body;
    if (json !== undefined) { hdrs["Content-Type"] = "application/json"; payload = JSON.stringify(json); }
    const res = await fetch(base + url, { method, headers: hdrs, body: payload, redirect: "manual" });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed, text, headers: res.headers };
  }

  /** A request as the site's own pages send it: the verified-human token rides along. */
  async function call(method, url, body, token, rawBody, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (h.humanToken) headers["X-Human-Token"] = h.humanToken;
    return raw(method, url, { headers, json: rawBody ? undefined : body, body: rawBody, token });
  }

  const h = {
    base, sent, stripe, tmp,
    models: require("../models"),
    get: (url, token) => call("GET", url, undefined, token),
    post: (url, body, token) => call("POST", url, body, token),
    put: (url, body, token) => call("PUT", url, body, token),
    del: (url, token) => call("DELETE", url, undefined, token),
    /** multipart POST: files = { field: { name, data } } */
    form: (url, fields = {}, files = {}, token) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      for (const [k, f] of Object.entries(files)) fd.append(k, new Blob([f.data]), f.name);
      // The request form, as a person sends it: check passed, form open for a few seconds.
      // These suites send many requests from one address inside a second; the hourly and daily
      // limits are tested on their own (h.limits = true keeps the counters running).
      if (url === "/api/rfq" && !h.limits) botGuard.resetForTests();
      const headers = url === "/api/rfq" ? { "X-Form-Token": formToken("rfq"), ...(turnstileOn ? { "X-Turnstile-Token": "pass-rfq" } : {}) } : {};
      return call("POST", url, undefined, token, fd, headers);
    },
    raw,
    formToken,
    password: PASSWORD,
    turnstile: turnstileStub,
    humanToken: "",
    ip: "",
    limits: false,
    /**
     * Create an account the way a person does: bot check passed, a few seconds
     * on the form, then the emailed link confirmed. Returns the session token.
     * `{ verify: false }` leaves the address unconfirmed.
     */
    async register(email, name = "Test Buyer", { verify = true, password = PASSWORD } = {}) {
      const r = await raw("POST", "/api/auth/register", {
        json: { email, password, name },
        headers: { "X-Form-Token": formToken("register"), ...(turnstileOn ? { "X-Turnstile-Token": "pass-register" } : {}) },
      });
      if (r.status !== 201) throw new Error(`register failed: ${r.text}`);
      if (verify) await h.confirmEmail(email);
      return r.body.token;
    },
    /** Open the confirmation link that was emailed to `email` (and take that email out of h.sent). */
    async confirmEmail(email) {
      const i = sent.findIndex((m) => m.to === email && /confirm your email/i.test(m.subject));
      if (i < 0) throw new Error(`no confirmation email captured for ${email}`);
      const [mail] = sent.splice(i, 1);
      const token = (mail.text.match(/#token=(\S+)/) || [])[1];
      const v = await raw("POST", "/api/auth/verify-email", { json: { token } });
      if (v.status !== 200) throw new Error(`verify failed: ${v.text}`);
      return v.body;
    },
    async login(email, password = PASSWORD, extra = {}) {
      const r = await raw("POST", "/api/auth/login", { json: { email, password, ...extra } });
      if (r.status !== 200) throw new Error(`login failed: ${r.text}`);
      return r.body.token;
    },
    /**
     * The owner's account, set up the way the owner does it: register the
     * ADMIN_EMAIL address, confirm the emailed link (that is what gives the
     * admin role), then switch two-step sign-in on — without it every admin
     * route answers 403. Returns the session token issued at enrolment.
     * `{ enrol: false }` stops before the second step.
     */
    async admin(name = "Owner", { password = PASSWORD, enrol = true } = {}) {
      const email = process.env.ADMIN_EMAIL;
      let token = await h.register(email, name, { password });
      if (!enrol) return token;
      // The role came with the confirmation; this session predates it but the role is read from the database.
      const setup = await raw("POST", "/api/auth/2fa/setup", { json: { password }, token });
      if (setup.status !== 200) throw new Error(`2fa setup failed: ${setup.text}`);
      h.adminSecret = setup.body.setupKey.replace(/\s/g, "");
      const enabled = await raw("POST", "/api/auth/2fa/enable", { json: { code: totp.codeAt(h.adminSecret) }, token });
      if (enabled.status !== 200) throw new Error(`2fa enable failed: ${enabled.text}`);
      h.adminPassword = password;
      // The "two-step sign-in is on" notice is the owner's own doing: not part of what a suite counts.
      for (let i = sent.length - 1; i >= 0; i--) if (sent[i].to === email && /two-step sign-in/i.test(sent[i].subject)) sent.splice(i, 1);
      return enabled.body.token;
    },
    /**
     * Sign in to the owner's account again: password, then the authenticator's
     * current code. A code is accepted once per 30-second step, and suites sign
     * in many times a second, so the stored "last step used" is cleared first —
     * the same as the owner waiting for the next code.
     */
    async adminLogin() {
      const email = process.env.ADMIN_EMAIL;
      const row = h.models.usersDB.getAll().find((u) => u.email === email);
      if (!row || !h.adminSecret) throw new Error("adminLogin: call h.admin() first");
      h.models.usersDB.update(row.id, { totpLastStep: null });
      return h.login(email, h.adminPassword, { totp: totp.codeAt(h.adminSecret) });
    },
    /** Upload the 20 mm cube and return its partId. */
    async uploadCube() {
      const data = fs.readFileSync(path.join(__dirname, "..", "..", "tools", "vet-quotes", "parts", "cube_20mm.stl"));
      const r = await h.form("/api/upload", {}, { files: { name: "cube_20mm.stl", data } });
      if (r.status !== 200 || !r.body.parts.length) throw new Error(`upload failed: ${r.text}`);
      return r.body.parts[0].partId;
    },
    /** A CNC config for a part in the first seeded CNC material. */
    cncConfig(partId, quantity = 2) {
      const mat = h.models.materialsDB.getAll().find((m) => m.process === "cnc" && m.active);
      return { partId, materialSlug: mat.slug, grade: mat.grades?.[0]?.name || "", finishSlug: "", quantity, process: "cnc", subProcess: "milling" };
    },
    /** Simulate Stripe reporting a session paid. */
    pay(sessionId, over = {}) { Object.assign(stripe.sessions[sessionId], { payment_status: "paid" }, over); },
    stop: () => new Promise((resolve) => server.close(() => { fs.rmSync(tmp, { recursive: true, force: true }); resolve(); })),
  };
  // The quote tool's one-time check: trade a passed Turnstile token for a verified-human token (good for an hour).
  h.refreshHuman = async () => {
    if (!turnstileOn) return "";
    const v = await raw("POST", "/api/human/verify", { json: { turnstileToken: "pass-quote" } });
    if (v.status !== 200 || !v.body.humanToken) throw new Error(`human verify failed: ${v.text}`);
    h.humanToken = v.body.humanToken;
    return h.humanToken;
  };
  await h.refreshHuman();
  return h;
}

/** Sequential async test runner in the style of the other suites. */
function runner(title) {
  console.log(title);
  let passed = 0;
  const tests = [];
  const test = (name, fn) => tests.push({ name, fn });
  async function run(cleanup) {
    for (const t of tests) {
      try { await t.fn(); passed++; console.log(`  ok   ${t.name}`); }
      catch (err) { console.error(`  FAIL ${t.name}\n       ${err.stack || err.message}`); process.exitCode = 1; }
    }
    console.log(`\n${passed} passed`);
    if (cleanup) await cleanup();
  }
  return { test, run };
}

module.exports = { start, runner };
