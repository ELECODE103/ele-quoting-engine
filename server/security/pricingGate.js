/**
 * Admission to quote pricing (POST /api/quote, and reorder), in front of the route.
 *
 *   one at a time per client   a client key (IPv4 address or IPv6 /64) has one
 *        pricing request in flight. The quote tool re-prices on every change,
 *        so a second request from the same browser simply waits its turn for up
 *        to QUOTE_PRICE_WAIT_MS; if the first is still running then, the second
 *        is answered 429 with Retry-After.
 *   an allowance of pricing time   every piece of pricing work is charged to
 *        the address and to the account (services/pricingMemo.js). A sender who
 *        has used QUOTE_PRICE_SECONDS_PER_CLIENT_HOUR (or _PER_ACCOUNT_HOUR) is
 *        told when to come back and offered the firm quote. The limit is in
 *        seconds because a count of requests says nothing: one quote of 25
 *        dense drawings costs what a thousand one-line quotes cost.
 *   fewer lines without an account   a visitor who is not signed in may price
 *        QUOTE_MAX_LINES_ANON lines in one quote; a signed-in customer keeps the
 *        full allowance. Bigger jobs are offered the firm quote.
 *
 * There is no site-wide number of pricing requests "in flight" any more: a cap
 * like that is a door eight addresses can hold shut (independent re-review
 * 2026-11-12, RR-13). Whose turn it is, across the site, is decided by the one
 * runner in services/pricingMemo.js: least pricing time used this hour first.
 *
 * Counters are in memory (one instance serves the site).
 *
 * To put another pricing route behind the same protection (the reorder route):
 *
 *     router.post("/:id/reorder", authenticate, pricingGate.admit(), async (req, res) => {
 *       …
 *       result = await pricingMemo.run(() => saveQuote(input, req.user, pricingGate.context(req)), pricingGate.job(req, configs));
 */
const { limits } = require("./limits");
const { clientKey } = require("./clientKey");
const brand = require("../../shared/brand.json");

const inFlight = new Map(); // client key → { waiters: [fn] }
let total = 0;
const globalWaiters = [];   // unused since the site-wide cap went; kept so stats() keeps its shape
const counters = { admitted: 0, waited: 0, refusedClient: 0, refusedBusy: 0, refusedLines: 0, refusedBudget: 0 };

const MESSAGES = {
  oneAtATime: "We're still pricing your last change. Give it a few seconds and the price will update.",
  busy: `We're pricing a lot of quotes right now. Try again in a few seconds, or call ${brand.phone}.`,
  tooManyLines: (max) => `An instant quote without an account holds up to ${max} lines. Sign in to price more at once, or send us the files for a firm quote and we'll price the whole job by hand.`,
  budget: (minutes) => `We've priced as much from this network or account in the last hour as the instant quote allows. It will price again in about ${minutes} minute${minutes === 1 ? "" : "s"}. For a price sooner, send us the files for a firm quote (${brand.email}) or call ${brand.phone}.`,
};

/** `user:<id>` — the key an account's pricing time is charged to. */
const accountKey = (user) => (user && user.userId ? `user:${user.userId}` : "");

/**
 * Who pays for a pricing request and which lane it belongs in, for pricingMemo.run().
 * @param {object} req      the request (after admit())
 * @param {Array} [configs] the quote's lines ({ partId }); default req.body.parts
 */
function job(req, configs) {
  const lines = Array.isArray(configs) ? configs : (Array.isArray(req.body && req.body.parts) ? req.body.parts : []);
  const keys = [req.pricingClientKey || clientKey(req), accountKey(req.user)].filter(Boolean);
  // How much measured detail the quote's distinct parts carry: read from the rows, no file is opened.
  let detail = 0;
  try {
    const { partsDB } = require("../models");
    const seen = new Set();
    for (const c of lines) {
      const id = c && c.partId;
      if (typeof id !== "string" || seen.has(id)) continue;
      seen.add(id);
      const row = partsDB.getRow ? partsDB.getRow(id) : null;
      if (row) detail += Number(row.detailBytes) || 0;
    }
  } catch { /* priced as light; a slow one is moved to the heavy lane by the runner */ }
  return { keys, heavy: detail > limits.quotePriceLightBytes };
}

/** What saveQuote() needs to know about the sender. */
function context(req) {
  return { clientKey: req.pricingClientKey || clientKey(req) };
}

function release(key) {
  const slot = inFlight.get(key);
  if (!slot) return;
  total = Math.max(0, total - 1);
  const next = slot.waiters.shift();
  if (next) { total++; next(true); } else inFlight.delete(key);
}

/** Wait for this client's turn. Resolves true when admitted, or a refusal object. */
function acquire(key, waitMs) {
  return new Promise((resolve) => {
    const slot = inFlight.get(key);
    if (!slot) {
      inFlight.set(key, { waiters: [] });
      total++;
      return resolve(true);
    }
    let settled = false;
    const waiter = { key, settled: false, grant: null };
    const grant = (ok) => { if (settled) { if (ok === true) release(key); return; } settled = true; waiter.settled = true; clearTimeout(timer); resolve(ok); };
    waiter.grant = grant;
    const perClient = true;
    // A browser has at most a couple of re-prices queued; more than that is not a person.
    if (slot.waiters.length >= 2) return resolve({ status: 429, code: "pricing-in-progress", message: MESSAGES.oneAtATime });
    slot.waiters.push(grant);
    counters.waited++;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      waiter.settled = true;
      if (perClient) { const s = inFlight.get(key); if (s) { const i = s.waiters.indexOf(grant); if (i >= 0) s.waiters.splice(i, 1); } }
      resolve(perClient
        ? { status: 429, code: "pricing-in-progress", message: MESSAGES.oneAtATime }
        : { status: 503, code: "pricing-busy", message: MESSAGES.busy });
    }, waitMs);
    if (timer.unref) timer.unref();
  });
}

/**
 * Express middleware for POST /api/quote. Put it after the session is read
 * (req.user) and before the route. The place is given back when the answer has
 * been sent or the client has gone away.
 */
function admit() {
  return async (req, res, next) => {
    try {
      const lines = Array.isArray(req.body && req.body.parts) ? req.body.parts.length : 0;
      const maxAnon = limits.quoteMaxLinesAnonymous;
      if (!req.user && lines > maxAnon) {
        counters.refusedLines++;
        return res.status(400).json({ error: MESSAGES.tooManyLines(maxAnon), code: "too-many-lines", offerRfq: true, maxLines: maxAnon });
      }
      const key = clientKey(req);
      // The hour's pricing allowance, per address and per account.
      const pricingMemo = require("../services/pricingMemo");
      const over = [[key, limits.quotePriceSecondsPerClientHour * 1000], [accountKey(req.user), limits.quotePriceSecondsPerAccountHour * 1000]]
        .filter(([k, limitMs]) => k && pricingMemo.usedMs(k) >= limitMs);
      if (over.length) {
        counters.refusedBudget++;
        const retry = Math.max(...over.map(([k, limitMs]) => pricingMemo.retryAfterSeconds(k, limitMs)));
        res.set("Retry-After", String(retry));
        return res.status(429).json({ error: MESSAGES.budget(Math.max(1, Math.ceil(retry / 60))), code: "pricing-budget", offerRfq: true, retryAfterSeconds: retry });
      }
      const got = await acquire(key, limits.quotePriceWaitMs);
      if (got !== true) {
        if (got.status === 429) counters.refusedClient++; else counters.refusedBusy++;
        res.set("Retry-After", "3");
        return res.status(got.status).json({ error: got.message, code: got.code, retryAfterSeconds: 3 });
      }
      // The client hung up while it waited: nothing to price, and no answer will ever "finish".
      if (res.destroyed || (req.socket && req.socket.destroyed)) { release(key); return undefined; }
      counters.admitted++;
      let released = false;
      const done = () => { if (!released) { released = true; clearTimeout(guard); release(key); } };
      res.on("finish", done);
      res.on("close", done);
      // Belt and braces: a place is never held past the pricing budget, whatever happened to the response.
      const guard = setTimeout(done, limits.quotePriceWallMs + 30000);
      if (guard.unref) guard.unref();
      req.pricingClientKey = key;
      next();
    } catch (err) {
      next(err);
    }
  };
}

function stats() {
  return { inFlight: total, clients: inFlight.size, waitingForAPlace: globalWaiters.filter((w) => !w.settled).length, ...counters };
}

/** Tests only. */
function resetForTests() {
  inFlight.clear();
  globalWaiters.length = 0;
  total = 0;
  for (const k of Object.keys(counters)) counters[k] = 0;
}

module.exports = { admit, acquire, release, job, context, accountKey, stats, resetForTests, MESSAGES };
