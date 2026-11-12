/**
 * Independent security review, 2026-11-11 — test preload.
 *
 * Loaded into the server process under test with NODE_OPTIONS=--require. It keeps the
 * proofs of concept on this machine:
 *   - every outbound fetch is answered here (Resend "accepts" the message, Turnstile passes a
 *     token that starts with "pass"); nothing leaves the host
 *   - the Stripe client is a stub that records the sessions it is asked to create in a JSON
 *     file (SE_REVIEW_STATE) the test can read and edit; webhook signatures are still checked
 *     by the real library, offline
 * It changes no application code.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const stateFile = process.env.SE_REVIEW_STATE || "";
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return { sessions: {}, mail: 0, turnstile: 0 }; } };
const writeState = (s) => { if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(s, null, 2)); };

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("https://api.resend.com/")) {
    const s = readState(); s.mail = (s.mail || 0) + 1; writeState(s);
    return new Response(JSON.stringify({ id: "stub" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (u.startsWith("https://challenges.cloudflare.com/")) {
    const body = new URLSearchParams(String(init.body));
    const s = readState(); s.turnstile = (s.turnstile || 0) + 1; writeState(s);
    const pass = String(body.get("response") || "").startsWith("pass");
    return new Response(JSON.stringify(pass ? { success: true } : { success: false, "error-codes": ["invalid-input-response"] }), { status: 200 });
  }
  if (/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u)) return realFetch(url, init);
  throw new Error(`review preload: outbound request blocked (${new URL(u).host})`);
};

const root = path.join(__dirname, "..", "..", "..", "..");
const stripeClient = require(path.join(root, "server", "services", "stripeClient"));
const offline = require(path.join(root, "node_modules", "stripe"))("sk_test_review_stub");
stripeClient.setForTests({
  webhooks: offline.webhooks,
  checkout: {
    sessions: {
      async create(args) {
        const s = readState();
        const id = `cs_test_${crypto.randomBytes(8).toString("hex")}`;
        const amount = (args.line_items || []).reduce((sum, li) => sum + li.price_data.unit_amount * li.quantity, 0);
        s.sessions[id] = { id, url: `https://checkout.stripe.test/${id}`, payment_status: "unpaid", amount_subtotal: amount, amount_total: amount, metadata: args.metadata, success_url: args.success_url, cancel_url: args.cancel_url, customer_email: args.customer_email, line_items: args.line_items };
        writeState(s);
        return s.sessions[id];
      },
      async retrieve(id) {
        const s = readState();
        if (!s.sessions[id]) throw new Error("No such checkout.session");
        return s.sessions[id];
      },
    },
  },
});
