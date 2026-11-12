/**
 * Order lifecycle after a Stripe session exists: opening and closing Checkout sessions,
 * settling a payment, payments that arrive for an order that is not waiting for one,
 * refunds, disputes, expiry, cancelling, and the owner's manual moves.
 *
 * The states and the allowed moves are in services/orderState.js. The rules this file keeps:
 *
 *   - An order has at most one open Checkout session. A new one is made only when the old
 *     one cannot be used, and the old one is closed at Stripe first.
 *   - An order is marked paid only by a payment that passes every check (checkSession):
 *     a session we made for this order, payment_status "paid", an integer amount that equals
 *     the expected charge (services/expectedCharge.js) less the discount Stripe reports, and
 *     the order's currency.
 *   - A payment is never dropped. One that cannot settle its order (already paid, cancelled,
 *     expired, not matching, nothing collected) is recorded, the order is flagged, and the
 *     shop is emailed once.
 *   - Every decision is made on the order as it is in the database NOW, read and written in
 *     one synchronous step. sql.js is synchronous but the handlers are not: anything read
 *     before an `await` may be stale after it.
 *
 * Every money event is also a row in `payment_events` (kind, order, amount, whether the shop
 * was emailed), which is what a digest or an alert can count.
 */
const crypto = require("crypto");
const { ordersDB, orderItemsDB, quotesDB, rfqsDB } = require("../models");
const { paymentSessionsDB, paymentEventsDB } = require("../models/lifecycleStore");
const stripeClient = require("./stripeClient");
const mailer = require("./mailer");
const shipBy = require("./shipBy");
const audit = require("./audit");
const orderState = require("./orderState");
const expectedChargeModule = require("./expectedCharge");
const paymentTemplates = require("../emails/paymentTemplates");
const { money } = require("../emails/templates");

// ─── Settings ──────────────────────────────────────────────────

/** How long a Checkout session stays payable. Stripe allows 30 minutes to 24 hours. */
function sessionMinutes() {
  const n = Number(process.env.CHECKOUT_SESSION_MINUTES);
  return Number.isFinite(n) && n > 0 ? Math.min(1440, Math.max(30, Math.round(n))) : 120;
}
const SWEEP_GRACE_MS = 10 * 60 * 1000;        // after a session's expiry, before the sweep closes the order (a webhook can trail)
const LEGACY_SESSION_MS = 24 * 60 * 60 * 1000; // sessions made before an expiry was set: Stripe's own default
const REUSE_MARGIN_MS = 5 * 60 * 1000;        // a session this close to expiry is replaced, not handed out again
const SWEEP_EVERY_MS = 10 * 60 * 1000;

/**
 * Promotion codes at checkout. OFF unless STRIPE_PROMOTION_CODES=on (owner decision pending,
 * review F-17). Shown on the admin orders screen; changed only by the owner in the host's settings.
 */
function promotionCodesAllowed() {
  return /^(on|true|1|yes)$/i.test(String(process.env.STRIPE_PROMOTION_CODES || "").trim());
}

/** What the admin screen shows about payments. No secret is in here, only whether each thing is set. */
function paymentSettings() {
  return {
    promotionCodes: promotionCodesAllowed(),
    sessionMinutes: sessionMinutes(),
    cardPayments: Boolean(stripeClient.get()),
    webhookSecret: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    shopEmails: mailer.configured(),
  };
}

// ─── Small helpers ─────────────────────────────────────────────

const now = () => new Date().toISOString();

function currencyOf(order) {
  return String((order && order.currency) || "usd").toLowerCase();
}

/**
 * What Stripe should report as charged for this order before any promotion code, in cents.
 * One source: services/expectedCharge.js (whichever shape it answers in).
 */
function expectedCents(order) {
  const e = expectedChargeModule.expectedCharge(order);
  if (typeof e === "number") return Math.round(e * 100);
  return e && Number.isInteger(e.cents) ? e.cents : 0;
}

function idOf(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.id === "string") return value.id;
  return "";
}

function isMissing(err) {
  return Boolean(err) && (err.code === "resource_missing" || err.statusCode === 404);
}

function refusal(status, code, message) {
  return Object.assign(new Error(message), { status, code, expose: true });
}

function sessionsFor(orderId) {
  return paymentSessionsDB.query((s) => s.orderId === orderId);
}
function openSessionsFor(orderId) {
  return sessionsFor(orderId).filter((s) => s.status === "open");
}

function recordEvent({ eventId, kind, order, sessionId, paymentIntent, amountCents, currency, detail, notified = false }) {
  try {
    return paymentEventsDB.insert({
      eventId: eventId || null,
      kind,
      orderId: order ? order.id : null,
      sessionId: sessionId || null,
      paymentIntent: paymentIntent || null,
      amountCents: Number.isInteger(amountCents) ? amountCents : null,
      currency: currency || null,
      detail: String(detail || "").slice(0, 1000),
      notified: Boolean(notified),
    });
  } catch (err) {
    console.error(`[lifecycle] could not record a ${kind} event: ${err.name || "Error"}`);
    return null;
  }
}

/** Has this Stripe event been handled already? (Stripe delivers an event more than once.) */
function eventSeen(eventId) {
  if (!eventId) return false;
  return paymentEventsDB.query((e) => e.eventId === eventId).length > 0;
}

function eventsFor(orderId) {
  return paymentEventsDB.query((e) => e.orderId === orderId).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function adminUrl(base) {
  return `${base || require("./orderEvents").baseUrl()}/admin`;
}

/** One email to the shop, through the same path as every other shop notice. Never throws. */
async function tellShop(message) {
  try {
    await mailer.send({ to: mailer.shopNotifyAddress(), ...message });
  } catch (err) {
    console.error(`[lifecycle] shop notice failed (${message && message.template}): ${err.name || "Error"}`);
  }
}

function flag(orderId, code, note) {
  return ordersDB.update(orderId, { attention: code, attentionNote: String(note || "").slice(0, 1000), attentionAt: now() });
}

// ─── Checkout sessions ─────────────────────────────────────────

/** Names the pair of return pages a session was made with: a session is only handed out again for the same pair. */
function returnKey(opts) {
  const source = opts.returnKey ? `key\n${opts.returnKey}` : `${opts.successUrl || ""}\n${opts.cancelUrl || ""}`;
  return crypto.createHash("sha256").update(source).digest("hex").slice(0, 32);
}

function markSession(id, updates) {
  return paymentSessionsDB.update(id, updates);
}

/**
 * Close a session at Stripe so it can no longer be paid.
 * @returns {Promise<{closed: true} | {paid: object}>} `paid` when Stripe says it was paid in the meantime.
 * Throws `payment-session-busy` when it cannot be confirmed closed: a second session is never
 * opened beside one that might still take money.
 */
async function closeSession(rec, status = "replaced") {
  const stripe = stripeClient.get();
  // Marked first, in the same step as the decision: the "expired" event Stripe sends for a
  // session we closed ourselves must not be read as the order's own session lapsing.
  markSession(rec.id, { status, closedAt: now() });
  let failure = null;
  try {
    if (!stripe || !stripe.checkout || typeof stripe.checkout.sessions.expire !== "function") throw new Error("expire unavailable");
    await stripe.checkout.sessions.expire(rec.id);
    return { closed: true };
  } catch (err) {
    failure = err;
  }
  if (isMissing(failure)) { markSession(rec.id, { status: "gone" }); return { closed: true }; }
  // Stripe refuses to expire a session that is already complete or expired: ask what it is.
  let current = null;
  try {
    current = stripe ? await stripe.checkout.sessions.retrieve(rec.id) : null;
  } catch (err) {
    if (isMissing(err)) { markSession(rec.id, { status: "gone" }); return { closed: true }; }
    markSession(rec.id, { status: "open", closedAt: null });
    throw refusal(502, "payment-session-busy", "We couldn't start the card payment just now. Try again in a minute.");
  }
  if (current && current.payment_status === "paid") { markSession(rec.id, { status: "open", closedAt: null }); return { paid: current }; }
  if (!current || current.status === "expired" || current.status === "complete") {
    markSession(rec.id, { status: current && current.status === "complete" ? "complete" : "expired" });
    return { closed: true };
  }
  markSession(rec.id, { status: "open", closedAt: null });
  throw refusal(502, "payment-session-busy", "We couldn't start the card payment just now. Try again in a minute.");
}

const inFlight = new Map(); // orderId → Promise of the session being opened for it

/**
 * The Checkout session to send the buyer to for an unpaid order.
 *
 * Two requests for the same order at the same moment (a double click) share one call and get
 * the same session. An order's open session is handed out again while it is still good (same
 * amount, same return pages, not about to expire); otherwise it is closed at Stripe and a new
 * one is made. If Stripe says the old session was paid, the order is settled here and the
 * answer carries `alreadyPaid` with the success page as its url: nobody is sent to pay twice.
 *
 * @returns {Promise<{id: string, url: string, alreadyPaid?: boolean, reused?: boolean}>}
 */
function checkoutSession(order, opts) {
  const existing = inFlight.get(order.id);
  if (existing) return existing;
  const work = openSession(order, opts).finally(() => inFlight.delete(order.id));
  inFlight.set(order.id, work);
  return work;
}

async function openSession(orderRef, opts) {
  const stripe = stripeClient.get();
  if (!stripe) throw Object.assign(new Error("Payment processing is not configured"), { status: 503, code: "payments-unavailable" });
  const orderEvents = require("./orderEvents");
  let order = ordersDB.getById(orderRef.id);
  if (!order || order.status !== "pending_payment") throw refusal(409, "order-not-payable", "This order is not waiting for a card payment.");

  const expected = expectedCents(order);
  const promo = promotionCodesAllowed();
  const key = returnKey(opts);
  let reuse = null;

  // An order made before sessions were recorded has only the id on its row.
  if (order.stripeSessionId && !paymentSessionsDB.getById(order.stripeSessionId)) {
    paymentSessionsDB.insert({ id: order.stripeSessionId, orderId: order.id, status: "open", amountCents: null, currency: currencyOf(order), promoAllowed: true, expiresAt: null });
  }

  for (const rec of openSessionsFor(order.id).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))) {
    let current = null;
    try { current = await stripe.checkout.sessions.retrieve(rec.id); } catch { current = null; }
    if (current && current.payment_status === "paid") {
      await settleFromSession(order.id, current, { base: opts.base, source: "checkout" });
      return { id: current.id, url: opts.successUrl, alreadyPaid: true };
    }
    const stillOpen = current && typeof current.url === "string" && current.url && (current.status === undefined || current.status === null || current.status === "open");
    const good = stillOpen && !reuse
      && rec.amountCents === expected && Boolean(rec.promoAllowed) === promo && rec.returnKey === key
      && rec.expiresAt && Date.parse(rec.expiresAt) > Date.now() + REUSE_MARGIN_MS;
    if (good) { reuse = current; continue; }
    const closed = await closeSession(rec);
    if (closed.paid) {
      await settleFromSession(order.id, closed.paid, { base: opts.base, source: "checkout" });
      return { id: closed.paid.id, url: opts.successUrl, alreadyPaid: true };
    }
  }
  if (reuse) return { id: reuse.id, url: reuse.url, reused: true };

  // The awaits above may have taken a while: look at the order again before opening anything.
  order = ordersDB.getById(order.id);
  if (!order || order.status !== "pending_payment") throw refusal(409, "order-not-payable", "This order is not waiting for a card payment.");

  const expiresAt = new Date(Date.now() + sessionMinutes() * 60 * 1000);
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    mode: "payment",
    customer_email: orderEvents.customerEmail(order) || undefined,
    line_items: orderEvents.stripeLineItems(order, { itemCount: opts.itemCount, description: opts.description }),
    metadata: { orderId: order.id, ...(opts.metadata || {}) },
    // The charge carries the order id too, so a refund or a dispute can be matched to its order.
    payment_intent_data: { metadata: { orderId: order.id } },
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    expires_at: Math.floor(expiresAt.getTime() / 1000),
    allow_promotion_codes: promo,
  });
  paymentSessionsDB.insert({
    id: session.id, orderId: order.id, status: "open", amountCents: expected, currency: currencyOf(order),
    promoAllowed: promo, url: session.url, returnKey: key, expiresAt: expiresAt.toISOString(),
  });

  // And once more after the call to Stripe: an order cancelled or settled while the session
  // was being made must not be left with a payable page.
  const after = ordersDB.getById(order.id);
  if (!after || after.status !== "pending_payment") {
    const rec = paymentSessionsDB.getById(session.id);
    try { if (rec) await closeSession(rec, "replaced"); } catch { /* the sweep and the late-payment path cover it */ }
    throw refusal(409, "order-not-payable", "This order is not waiting for a card payment.");
  }
  ordersDB.update(order.id, { stripeSessionId: session.id, sessionExpiresAt: expiresAt.toISOString(), currency: currencyOf(order) });
  return session;
}

/** Close every open session of an order (cancelled, paid another way, settled by another session). */
async function closeOpenSessions(orderId, { except, base } = {}) {
  for (const rec of openSessionsFor(orderId)) {
    if (rec.id === except) continue;
    try {
      const closed = await closeSession(rec, "replaced");
      // Paid in the meantime: it goes through the same door as any other payment (and is flagged there).
      if (closed.paid) await settleFromSession(orderId, closed.paid, { base, source: "close" });
    } catch (err) {
      console.error(`[lifecycle] could not close a checkout session for order ${String(orderId).slice(0, 8)}: ${err.code || err.name || "Error"}`);
    }
  }
}

// ─── Settling a payment ────────────────────────────────────────

const OUTCOMES = ["order-paid", "duplicate-payment", "late-payment", "payment-mismatch", "zero-payment"];

/**
 * Compare what Stripe reports with what this order should have been charged.
 * @returns {{problems: string[], total: number|null, discount: number, zero: boolean}}
 */
function checkSession(order, session, rec) {
  const problems = [];
  const total = session.amount_total;
  const rawDiscount = session.total_details ? session.total_details.amount_discount : 0;
  const discount = rawDiscount === undefined || rawDiscount === null ? 0 : rawDiscount;
  const expected = expectedCents(order);
  const currency = typeof session.currency === "string" ? session.currency.toLowerCase() : "";
  const ours = Boolean(rec && rec.orderId === order.id);

  if (!ours) problems.push("the checkout session named in the payment is not one we opened for this order");
  if (!Number.isInteger(total) || total < 0) {
    problems.push("the payment report carries no amount");
    return { problems, total: null, discount: 0, zero: false };
  }
  if (!Number.isInteger(discount) || discount < 0) problems.push("the discount in the payment report is not an amount");
  else {
    if (discount > 0 && !(rec && rec.promoAllowed)) problems.push(`a discount of ${money(discount / 100)} was applied although promotion codes are switched off`);
    if (total + discount !== expected) {
      problems.push(`Stripe reports ${money(total / 100)}${discount > 0 ? ` after a discount of ${money(discount / 100)}` : ""}; the order comes to ${money(expected / 100)}`);
    }
  }
  if (currency !== currencyOf(order)) problems.push(`the payment is in ${currency ? currency.toUpperCase().slice(0, 8) : "an unnamed currency"}; the order is in ${currencyOf(order).toUpperCase()}`);
  if (!(expected > 0)) problems.push("the order has no amount to pay");
  return { problems, total, discount: Number.isInteger(discount) && discount > 0 ? discount : 0, zero: total === 0 };
}

/**
 * Decide what a reported session means for its order and write it, in one synchronous step.
 * Returns what to do afterwards (emails, closing other sessions); does none of it itself.
 */
function applySession(orderId, session, { eventId, source } = {}) {
  const order = ordersDB.getById(orderId);
  if (!order) return { order: null, changed: false, outcome: "no-order" };
  const sid = idOf(session.id);
  const pi = idOf(session.payment_intent);

  let rec = sid ? paymentSessionsDB.getById(sid) : null;
  // An order made before sessions were recorded: the id on the order row is its session.
  if (!rec && sid && order.stripeSessionId === sid) {
    rec = paymentSessionsDB.insert({ id: sid, orderId: order.id, status: "open", amountCents: null, currency: currencyOf(order), promoAllowed: true, expiresAt: null });
  }

  // This session has already been dealt with for this order (a replayed webhook, the return page after the webhook).
  const dealtWith = sid && paymentEventsDB.query((e) => e.orderId === order.id && e.sessionId === sid && OUTCOMES.includes(e.kind)).length > 0;
  if (dealtWith) return { order, changed: false, outcome: "replay" };
  // Written by an earlier version, which kept no events: the session on a settled order is the one that paid it.
  if (order.status !== "pending_payment" && sid && order.stripeSessionId === sid && !order.attention && sessionsFor(order.id).every((s) => !s.outcome)
    && [...orderState.ACTIVE, "refunded", "paid_amount_mismatch"].includes(order.status)) {
    return { order, changed: false, outcome: "replay" };
  }

  const status = session.payment_status;
  const noPaymentNeeded = status === "no_payment_required";
  if (status !== "paid" && !noPaymentNeeded) return { order, changed: false, outcome: "unpaid" };

  const check = checkSession(order, session, rec);
  const base = { eventId, order, sessionId: sid, paymentIntent: pi, amountCents: check.total, currency: typeof session.currency === "string" ? session.currency.toLowerCase().slice(0, 8) : null };
  const ours = Boolean(rec && rec.orderId === order.id);
  const closeRec = (outcome) => { if (ours) markSession(rec.id, { status: "paid", outcome, paymentIntent: pi || null, paidCents: check.total, closedAt: now() }); };

  if (order.status === "pending_payment") {
    if (check.problems.length === 0 && !check.zero && !noPaymentNeeded) {
      const orderEvents = require("./orderEvents");
      const paid = orderEvents.transitionToPaid(order, {
        paidVia: "card",
        stripePaymentId: pi || null,
        stripeSessionId: sid,
        amountPaid: check.total / 100,
        discountAmount: check.discount / 100,
        currency: currencyOf(order),
      });
      if (!paid) return { order, changed: false, outcome: "replay" };
      closeRec("settled");
      recordEvent({ ...base, order: paid, kind: "order-paid", detail: `${source || "stripe"}${check.discount ? `; discount ${check.discount} cents` : ""}`, notified: true });
      return { order: paid, changed: true, outcome: "paid", after: { emails: "paid", closeOthers: sid } };
    }
    // Nothing collected (a 100% promotion code): never released without the owner.
    const nothingCollected = (check.zero || noPaymentNeeded) && check.problems.length === 0;
    const kind = nothingCollected ? "zero-payment" : "payment-mismatch";
    const note = nothingCollected
      ? `A checkout for this order was completed with nothing to pay: a promotion code covered all ${money(expectedCents(order) / 100)}. Nothing was collected and the order has not been released.`
      : `A payment arrived that does not match this order: ${check.problems.join("; ")}. The order has not been marked paid.`;
    const flagged = flag(order.id, kind, note);
    closeRec(kind);
    recordEvent({ ...base, kind, detail: note, notified: true });
    return { order: flagged, changed: false, outcome: kind, warning: kind, after: { notice: { kind, note, amountCents: check.total, sessionId: sid, paymentIntent: pi } } };
  }

  // The order is not waiting for a payment. Nothing was collected: nothing to chase.
  if (check.zero || noPaymentNeeded) {
    closeRec("zero-payment");
    recordEvent({ ...base, kind: "zero-payment", detail: `completed with nothing to pay while the order was ${order.status}` });
    return { order, changed: false, outcome: "ignored" };
  }
  const settledAlready = [...orderState.ACTIVE, "refunded", "paid_amount_mismatch"].includes(order.status);
  const kind = settledAlready ? "duplicate-payment" : order.status === "pending_po" ? "payment-mismatch" : "late-payment";
  const amount = check.total !== null ? money(check.total / 100) : "an unstated amount";
  const note = kind === "duplicate-payment"
    ? `A second card payment of ${amount} arrived for this order, which was already ${orderState.label(order.status)}. It has been taken by Stripe and is not part of this order: refund it unless the customer meant to pay twice.`
    : kind === "late-payment"
      ? `A card payment of ${amount} arrived after this order was ${orderState.label(order.status)}. The order has not been reopened: refund the payment, or mark the order paid by hand if you will build it.`
      : `A card payment of ${amount} arrived for an order placed on a purchase order. Check it in Stripe.`;
  const flagged = flag(order.id, kind, note);
  closeRec(kind);
  recordEvent({ ...base, kind, detail: note, notified: true });
  return { order: flagged, changed: false, outcome: kind, warning: kind, after: { notice: { kind, note, amountCents: check.total, sessionId: sid, paymentIntent: pi } } };
}

/**
 * Settle an order from a Stripe Checkout session (webhook, or a confirm-payment route).
 * @param {string|{id: string}} orderRef  the order, by id: it is read again here
 * @returns {Promise<{order: object|null, changed: boolean, outcome: string, warning?: string}>}
 */
async function settleFromSession(orderRef, session, { base, eventId, source } = {}) {
  const orderId = typeof orderRef === "string" ? orderRef : orderRef && orderRef.id;
  const result = applySession(orderId, session || {}, { eventId, source });
  const after = result.after;
  if (after && after.emails === "paid") await require("./orderEvents").sendPaidEmails(result.order, { base });
  if (after && after.notice) {
    await tellShop(paymentTemplates.paymentAttentionShop({ order: result.order, ...after.notice, adminUrl: adminUrl(base) }));
  }
  if (after && after.closeOthers) await closeOpenSessions(result.order.id, { except: after.closeOthers, base });
  return { order: result.order, changed: result.changed, outcome: result.outcome, ...(result.warning ? { warning: result.warning } : {}) };
}

/** Ask Stripe whether a pending order's open session was paid, and settle it if so. */
async function confirmPayment(orderRef, { base } = {}) {
  const orderId = typeof orderRef === "string" ? orderRef : orderRef && orderRef.id;
  let order = ordersDB.getById(orderId);
  if (!order) return { order: null, changed: false, outcome: "no-order" };
  const stripe = stripeClient.get();
  if (order.status !== "pending_payment" || !stripe) return { order, changed: false, outcome: "unchanged" };
  const ids = new Set(openSessionsFor(order.id).map((s) => s.id));
  if (order.stripeSessionId && !sessionsFor(order.id).some((s) => s.id === order.stripeSessionId)) ids.add(order.stripeSessionId); // made before sessions were recorded
  let last = { order, changed: false, outcome: "unchanged" };
  for (const id of ids) {
    const session = await stripe.checkout.sessions.retrieve(id);
    if (!session) continue;
    // The session is the one named on our own record, whatever id the answer carries.
    last = await settleFromSession(order.id, { ...session, id }, { base, source: "confirm" });
    if (last.changed) break;
  }
  order = ordersDB.getById(orderId);
  return { ...last, order };
}

// ─── Expiry ────────────────────────────────────────────────────

/** Give the quote back: an instant quote can be checked out again, a firm quote accepted again. */
function releaseSource(order) {
  if (order.rfqId) {
    const rfq = rfqsDB.getById(order.rfqId);
    if (rfq && rfq.status === "accepted" && rfq.orderId === order.id) {
      const open = rfq.validUntil && new Date(rfq.validUntil) > new Date();
      rfqsDB.update(rfq.id, { status: open ? "quoted" : "expired", acceptedAt: null, acceptedVia: null, poNumber: "", orderId: null });
    }
    return;
  }
  if (!order.quoteId) return;
  const others = ordersDB.query((o) => o.quoteId === order.quoteId && o.id !== order.id && !["expired", "cancelled"].includes(o.status));
  if (others.length > 0) return;
  const quote = quotesDB.getById(order.quoteId);
  if (quote && quote.status === "ordered") quotesDB.update(quote.id, { status: "draft" });
}

/** An unpaid order whose session lapsed: closed out and shown as expired. Synchronous. */
function expireOrder(orderId, cause) {
  const order = ordersDB.getById(orderId);
  if (!order || order.status !== "pending_payment" || order.attention) return null;
  const expired = ordersDB.update(order.id, { status: "expired", expiredAt: now() });
  for (const rec of openSessionsFor(order.id)) markSession(rec.id, { status: "expired", closedAt: now() });
  releaseSource(expired);
  recordEvent({ kind: "order-expired", order: expired, sessionId: order.stripeSessionId, detail: cause });
  return expired;
}

/** checkout.session.expired */
function handleSessionExpired(session, { eventId } = {}) {
  const sid = idOf(session && session.id);
  const rec = sid ? paymentSessionsDB.getById(sid) : null;
  const orderId = (rec && rec.orderId) || (session && session.metadata && session.metadata.orderId);
  const order = orderId ? ordersDB.getById(orderId) : null;
  if (!order) return { outcome: "no-order" };
  // A session we closed ourselves (replaced, cancelled) is already marked and says nothing about the order.
  const lapsedOnItsOwn = rec ? rec.status === "open" && rec.orderId === order.id : order.stripeSessionId === sid;
  if (rec && rec.status === "open") markSession(rec.id, { status: "expired", closedAt: now() });
  if (!lapsedOnItsOwn || inFlight.has(order.id) || openSessionsFor(order.id).length > 0) return { outcome: "session-closed", order };
  if (order.stripeSessionId && order.stripeSessionId !== sid) return { outcome: "session-closed", order };
  const expired = expireOrder(order.id, `checkout session expired${eventId ? "" : " (no event id)"}`);
  return { outcome: expired ? "order-expired" : "unchanged", order: expired || order };
}

/**
 * Close out unpaid orders whose session's expiry has passed. Asks Stripe about each session
 * first: one that was paid is settled, never expired. Orders taken by phone (no session) and
 * flagged orders are left for the owner.
 */
async function sweepExpired({ now: at = Date.now(), base } = {}) {
  const stripe = stripeClient.get();
  const result = { checked: 0, expired: 0, settled: 0, skipped: 0 };
  const pending = ordersDB.query((o) => o.status === "pending_payment" && !o.attention);
  for (const candidate of pending) {
    const recs = sessionsFor(candidate.id);
    if (!candidate.stripeSessionId && recs.length === 0) continue; // a phone order: no card session to lapse
    const deadline = candidate.sessionExpiresAt ? Date.parse(candidate.sessionExpiresAt) : Date.parse(candidate.createdAt || 0) + LEGACY_SESSION_MS;
    if (!Number.isFinite(deadline) || at < deadline + SWEEP_GRACE_MS || inFlight.has(candidate.id)) continue;
    result.checked++;
    const ids = new Set(recs.filter((s) => s.status === "open").map((s) => s.id));
    if (candidate.stripeSessionId && !recs.some((s) => s.id === candidate.stripeSessionId)) ids.add(candidate.stripeSessionId);
    let unknown = false;
    let settled = false;
    for (const id of ids) {
      let session = null;
      try {
        session = stripe ? await stripe.checkout.sessions.retrieve(id) : null;
      } catch (err) {
        if (!isMissing(err)) { unknown = true; continue; } // Stripe did not answer: do not expire blind
      }
      if (!stripe) { unknown = true; continue; }
      if (session && (session.payment_status === "paid" || session.payment_status === "no_payment_required")) {
        const r = await settleFromSession(candidate.id, { ...session, id }, { base, source: "sweep" });
        if (r.changed || r.warning) settled = true;
        continue;
      }
      if (session && (session.status === "open" || session.status === undefined || session.status === null)) {
        const rec = paymentSessionsDB.getById(id);
        try {
          if (rec) { const c = await closeSession(rec, "expired"); if (c.paid) { await settleFromSession(candidate.id, c.paid, { base, source: "sweep" }); settled = true; } }
          else if (typeof stripe.checkout.sessions.expire === "function") await stripe.checkout.sessions.expire(id);
        } catch { unknown = true; }
      }
    }
    if (settled) { result.settled++; continue; }
    if (unknown) { result.skipped++; continue; }
    if (expireOrder(candidate.id, "unpaid past the session's expiry (sweep)")) result.expired++;
  }
  return result;
}

let sweepTimer = null;
function startSweep({ everyMs = SWEEP_EVERY_MS } = {}) {
  const run = () => sweepExpired().then((r) => {
    if (r.expired || r.settled || r.skipped) console.log(`Order sweep: ${r.expired} unpaid order(s) closed as expired, ${r.settled} settled late, ${r.skipped} left for the next run (Stripe did not answer)`);
  }).catch((err) => console.error("Order sweep error:", err.code || err.name || "Error"));
  run();
  sweepTimer = setInterval(run, everyMs);
  if (sweepTimer.unref) sweepTimer.unref();
  return sweepTimer;
}

// ─── Refunds and disputes ──────────────────────────────────────

/**
 * Which order does a charge belong to, and is it the payment that settled the order
 * (`primary`) or an extra one that was flagged (duplicate, late, not matching)?
 */
async function orderForCharge({ paymentIntent, metadataOrderId }) {
  if (paymentIntent) {
    const primary = ordersDB.query((o) => o.stripePaymentId === paymentIntent)[0];
    if (primary) return { order: primary, primary: true };
    const rec = paymentSessionsDB.query((s) => s.paymentIntent === paymentIntent)[0];
    if (rec) {
      const order = ordersDB.getById(rec.orderId);
      if (order) return { order, primary: rec.outcome === "settled", rec };
    }
    // An order paid before payments were recorded: ask Stripe which checkout session the payment came from.
    const stripe = stripeClient.get();
    if (stripe && stripe.checkout && typeof stripe.checkout.sessions.list === "function") {
      const listed = await stripe.checkout.sessions.list({ payment_intent: paymentIntent, limit: 1 });
      const session = listed && Array.isArray(listed.data) ? listed.data[0] : null;
      const orderId = session && session.metadata ? session.metadata.orderId : null;
      const order = orderId ? ordersDB.getById(orderId) : null;
      if (order) return { order, primary: !order.stripePaymentId && (!order.stripeSessionId || order.stripeSessionId === session.id) };
    }
  }
  const named = metadataOrderId ? ordersDB.getById(metadataOrderId) : null;
  // Named by the charge's own metadata (we put the order id there when the session is made).
  if (named) return { order: named, primary: !paymentIntent || !named.stripePaymentId || named.stripePaymentId === paymentIntent };
  return { order: null, primary: false };
}

function paidCentsOf(order) {
  const paid = order.amountPaid !== null && order.amountPaid !== undefined ? Number(order.amountPaid) : Number(order.total);
  return Math.round((Number.isFinite(paid) ? paid : 0) * 100);
}

/** charge.refunded — the charge carries the running total refunded. */
async function handleChargeRefunded(charge, { eventId, base } = {}) {
  const pi = idOf(charge && charge.payment_intent);
  const refunded = charge ? charge.amount_refunded : null;
  if (!Number.isInteger(refunded) || refunded < 0) return { outcome: "ignored" };
  const found = await orderForCharge({ paymentIntent: pi, metadataOrderId: charge.metadata && charge.metadata.orderId });
  if (!found.order) {
    recordEvent({ eventId, kind: "unmatched", paymentIntent: pi, amountCents: refunded, detail: "refund for a payment that is not one of our orders" });
    return { outcome: "unmatched" };
  }

  // One synchronous step on the order as it is now.
  const order = ordersDB.getById(found.order.id);
  if (!found.primary) {
    const captured = Number.isInteger(charge.amount_captured) ? charge.amount_captured : charge.amount;
    const full = charge.refunded === true || (Number.isInteger(captured) && refunded >= captured) || (found.rec && Number.isInteger(found.rec.paidCents) && refunded >= found.rec.paidCents);
    const already = paymentEventsDB.query((e) => e.orderId === order.id && e.kind === "refund" && e.paymentIntent === pi && e.amountCents === refunded).length > 0;
    if (already) return { outcome: "replay", order };
    let updated = order;
    if (full && ["duplicate-payment", "late-payment", "payment-mismatch"].includes(order.attention)) {
      updated = ordersDB.update(order.id, { attention: null, attentionNote: `${order.attentionNote || ""} Refunded in full on ${now().slice(0, 10)}.`.trim(), attentionAt: now() });
    }
    recordEvent({ eventId, kind: "refund", order: updated, paymentIntent: pi, amountCents: refunded, detail: `extra payment refunded${full ? " in full" : " in part"}`, notified: true });
    await tellShop(paymentTemplates.refundShop({ order: updated, refundedCents: refunded, paidCents: 0, full, extraPayment: true, paymentIntent: pi, adminUrl: adminUrl(base) }));
    return { outcome: "extra-refund", order: updated };
  }

  const paidCents = paidCentsOf(order);
  const before = Math.round((Number(order.refundedAmount) || 0) * 100);
  if (refunded === before) return { outcome: "replay", order };
  const full = paidCents > 0 && refunded >= paidCents;
  const updates = { refundedAmount: refunded / 100, refundedAt: now() };
  let problem = null;
  if (full && [...orderState.ACTIVE, "paid_amount_mismatch"].includes(order.status)) updates.status = "refunded";
  if (refunded < before) {
    // The running total went down: a refund failed or was reversed after we recorded it.
    problem = `A refund on this order was reversed or did not go through: Stripe now reports ${money(refunded / 100)} refunded, down from ${money(before / 100)}.`;
    Object.assign(updates, { attention: "refund-problem", attentionNote: problem, attentionAt: now() });
  }
  if (!order.stripePaymentId && pi) updates.stripePaymentId = pi;
  const updated = ordersDB.update(order.id, updates);
  recordEvent({ eventId, kind: problem ? "refund-problem" : "refund", order: updated, paymentIntent: pi, amountCents: refunded, detail: problem || (full ? "refunded in full" : "partly refunded"), notified: true });
  if (problem) await tellShop(paymentTemplates.paymentAttentionShop({ order: updated, kind: "refund-problem", note: problem, amountCents: refunded, paymentIntent: pi, adminUrl: adminUrl(base) }));
  else await tellShop(paymentTemplates.refundShop({ order: updated, refundedCents: refunded, paidCents, full, paymentIntent: pi, adminUrl: adminUrl(base) }));
  return { outcome: full ? "refunded" : "partially-refunded", order: updated };
}

/**
 * refund.updated / refund.failed / charge.refund.updated — one refund changed (it can fail days
 * later). The refund names its charge; the charge is read from Stripe so the order gets the
 * running total, exactly as charge.refunded would give it.
 */
async function handleRefundUpdated(refund, { eventId, base } = {}) {
  const stripe = stripeClient.get();
  const chargeId = idOf(refund && refund.charge);
  if (!chargeId || !stripe || !stripe.charges || typeof stripe.charges.retrieve !== "function") {
    // Without the charge there is no running total: only a refund that failed is acted on.
    const pi = idOf(refund && refund.payment_intent);
    if (refund && (refund.status === "failed" || refund.status === "canceled") && pi) {
      const found = await orderForCharge({ paymentIntent: pi, metadataOrderId: refund.metadata && refund.metadata.orderId });
      if (found.order) {
        const note = `A refund of ${money((Number(refund.amount) || 0) / 100)} on this order did not go through. Check the payment in Stripe.`;
        const flagged = flag(found.order.id, "refund-problem", note);
        recordEvent({ eventId, kind: "refund-problem", order: flagged, paymentIntent: pi, amountCents: Number.isInteger(refund.amount) ? refund.amount : null, detail: note, notified: true });
        await tellShop(paymentTemplates.paymentAttentionShop({ order: flagged, kind: "refund-problem", note, amountCents: refund.amount, paymentIntent: pi, adminUrl: adminUrl(base) }));
        return { outcome: "refund-problem", order: flagged };
      }
    }
    return { outcome: "ignored" };
  }
  const charge = await stripe.charges.retrieve(chargeId); // a failure here answers 500 and Stripe sends the event again
  if (!charge) return { outcome: "ignored" };
  return handleChargeRefunded(charge, { eventId, base });
}

/** charge.dispute.created / charge.dispute.closed. The order is flagged and the shop told at once; nothing is cancelled. */
async function handleDispute(dispute, { eventId, base, phase } = {}) {
  const pi = idOf(dispute && dispute.payment_intent);
  const found = await orderForCharge({ paymentIntent: pi, metadataOrderId: dispute && dispute.metadata && dispute.metadata.orderId });
  const amountCents = dispute && Number.isInteger(dispute.amount) ? dispute.amount : null;
  if (!found.order) {
    recordEvent({ eventId, kind: "unmatched", paymentIntent: pi, amountCents, detail: `dispute ${phase} for a payment that is not one of our orders` });
    return { outcome: "unmatched" };
  }
  const order = ordersDB.getById(found.order.id);
  const extra = !found.primary;
  let updated;
  let outcome = null;
  if (phase === "opened") {
    const note = `The cardholder's bank opened a dispute${amountCents !== null ? ` for ${money(amountCents / 100)}` : ""}${extra ? " on the extra payment flagged on this order" : ""}. Answer it in Stripe before the deadline shown there. The order has not been cancelled.`;
    updated = ordersDB.update(order.id, { disputeStatus: "open", disputeAt: now(), attention: "dispute", attentionNote: note, attentionAt: now() });
  } else {
    const status = dispute && typeof dispute.status === "string" ? dispute.status : "";
    outcome = status === "won" ? "won" : status === "lost" ? "lost" : "closed";
    const note = outcome === "lost"
      ? `The dispute was lost: the bank took ${amountCents !== null ? money(amountCents / 100) : "the payment"} back. This order is no longer paid for.`
      : outcome === "won" ? "The dispute was closed in your favour. The payment stands." : "The dispute was closed. Check its result in Stripe.";
    updated = ordersDB.update(order.id, {
      disputeStatus: outcome, disputeAt: now(),
      // A lost dispute stays flagged until the owner has dealt with it.
      ...(outcome === "lost" ? { attention: "dispute", attentionNote: note, attentionAt: now() } : order.attention === "dispute" ? { attention: null, attentionNote: note, attentionAt: now() } : {}),
    });
  }
  recordEvent({ eventId, kind: phase === "opened" ? "dispute-opened" : "dispute-closed", order: updated, paymentIntent: pi, amountCents, detail: outcome || "opened", notified: true });
  await tellShop(paymentTemplates.disputeShop({ order: updated, phase, outcome, amountCents, reason: dispute && dispute.reason, extraPayment: extra, paymentIntent: pi, adminUrl: adminUrl(base) }));
  return { outcome: phase === "opened" ? "dispute-opened" : `dispute-${outcome}`, order: updated };
}

// ─── The owner's manual moves ──────────────────────────────────

/**
 * Move an order by hand (PUT /api/orders/:id/status). Only the moves in orderState.MANUAL;
 * "paid" with no payment on record needs a typed reason and how it was paid. Every move is
 * written to the audit trail.
 *
 * @returns {{ok: true, order, changed: boolean, closeSessions: boolean} | {ok: false, status: number, code: string, error: string}}
 */
function manualMove(orderId, to, { actor, reason, paidVia, extra = {} } = {}) {
  const order = ordersDB.getById(orderId);
  if (!order) return { ok: false, status: 404, code: "order-not-found", error: "Order not found" };
  const move = orderState.manualTransition(order, to);
  if (!move.ok) return { ok: false, status: move.code === "status-unknown" ? 400 : 409, code: move.code, error: move.error };
  if (move.same) {
    const updated = Object.keys(extra).length ? ordersDB.update(order.id, extra) : order;
    return { ok: true, order: updated, before: order, changed: false, closeSessions: false };
  }
  const why = typeof reason === "string" ? reason.trim() : "";
  if (move.needsReason && why.length < 3) {
    return { ok: false, status: 400, code: "reason-required", error: to === "paid" ? "Say how this order was paid (for example: cheque 1042, wire received 11 Nov, PO terms agreed) before marking it paid." : "Say why before making this change." };
  }
  const updates = { ...extra, status: to };
  let via = null;
  if (to === "paid" && move.needsReason) {
    via = orderState.MANUAL_PAID_METHODS.includes(paidVia) ? paidVia : "other";
    Object.assign(updates, { paidAt: now(), paidVia: "manual", manualPaidReason: `${via}: ${why}`.slice(0, 500), manualPaidBy: (actor && actor.email) || "" });
    if (order.leadDays !== null && order.leadDays !== undefined) updates.shipBy = shipBy.shipByDate(Number(order.leadDays));
  }
  if (to === "cancelled") updates.cancelledAt = now();
  if (to === "refunded") Object.assign(updates, { refundedAt: now(), refundedAmount: order.refundedAmount || paidCentsOf(order) / 100 });
  const updated = ordersDB.update(order.id, updates);
  audit.record({
    actor, action: to === "paid" && move.needsReason ? "order.mark-paid" : to === "cancelled" ? "order.cancel" : "order.status",
    entity: "order", entityId: order.id, note: why,
    before: { status: order.status }, after: { status: to, ...(via ? { paidVia: via } : {}) },
  });
  if (to === "paid" && move.needsReason) recordEvent({ kind: "manual-paid", order: updated, amountCents: expectedCents(order), currency: currencyOf(order), detail: `${via}: ${why}` });
  if (to === "cancelled") recordEvent({ kind: "order-cancelled", order: updated, detail: why });
  // Paid another way or called off: the card page must stop taking money for it.
  const closeSessions = ["pending_payment", "expired"].includes(order.status) && ["paid", "cancelled"].includes(to);
  return { ok: true, order: updated, before: order, changed: true, closeSessions };
}

/** The owner has dealt with whatever was flagged. */
function resolveAttention(orderId, { actor, note } = {}) {
  const order = ordersDB.getById(orderId);
  if (!order) return { ok: false, status: 404, code: "order-not-found", error: "Order not found" };
  if (!order.attention) return { ok: true, order, changed: false };
  const why = typeof note === "string" ? note.trim() : "";
  if (why.length < 3) return { ok: false, status: 400, code: "reason-required", error: "Say what was done about it (for example: refunded in Stripe, customer called) before clearing the flag." };
  const updated = ordersDB.update(order.id, { attention: null, attentionNote: `${order.attentionNote || ""} Resolved: ${why}`.trim().slice(0, 1000), attentionAt: now() });
  audit.record({ actor, action: "order.attention-resolved", entity: "order", entityId: order.id, note: why, before: { attention: order.attention }, after: { attention: null } });
  recordEvent({ kind: "attention-resolved", order: updated, detail: why });
  return { ok: true, order: updated, changed: true };
}

// ─── What the screens show ─────────────────────────────────────

/** The payment facts of an order in the words the pages use. Shared by the admin and customer views. */
function paymentView(order) {
  const refunded = Number(order.refundedAmount) || 0;
  const paid = order.amountPaid !== null && order.amountPaid !== undefined ? Number(order.amountPaid) : null;
  return {
    needsAttention: Boolean(order.attention),
    attention: order.attention || null,
    attentionLabel: order.attention ? (orderState.ATTENTION[order.attention] || "Needs attention") : null,
    refundedAmount: refunded,
    partiallyRefunded: refunded > 0 && order.status !== "refunded",
    disputed: order.disputeStatus === "open",
    disputeStatus: order.disputeStatus || null,
    discountAmount: Number(order.discountAmount) || 0,
    amountPaid: paid,
    paidByHand: order.paidVia === "manual",
  };
}

module.exports = {
  sessionMinutes, promotionCodesAllowed, paymentSettings, expectedCents, currencyOf,
  checkoutSession, closeOpenSessions, settleFromSession, confirmPayment, checkSession,
  expireOrder, releaseSource, handleSessionExpired, sweepExpired, startSweep,
  handleChargeRefunded, handleRefundUpdated, handleDispute,
  manualMove, resolveAttention, paymentView,
  recordEvent, eventSeen, eventsFor, sessionsFor, tellShop,
  SWEEP_GRACE_MS, LEGACY_SESSION_MS,
};
