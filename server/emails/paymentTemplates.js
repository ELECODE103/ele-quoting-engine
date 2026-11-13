/**
 * Shop notices for money events that are not a plain new order: a payment that needs the
 * owner (duplicate, late, not matching, nothing collected), a refund, a dispute.
 *
 * They go to the shop only, through the same branded layout as every other message
 * (emails/templates.js `layout`). Subjects carry our own words, the order reference and an
 * amount — never anything a customer typed.
 */
const templates = require("./templates");
const { ATTENTION } = require("../services/orderState");

const { layout, money, shortId } = templates;

function who(order) {
  return `${order.customerName || order.shippingName || "Customer"}${order.customerEmail ? ` <${order.customerEmail}>` : ""}`;
}

/** Ids from Stripe, shown so the owner can find the payment in the dashboard. Shape-checked: they are never free text. */
function stripeId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_]{1,120}$/.test(value) ? value : "";
}

const WHAT_TO_DO = {
  "duplicate-payment": "This order was already paid. Find the second payment in Stripe and refund it, unless the customer meant to pay twice. Nothing about the order has changed.",
  "late-payment": "This order was no longer open when the payment arrived, so it has not been put back in the queue. Either refund the payment in Stripe, or call the customer and, if you will build it, mark the order paid by hand in admin.",
  "payment-mismatch": "The order has NOT been marked paid. Look at the payment in Stripe: refund it, or, if you are satisfied, mark the order paid by hand in admin and say why.",
  "zero-payment": "A checkout was completed with nothing to pay (a promotion code covered the whole amount). The order has NOT been released to the queue. If the discount was meant, mark the order paid by hand in admin; if not, cancel it.",
  "refund-problem": "A refund on this order did not go through or was reversed. Check the payment in Stripe before doing anything else with the order.",
  "order-incomplete": "Nothing has been cancelled or refunded. Open the order and its quote in admin and compare the lines; call the customer if anything is unclear. When it is sorted out, clear this flag in admin with a note.",
  "part-changed": "The payment is in order and the order is in the queue. Before cutting, open the job traveler: it shows the size that was priced beside the size of the file as it is stored now. Confirm with the customer which one they want, then clear this flag in admin with a note.",
};

/** To the shop: a payment arrived that the site would not settle on its own. */
function paymentAttentionShop({ order, kind, note, amountCents, sessionId, paymentIntent, adminUrl }) {
  const label = ATTENTION[kind] || "Payment needs attention";
  const amount = Number.isInteger(amountCents) ? money(amountCents / 100) : "";
  return {
    ...layout({
      subject: `Order ${shortId(order.id)} needs attention: ${label.toLowerCase()}${amount ? ` — ${amount}` : ""}`,
      preheader: `${label}. The order is ${String(order.status || "").replace(/_/g, " ")}.`,
      heading: `Needs attention: ${label.toLowerCase()}`,
      paragraphs: [who(order), note, WHAT_TO_DO[kind] || ""].filter(Boolean),
      facts: [
        ["Order", shortId(order.id)],
        ["Order status", String(order.status || "").replace(/_/g, " ")],
        ["Order total", money(order.total)],
        ["Payment reported", amount],
        ["Stripe payment", stripeId(paymentIntent)],
        ["Stripe checkout session", stripeId(sessionId)],
      ],
      cta: adminUrl ? { label: "Open admin", url: adminUrl } : undefined,
    }),
    template: "paymentAttentionShop",
  };
}

/** To the shop: Stripe reports a refund on an order's payment (or on an extra payment that was flagged). */
function refundShop({ order, refundedCents, paidCents, full, extraPayment, paymentIntent, adminUrl }) {
  const amount = money(refundedCents / 100);
  const heading = extraPayment ? "Extra payment refunded" : full ? "Order refunded in full" : "Order partly refunded";
  return {
    ...layout({
      subject: `Order ${shortId(order.id)}: ${extraPayment ? "extra payment refunded" : full ? "refunded in full" : "partly refunded"} — ${amount}`,
      preheader: `${amount} refunded in Stripe.`,
      heading,
      paragraphs: [
        who(order),
        extraPayment
          ? `Stripe reports ${amount} refunded on the extra payment that was flagged on this order. The order itself has not changed.`
          : full
            ? `Stripe reports the whole payment (${amount}) refunded. The order is now marked refunded and is out of the production queue. If parts were already made or shipped, that is for you to sort out with the customer.`
            : `Stripe reports ${amount} refunded of ${money(paidCents / 100)} paid. The order stays active; the refunded amount is shown on it.`,
      ],
      facts: [
        ["Order", shortId(order.id)],
        ["Order status", String(order.status || "").replace(/_/g, " ")],
        ["Refunded so far", amount],
        ["Paid", extraPayment ? "" : money(paidCents / 100)],
        ["Stripe payment", stripeId(paymentIntent)],
      ],
      cta: adminUrl ? { label: "Open admin", url: adminUrl } : undefined,
    }),
    template: "refundShop",
  };
}

/** To the shop, at once: a cardholder disputed a payment, or the dispute was closed. */
function disputeShop({ order, phase, outcome, amountCents, reason, extraPayment, paymentIntent, adminUrl }) {
  const amount = Number.isInteger(amountCents) ? money(amountCents / 100) : "";
  const opened = phase === "opened";
  const cleanReason = typeof reason === "string" && /^[a-z_]{1,60}$/.test(reason) ? reason.replace(/_/g, " ") : "";
  const closedLine = outcome === "won"
    ? "The dispute was closed in your favour. The payment stands."
    : outcome === "lost"
      ? "The dispute was lost: the bank has taken the money back. This order is no longer paid for. Decide with the customer what happens next; nothing was cancelled automatically."
      : "The dispute was closed. Check its result in Stripe.";
  return {
    ...layout({
      subject: opened
        ? `Order ${shortId(order.id)}: payment disputed${amount ? ` — ${amount}` : ""}`
        : `Order ${shortId(order.id)}: dispute ${outcome === "won" ? "won" : outcome === "lost" ? "lost" : "closed"}${amount ? ` — ${amount}` : ""}`,
      preheader: opened ? "Answer it in Stripe before the deadline shown there." : closedLine,
      heading: opened ? "Payment disputed" : `Dispute ${outcome === "won" ? "won" : outcome === "lost" ? "lost" : "closed"}`,
      paragraphs: [
        who(order),
        opened
          ? `The cardholder's bank has opened a dispute${extraPayment ? " on the extra payment flagged on this order" : " on this order's payment"}. Stripe holds the amount until it is decided. Answer the dispute in the Stripe dashboard before the deadline shown there. The order has NOT been cancelled: decide yourself whether to keep working on it.`
          : closedLine,
      ],
      facts: [
        ["Order", shortId(order.id)],
        ["Order status", String(order.status || "").replace(/_/g, " ")],
        ["Disputed amount", amount],
        ["Bank's reason", cleanReason],
        ["Stripe payment", stripeId(paymentIntent)],
      ],
      cta: adminUrl ? { label: "Open admin", url: adminUrl } : undefined,
    }),
    template: "disputeShop",
  };
}

module.exports = { paymentAttentionShop, refundShop, disputeShop, WHAT_TO_DO };
