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
 *   EMAIL_OUTBOX_DIR  dev/test only: also write every message to this folder as JSON
 *
 * The no-op log line carries the recipient and subject only — message bodies
 * can hold signed links, which don't belong in logs.
 */
const fs = require("fs");
const path = require("path");
const brand = require("../../shared/brand.json");

function configured() {
  return Boolean(process.env.EMAIL_API_KEY && process.env.EMAIL_FROM);
}

let outboxSeq = 0;
function writeOutbox(message) {
  const dir = process.env.EMAIL_OUTBOX_DIR;
  if (!dir) return;
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

async function send(message) {
  const { text, html } = message || {};
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
    if (message && (message.to || message.subject)) console.error("[mailer] refused a message with an unusable recipient or subject");
    return false;
  }
  writeOutbox({ to, subject, text: text || "", html: html || "", replyTo: replyTo || null });
  if (!configured()) {
    console.log(`[mailer] (not configured, not sent) To: ${list.join(", ")} | ${subject}`);
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.EMAIL_API_KEY}`,
        "Content-Type": "application/json",
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
      const body = await res.text().catch(() => "");
      console.error(`[mailer] send failed ${res.status}: ${body.slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[mailer] send error:", err.message);
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

module.exports = { send, configured, shopNotifyAddress, rfqNotifyAddress: shopNotifyAddress, cleanAddress, cleanSubject };
