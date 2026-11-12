/**
 * Preload for the buyer-journey walk (scripts/e2e/journey-qa.mjs):
 *
 *   node -r ./scripts/e2e/journey-stubs.cjs server/index.js
 *
 * It loads the hardening run's stubs (Turnstile siteverify, Resend, Stripe:
 * stub-network.cjs) and adds one more answer to the Turnstile stand-in so the
 * walk can show every state a buyer can meet:
 *
 *   token starts "e2e-pass"   verified
 *   token starts "e2e-down"   Cloudflare did not answer (HTTP 503)
 *   anything else             rejected
 *
 * Like stub-network.cjs it refuses to load without E2E_STUBS=1.
 */
require("./stub-network.cjs");
const path = require("path");
const root = path.join(__dirname, "..", "..");

require(path.join(root, "server", "security", "turnstile")).setFetchForTests(async (url, init) => {
  const token = new URLSearchParams(String(init.body)).get("response") || "";
  if (token.startsWith("e2e-down")) return { ok: false, status: 503, json: async () => ({}) };
  const pass = token.startsWith("e2e-pass");
  return { ok: true, json: async () => (pass ? { success: true, hostname: "localhost" } : { success: false, "error-codes": ["invalid-input-response"] }) };
});
