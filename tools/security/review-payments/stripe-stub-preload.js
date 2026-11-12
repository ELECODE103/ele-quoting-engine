/**
 * Preloaded into the server under review (NODE_OPTIONS=--require …) so that no
 * request ever leaves the machine for Stripe. Checkout sessions are written to
 * a folder the proof-of-concept scripts read; webhook signatures are verified
 * by the real SDK's own code (local HMAC, no network).
 *
 * Review tooling only. Never load this in a deployed server.
 */
const fs = require("fs");
const path = require("path");

const dir = process.env.SE_REVIEW_STRIPE_DIR;
if (dir) {
  fs.mkdirSync(dir, { recursive: true });
  const root = path.join(__dirname, "..", "..", "..");
  const sdk = require(path.join(root, "node_modules", "stripe"))("sk_test_review_stub_not_a_key");
  const file = (id) => path.join(dir, `${id.replace(/[^A-Za-z0-9_]/g, "")}.json`);
  let n = fs.readdirSync(dir).length;
  const delayMs = Number(process.env.SE_REVIEW_STRIPE_DELAY_MS) || 0;
  require(path.join(root, "server", "services", "stripeClient")).setForTests({
    webhooks: sdk.webhooks,
    checkout: {
      sessions: {
        create: async (args) => {
          // Stripe's API answers in a few hundred milliseconds; SE_REVIEW_STRIPE_DELAY_MS stands in for that.
          if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
          const id = `cs_test_review_${++n}`;
          const amount = args.line_items.reduce((sum, li) => sum + li.price_data.unit_amount * (li.quantity || 1), 0);
          if (!Number.isInteger(amount) || amount < 50 || amount > 99999999) throw new Error(`stub: Stripe would refuse amount ${amount}`);
          const session = { id, object: "checkout.session", url: `https://checkout.stripe.invalid/${id}`, payment_status: "unpaid", currency: "usd", amount_total: amount, amount_subtotal: amount, metadata: args.metadata, _args: args };
          fs.writeFileSync(file(id), JSON.stringify(session, null, 1));
          return session;
        },
        retrieve: async (id) => JSON.parse(fs.readFileSync(file(id), "utf8")),
      },
    },
  });
}
