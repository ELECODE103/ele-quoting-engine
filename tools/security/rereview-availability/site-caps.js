#!/usr/bin/env node
/**
 * RR-03 / RR-04: the new site-wide caps as denial-of-service levers.
 * A passing fix: after the attacker's run, `visitorAfter` for the request form is 201 (bot check off),
 * and `newCustomer.verificationSent` is true (their confirmation email still goes out).
 *
 *   node tools/security/rereview-availability/site-caps.js rfq off    the 30-an-hour cap on requests from unverified senders
 *   node tools/security/rereview-availability/site-caps.js rfq on     the same with the bot check on (repository stand-in)
 *   node tools/security/rereview-availability/site-caps.js mail off   the 60-an-hour cap on mail to unconfirmed addresses
 *   node tools/security/rereview-availability/site-caps.js mail on
 *   node tools/security/rereview-availability/site-caps.js mail-one off   the same from ONE address (10 accounts, then "send it again"; takes 5 minutes)
 *
 * All limits are the server's defaults. Mail goes to a folder; nothing leaves the machine.
 */
const c = require("./common");

const mode = process.argv[2] || "rfq";
const on = process.argv[3] === "on";
const pdf = Buffer.from("%PDF-1.4\n%%EOF\n");
const T = on ? { "X-Turnstile-Token": "pass-x" } : {};

async function rfq() {
  const s = await c.startServer({ stubs: true, mail: true, turnstile: on });
  try {
    const send = (ip, n, extra = {}) => s.rfq({ contactName: "Sender", email: `sender-${ip.replace(/\W/g, "")}-${n}@example.test`, notes: `request ${n}` }, [{ name: "d.pdf", data: pdf }], { ip, ...extra });
    // A real visitor, before.
    const before = await send("203.0.113.5", 0, { headers: T });
    // The attacker: no account. With the check off nothing more is needed; with it on, either no token (refused, not counted) or a passed one (verified, not counted).
    let accepted = 0; let addresses = 0; let requests = 0; let lastCode = "";
    const perAddress = [];
    for (let a = 0; a < 12 && lastCode !== "requests-paused"; a++) {
      const ip = `192.0.2.${50 + a}`;
      addresses++;
      let mine = 0;
      for (let i = 0; i < 12; i++) {
        const r = await send(ip, i, on ? { headers: { "X-Turnstile-Token": "fail-not-a-person" } } : {});
        requests++;
        lastCode = (r.body && r.body.code) || "";
        if (r.status === 201) { accepted++; mine++; continue; }
        break;
      }
      perAddress.push(mine);
      if (on && a >= 3) break; // with the check on nothing is accepted without a pass: four addresses show it
    }
    // Who is locked out now?
    const visitorAfter = await send("203.0.113.6", 1, { headers: T });
    const customerToken = await s.register("customer@example.test", { ip: "203.0.113.7", headers: T });
    const customerAfter = await s.rfq({ contactName: "Customer", email: "customer@example.test", notes: "a real job" }, [{ name: "d.pdf", data: pdf }], { ip: "203.0.113.7", token: customerToken });
    const unconfirmedToken = await s.register("unconfirmed@example.test", { ip: "203.0.113.8", verify: false, headers: T });
    const unconfirmedAfter = await s.rfq({ contactName: "New", email: "unconfirmed@example.test", notes: "a real job" }, [{ name: "d.pdf", data: pdf }], { ip: "203.0.113.8", token: unconfirmedToken, headers: on ? {} : {} });
    c.result({
      test: "site-caps rfq", botCheck: on ? "on (stand-in)" : "off",
      visitorBefore: before.status,
      attacker: { addresses, requests, accepted, acceptedPerAddress: perAddress, stoppedWith: lastCode },
      visitorWithoutAccountAfter: { status: visitorAfter.status, code: (visitorAfter.body && visitorAfter.body.code) || "", retryAfterSeconds: visitorAfter.headers["retry-after"] || null },
      signedInConfirmedCustomerAfter: { status: customerAfter.status, code: (customerAfter.body && customerAfter.body.code) || "" },
      signedInUnconfirmedAccountAfter: { status: unconfirmedAfter.status, code: (unconfirmedAfter.body && unconfirmedAfter.body.code) || "" },
      note: on ? "with the check on a sender who passes it is never counted, and one who does not is refused before counting: the cap is only reachable while Cloudflare cannot be reached" : "the window is a fixed hour from the first request: 30 requests at its start close the form to everyone without a confirmed account until it ends; each address may send 10 an hour and 30 a day",
    });
  } finally { await s.stop(); }
}

async function mail(oneAddress) {
  const s = await c.startServer({ stubs: true, mail: true, turnstile: on });
  try {
    const reg = (ip, email) => s.post("/api/auth/register", { email, password: `Rv9-${Math.random().toString(36).slice(2)}-xQ`, name: "Bot" }, { ip, headers: { "X-Form-Token": s.formToken("register"), ...T } });
    const t0 = Date.now();
    const tokens = []; let registered = 0; let addresses = 0; let sent = 0; let resends = 0;
    const want = 60; // MAIL_UNCONFIRMED_PER_HOUR_SITE
    for (let a = 0; a < (oneAddress ? 1 : 8) && sent < want; a++) {
      const ip = `192.0.2.${70 + a}`;
      addresses++;
      for (let i = 0; i < 10 && sent < want; i++) {
        const r = await reg(ip, `typed-by-bot-${a}-${i}@example.test`);
        if (r.status !== 201) break;
        registered++;
        if (r.body.verificationSent) sent++;
        tokens.push({ token: r.body.token, ip });
      }
    }
    // One address only: each account may ask for its link again once a minute, five times a day. No bot check on that.
    for (let round = 0; oneAddress && round < 5 && sent < want; round++) {
      for (const t of tokens) {
        if (sent >= want) break;
        const r = await s.post("/api/auth/verify-email/resend", {}, { ip: t.ip, headers: await s.browser(t.token) });
        if (r.status === 200 && r.body.sent) { sent++; resends++; }
      }
      if (sent < want) await c.sleep(61000);
    }
    const seconds = Math.round((Date.now() - t0) / 1000);
    // A real new customer, from somewhere else.
    const ip = "203.0.113.20";
    const nc = await reg(ip, "new-customer@example.test");
    await c.sleep(300);
    const got = s.mail("new-customer@example.test", /confirm your email/i).length;
    const again = await s.post("/api/auth/verify-email/resend", {}, { ip, headers: await s.browser(nc.body.token) });
    // Can they buy? Checkout needs the confirmed address once mail is configured.
    const h = on ? { "X-Human-Token": await c.humanToken(s, ip) } : {};
    const part = await c.uploadOne(s, "cube.stl", c.g.stlCube(20), { ip, headers: h });
    const { line } = await c.lineFor(s, part.partId, "cnc", ip);
    const q = await s.post("/api/quote", { parts: [{ ...line, subProcess: "milling" }], leadTimeSlug: "standard" }, { ip, headers: h, token: nc.body.token });
    const co = q.status === 200 ? await s.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, shippingName: "B", shippingAddress: "1 Test St", shippingCity: "T", shippingState: "IL", shippingZip: "60000" }, { ip, token: nc.body.token }) : { status: q.status, body: q.body };
    // Mail that must never be capped still goes out?
    const reset = await s.post("/api/auth/password-reset/request", { email: "new-customer@example.test" }, { ip, headers: { "X-Form-Token": s.formToken("password-reset"), ...T } });
    await c.sleep(300);
    const resetMail = s.mail("new-customer@example.test", /password/i).length;
    const ownerNotice = s.mail(s.adminEmail, /hourly limit reached/i).length;
    c.result({
      test: `site-caps ${oneAddress ? "mail-one" : "mail"}`, botCheck: on ? "on (stand-in; the attacker passes it once per account, never for a resend)" : "off",
      attacker: { addresses, accountsRegistered: registered, resendRequests: resends, confirmationEmailsCaused: sent, seconds },
      newCustomer: { registerStatus: nc.status, verificationSent: nc.body && nc.body.verificationSent, confirmationEmailsInTheirInbox: got, askedAgain: { status: again.status, sent: again.body && again.body.sent }, checkout: { status: co.status, code: (co.body && co.body.code) || "" } },
      passwordResetStillSent: { status: reset.status, emails: resetMail },
      ownerNoticesSent: ownerNotice,
    });
  } finally { await s.stop(); }
}

({ rfq, mail: () => mail(false), "mail-one": () => mail(true) }[mode] || rfq)().catch((e) => { console.error(e); process.exit(1); });
