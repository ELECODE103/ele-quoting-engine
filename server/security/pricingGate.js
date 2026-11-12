/**
 * Admission to quote pricing (POST /api/quote), in front of the route.
 *
 *   one at a time per client   a client key (IPv4 address or IPv6 /64) has one
 *        pricing request in flight. The quote tool re-prices on every change,
 *        so a second request from the same browser simply waits its turn for up
 *        to QUOTE_PRICE_WAIT_MS; if the first is still running then, the second
 *        is answered 429 with Retry-After. Eight in parallel from one address
 *        was how the site was held frozen (independent review 2026-11-11, C2).
 *   a ceiling for everyone     at most QUOTE_PRICE_MAX_INFLIGHT pricing requests
 *        run at once across all clients; past it a request waits the same short
 *        time, then is told the site is busy (503, Retry-After).
 *   fewer lines without an account   a visitor who is not signed in may price
 *        QUOTE_MAX_LINES_ANON lines in one quote; a signed-in customer keeps the
 *        full allowance. Bigger jobs are offered the firm quote.
 *
 * Counters are in memory (one instance serves the site).
 */
const { limits } = require("./limits");
const { clientKey } = require("./clientKey");
const brand = require("../../shared/brand.json");

const inFlight = new Map(); // client key → { running: 1, waiters: [fn] }
let total = 0;
const globalWaiters = [];
const counters = { admitted: 0, waited: 0, refusedClient: 0, refusedBusy: 0, refusedLines: 0 };

const MESSAGES = {
  oneAtATime: "We're still pricing your last change. Give it a few seconds and the price will update.",
  busy: `We're pricing a lot of quotes right now. Try again in a few seconds, or call ${brand.phone}.`,
  tooManyLines: (max) => `An instant quote without an account holds up to ${max} lines. Sign in to price more at once, or send us the files for a firm quote and we'll price the whole job by hand.`,
};

function release(key) {
  const slot = inFlight.get(key);
  if (!slot) return;
  total = Math.max(0, total - 1);
  const next = slot.waiters.shift();
  if (next) { total++; next(true); } else inFlight.delete(key);
  // A place opened for everyone: hand it to the longest-waiting client that is not already running.
  while (globalWaiters.length && total < limits.quotePriceMaxInFlight) {
    const w = globalWaiters.shift();
    if (w.settled) continue;
    if (inFlight.has(w.key)) { inFlight.get(w.key).waiters.push(w.grant); continue; }
    inFlight.set(w.key, { waiters: [] });
    total++;
    w.grant(true);
  }
}

/** Wait for this client's turn. Resolves true when admitted, or a refusal object. */
function acquire(key, waitMs) {
  return new Promise((resolve) => {
    const slot = inFlight.get(key);
    if (!slot && total < limits.quotePriceMaxInFlight) {
      inFlight.set(key, { waiters: [] });
      total++;
      return resolve(true);
    }
    let settled = false;
    const waiter = { key, settled: false, grant: null };
    const grant = (ok) => { if (settled) { if (ok === true) release(key); return; } settled = true; waiter.settled = true; clearTimeout(timer); resolve(ok); };
    waiter.grant = grant;
    const perClient = Boolean(slot);
    if (perClient) {
      // A browser has at most a couple of re-prices queued; more than that is not a person.
      if (slot.waiters.length >= 2) return resolve({ status: 429, code: "pricing-in-progress", message: MESSAGES.oneAtATime });
      slot.waiters.push(grant);
    } else {
      for (let i = globalWaiters.length - 1; i >= 0; i--) if (globalWaiters[i].settled) globalWaiters.splice(i, 1);
      if (globalWaiters.length >= 64) return resolve({ status: 503, code: "pricing-busy", message: MESSAGES.busy });
      globalWaiters.push(waiter);
    }
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

module.exports = { admit, acquire, release, stats, resetForTests, MESSAGES };
