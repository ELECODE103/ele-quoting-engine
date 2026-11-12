/**
 * Start-up requirement for the robot check (Cloudflare Turnstile).
 *
 * Independent re-review 2026-11-12 (RR-02, RR-03, RR-13): with the check off, every limit that is
 * counted per address is a limit an attacker multiplies by changing address, and several of the
 * findings are only reachable that way. So in production the server does not start without the
 * two Turnstile keys, the same way it does not start without the Stripe keys, unless the owner
 * says in so many words that the site is to run without the check:
 *
 *     ALLOW_LAUNCH_WITHOUT_BOT_CHECK=1
 *
 * Development and tests (NODE_ENV other than "production") are not affected. The suites that start
 * the real server in production mode set the variable themselves (server/testSupport/liveServer.js).
 * The value of a key is never printed.
 */
const KEYS = ["TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY"];

const set = (v) => String(v || "").trim() !== "";
const yes = (v) => /^(1|true|yes|on)$/i.test(String(v || "").trim());

/**
 * @param {object} [env] process.env
 * @returns {{ ok: boolean, missing: string[], waived: boolean, fatal: string[], warning: string }}
 *          fatal: the lines to print before exiting (empty when the server may start)
 */
function check(env = process.env) {
  const production = env.NODE_ENV === "production";
  const missing = KEYS.filter((k) => !set(env[k]));
  const waived = yes(env.ALLOW_LAUNCH_WITHOUT_BOT_CHECK);
  if (!production || missing.length === 0) return { ok: true, missing, waived, fatal: [], warning: "" };
  if (waived) {
    return {
      ok: true, missing, waived, fatal: [],
      warning: "WARNING: THE ROBOT CHECK IS OFF (ALLOW_LAUNCH_WITHOUT_BOT_CHECK is set and the Turnstile keys are not). Uploads, quotes, the request forms and registration can be driven by a script from many addresses. Set TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY and remove ALLOW_LAUNCH_WITHOUT_BOT_CHECK before the site is public.",
    };
  }
  return {
    ok: false, missing, waived, warning: "",
    fatal: [
      `FATAL: Missing required environment variables: ${missing.join(", ")}`,
      "FATAL: The robot check (Cloudflare Turnstile) is not set up, so the server will not start. Without it a script can upload, quote, send requests and register from as many addresses as it likes. In the Cloudflare dashboard open Turnstile, add this site, and set the two keys it gives you as TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY in Railway. To start without the check on purpose (not for a public site), set ALLOW_LAUNCH_WITHOUT_BOT_CHECK=1.",
    ],
  };
}

module.exports = { check, KEYS };
