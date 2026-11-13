/**
 * Emails that are owed for an order: remembered with the change that made them owed, sent
 * afterwards, and sent again later if they could not be (independent re-review 2026-11-12, F-05).
 *
 * Before: a payment marked the order paid and recorded "handled" in one step, and the confirmation
 * to the buyer and the new-order notice to the shop were sent after it, from memory. A process
 * killed between the two (an out-of-memory kill, a host fault) left a paid order nobody was told
 * about, and Stripe's second delivery of the event was answered "duplicate" and sent nothing.
 *
 * Now "the buyer and the shop are owed an email" is a row, written in the SAME database change as
 * the payment (services/orderLifecycle.js applySession). A row is done when the mail provider took
 * the message, and only then:
 *
 *   right after the payment is settled            deliver({ orderId })
 *   when Stripe delivers the event again          deliver({ orderId })   (routes/stripeWebhook.js)
 *   at start-up, and every few minutes after      deliver()              (server/index.js)
 *
 * so a kill between the payment and the email loses nothing: the next of those three sends it.
 *
 * Once, not twice. A row being sent is not picked up by a second caller (the return page and the
 * webhook arrive together). A send the provider refused is tried again after a wait that grows
 * with each try, and given up, with a line in the log, a day after it was owed. The one case a
 * message can go twice is a kill after the provider took it and before that was written down; the
 * request carries an Idempotency-Key (the row's id) so the provider drops the second one.
 *
 * When email is not set up at all (no EMAIL_API_KEY: a development machine, or the first hour of a
 * deploy) nothing can be sent now or later by retrying: the message is logged as before
 * (services/mailer.js) and the row is closed, so a key added a week later does not send a week's
 * old confirmations.
 */
const mailer = require("./mailer");

const KINDS = ["order-paid-buyer", "order-paid-shop", "payment-notice-shop"];
const GIVE_UP_MS = 24 * 60 * 60 * 1000;
const RETRY_BASE_MS = 60 * 1000;      // after a refused send: 1 min, 2, 4, … up to 30
const RETRY_MAX_MS = 30 * 60 * 1000;
const SWEEP_MS = 5 * 60 * 1000;

const inFlight = new Set(); // row ids being sent right now
const counters = { owed: 0, sent: 0, closedNoMailer: 0, failed: 0, gaveUp: 0, dropped: 0 };

const table = () => require("../models").emailsOwedDB;

/**
 * Remember that an email is owed. Synchronous: call it inside the database change that makes it owed.
 * @param {string} orderId
 * @param {"order-paid-buyer"|"order-paid-shop"|"payment-notice-shop"} kind
 * @param {{ base?: string, data?: object }} [o]  base: the site address the links in the message use; data: what a notice says
 */
function owe(orderId, kind, { base = "", data = null } = {}) {
  if (!orderId || !KINDS.includes(kind)) throw new Error(`owedEmails.owe: unknown kind ${kind}`);
  const row = table().insert({ orderId, kind, baseUrl: String(base || "").slice(0, 300), data: data || null, attempts: 0 });
  counters.owed++;
  return row.id;
}

/** The rows still owed (for one order, or all), oldest first. */
function pending(orderId) {
  const all = orderId
    ? table()._query("SELECT * FROM emails_owed WHERE done_at IS NULL AND order_id = ? ORDER BY created_at, id", [orderId])
    : table()._query("SELECT * FROM emails_owed WHERE done_at IS NULL ORDER BY created_at, id");
  return all.map((r) => table()._deserialize(r));
}
const close = (id, result) => table().update(id, { doneAt: new Date().toISOString(), result });

/** The message for a row, from the order as it is now; null when there is nothing left to say. */
function messageFor(row) {
  const { ordersDB } = require("../models");
  const orderEvents = require("./orderEvents");
  const order = ordersDB.getById(row.orderId);
  if (!order) return null;
  const base = row.baseUrl || orderEvents.baseUrl();
  if (row.kind === "payment-notice-shop") {
    const data = row.data && typeof row.data === "object" ? row.data : {};
    const kind = data.kind || order.attention;
    if (!kind) return null;
    return { to: mailer.shopNotifyAddress(), ...require("../emails/paymentTemplates").paymentAttentionShop({ order, kind, note: data.note || order.attentionNote || "", amountCents: data.amountCents, sessionId: data.sessionId, paymentIntent: data.paymentIntent, adminUrl: `${base}/admin` }) };
  }
  // A confirmation for an order that has since been cancelled or refunded would only confuse: the
  // emails about THAT were sent when it happened.
  if (["cancelled", "refunded", "expired"].includes(order.status)) return null;
  const messages = orderEvents.paidMessages(order, { base });
  return row.kind === "order-paid-buyer" ? messages.buyer : messages.shop;
}

function dueAt(row) {
  const attempts = Number(row.attempts) || 0;
  if (attempts === 0 || !row.lastTriedAt) return 0;
  return Date.parse(row.lastTriedAt) + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1));
}

/**
 * Send what is owed: for one order, or everything. Never throws.
 * @param {{ orderId?: string, now?: number, force?: boolean }} [o]  force: ignore the wait after a refused send (tests)
 * @returns {Promise<{ sent: number, failed: number, closed: number, waiting: number }>}
 */
async function deliver({ orderId, now = Date.now(), force = false } = {}) {
  const out = { sent: 0, failed: 0, closed: 0, waiting: 0 };
  let list;
  try { list = pending(orderId); } catch (err) { console.error(`[owed-email] could not read what is owed: ${err.name || "Error"}`); return out; }
  for (const row of list) {
    if (inFlight.has(row.id)) { out.waiting++; continue; }
    if (!force && dueAt(row) > now) { out.waiting++; continue; }
    inFlight.add(row.id);
    try {
      // Read again: another caller may have finished this row while this one waited on the row before it.
      const fresh = table().getById(row.id);
      if (!fresh || fresh.doneAt) continue;
      if (now - Date.parse(row.createdAt) > GIVE_UP_MS) {
        close(row.id, "gave-up");
        counters.gaveUp++; out.closed++;
        console.error(`[owed-email] GAVE UP after a day: the ${row.kind} email for order ${String(row.orderId).slice(0, 8)} could not be sent (${row.attempts} tries). The order is in Admin → Orders.`);
        continue;
      }
      const message = messageFor(row);
      if (!message || !message.to) { close(row.id, "nothing-to-send"); counters.dropped++; out.closed++; continue; }
      let ok = false;
      try { ok = await mailer.send({ ...message, idempotencyKey: `owed-${row.id}` }); } catch (err) { ok = false; console.error(`[owed-email] send error (${row.kind}): ${err.name || "Error"}`); }
      if (ok === true || ok === mailer.HELD) { close(row.id, "sent"); counters.sent++; out.sent++; continue; }
      if (!mailer.configured()) { close(row.id, "no-mailer"); counters.closedNoMailer++; out.closed++; continue; }
      table().update(row.id, { attempts: (Number(fresh.attempts) || 0) + 1, lastTriedAt: new Date().toISOString() });
      counters.failed++; out.failed++;
    } catch (err) {
      console.error(`[owed-email] ${row.kind} for order ${String(row.orderId).slice(0, 8)}: ${err.name || "Error"}`);
    } finally {
      inFlight.delete(row.id);
    }
  }
  return out;
}

let timer = null;
/** At start-up: send what a stopped process left owed, and look again every few minutes. */
function start() {
  deliver().then((r) => { if (r.sent || r.closed || r.failed) console.log(`[owed-email] at start-up: ${r.sent} sent, ${r.failed} to be tried again, ${r.closed} closed without sending`); }).catch(() => {});
  if (timer) clearInterval(timer);
  timer = setInterval(() => { deliver().catch(() => {}); }, SWEEP_MS);
  if (timer.unref) timer.unref();
}

module.exports = { owe, deliver, pending, start, counters, KINDS, GIVE_UP_MS };
