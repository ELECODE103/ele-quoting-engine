/**
 * How many unpaid orders one sender may hold (independent re-review 2026-11-12, F-09 and F-12).
 *
 * Pressing "pay" makes an order and costs the sender nothing. Each unpaid order keeps its lines in
 * the database and protects its files in the store, so "start a checkout and never pay" was a way to
 * hold both: thirteen accounts held the whole file store, and one account's unpaid orders made the
 * order list too large to send. Two ceilings, each per account and per address:
 *
 *   at the same time   ORDERS_UNPAID_PER_ACCOUNT (3) / ORDERS_UNPAID_PER_CLIENT (5)
 *                      orders waiting for a card payment right now
 *   in a day           ORDERS_UNPAID_NEW_PER_ACCOUNT_DAY (8) / ORDERS_UNPAID_NEW_PER_CLIENT_DAY (16)
 *                      orders started in the last 24 hours that were not paid for
 *
 * Not counted: an order that was paid; a firm-quote order (the shop priced it and sent the link); a
 * phone order the owner made; and going back to pay for an order that already exists, which makes
 * no new order. An admin is not limited.
 *
 * Everything is one indexed COUNT on the orders table.
 */
const { ordersDB } = require("../models");
const { limits } = require("./limits");
const brand = require("../../shared/brand.json");

const DAY_MS = 24 * 60 * 60 * 1000;
const hasSql = typeof ordersDB._query === "function";
const NOT_FIRM = "(rfq_id IS NULL OR rfq_id = '')";

function countWaiting(column, value, except = []) {
  if (!value) return 0;
  const skip = (Array.isArray(except) ? except : []).filter((id) => typeof id === "string" && id).slice(0, 50);
  if (hasSql) return Number(ordersDB._query(`SELECT COUNT(*) AS n FROM orders WHERE ${column} = ? AND status = 'pending_payment' AND ${NOT_FIRM} AND (payment_method IS NULL OR payment_method = 'card')${skip.length ? ` AND id NOT IN (${skip.map(() => "?").join(", ")})` : ""}`, [value, ...skip])[0].n) || 0;
  const field = column === "user_id" ? "userId" : "clientTag";
  return ordersDB.query((o) => o[field] === value && o.status === "pending_payment" && !o.rfqId && (!o.paymentMethod || o.paymentMethod === "card") && !skip.includes(o.id)).length;
}

function countStartedUnpaid(column, value, since) {
  if (!value) return 0;
  if (hasSql) return Number(ordersDB._query(`SELECT COUNT(*) AS n FROM orders WHERE ${column} = ? AND created_at >= ? AND paid_at IS NULL AND status IN ('pending_payment', 'expired', 'cancelled') AND ${NOT_FIRM} AND (payment_method IS NULL OR payment_method = 'card')`, [value, since])[0].n) || 0;
  const field = column === "user_id" ? "userId" : "clientTag";
  return ordersDB.query((o) => o[field] === value && String(o.createdAt || "") >= since && !o.paidAt && ["pending_payment", "expired", "cancelled"].includes(o.status) && !o.rfqId && (!o.paymentMethod || o.paymentMethod === "card")).length;
}

const minutesText = (m) => (m >= 120 ? `${Math.round(m / 60)} hours` : `${m} minutes`);

/**
 * May this sender start ONE MORE unpaid order now?
 * @param {{ userId?: string, clientTag?: string, sessionMinutes?: number, now?: number, closing?: string[] }} who
 *   closing: ids of the buyer's own unpaid orders that the same step is about to close because this
 *   checkout replaces them (routes/orders.js; review of 2026-11-13, N-01). They are not counted as
 *   "waiting at once". They ARE still counted in the day's total of checkouts started and not paid.
 * @returns {null | { status: 429, retryAfterSeconds: number, body: { error: string, code: string, waiting?: number } }}
 */
function refusalFor({ userId = "", clientTag = "", sessionMinutes = 120, now = Date.now(), closing = [] } = {}) {
  const waitingAccount = countWaiting("user_id", userId, closing);
  const waitingClient = countWaiting("client_tag", clientTag, closing);
  if (waitingAccount >= limits.ordersUnpaidPerAccount || waitingClient >= limits.ordersUnpaidPerClient) {
    const n = Math.max(waitingAccount, waitingClient);
    return {
      status: 429,
      retryAfterSeconds: Math.min(3600, sessionMinutes * 60),
      body: {
        error: `You have ${n} order${n === 1 ? "" : "s"} waiting for payment, which is the most we keep open at once. Pay for one of them from Your orders, or cancel one there, then check out again. (An order nobody pays for closes by itself: a payment page stays open for ${minutesText(sessionMinutes)}.) To place this order by phone, call ${brand.phone}.`,
        code: "unpaid-orders-limit",
        waiting: n,
      },
    };
  }
  const since = new Date(now - DAY_MS).toISOString();
  if (countStartedUnpaid("user_id", userId, since) >= limits.ordersUnpaidNewPerAccountDay || countStartedUnpaid("client_tag", clientTag, since) >= limits.ordersUnpaidNewPerClientDay) {
    return {
      status: 429,
      retryAfterSeconds: 3600,
      body: {
        error: `That is more checkouts started and not paid for than we take in one day. Nothing was charged. Pay for an order that is waiting in Your orders, try again tomorrow, or call ${brand.phone} and we'll take the order by phone.`,
        code: "unpaid-orders-daily-limit",
      },
    };
  }
  return null;
}

module.exports = { refusalFor, countWaiting, countStartedUnpaid };
