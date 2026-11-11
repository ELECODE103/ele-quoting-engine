/**
 * The explicit test switch.
 *
 * A few behaviours exist only so the suites and the browser run can drive a
 * real, production-mode server: every email also written to a folder
 * (EMAIL_OUTBOX_DIR) so a test can open an emailed link, and Stripe webhooks
 * accepted without a signature. None of them may switch on because NODE_ENV
 * happens not to be "production" — a server started by any command other than
 * `npm start` has no NODE_ENV at all. They need this switch, set by name:
 *
 *   SE_TEST_HOOKS=1
 *
 * The test harnesses set it for the processes they start. It must never be
 * set on the live site; server/index.js prints a warning at startup if it is.
 */
function enabled() {
  return process.env.SE_TEST_HOOKS === "1";
}

/** Unsigned Stripe webhooks: the switch, and never in production whatever is set. */
function unsignedWebhooksAllowed() {
  return enabled() && process.env.NODE_ENV !== "production";
}

/** Lines for the startup log when the switch (or a setting that depends on it) is present. */
function startupWarnings() {
  const lines = [];
  if (enabled()) {
    lines.push("WARNING: SE_TEST_HOOKS=1 — TEST-ONLY behaviour is switched on in this process" + (process.env.EMAIL_OUTBOX_DIR ? " (every email, signed links included, is also written to EMAIL_OUTBOX_DIR)" : "") + ". Never set this on the live site.");
  } else if (process.env.EMAIL_OUTBOX_DIR) {
    lines.push("WARNING: EMAIL_OUTBOX_DIR is set but ignored: writing emails to disk is a test-only behaviour (SE_TEST_HOOKS). Remove EMAIL_OUTBOX_DIR.");
  }
  return lines;
}

module.exports = { enabled, unsignedWebhooksAllowed, startupWarnings };
