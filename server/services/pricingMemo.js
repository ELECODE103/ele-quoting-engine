/**
 * Pricing a quote without stalling the site (independent review 2026-11-11, C2).
 *
 * The problem: POST /api/quote priced every line on the one thread that serves
 * every visitor, and for each line it loaded the part again (for a detailed
 * part: read and parse its geometry file), re-read the whole materials,
 * finishes and lead-time tables, re-ran the DFM rules and computed seven
 * prices. A 100-line quote of one dense DXF held the thread for seconds; one
 * address inside its rate limit kept the health check at a median of 17–35 s.
 *
 * The fix here does not touch how a price is worked out. It wraps the things
 * the pricing function fetches, from the outside:
 *
 *   a memo per request   each distinct part is loaded once; each catalog table
 *        is read once; DFM is run once per (part, process, configuration);
 *        the engine prices each distinct (part, configuration, quantity) once.
 *        Everything memoised is a pure function of its inputs within one
 *        request, so the result is the same object the unmemoised code would
 *        have built — proven by tools/vet-quotes (300 quotes, identical).
 *
 *   yielding   the first time a value is needed it is computed; when the
 *        request has used its time slice (QUOTE_PRICE_SLICE_MS) the memo
 *        interrupts the pricing function, the site's one runner (below) lets
 *        the event loop turn and calls the function again. Everything already
 *        computed is answered from the memo, so each pass gets further, and
 *        other requests are served between passes. The pricing function is
 *        pure up to the point it saves the quote, and the save is reached only
 *        by the final pass, which runs with interruption switched off.
 *
 *   a budget   QUOTE_PRICE_BUDGET_MS of main-thread work and
 *        QUOTE_PRICE_WALL_MS on the clock per request; past either the request
 *        stops with a refusal that offers the firm quote.
 *
 * Wiring (routes/api.js): the model handles and the two pure functions are
 * wrapped once where they are imported —
 *
 *     const { materialsDB, finishesDB, leadTimesDB, partsDB } = pricingMemo.wrapModels(models)
 *     const runDFMAnalysis = pricingMemo.wrapDfm(fileParser.runDFMAnalysis)
 *     pricingMemo.wrapEngine(pricingEngine)
 *
 * — and the pricing route calls `await pricingMemo.run(() => saveQuote(...))`.
 * With no memo active (reorder, tests calling saveQuote directly) every wrapper
 * passes straight through to the real function.
 */
const { limits } = require("../security/limits");
const brand = require("../../shared/brand.json");

class Interrupt extends Error {
  constructor() { super("pricing interrupted to let other requests run"); this.name = "PricingInterrupt"; this.pricingInterrupt = true; }
}

/** The memo of the pricing call that is running right now (pricing is synchronous, so there is at most one). */
let active = null;

function createMemo() {
  return {
    parts: new Map(),          // part id → part (or null)
    tables: new Map(),         // table name → rows
    dfm: new WeakMap(),        // geometry object → Map(options JSON → result)
    price: new WeakMap(),      // geometry object → Map(key → price)
    ids: new WeakMap(),        // object → small integer, for keys
    nextId: 1,
    interruptible: false,
    interrupted: false,
    warming: false,
    sliceStart: 0,
    sliceWork: 0,              // values computed in this slice
    stats: { hits: 0, misses: 0, passes: 0, workMs: 0 },
  };
}

/** Called before a value is computed: stop here when the slice is used up (and at least one value was computed in it). */
function checkpoint(memo) {
  if (!memo.interruptible) return;
  if (memo.sliceWork > 0 && Date.now() - memo.sliceStart >= limits.quotePriceSliceMs) {
    memo.interrupted = true;
    throw new Interrupt();
  }
}

function compute(memo, fn) {
  checkpoint(memo);
  memo.stats.misses++;
  const value = fn();
  memo.sliceWork++;
  return value;
}

const idOf = (memo, obj) => {
  if (obj === null || typeof obj !== "object") return String(obj);
  let id = memo.ids.get(obj);
  if (!id) { id = memo.nextId++; memo.ids.set(obj, id); }
  return `#${id}`;
};

/**
 * A stand-in for a model handle whose getAll()/getById() answer from the active
 * memo. Everything else (insert, update, delete, query …) is the real handle's.
 */
function wrapModel(db, name) {
  const wrapped = Object.create(db);
  wrapped.getAll = function getAll() {
    const memo = active;
    if (!memo) return db.getAll();
    if (memo.tables.has(name)) { memo.stats.hits++; return memo.tables.get(name); }
    const rows = compute(memo, () => db.getAll());
    memo.tables.set(name, rows);
    return rows;
  };
  wrapped.getById = function getById(id, opt) {
    const memo = active;
    // A call with options (the preview mesh) is not a pricing read: pass it through.
    if (!memo || opt !== undefined || typeof id !== "string") return db.getById(id, opt);
    const key = `${name}:${id}`;
    if (memo.parts.has(key)) { memo.stats.hits++; return memo.parts.get(key); }
    const row = compute(memo, () => db.getById(id));
    memo.parts.set(key, row);
    return row;
  };
  return wrapped;
}

/** @param {object} models { materialsDB, finishesDB, leadTimesDB, partsDB } @returns the same keys, wrapped */
function wrapModels(models) {
  const out = {};
  for (const key of ["materialsDB", "finishesDB", "leadTimesDB", "partsDB"]) {
    if (models[key]) out[key] = wrapModel(models[key], key);
  }
  return out;
}

/** DFM by (geometry, options): the rules are pure, so the same inputs give the same checks. */
function wrapDfm(runDFMAnalysis) {
  return function memoDfm(geometry, options = {}) {
    const memo = active;
    if (!memo || !geometry || typeof geometry !== "object") return runDFMAnalysis(geometry, options);
    let byOptions = memo.dfm.get(geometry);
    if (!byOptions) { byOptions = new Map(); memo.dfm.set(geometry, byOptions); }
    let key;
    try { key = JSON.stringify(options); } catch { return runDFMAnalysis(geometry, options); }
    if (byOptions.has(key)) { memo.stats.hits++; return byOptions.get(key); }
    const result = compute(memo, () => runDFMAnalysis(geometry, options));
    byOptions.set(key, result);
    return result;
  };
}

/** The engine's per-part price, memoised by everything it is given. */
function wrapEngine(engine) {
  const real = engine.calculatePartPrice.bind(engine);
  engine.calculatePartPrice = function memoPrice(params) {
    const memo = active;
    if (!memo || !params || !params.geometry || typeof params.geometry !== "object") return real(params);
    let byKey = memo.price.get(params.geometry);
    if (!byKey) { byKey = new Map(); memo.price.set(params.geometry, byKey); }
    // Objects by identity (the catalog rows are the memo's own, one per request), plain values by value.
    const parts = [idOf(memo, engine.rules)];
    for (const k of Object.keys(params).sort()) {
      if (k === "geometry") continue;
      const v = params[k];
      parts.push(k, v !== null && typeof v === "object" ? idOf(memo, v) : `${typeof v}:${String(v)}`);
    }
    const key = parts.join("|");
    if (byKey.has(key)) { memo.stats.hits++; return byKey.get(key); }
    const price = compute(memo, () => real(params));
    byKey.set(key, price);
    return price;
  };
  return engine;
}

/** Run `fn` with a memo active (and nothing else): for synchronous callers that want the saving without the yielding. */
function sync(fn, memo = createMemo()) {
  const previous = active;
  active = memo;
  try { return fn(); } finally { active = previous; }
}

/** True while the current call is a warm-up pass: the pricing function must stop before it writes anything. */
function warming() {
  return Boolean(active && active.warming);
}

const tooSlow = () => Object.assign(
  new Error(`This quote is taking longer to price than the instant quote allows. Send us the files for a firm quote and we'll price it by hand, or split it into smaller quotes. Questions: ${brand.phone}.`),
  { status: 422, expose: true, extra: { code: "quote-too-slow", offerRfq: true } },
);

const busy = () => Object.assign(
  new Error(`We're pricing a lot of quotes right now. Try again in a few seconds, or call ${brand.phone}.`),
  { status: 503, expose: true, retryAfterSeconds: 5, extra: { code: "pricing-busy", retryAfterSeconds: 5 } },
);

// ─── One piece at a time, for the whole site ─────────────────
//
// Independent re-review 2026-11-12, RR-13: with one runner per request, eight requests in flight
// meant eight pieces of pricing ran back to back before the server looked at the network again,
// and a quote of 25 different dense parts is about 75 pieces of 10 to 50 ms each. So there is now
// ONE runner. It does one piece of one quote, lets the event loop turn (everything else that is
// waiting — the health check, a page, somebody's upload — is served), then does the next piece.
//
//   two lanes    "light" for quotes whose parts carry little measured detail (a cube, a bracket,
//                a plate with a few holes: milliseconds each) and "heavy" for the rest. Each lane
//                works on one quote at a time and the runner alternates between the lanes, so a
//                one-line re-price waits for one piece of somebody's heavy quote, not for the
//                quote. A light quote that turns out to be slow is moved to the heavy lane.
//   whose turn   within a lane, the sender who has used the least pricing time this hour goes
//                first (first come first served between equals). A sender who prices heavy quotes
//                all hour is always behind one who has just arrived.
//   an allowance per sender   pricing time is charged to the address and to the account, and
//                security/pricingGate.js refuses a sender who has used the hour's allowance
//                (QUOTE_PRICE_SECONDS_PER_CLIENT_HOUR / _PER_ACCOUNT_HOUR).
//   memory       only the quote a lane is working on holds its loaded parts; the ones waiting
//                hold nothing but their request.
const { UsageWindow } = require("./usageWindow");

const usage = new UsageWindow();             // sender key → ms of pricing work in the last hour
const lanes = { light: { active: null, queue: [] }, heavy: { active: null, queue: [] } };
let scheduled = false;
let lastLane = "heavy";
const counters = { started: 0, finished: 0, refusedSlow: 0, refusedBusy: 0, demoted: 0, pieces: 0, longestPieceMs: 0 };

const usedBy = (job, now) => Math.max(0, ...job.keys.map((k) => usage.total(k, now)));

function hasWork() {
  return Boolean(lanes.light.active || lanes.heavy.active || lanes.light.queue.length || lanes.heavy.queue.length);
}

let heavyRestUntil = 0; // the heavy lane is resting until then (see tick)
let heavyCredit = Infinity; // ms of heavy work the lane may still do without resting (capped at the burst)
let heavyCreditAt = 0;
let restTimer = null;

function kick() {
  if (scheduled || !hasWork()) return;
  const lightReady = Boolean(lanes.light.active || lanes.light.queue.length);
  const wait = heavyRestUntil - Date.now();
  if (!lightReady && wait > 0) {
    // Only heavy work, and it is resting: come back when the rest is over.
    if (!restTimer) { restTimer = setTimeout(() => { restTimer = null; kick(); }, wait); if (restTimer.unref) restTimer.unref(); }
    return;
  }
  scheduled = true;
  // One pending immediate for the whole site: between two pieces the loop polls the network.
  setImmediate(tick);
}

/** The next quote for a lane: least pricing time used this hour first; a quote that waited too long is told to retry. */
function takeNext(lane, now) {
  const L = lanes[lane];
  let best = -1;
  let bestUsed = Infinity;
  for (let i = 0; i < L.queue.length; i++) {
    const job = L.queue[i];
    if (job.started ? now - job.started > job.wallMs : now - job.enqueued > job.queueMs) {
      L.queue.splice(i--, 1);
      counters.refusedBusy++;
      job.reject(busy());
      continue;
    }
    const used = usedBy(job, now);
    if (used < bestUsed) { bestUsed = used; best = i; }
  }
  if (best < 0) return null;
  const [job] = L.queue.splice(best, 1);
  if (!job.started) { job.started = now; counters.started++; }
  return job;
}

function finish(lane, job) {
  if (lanes[lane].active === job) lanes[lane].active = null;
  counters.finished++;
  if (typeof job.opt.onDone === "function") { try { job.opt.onDone(job.memo.stats); } catch { /* a hook must not break pricing */ } }
}

/** One piece of one quote. */
function step(lane, job) {
  const memo = job.memo;
  const t0 = Date.now();
  if (job.final) {
    // Everything the pricing function needs is in the memo: this pass is lookups, then the save.
    memo.warming = false;
    memo.interruptible = false;
    let result;
    let error = null;
    try { result = sync(job.fn, memo); } catch (err) { error = err; }
    const ms = Date.now() - t0;
    memo.stats.workMs += ms;
    for (const k of job.keys) usage.add(k, ms);
    finish(lane, job);
    if (error) job.reject(error); else job.resolve(result);
    return ms;
  }
  memo.interrupted = false;
  memo.sliceStart = t0;
  memo.sliceWork = 0;
  memo.stats.passes++;
  let failed = false;
  try {
    sync(job.fn, memo);
  } catch (err) {
    // An interrupt is ours. Anything else is the pricing function's own refusal (a bad part, a bad
    // material): the final pass raises it again, in order, from the memo.
    failed = !memo.interrupted;
  }
  const ms = Date.now() - t0;
  memo.stats.workMs += ms;
  for (const k of job.keys) usage.add(k, ms);
  if (!memo.interrupted || failed) { job.final = true; return ms; }
  if (memo.stats.workMs > job.budgetMs || Date.now() - job.started > job.wallMs) {
    counters.refusedSlow++;
    if (typeof job.opt.onRefused === "function") { try { job.opt.onRefused(memo.stats); } catch { /* as above */ } }
    finish(lane, job);
    job.reject(tooSlow());
    return ms;
  }
  if (lane === "light" && memo.stats.workMs > limits.quotePriceLightMs) {
    // Slower than its parts suggested: it goes on in the heavy lane, with what it has worked out so far.
    lanes.light.active = null;
    counters.demoted++;
    job.enqueued = Date.now();
    lanes.heavy.queue.push(job);
  }
  return ms;
}

function tick() {
  scheduled = false;
  const now = Date.now();
  const ready = (lane) => Boolean(lanes[lane].active || lanes[lane].queue.length);
  // Alternate between the lanes when both have work.
  const order = lastLane === "light" ? ["heavy", "light"] : ["light", "heavy"];
  for (const lane of order) {
    if (!ready(lane)) continue;
    if (lane === "heavy" && now < heavyRestUntil) continue;
    const L = lanes[lane];
    if (!L.active) L.active = takeNext(lane, now);
    if (!L.active) continue;
    lastLane = lane;
    const job = L.active;
    const ms = step(lane, job);
    counters.pieces++;
    if (ms > counters.longestPieceMs) counters.longestPieceMs = ms;
    // The heavy lane may have the thread outright for a short burst (one dense quote from one
    // customer), and after that a set share of it (QUOTE_PRICE_HEAVY_DUTY_PERCENT, a third): when the
    // burst is spent, the lane rests after each piece until it has earned the piece back. Everything
    // else on the site, and the light lane, runs in the rests. However many addresses price dense
    // quotes at once, together they get that share and no more.
    if (lane === "heavy") {
      const t = Date.now();
      const duty = limits.quotePriceHeavyDutyPercent / 100;
      heavyCredit = Math.min(limits.quotePriceHeavyBurstMs, heavyCredit + (t - heavyCreditAt) * duty) - ms;
      heavyCreditAt = t;
      if (heavyCredit < 0 && duty < 1) heavyRestUntil = t + Math.min(2000, Math.ceil(-heavyCredit / duty));
    }
    break;
  }
  kick();
}

/**
 * Price with yielding, a budget and a fair turn.
 * @param {() => any} fn  the synchronous pricing-and-saving call. It is run
 *        several times: warm-up passes (memo.warming, interruptible) in which it
 *        must return before writing — routes/api.js saveQuote() checks
 *        pricingMemo.warming() right after pricing — and one final pass.
 * @param {{ keys?: string[], heavy?: boolean, budgetMs?: number, wallMs?: number, queueMs?: number }} [opt]
 *        keys: who is charged for the work (the client key, the account); security/pricingGate.js
 *        job(req) builds this from a request. heavy: the quote's parts carry a lot of measured detail.
 * @returns {Promise<any>} what the final pass returned (its error, if it threw)
 */
function run(fn, opt = {}) {
  return new Promise((resolve, reject) => {
    const queued = lanes.light.queue.length + lanes.heavy.queue.length;
    if (queued >= limits.quotePriceQueueMax) { counters.refusedBusy++; return reject(busy()); }
    const job = {
      fn, opt, resolve, reject,
      memo: createMemo(),
      keys: (Array.isArray(opt.keys) ? opt.keys : []).filter((k) => typeof k === "string" && k),
      budgetMs: opt.budgetMs ?? limits.quotePriceBudgetMs,
      wallMs: opt.wallMs ?? limits.quotePriceWallMs,
      queueMs: opt.queueMs ?? limits.quotePriceQueueWaitMs,
      enqueued: Date.now(),
      started: 0,
      final: false,
    };
    job.memo.warming = true;
    job.memo.interruptible = true;
    lanes[opt.heavy ? "heavy" : "light"].queue.push(job);
    kick();
  });
}

/** Pricing time a sender has used in the last hour, ms. */
function usedMs(key, now = Date.now()) { return usage.total(key, now); }
function retryAfterSeconds(key, limitMs, now = Date.now()) { return usage.retryAfterSeconds(key, limitMs, now); }

function stats() {
  return {
    lightWaiting: lanes.light.queue.length, heavyWaiting: lanes.heavy.queue.length,
    lightActive: Boolean(lanes.light.active), heavyActive: Boolean(lanes.heavy.active),
    ...counters,
  };
}

/** Tests only. */
function resetForTests() {
  usage.reset();
  for (const lane of ["light", "heavy"]) { lanes[lane].active = null; lanes[lane].queue.length = 0; }
  heavyRestUntil = 0; heavyCredit = Infinity; heavyCreditAt = 0;
  for (const k of Object.keys(counters)) counters[k] = 0;
}

module.exports = { run, sync, warming, wrapModels, wrapModel, wrapDfm, wrapEngine, createMemo, Interrupt, usedMs, retryAfterSeconds, stats, resetForTests, usage };
