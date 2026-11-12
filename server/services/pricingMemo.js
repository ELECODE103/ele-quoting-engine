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
 *        interrupts the pricing function, the runner lets the event loop turn
 *        (setImmediate) and calls the function again. Everything already
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

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Price with yielding and a budget.
 * @param {() => any} fn  the synchronous pricing-and-saving call. It is run
 *        several times: warm-up passes (memo.warming, interruptible) in which it
 *        must return before writing — routes/api.js saveQuote() checks
 *        pricingMemo.warming() right after pricing — and one final pass.
 * @returns {Promise<any>} what the final pass returned (its error, if it threw)
 */
async function run(fn, opt = {}) {
  const memo = createMemo();
  const budgetMs = opt.budgetMs ?? limits.quotePriceBudgetMs;
  const wallMs = opt.wallMs ?? limits.quotePriceWallMs;
  const started = Date.now();
  memo.warming = true;
  memo.interruptible = true;
  for (;;) {
    memo.interrupted = false;
    memo.sliceStart = Date.now();
    memo.sliceWork = 0;
    memo.stats.passes++;
    let failed = false;
    try {
      sync(fn, memo);
    } catch (err) {
      // An interrupt is ours. Anything else is the pricing function's own refusal (a bad part, a bad
      // material): the final pass below raises it again, in order, from the memo.
      failed = !memo.interrupted;
    }
    memo.stats.workMs += Date.now() - memo.sliceStart;
    if (!memo.interrupted || failed) break;
    if (memo.stats.workMs > budgetMs || Date.now() - started > wallMs) {
      if (typeof opt.onRefused === "function") opt.onRefused(memo.stats);
      throw tooSlow();
    }
    await yieldToLoop();
  }
  // Everything the pricing function needs is in the memo now: the final pass is lookups, then the save.
  await yieldToLoop();
  memo.warming = false;
  memo.interruptible = false;
  const t0 = Date.now();
  try {
    return sync(fn, memo);
  } finally {
    memo.stats.workMs += Date.now() - t0;
    if (typeof opt.onDone === "function") opt.onDone(memo.stats);
  }
}

module.exports = { run, sync, warming, wrapModels, wrapModel, wrapDfm, wrapEngine, createMemo, Interrupt };
