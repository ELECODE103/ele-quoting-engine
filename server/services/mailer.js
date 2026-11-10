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

async function send({ to, subject, text, html, replyTo }) {
  if (!to || !subject) return false;
  writeOutbox({ to, subject, text: text || "", html: html || "", replyTo: replyTo || null });
  if (!configured()) {
    console.log(`[mailer] (not configured, not sent) To: ${to} | ${subject}`);
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
        to: Array.isArray(to) ? to : [to],
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
  return process.env.RFQ_NOTIFY_TO || process.env.ADMIN_EMAIL || brand.email;
}

module.exports = { send, configured, shopNotifyAddress, rfqNotifyAddress: shopNotifyAddress };
