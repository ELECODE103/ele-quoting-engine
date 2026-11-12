/**
 * Preload for the tax-and-shipping browser run against a real, production-mode server:
 *
 *   NODE_OPTIONS="-r ./scripts/e2e/stub-tax-shipping.cjs" E2E_STUBS=1 node server/index.js
 *
 * Stripe is replaced at its boundary (services/stripeClient), as the route suites do, so
 * nothing leaves the machine:
 *
 *   customers.create          remembered in memory; nothing is sent anywhere
 *   checkout.sessions.create  a session that is already paid and whose "hosted page" is the
 *                             order's own success URL. With automatic_tax it carries tax the
 *                             way Stripe reports it (total_details.amount_tax): 7% of every
 *                             line not sent as nontaxable, none for a Customer marked exempt.
 *
 * The 7% is a stand-in so a tax line has something to show. It is not a rate from anywhere.
 * Refuses to load unless E2E_STUBS=1, so it cannot be left on a real deploy by accident.
 */
if (process.env.E2E_STUBS !== "1") {
  console.error("stub-tax-shipping.cjs: refusing to load without E2E_STUBS=1");
  process.exit(1);
}
const path = require("path");
const root = path.join(__dirname, "..", "..");
const STAND_IN_RATE = 0.07;

const sessions = {};
const customers = {};
let n = 0;
require(path.join(root, "server", "services", "stripeClient")).setForTests({
  customers: {
    create: async (args) => {
      const id = `cus_e2e_${Object.keys(customers).length + 1}`;
      customers[id] = { id, ...args };
      return customers[id];
    },
  },
  checkout: {
    sessions: {
      create: async (args) => {
        const id = `cs_e2e_${++n}`;
        const amount = args.line_items.reduce((sum, li) => sum + li.price_data.unit_amount * (li.quantity || 1), 0);
        // The buyer "pays" at once: the hosted page is the return URL.
        sessions[id] = { id, url: args.success_url, payment_status: "paid", currency: "usd", amount_total: amount, amount_subtotal: amount, metadata: args.metadata };
        if (args.automatic_tax && args.automatic_tax.enabled) {
          const customer = customers[args.customer];
          const taxable = args.line_items.filter((li) => li.price_data.product_data.tax_code !== "txcd_00000000").reduce((sum, li) => sum + li.price_data.unit_amount * (li.quantity || 1), 0);
          const tax = customer && customer.tax_exempt === "exempt" ? 0 : Math.round(taxable * STAND_IN_RATE);
          Object.assign(sessions[id], { amount_total: amount + tax, customer: args.customer, total_details: { amount_tax: tax, amount_discount: 0, amount_shipping: 0 } });
        }
        return sessions[id];
      },
      retrieve: async (id) => sessions[id],
    },
  },
});
console.log("[e2e] Stripe (customers, checkout sessions, tax) is stubbed in this process.");
