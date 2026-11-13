/**
 * Stripe stand-in for a CHILD server started by the re-review scripts (node --require this file, with
 * RR_STRIPE_FILE set). Nothing leaves the machine. Unlike the review-uploads stand-in it survives a
 * restart of the server: every session is kept in the JSON file named by RR_STRIPE_FILE, which the
 * script also edits to say "this session has been paid". Webhook signatures are checked with the real
 * library's own local code (stripe.webhooks.constructEvent needs no network).
 */
const { isMainThread } = require("worker_threads");
if (isMainThread && process.env.RR_STRIPE_FILE) {
  const fs = require("fs");
  const path = require("path");
  const root = path.join(__dirname, "..", "..", "..");
  const file = process.env.RR_STRIPE_FILE;
  const load = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { seq: 0, sessions: {} }; } };
  const save = (s) => fs.writeFileSync(file, JSON.stringify(s));
  const real = require(path.join(root, "node_modules", "stripe"))("sk_test_local_only");
  const delay = () => new Promise((r) => setTimeout(r, Number(process.env.RR_STRIPE_DELAY_MS) || 0));
  require(path.join(root, "server", "services", "stripeClient")).setForTests({
    webhooks: real.webhooks,
    customers: { create: async (args) => ({ id: `cus_rr_${Date.now()}`, ...args }) },
    checkout: {
      sessions: {
        create: async (args) => {
          await delay();
          const s = load();
          const id = `cs_test_rr_${++s.seq}`;
          const amount = (args.line_items || []).reduce((sum, li) => sum + li.price_data.unit_amount * (li.quantity || 1), 0);
          s.sessions[id] = { id, object: "checkout.session", url: `https://checkout.stripe.invalid/${id}`, status: "open", payment_status: "unpaid", currency: "usd", amount_total: amount, amount_subtotal: amount, total_details: { amount_discount: 0, amount_tax: 0 }, payment_intent: null, metadata: args.metadata, expires_at: args.expires_at || null, items: (args.line_items || []).map((li) => li.price_data.product_data.name) };
          save(s);
          return s.sessions[id];
        },
        retrieve: async (id) => load().sessions[id],
        expire: async (id) => {
          const s = load();
          const x = s.sessions[id];
          if (!x) throw Object.assign(new Error("No such checkout.session"), { code: "resource_missing", statusCode: 404 });
          if (x.status !== "open") throw Object.assign(new Error("not open"), { code: "checkout_session_not_open", statusCode: 400 });
          x.status = "expired";
          save(s);
          return x;
        },
        list: async ({ payment_intent: pi } = {}) => ({ data: Object.values(load().sessions).filter((x) => x.payment_intent && x.payment_intent === pi) }),
      },
    },
    charges: { retrieve: async () => null },
  });
}
