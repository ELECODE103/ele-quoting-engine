/**
 * Preload for the order-lifecycle browser run, loaded AFTER stub-network.cjs:
 *
 *   node -r ./scripts/e2e/stub-network.cjs -r ./scripts/e2e/stub-stripe-hosted.cjs server/index.js
 *
 * stub-network.cjs makes every Checkout session paid the moment it is created, which is right
 * for a run that is about accounts. This one replaces only the Stripe stub with sessions that
 * behave like Stripe's: open until they are paid or expired, each a JSON file in
 * E2E_STRIPE_DIR that the browser run reads and changes (it plays Stripe: marks a session
 * paid, then sends the signed webhook). The "hosted page" URL is on checkout.stripe.test, a
 * host that does not exist; the browser run answers it with a stand-in page.
 *
 * Refuses to load unless E2E_STUBS=1 and E2E_STRIPE_DIR is set.
 */
if (process.env.E2E_STUBS !== "1" || !process.env.E2E_STRIPE_DIR) {
  console.error("stub-stripe-hosted.cjs: refusing to load without E2E_STUBS=1 and E2E_STRIPE_DIR");
  process.exit(1);
}
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..");
const dir = process.env.E2E_STRIPE_DIR;
fs.mkdirSync(dir, { recursive: true });

const file = (id) => path.join(dir, `${String(id).replace(/[^A-Za-z0-9_]/g, "")}.json`);
const read = (id) => JSON.parse(fs.readFileSync(file(id), "utf8"));
const write = (session) => { fs.writeFileSync(file(session.id), JSON.stringify(session, null, 1)); return session; };
const stripeError = (message, code, statusCode) => Object.assign(new Error(message), { code, statusCode });
const missing = (id) => stripeError(`No such checkout.session: ${id}`, "resource_missing", 404);
let n = fs.readdirSync(dir).filter((f) => f.startsWith("cs_")).length;
const delayMs = Number(process.env.E2E_STRIPE_DELAY_MS) || 0;

require(path.join(root, "server", "services", "stripeClient")).setForTests({
  webhooks: require(path.join(root, "node_modules", "stripe"))("sk_test_e2e_stub_not_a_key").webhooks,
  checkout: {
    sessions: {
      create: async (args) => {
        // Stripe's API takes a moment; a double click lands inside it.
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        const id = `cs_e2e_${++n}`;
        const amount = args.line_items.reduce((sum, li) => sum + li.price_data.unit_amount * (li.quantity || 1), 0);
        return write({
          id, object: "checkout.session", url: `https://checkout.stripe.test/pay/${id}`, status: "open", payment_status: "unpaid", currency: "usd",
          amount_total: amount, amount_subtotal: amount, total_details: { amount_discount: 0 }, payment_intent: null, expires_at: args.expires_at || null,
          metadata: args.metadata, success_url: args.success_url, cancel_url: args.cancel_url, allow_promotion_codes: Boolean(args.allow_promotion_codes),
          line_items: args.line_items.map((li) => ({ name: li.price_data.product_data.name, amount: li.price_data.unit_amount })),
        });
      },
      retrieve: async (id) => { try { return read(id); } catch { throw missing(id); } },
      expire: async (id) => {
        let session;
        try { session = read(id); } catch { throw missing(id); }
        if (session.status !== "open") throw stripeError("Only Checkout Sessions with a status in [\"open\"] can be expired.", "checkout_session_not_open", 400);
        return write({ ...session, status: "expired" });
      },
      list: async ({ payment_intent: pi } = {}) => ({ data: fs.readdirSync(dir).filter((f) => f.startsWith("cs_")).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))).filter((x) => x.payment_intent && x.payment_intent === pi) }),
    },
  },
  charges: { retrieve: async (id) => { try { return JSON.parse(fs.readFileSync(path.join(dir, `charge_${String(id).replace(/[^A-Za-z0-9_]/g, "")}.json`), "utf8")); } catch { return null; } } },
});
console.log("[e2e] Stripe Checkout sessions are files in E2E_STRIPE_DIR; the browser run plays Stripe.");
