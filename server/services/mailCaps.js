/**
 * Site-wide hourly caps on the two kinds of mail a stranger can make the site
 * send (independent review 2026-11-11, M2 and M3):
 *
 *   unconfirmed   mail to an address somebody typed and has not confirmed:
 *                 "confirm your email" after registering, and the "we have
 *                 your request" confirmation. Limited per client and per
 *                 recipient elsewhere; from many addresses those limits add up
 *                 to unwanted mail from the shop's domain, and enough
 *                 complaints get the mail account suspended — which stops
 *                 order confirmations and password resets too.
 *                 MAIL_UNCONFIRMED_PER_HOUR_SITE (default 60).
 *   shop          the per-request notice to the shop's own inbox. A flood of
 *                 requests would bury real ones. MAIL_SHOP_REQUESTS_PER_HOUR_SITE
 *                 (default 40). The requests themselves are still stored and
 *                 shown in the admin panel.
 *
 * Mail about money and accounts is never capped here: order confirmations,
 * new-order and accepted-quote notices, shipping notices, firm quotes,
 * password resets and security notices always go out.
 *
 * When a cap is reached the owner gets ONE notice for that hour saying which
 * cap, and what was held. counters() is for the status page.
 *
 * Since the re-review of 2026-11-12 (RR-04) the unconfirmed cap does not drop
 * anything and does not apply to a client's first two messages in the hour:
 * see admit() below.
 */
const { limits } = require("../security/limits");

const HOUR = 60 * 60 * 1000;

// Which cap a template falls under (the name every message carries; see emails/templates.js).
const KIND_BY_TEMPLATE = {
  verifyEmail: "unconfirmed",
  rfqReceivedBuyer: "unconfirmed",
  partRequestBuyer: "unconfirmed",
  rfqReceivedShop: "shop",
};

const LABEL = {
  unconfirmed: "confirmation emails to addresses that are not confirmed yet",
  shop: "new-request notices to the shop inbox",
};

function fresh(now) {
  return { start: now, sent: 0, held: 0, free: 0, notified: false };
}
const windows = { unconfirmed: fresh(0), shop: fresh(0) };
const totals = { unconfirmed: { sent: 0, held: 0, free: 0, sentLater: 0, dropped: 0 }, shop: { sent: 0, held: 0 }, noticesSent: 0 };

// Independent re-review 2026-11-12, RR-04: one address used up the hour's 60 confirmation emails in
// four minutes, and for the rest of the hour no new customer could confirm their address, so none
// could check out. A cap that everyone shares and that drops what is over it is a switch an
// attacker can throw. Two changes:
//
//   the first few are not the cap's business   each client address's first
//        MAIL_UNCONFIRMED_FREE_PER_CLIENT_HOUR (2) messages to unconfirmed addresses in an hour go
//        out whatever the site-wide count is. A new customer registering from their own address
//        always gets their confirmation email at once.
//   held, not dropped   past the cap a message is HELD and sent when the hour turns, and the
//        caller is told so ("we'll send it within the hour"), not `sent: false`. Only a sender who
//        already has MAIL_HELD_PER_CLIENT messages waiting has more turned away.
//
// A hard ceiling (MAIL_UNCONFIRMED_HARD_PER_HOUR_SITE, 300) is the one thing that still holds
// first messages too: it is what protects the mail account from a flood sent from hundreds of
// addresses, and what is over it is held for the next hour, not dropped.
const { UsageWindow } = require("./usageWindow");
const perClient = new UsageWindow({ windowMs: HOUR });
const heldQueue = []; // [{ message, clientKey, kind, at }]
const HELD_MAX = 1000;

function capFor(kind) {
  return kind === "unconfirmed" ? limits.mailUnconfirmedPerHourSite : limits.mailShopRequestsPerHourSite;
}

function windowFor(kind, now) {
  if (now - windows[kind].start >= HOUR) windows[kind] = fresh(now);
  return windows[kind];
}

/**
 * May this message go out now? Counts it when the answer is yes.
 * @param {string} template  the message's template name
 * @param {number} [now]
 * @param {{ confirmedRecipient?: boolean, clientKey?: string, retry?: boolean }} [opt]
 *        confirmedRecipient: the caller knows the recipient's address is confirmed.
 *        clientKey: the client the message was caused by (its first few each hour always go).
 *        retry: a held message being tried again (not counted as held twice).
 * @returns {{ allowed: boolean, hold: boolean, kind: string|null, notify: boolean }}
 *          hold: not now, but keep it and send it when the hour turns (mailer.js does)
 *          notify: this is the first message over the cap this hour — tell the owner once
 */
function admit(template, now = Date.now(), { confirmedRecipient = false, clientKey = "", retry = false } = {}) {
  const kind = Object.prototype.hasOwnProperty.call(KIND_BY_TEMPLATE, template) ? KIND_BY_TEMPLATE[template] : null;
  if (!kind) return { allowed: true, hold: false, kind: null, notify: false };
  // The same message to an address that IS confirmed (a signed-in customer writing from their own account) is not what the cap is for.
  if (kind === "unconfirmed" && confirmedRecipient) return { allowed: true, hold: false, kind: null, notify: false };
  const w = windowFor(kind, now);
  if (kind === "unconfirmed") {
    const underHard = w.sent + w.free < limits.mailUnconfirmedHardPerHourSite;
    if (clientKey && underHard && perClient.total(clientKey, now) < limits.mailUnconfirmedFreePerClientHour) {
      perClient.add(clientKey, 1, now);
      w.free++;
      totals.unconfirmed.free++;
      return { allowed: true, hold: false, kind, notify: false };
    }
    if (underHard && w.sent < capFor(kind)) {
      if (clientKey) perClient.add(clientKey, 1, now);
      w.sent++;
      totals[kind].sent++;
      return { allowed: true, hold: false, kind, notify: false };
    }
    if (!retry) { w.held++; totals[kind].held++; }
    const notify = !retry && !w.notified;
    if (notify) w.notified = true;
    return { allowed: false, hold: true, kind, notify };
  }
  if (w.sent < capFor(kind)) {
    w.sent++;
    totals[kind].sent++;
    return { allowed: true, hold: false, kind, notify: false };
  }
  w.held++;
  totals[kind].held++;
  const notify = !w.notified;
  w.notified = true;
  return { allowed: false, hold: false, kind, notify };
}

/**
 * Keep a message that could not go out this hour. One per recipient and template (a newer one
 * replaces it: the newest link is the one to send).
 * @returns {boolean} false when it was not kept (this client already has its share waiting, or the queue is full)
 */
function hold(message, { clientKey = "", kind = "unconfirmed", now = Date.now() } = {}) {
  const same = (h) => h.message.template === message.template && String(h.message.to) === String(message.to);
  const at = heldQueue.findIndex(same);
  if (at >= 0) { heldQueue[at] = { ...heldQueue[at], message }; return true; }
  if (heldQueue.length >= HELD_MAX || (clientKey && heldQueue.filter((h) => h.clientKey === clientKey).length >= limits.mailHeldPerClient)) {
    totals.unconfirmed.dropped++;
    lastDropped.set(`${message.template}\n${String(message.to).toLowerCase()}`, now);
    if (lastDropped.size > 5000) lastDropped.clear();
    return false;
  }
  heldQueue.push({ message, clientKey, kind, at: now });
  return true;
}

/** Messages the caps turned away with nothing left in line, by template and recipient (for recentlyDropped()). */
const lastDropped = new Map();

/** Did the caps themselves turn away this recipient's message of this kind in the last few seconds, with nothing held for it? */
function recentlyDropped(to, template, now = Date.now()) {
  const at = lastDropped.get(`${template}\n${String(to).toLowerCase()}`);
  return at !== undefined && now - at < 10 * 1000;
}

/** The held messages that may go now, removed from the queue (oldest first; each client's first before anyone's second). */
function due(now = Date.now()) {
  if (heldQueue.length === 0) return [];
  const out = [];
  const seen = new Map();
  const order = heldQueue.map((h, i) => { const n = seen.get(h.clientKey) || 0; seen.set(h.clientKey, n + 1); return { i, turn: n, at: h.at }; }).sort((x, y) => (x.turn - y.turn) || (x.at - y.at));
  const taken = new Set();
  for (const o of order) {
    const h = heldQueue[o.i];
    // A message held for a day is not sent (its link would be the last thing its recipient expects).
    if (now - h.at > 24 * HOUR) { taken.add(o.i); totals.unconfirmed.dropped++; continue; }
    const verdict = admit(h.message.template, now, { clientKey: h.clientKey, retry: true });
    if (!verdict.allowed) break;
    taken.add(o.i);
    totals.unconfirmed.sentLater++;
    out.push(h.message);
  }
  for (let i = heldQueue.length - 1; i >= 0; i--) if (taken.has(i)) heldQueue.splice(i, 1);
  return out;
}

/** When the current hour of the unconfirmed-mail cap ends (ms since epoch). */
function nextTurn(now = Date.now()) {
  return windowFor("unconfirmed", now).start + HOUR;
}

/** The one notice the owner gets when a cap is first reached in an hour. Plain text; no customer data. */
function ownerNotice(kind, now = Date.now()) {
  const cap = capFor(kind);
  const until = new Date(windows[kind].start + HOUR).toISOString().slice(11, 16);
  const lines = kind === "shop"
    ? [
      `The site has sent ${cap} new-request notices to this inbox in the last hour, which is its hourly limit.`,
      "Requests are still being taken and stored. They are in the admin panel under Requests; they just will not each send an email until the hour is up.",
      "If this is a run of junk requests, delete them in the admin panel: open a request and choose Delete request.",
    ]
    : [
      `The site has sent ${cap} confirmation emails to addresses that are not confirmed yet in the last hour, which is its hourly limit.`,
      "New accounts and requests are still being taken. Each visitor's first confirmation email still goes out at once; the ones over the limit are being held and will be sent when the hour is up. Requests are in the admin panel.",
      "A burst like this is usually a script typing other people's addresses. If it keeps happening, switch on the robot check (TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY in Railway).",
    ];
  const text = [...lines, "", `The limit resets at ${until} UTC. Order, payment and password emails are not affected.`].join("\n");
  return {
    subject: kind === "shop" ? "Straightedge site: hourly limit reached for new-request emails" : "Straightedge site: hourly limit reached for confirmation emails",
    text,
    html: `<div style="font-family:system-ui,Arial,sans-serif;font-size:14px;line-height:1.5">${lines.map((l) => `<p>${l}</p>`).join("")}<p>The limit resets at ${until} UTC. Order, payment and password emails are not affected.</p></div>`,
    template: "mailCapReached",
  };
}

/** For the status page: this hour's counts and the totals since the server started. */
function counters(now = Date.now()) {
  const out = {};
  for (const kind of ["unconfirmed", "shop"]) {
    const w = windowFor(kind, now);
    out[kind] = {
      what: LABEL[kind],
      capPerHour: capFor(kind),
      sentThisHour: w.sent,
      heldThisHour: w.held,
      capReached: w.sent >= capFor(kind),
      ...(kind === "unconfirmed" ? { firstFewThisHour: w.free, waitingToBeSent: heldQueue.length, sentLaterSinceStart: totals.unconfirmed.sentLater, turnedAwaySinceStart: totals.unconfirmed.dropped } : {}),
      windowStartedAt: new Date(w.start).toISOString(),
      sentSinceStart: totals[kind].sent,
      heldSinceStart: totals[kind].held,
    };
  }
  out.ownerNoticesSent = totals.noticesSent;
  return out;
}

function noteNoticeSent() { totals.noticesSent++; }

/** Tests only. */
function resetForTests() {
  windows.unconfirmed = fresh(0);
  windows.shop = fresh(0);
  perClient.reset();
  heldQueue.length = 0;
  lastDropped.clear();
  for (const k of ["unconfirmed", "shop"]) { for (const f of Object.keys(totals[k])) totals[k][f] = 0; }
  totals.noticesSent = 0;
}

module.exports = { admit, hold, due, nextTurn, recentlyDropped, ownerNotice, counters, noteNoticeSent, resetForTests, KIND_BY_TEMPLATE, heldQueue };
