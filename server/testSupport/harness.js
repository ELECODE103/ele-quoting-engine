/**
 * Test harness for the route suites: a throwaway SQLite file, the real routes
 * on an ephemeral port, Stripe stubbed at the boundary (services/stripeClient)
 * and every email captured instead of sent.
 *
 *   const h = await require("../testSupport/harness").start();
 *   const r = await h.post("/api/quote", { parts: [...] }, token);
 *   h.sent      → emails captured: [{ to, subject, text, html, replyTo }]
 *   h.stripe    → { created: [...sessions.create args], sessions: { id: session }, failNext }
 *   await h.stop();
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

async function start() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "se-test-"));
  process.env.QUOTING_DB_PATH = path.join(tmp, "quoting.db");
  process.env.JWT_SECRET = "test-secret";
  process.env.ADMIN_EMAIL = "owner@shop.test";
  process.env.FRONTEND_URL = "https://shop.test";
  delete process.env.EMAIL_API_KEY;
  delete process.env.EMAIL_FROM;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  process.env.NODE_ENV = "test";

  // Captured mail.
  const mailer = require("../services/mailer");
  const sent = [];
  mailer.send = async (m) => { sent.push(m); return false; };

  // Stripe stub: records what would be sent to Stripe, hands back a fake session.
  const stripe = { created: [], sessions: {}, failNext: false };
  require("../services/stripeClient").setForTests({
    checkout: {
      sessions: {
        create: async (args) => {
          if (stripe.failNext) { stripe.failNext = false; throw new Error("stripe unavailable"); }
          const id = `cs_test_${stripe.created.length + 1}`;
          stripe.created.push(args);
          // What Stripe would charge: every line (the order, plus the inspection paperwork when it was ordered).
          const amount = args.line_items.reduce((sum, li) => sum + li.price_data.unit_amount * (li.quantity || 1), 0);
          stripe.sessions[id] = { id, url: `https://checkout.stripe.test/${id}`, payment_status: "unpaid", amount_total: amount, amount_subtotal: amount, metadata: args.metadata };
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
  app.use("/api/stripe/webhook", express.raw({ type: "application/json" }), require("../routes/stripeWebhook"));
  app.use(express.json());
  app.use("/api", api);
  app.use("/api/auth", require("../routes/auth"));
  app.use("/api/orders", require("../routes/orders"));
  app.use("/api/rfq", require("../routes/rfq"));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, url, body, token, raw) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (raw) payload = raw;
    else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text };
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
      return call("POST", url, undefined, token, fd);
    },
    async register(email, name = "Test Buyer") {
      const r = await call("POST", "/api/auth/register", { email, password: "Passw0rd1", name });
      if (r.status !== 201) throw new Error(`register failed: ${r.text}`);
      return r.body.token;
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
