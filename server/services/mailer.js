/**
 * Minimal transactional mailer. Uses Resend's HTTP API when EMAIL_API_KEY is
 * set (keys start with "re_"); otherwise logs the message and returns false so
 * nothing breaks in dev or before the domain's mail is set up.
 *
 * Env:
 *   EMAIL_API_KEY   Resend API key
 *   EMAIL_FROM      e.g. "Straightedge <quotes@straightedgemfg.com>" (domain must be verified in Resend)
 *   RFQ_NOTIFY_TO   where new RFQs go (defaults to brand.email)
 */
const brand = require("../../shared/brand.json");

function configured() {
  return Boolean(process.env.EMAIL_API_KEY && process.env.EMAIL_FROM);
}

async function send({ to, subject, text, html, replyTo }) {
  if (!to || !subject) return false;
  if (!configured()) {
    console.log(`[mailer] (not configured) To: ${to} | ${subject}\n${text || ""}`);
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

function rfqNotifyAddress() {
  return process.env.RFQ_NOTIFY_TO || brand.email;
}

module.exports = { send, configured, rfqNotifyAddress };
