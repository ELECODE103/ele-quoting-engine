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
  return { start: now, sent: 0, held: 0, notified: false };
}
const windows = { unconfirmed: fresh(0), shop: fresh(0) };
const totals = { unconfirmed: { sent: 0, held: 0 }, shop: { sent: 0, held: 0 }, noticesSent: 0 };

function capFor(kind) {
  return kind === "unconfirmed" ? limits.mailUnconfirmedPerHourSite : limits.mailShopRequestsPerHourSite;
}

function windowFor(kind, now) {
  if (now - windows[kind].start >= HOUR) windows[kind] = fresh(now);
  return windows[kind];
}

/**
 * May this message go out? Counts it when the answer is yes.
 * @param {string} template  the message's template name
 * @returns {{ allowed: boolean, kind: string|null, notify: boolean }}
 *          notify: this is the first message held this hour — tell the owner once
 */
function admit(template, now = Date.now()) {
  const kind = Object.prototype.hasOwnProperty.call(KIND_BY_TEMPLATE, template) ? KIND_BY_TEMPLATE[template] : null;
  if (!kind) return { allowed: true, kind: null, notify: false };
  const w = windowFor(kind, now);
  if (w.sent < capFor(kind)) {
    w.sent++;
    totals[kind].sent++;
    return { allowed: true, kind, notify: false };
  }
  w.held++;
  totals[kind].held++;
  const notify = !w.notified;
  w.notified = true;
  return { allowed: false, kind, notify };
}

/** The one notice the owner gets when a cap is first reached in an hour. Plain text; no customer data. */
function ownerNotice(kind, now = Date.now()) {
  const cap = capFor(kind);
  const until = new Date(windows[kind].start + HOUR).toISOString().slice(11, 16);
  const lines = kind === "shop"
    ? [
      `The site has sent ${cap} new-request notices to this inbox in the last hour, which is its hourly limit.`,
      "Requests are still being taken and stored. They are in the admin panel under Requests; they just will not each send an email until the hour is up.",
      "If this is a run of junk requests, delete them from the admin panel (each has a Delete button).",
    ]
    : [
      `The site has sent ${cap} confirmation emails to addresses that are not confirmed yet in the last hour, which is its hourly limit.`,
      "New accounts and requests are still being taken. People who register now can ask for their confirmation link again once the hour is up; requests are in the admin panel.",
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
  for (const k of ["unconfirmed", "shop"]) { totals[k].sent = 0; totals[k].held = 0; }
  totals.noticesSent = 0;
}

module.exports = { admit, ownerNotice, counters, noteNoticeSent, resetForTests, KIND_BY_TEMPLATE };
