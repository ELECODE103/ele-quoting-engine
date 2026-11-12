/**
 * Preload for browser runs against a real server process:
 *
 *   node -r ./scripts/e2e/stub-network.cjs server/index.js
 *
 * It replaces the three outside calls at their boundaries, the same way the
 * route suites do, so a production-mode server can be driven end to end with
 * nothing leaving the machine:
 *
 *   Turnstile siteverify   answers "success" for tokens that start with
 *                          "e2e-pass", "failed" for anything else
 *   Resend                 answers 200; the message is already on disk in
 *                          EMAIL_OUTBOX_DIR, where the test reads it
 *   Stripe Checkout        a session whose "hosted page" is the order's own
 *                          success URL, already paid
 *
 * Refuses to load unless E2E_STUBS=1, so it cannot be left on a real deploy by
 * accident.
 */
if (process.env.E2E_STUBS !== "1") {
  console.error("stub-network.cjs: refusing to load without E2E_STUBS=1");
  process.exit(1);
}
const path = require("path");
const root = path.join(__dirname, "..", "..");

// ─── Turnstile ───
require(path.join(root, "server", "security", "turnstile")).setFetchForTests(async (url, init) => {
  const token = new URLSearchParams(String(init.body)).get("response") || "";
  const pass = token.startsWith("e2e-pass");
  return { ok: true, json: async () => (pass ? { success: true, hostname: "localhost" } : { success: false, "error-codes": ["invalid-input-response"] }) };
});

// ─── Resend ───
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  if (String(url).startsWith("https://api.resend.com/")) return new Response(JSON.stringify({ id: "e2e" }), { status: 200, headers: { "Content-Type": "application/json" } });
  return realFetch(url, init);
};

// ─── Stripe ───
const sessions = {};
let n = 0;
require(path.join(root, "server", "services", "stripeClient")).setForTests({
  checkout: {
    sessions: {
      create: async (args) => {
        const id = `cs_e2e_${++n}`;
        const amount = args.line_items.reduce((sum, li) => sum + li.price_data.unit_amount * (li.quantity || 1), 0);
        // The buyer "pays" at once: the hosted page is the return URL. The session reads as Stripe
        // reports a paid one: complete, in US dollars, with a payment intent and no discount.
        sessions[id] = { id, object: "checkout.session", url: args.success_url, status: "complete", payment_status: "paid", currency: "usd", amount_total: amount, amount_subtotal: amount, total_details: { amount_discount: 0 }, payment_intent: `pi_e2e_${n}`, metadata: args.metadata };
        return sessions[id];
      },
      retrieve: async (id) => sessions[id],
      // As the API does it: only an open session can be expired, and these are complete the moment they are made.
      expire: async (id) => { throw Object.assign(new Error(sessions[id] ? "Only Checkout Sessions with a status in [\"open\"] can be expired." : `No such checkout.session: ${id}`), sessions[id] ? { code: "checkout_session_not_open", statusCode: 400 } : { code: "resource_missing", statusCode: 404 }); },
      list: async ({ payment_intent: pi } = {}) => ({ data: Object.values(sessions).filter((x) => x.payment_intent === pi) }),
    },
  },
  charges: { retrieve: async () => null },
  // Signature checks are the SDK's own code (a local HMAC; nothing leaves the machine).
  webhooks: require(path.join(root, "node_modules", "stripe"))("sk_test_e2e_stub_not_a_key").webhooks,
});
console.log("[e2e] Turnstile, Resend and Stripe are stubbed in this process.");
