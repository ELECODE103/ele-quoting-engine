/**
 * Second re-review (2026-11-13). Preloaded (node --require) into a CHILD server started by
 * r3-paid-mail-window.js. Nothing leaves the machine.
 *
 *   - Stripe: the earlier reviewer's persistent stand-in (rereview-relaunch/stripe-stub-preload.js), unchanged.
 *   - The mail provider: the server runs with a placeholder EMAIL_API_KEY, so it behaves as it will in
 *     production (a message is "sent" only when the provider answers 200), and the one call it makes
 *     to the provider's API is answered HERE. Every call is written to the file named by R3_MAIL_LOG,
 *     one JSON line per step, so the script can (a) kill the server at an exact step and (b) count what
 *     the provider was handed, with the Idempotency-Key of each request:
 *
 *        {"step":"begin", ...}      the request has reached the provider, nothing accepted yet
 *        {"step":"accepted", ...}   the provider has the message (it WILL be delivered)
 *        {"step":"answered", ...}   the 200 has gone back to the server
 *
 *     R3_MAIL_BEFORE_MS / R3_MAIL_AFTER_MS: how long the provider takes before it accepts, and between
 *     accepting and answering (a real provider call takes tens to hundreds of milliseconds).
 *     R3_MAIL_FAIL_FILE: while this file exists the provider answers 500 (an outage).
 */
const { isMainThread } = require("worker_threads");
require("../rereview-relaunch/stripe-stub-preload.js");
if (isMainThread && process.env.R3_MAIL_LOG) {
  const fs = require("fs");
  const file = process.env.R3_MAIL_LOG;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const note = (o) => fs.appendFileSync(file, JSON.stringify({ t: Date.now(), pid: process.pid, ...o }) + "\n");
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (!String(url).startsWith("https://api.resend.com/")) {
      if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(String(url))) return realFetch(url, init);
      throw new Error(`r3 stub: outbound call blocked: ${String(url).slice(0, 60)}`);
    }
    const headers = init.headers || {};
    const key = headers["Idempotency-Key"] || headers["idempotency-key"] || null;
    let body = {};
    try { body = JSON.parse(String(init.body || "{}")); } catch { /* not ours */ }
    const what = { key, to: body.to, subject: String(body.subject || "").slice(0, 120) };
    note({ step: "begin", ...what });
    await wait(Number(process.env.R3_MAIL_BEFORE_MS) || 0);
    if (process.env.R3_MAIL_FAIL_FILE && fs.existsSync(process.env.R3_MAIL_FAIL_FILE)) {
      note({ step: "refused", ...what });
      return { ok: false, status: 500, json: async () => ({ name: "internal_server_error" }) };
    }
    note({ step: "accepted", ...what });
    await wait(Number(process.env.R3_MAIL_AFTER_MS) || 0);
    note({ step: "answered", ...what });
    return { ok: true, status: 200, json: async () => ({ id: "r3" }) };
  };
}
