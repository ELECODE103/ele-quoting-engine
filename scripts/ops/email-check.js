#!/usr/bin/env node
/**
 * npm run email:check [-- --no-send] [--no-dns]
 *
 * Says, step by step, whether the site can send email (server/ops/emailCheck.js).
 *
 *   keys absent   reports exactly which variable is missing; sends nothing; exit code 1
 *   keys present  checks the settings, the sending domain's DNS records and what
 *                 Resend says about the domain, then sends ONE test message — to
 *                 the shop's own notification address and nowhere else
 *
 * Everything is read from the environment (Railway's variables, or a local
 * .env). No address and no key is taken from the command line, printed in
 * full, or written to a file.
 *
 * On Railway, run it where the variables are:   railway ssh -- npm run email:check
 * or use the button: Admin → System → "Send a test email".
 */
require("dotenv").config();

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: npm run email:check [-- --no-send] [--no-dns]\n  --no-send  check the settings and DNS, send nothing\n  --no-dns   skip the DNS lookups");
  process.exit(0);
}

const MARK = { ok: "  ok  ", info: "  --  ", warn: " WARN ", fail: " FAIL " };

(async () => {
  const r = await require("../../server/ops/emailCheck").run({ send: !args.includes("--no-send"), dns: !args.includes("--no-dns") });
  console.log("Email check");
  for (const l of r.lines) console.log(`${MARK[l.level] || "      "} ${l.text}`);
  console.log("");
  if (!r.configured) console.log("Result: email is OFF. Set the variables marked FAIL above, redeploy, and run this again.");
  else if (r.ok && r.sent) console.log("Result: working. A test message is on its way to the shop's notification address.");
  else if (r.ok) console.log("Result: the settings look right; no test message was sent.");
  else console.log("Result: NOT working yet. Fix the lines marked FAIL above and run this again.");
  process.exit(r.ok ? 0 : 1);
})().catch((err) => { console.error(`Email check could not run: ${err.name}`); process.exit(1); });
