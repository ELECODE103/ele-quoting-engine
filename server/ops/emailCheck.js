/**
 * "Can the site send email?" — answered step by step, in words.
 *
 * Used by `npm run email:check` (scripts/ops/email-check.js) and by the
 * "Send a test email" button in Admin → System. It reads everything from the
 * environment; no address or key is written anywhere, and none is printed:
 * a key is reported as set or not set, an address by its domain only.
 *
 * With the keys present it checks, in order:
 *   1. EMAIL_API_KEY, EMAIL_FROM and the notification address are set and well-formed
 *   2. (optional) the sending domain's DNS: the DKIM record, the SPF pair on the
 *      return-path host, a DMARC record
 *   3. (optional) what Resend itself says about the domain — verified or not
 *   4. one test message, sent ONLY to the shop's own notification address
 *      (RFQ_NOTIFY_TO, else ADMIN_EMAIL, else the address printed on the site)
 *
 * With keys absent it stops after step 1 and says exactly which variable is
 * missing. It never sends to a customer and never to an address given on the
 * command line.
 */
const brand = require("../../shared/brand.json");
const opsEmails = require("./opsEmails");

const RESEND_API = "https://api.resend.com";

function parseFrom(value) {
  const v = String(value || "").trim();
  if (!v) return null;
  const m = v.match(/^(?:"?([^"<]*)"?\s*)?<([^<>\s]+@[^<>\s]+)>$/) || v.match(/^()([^<>\s]+@[^<>\s]+)$/);
  if (!m) return null;
  const address = m[2];
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) return null;
  return { name: (m[1] || "").trim(), address, domain };
}

/** "quotes@example.com" → "q…@example.com": enough to recognise, not enough to harvest from a log. */
function mask(address) {
  const s = String(address || "");
  const at = s.lastIndexOf("@");
  if (at < 1) return "(unreadable address)";
  return `${s[0]}…@${s.slice(at + 1).toLowerCase()}`;
}

/** The registrable domain, near enough for a DMARC lookup: the last two labels. */
function organisationalDomain(domain) {
  const parts = domain.split(".");
  return parts.length <= 2 ? domain : parts.slice(-2).join(".");
}

/**
 * @param {object} [opt]
 * @param {boolean} [opt.send=true]  send the test message (to the shop's notification address only)
 * @param {boolean} [opt.dns=true]   look the DNS records up
 * @param {boolean} [opt.api=true]   ask Resend about the domain
 * @param {object}  [opt.env]        instead of process.env
 * @param {Function} [opt.fetch]     instead of global fetch (tests)
 * @param {object}  [opt.resolver]   instead of dns.promises (tests): { resolveTxt, resolveMx }
 * @returns {Promise<{ok: boolean, configured: boolean, sent: boolean, lines: Array<{level: "ok"|"info"|"warn"|"fail", text: string}>}>}
 */
async function run(opt = {}) {
  const env = opt.env || process.env;
  const doFetch = opt.fetch || globalThis.fetch;
  const lines = [];
  const say = (level, text) => lines.push({ level, text });
  const mailer = require("../services/mailer");

  // ── 1. settings ───────────────────────────────────────────
  const key = String(env.EMAIL_API_KEY || "").trim();
  if (!key) say("fail", "EMAIL_API_KEY is not set. Create an API key in Resend and enter it in Railway → the service → Variables.");
  else if (!/^re_[A-Za-z0-9_]{8,}$/.test(key)) say("warn", "EMAIL_API_KEY is set but does not look like a Resend key (they start with re_). Check it was pasted whole, without quotes or spaces.");
  else say("ok", "EMAIL_API_KEY is set.");

  const from = parseFrom(env.EMAIL_FROM);
  if (!String(env.EMAIL_FROM || "").trim()) say("fail", "EMAIL_FROM is not set. It is the sender shown to customers, written as: Name <address on your verified sending domain>.");
  else if (!from) say("fail", "EMAIL_FROM is set but cannot be read as an address. Write it as: Name <address>, with no extra quotes.");
  else {
    say("ok", `EMAIL_FROM is set; mail is sent from the domain ${from.domain}${from.name ? ` as “${from.name}”` : ""}.`);
    if (from.domain !== brand.domain && !from.domain.endsWith(`.${brand.domain}`)) say("warn", `The sending domain ${from.domain} is not ${brand.domain} or one of its subdomains. Customers will see mail from a different domain than the site.`);
  }

  const source = env.RFQ_NOTIFY_TO ? "RFQ_NOTIFY_TO" : env.ADMIN_EMAIL ? "ADMIN_EMAIL (RFQ_NOTIFY_TO is not set)" : "the address printed on the site (neither RFQ_NOTIFY_TO nor ADMIN_EMAIL is set)";
  const rawNotify = String(env.RFQ_NOTIFY_TO || env.ADMIN_EMAIL || brand.email);
  const notify = rawNotify.split(",").map((s) => mailer.cleanAddress(s.trim())).filter(Boolean);
  const typed = rawNotify.split(",").map((s) => s.trim()).filter(Boolean).length;
  if (!notify.length) say("fail", `The shop's notification address comes from ${source}, but nothing usable is there. Enter one plain address (or several, separated by commas).`);
  else {
    say(env.RFQ_NOTIFY_TO ? "ok" : "warn", `Shop notifications go to ${notify.length} address${notify.length === 1 ? "" : "es"} (${notify.map(mask).join(", ")}), from ${source}.`);
    if (typed !== notify.length) say("warn", `${typed - notify.length} entr${typed - notify.length === 1 ? "y" : "ies"} in that setting could not be read as a plain address and will be skipped.`);
  }

  if (!env.FRONTEND_URL) say("warn", "FRONTEND_URL is not set: links in emails fall back to the request's host or the brand address. Set it to the https address of the canonical host.");

  const configured = Boolean(key && from);
  if (!configured) {
    say("info", "Email is OFF: until both EMAIL_API_KEY and EMAIL_FROM are set, every message is only logged. Nothing was sent.");
    return { ok: false, configured: false, sent: false, lines };
  }

  // ── 2. DNS ────────────────────────────────────────────────
  if (opt.dns !== false) {
    const dns = opt.resolver || require("dns").promises;
    const txt = async (name) => { try { return (await dns.resolveTxt(name)).map((r) => r.join("")); } catch { return []; } };
    const mx = async (name) => { try { return await dns.resolveMx(name); } catch { return []; } };
    const dkim = await txt(`resend._domainkey.${from.domain}`);
    if (dkim.some((r) => /p=[A-Za-z0-9+/=]{20,}/.test(r))) say("ok", `DKIM: a key is published at resend._domainkey.${from.domain}.`);
    else say("warn", `DKIM: no key found at resend._domainkey.${from.domain}. Add the DKIM record Resend shows for this domain (or wait for DNS to update).`);
    const spfTxt = await txt(`send.${from.domain}`);
    const spfMx = await mx(`send.${from.domain}`);
    if (spfTxt.some((r) => /^v=spf1\b/i.test(r)) && spfMx.length) say("ok", `SPF: send.${from.domain} has its TXT and MX records.`);
    else say("warn", `SPF: send.${from.domain} is missing its ${!spfMx.length && !spfTxt.some((r) => /^v=spf1\b/i.test(r)) ? "TXT and MX records" : !spfMx.length ? "MX record" : "TXT record"}. Add the records Resend shows (this is expected only if a custom return-path name was chosen in Resend).`);
    const org = organisationalDomain(from.domain);
    const dmarc = [...await txt(`_dmarc.${from.domain}`), ...(org !== from.domain ? await txt(`_dmarc.${org}`) : [])];
    if (dmarc.some((r) => /^v=DMARC1\b/i.test(r))) say("ok", "DMARC: a policy record is published.");
    else say("warn", `DMARC: no record at _dmarc.${org}. Mail still sends, but Gmail and Yahoo expect one; add the starter record from the runbook.`);
  }

  // ── 3. Resend's view of the domain ────────────────────────
  if (opt.api !== false && typeof doFetch === "function") {
    try {
      const res = await doFetch(`${RESEND_API}/domains`, { method: "GET", headers: { Authorization: `Bearer ${key}` } });
      const body = await res.json().catch(() => null);
      const errName = body && typeof body.name === "string" && /^[a-z_]{1,60}$/i.test(body.name) ? body.name : "";
      if (res.ok && body && Array.isArray(body.data)) {
        const d = body.data.find((x) => x && String(x.name || "").toLowerCase() === from.domain);
        if (!d) say("fail", `Resend does not list ${from.domain} for this key. Add the domain in Resend → Domains, or change EMAIL_FROM to an address on a domain that is listed.`);
        else if (d.status === "verified") say("ok", `Resend reports ${from.domain} as verified.`);
        else say("fail", `Resend reports ${from.domain} as “${String(d.status || "unknown").replace(/[^a-z_ ]/gi, "")}”, not verified. Finish the DNS records and press Verify in Resend.`);
      } else if (res.status === 401 && errName === "restricted_api_key") {
        say("info", "The key is a sending-only key, so Resend will not tell it the domain's status. That is the right kind of key for the site; the test send below is the real check.");
      } else if (res.status === 401 || res.status === 403 || res.status === 400) {
        say("fail", `Resend refused the key (${res.status}${errName ? ` ${errName}` : ""}). It may be mistyped, deleted or inactive: create a new one in Resend → API Keys.`);
      } else {
        say("warn", `Resend answered ${res.status} when asked about the domain; skipping this check.`);
      }
    } catch (err) {
      say("warn", `Could not reach Resend to ask about the domain (${err.name || "Error"}); skipping this check.`);
    }
  }

  // ── 4. one test message, to the shop only ─────────────────
  let sent = false;
  if (opt.send === false) {
    say("info", "No test message was sent (send switched off).");
  } else if (!notify.length) {
    say("fail", "No test message was sent: there is no usable notification address to send it to.");
  } else if (typeof doFetch !== "function") {
    say("fail", "No test message was sent: this Node version has no fetch.");
  } else {
    const message = opsEmails.emailCheckEmail({ when: new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC" });
    try {
      const res = await doFetch(`${RESEND_API}/emails`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: String(env.EMAIL_FROM).trim(), to: notify, subject: message.subject, text: message.text, html: message.html }),
      });
      const body = await res.json().catch(() => null);
      const errName = body && typeof body.name === "string" && /^[a-z_]{1,60}$/i.test(body.name) ? body.name : "";
      if (res.ok) {
        sent = true;
        say("ok", `Test message accepted by Resend for ${notify.length} address${notify.length === 1 ? "" : "es"} (${notify.map(mask).join(", ")}). Check that inbox, and its spam folder.`);
      } else if (res.status === 403) {
        say("fail", `Resend refused the test message (403${errName ? ` ${errName}` : ""}): the sending domain is not verified for this key, or the account may only send to its own address until a domain is verified.`);
      } else if (res.status === 429) {
        say("fail", `Resend refused the test message (429${errName ? ` ${errName}` : ""}): a sending limit is reached. Check the plan's daily and monthly limits in Resend.`);
      } else {
        say("fail", `Resend refused the test message (${res.status}${errName ? ` ${errName}` : ""}).`);
      }
    } catch (err) {
      say("fail", `The test message could not be sent: Resend was not reachable (${err.name || "Error"}).`);
    }
  }

  const ok = !lines.some((l) => l.level === "fail");
  return { ok, configured: true, sent, lines };
}

module.exports = { run, parseFrom, mask, organisationalDomain };
