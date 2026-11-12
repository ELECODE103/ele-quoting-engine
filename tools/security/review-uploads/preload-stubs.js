/**
 * Preloaded into the LOCAL server under review (node --require) so nothing leaves the machine:
 *   - Stripe: services/stripeClient is given a fake client (no call to api.stripe.com)
 *   - Turnstile: siteverify is answered locally — a token starting with "pass" passes
 *   - the mailer's HTTP call is never reached (EMAIL_API_KEY is not set by the review scripts)
 * Only loaded when REVIEW_STUBS=1. Worker threads inherit --require; they skip it.
 */
const { isMainThread } = require("worker_threads");
if (isMainThread && process.env.REVIEW_STUBS === "1") {
  const path = require("path");
  const root = path.join(__dirname, "..", "..", "..");
  const created = [];
  const sessions = {};
  require(path.join(root, "server", "services", "stripeClient")).setForTests({
    checkout: {
      sessions: {
        create: async (args) => {
          const id = `cs_test_review_${created.length + 1}`;
          created.push(args);
          sessions[id] = { id, url: `https://checkout.stripe.invalid/${id}`, payment_status: "unpaid", metadata: args.metadata };
          return sessions[id];
        },
        retrieve: async (id) => sessions[id],
      },
    },
  });
  require(path.join(root, "server", "security", "turnstile")).setFetchForTests(async (url, init) => {
    const token = new URLSearchParams(String(init.body)).get("response") || "";
    const pass = token.startsWith("pass");
    return { ok: true, json: async () => (pass ? { success: true } : { success: false, "error-codes": ["invalid-input-response"] }) };
  });
  // Mail: with REVIEW_STUB_MAIL=1 the mailer is "configured" (a placeholder key) so the server behaves as it will in
  // production, and the one outbound call it would make (the mail provider's API) is answered here instead.
  if (process.env.REVIEW_STUB_MAIL === "1") {
    const realFetch = global.fetch;
    global.fetch = async (url, init) => {
      if (String(url).startsWith("https://api.resend.com/")) return { ok: true, status: 200, json: async () => ({ id: "review" }) };
      if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(String(url))) return realFetch(url, init);
      throw new Error(`review stub: outbound call blocked: ${String(url).slice(0, 60)}`);
    };
  }
}
