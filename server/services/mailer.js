/**
 * Transactional mailer. Uses Resend's HTTP API when EMAIL_API_KEY and
 * EMAIL_FROM are set; otherwise every send is a logged no-op that returns
 * false, so nothing breaks in dev or before the domain's mail is set up.
 *
 * Templates live in server/emails/templates.js (one branded layout, HTML +
 * plain text). Preview them with `node scripts/preview-emails.js`.
 *
 * Env:
 *   EMAIL_API_KEY     Resend API key
 *   EMAIL_FROM        e.g. "Straightedge <quotes@straightedgemfg.com>" (domain must be verified in Resend)
 *   RFQ_NOTIFY_TO     where shop notifications go (new RFQs, new orders, accepted quotes)
 *   ADMIN_EMAIL       fallback for RFQ_NOTIFY_TO; then brand.email
 *   EMAIL_OUTBOX_DIR  tests only: also write every message to this folder as JSON.
 *                     Honoured only together with the explicit test switch
 *                     (SE_TEST_HOOKS=1, see security/testHooks.js); ignored otherwise.
 *
 * Nothing about a message reaches the log except which template it was and
 * how many recipients it had: no address (customers' addresses do not belong
 * in a deploy log), no subject (some carry a reference or an amount) and no
 * body (bodies hold signed links).
 */
const fs = require("fs");
const path = require("path");
const brand = require("../../shared/brand.json");
const mailCaps = require("./mailCaps");

function configured() {
  return Boolean(process.env.EMAIL_API_KEY && process.env.EMAIL_FROM);
}

let outboxSeq = 0;
function writeOutbox(message) {
  const dir = process.env.EMAIL_OUTBOX_DIR;
  if (!dir || !require("../security/testHooks").enabled()) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}-${String(++outboxSeq).padStart(4, "0")}.json`;
    fs.writeFileSync(path.join(dir, name), JSON.stringify(message, null, 2));
  } catch (err) {
    console.error("[mailer] outbox write failed:", err.message);
  }
}

/**
 * One plain address, nothing else: no display name, no list, no angle
 * brackets, no line breaks. Anything a visitor typed that is not exactly that
 * is not a recipient.
 */
function cleanAddress(value) {
  if (typeof value !== "string") return "";
  const v = value.trim();
  if (v.length === 0 || v.length > 254) return "";
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(v) ? v : "";
}

/** A subject is one line: control characters (line breaks above all) become spaces. */
function cleanSubject(value) {
  // eslint-disable-next-line no-control-regex
  return String(value || "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

/** The template a message came from (templates.js stamps it), as a short safe label for the log. */
function templateLabel(message) {
  const t = message && message.template;
  return typeof t === "string" && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(t) ? t : "unnamed";
}

/** What send() answers for a message that was not sent now but is kept and will be sent within the hour. */
const HELD = "held";
let heldTimer = null;

/** Send what was held, once the cap's hour has turned (checked again every minute while anything waits). */
async function flushHeld() {
  heldTimer = null;
  const ready = mailCaps.due(Date.now());
  for (const message of ready) {
    try { await send({ ...message, heldBefore: true }); } catch (err) { console.error("[mailer] a held message could not be sent:", err.message); }
  }
  if (ready.length) console.log(`[mailer] sent ${ready.length} confirmation email(s) that were held over from the last hour`);
  if (mailCaps.heldQueue.length) scheduleHeld();
}

function scheduleHeld() {
  if (heldTimer) return;
  const wait = Math.max(1000, Math.min(60 * 1000, mailCaps.nextTurn(Date.now()) - Date.now() + 500));
  heldTimer = setTimeout(() => { flushHeld().catch(() => {}); }, wait);
  if (heldTimer.unref) heldTimer.unref();
}

/**
 * @returns {Promise<boolean|"held">} true: handed to the mail provider. false: not sent.
 *          "held": over the hour's cap for mail to unconfirmed addresses; kept and sent when the
 *          hour turns (callers that tell the customer something say "within the hour").
 */
async function send(message) {
  const { text, html } = message || {};
  const label = templateLabel(message);
  // Site-wide hourly caps on the mail a stranger can cause (services/mailCaps.js): confirmations to
  // addresses nobody has confirmed, and new-request notices to the shop. Mail about orders, payments
  // and accounts is never capped. When a cap is first reached in an hour the owner gets one notice.
  const clientKey = typeof (message && message.clientKey) === "string" ? message.clientKey : "";
  const cap = message && message.heldBefore
    ? { allowed: true }
    : mailCaps.admit(label, Date.now(), { confirmedRecipient: Boolean(message && message.confirmedRecipient), clientKey });
  if (!cap.allowed) {
    if (cap.notify) {
      mailCaps.noteNoticeSent();
      // Not awaited into the caller's result, and not itself capped (its template is not one of the capped ones).
      send({ to: shopNotifyAddress(), ...mailCaps.ownerNotice(cap.kind) }).catch(() => {});
    }
    if (cap.hold) {
      // Over the hour's cap for mail to unconfirmed addresses: kept, and sent when the hour turns.
      const kept = mailCaps.hold({ ...message, template: label }, { clientKey, kind: cap.kind });
      console.warn(`[mailer] hourly cap reached for mail to unconfirmed addresses: template ${label} ${kept ? "held, to be sent when the hour turns" : "not sent (this sender already has messages waiting)"}`);
      if (kept) scheduleHeld();
      return kept ? HELD : false;
    }
    console.warn(`[mailer] hourly cap reached for new-request notices: template ${label} not sent`);
    return false;
  }
  // Recipients and the subject are cleaned here, at the last step before the
  // wire, whatever the caller did: a typed address or name can never add a
  // header or a second recipient.
  // A list is only ever built by our own code (the shop's notification
  // addresses); a string is exactly one address.
  const rawTo = message && message.to;
  const list = Array.isArray(rawTo) ? rawTo.map(cleanAddress).filter(Boolean) : [cleanAddress(rawTo)].filter(Boolean);
  const to = list.length > 1 ? list : (list[0] || "");
  const subject = cleanSubject(message && message.subject);
  const rawReply = message && message.replyTo;
  const replyTo = cleanAddress(Array.isArray(rawReply) ? rawReply[0] : rawReply);
  if (list.length === 0 || !subject) {
    if (message && (message.to || message.subject)) console.error(`[mailer] refused a message with an unusable recipient or subject (template ${label})`);
    return false;
  }
  writeOutbox({ to, subject, text: text || "", html: html || "", replyTo: replyTo || null });
  if (!configured()) {
    console.log(`[mailer] (not configured, not sent) template ${label}, ${list.length} recipient${list.length === 1 ? "" : "s"}`);
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.EMAIL_API_KEY}`,
        "Content-Type": "application/json",
        // A message that may be sent again after a crash (services/owedEmails.js) carries a key the
        // provider uses to drop the second copy.
        ...(typeof (message && message.idempotencyKey) === "string" && /^[A-Za-z0-9_-]{8,200}$/.test(message.idempotencyKey) ? { "Idempotency-Key": message.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM,
        to: list,
        subject,
        text: text || "",
        html: html || undefined,
        reply_to: replyTo || undefined,
      }),
    });
    if (!res.ok) {
      // The provider's error body can repeat the recipient; log its error name only.
      const body = await res.json().catch(() => null);
      const name = body && typeof body.name === "string" && /^[a-z_]{1,60}$/i.test(body.name) ? ` (${body.name})` : "";
      console.error(`[mailer] send failed ${res.status}${name}: template ${label}, ${list.length} recipient${list.length === 1 ? "" : "s"}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[mailer] send error (template ${label}):`, err.name || "Error");
    return false;
  }
}

/** Where the shop's own notifications go. */
function shopNotifyAddress() {
  const configured = process.env.RFQ_NOTIFY_TO || process.env.ADMIN_EMAIL || brand.email;
  // RFQ_NOTIFY_TO may name several people, separated by commas.
  const parts = String(configured).split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length > 1 ? parts : (parts[0] || brand.email);
}

module.exports = { send, configured, shopNotifyAddress, rfqNotifyAddress: shopNotifyAddress, cleanAddress, cleanSubject, capCounters: mailCaps.counters, HELD, flushHeld };
