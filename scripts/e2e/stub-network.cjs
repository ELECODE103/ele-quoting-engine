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
        // The buyer "pays" at once: the hosted page is the return URL.
        sessions[id] = { id, url: args.success_url, payment_status: "paid", amount_total: amount, amount_subtotal: amount, metadata: args.metadata };
        return sessions[id];
      },
      retrieve: async (id) => sessions[id],
    },
  },
});
console.log("[e2e] Turnstile, Resend and Stripe are stubbed in this process.");
