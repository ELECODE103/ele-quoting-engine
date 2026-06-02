/**
 * Manufacturing process registry.
 *
 * A "process" (sheet metal, CNC, 3D printing, …) is a first-class entity here:
 * metadata + the wiring that tells the rest of the app how to price and DFM-check
 * it. The pricing engine, file parser, and routes look processes up from this
 * registry instead of hard-coding `switch (process)` branches — so adding a new
 * process is a registry entry, not edits scattered across the codebase.
 *
 * This module is intentionally dependency-light: it requires only the pure
 * metadata/config from `defaults.js`. It must NOT require the pricing engine or
 * file parser (they require this), which keeps the dependency graph acyclic.
 * Handlers are referenced by NAME (`priceMethod`, `dfmFn`) and resolved by the
 * owning module, so behavior stays where it lives today while dispatch becomes
 * data-driven.
 *
 * ── Adding a new process ──────────────────────────────────────────────
 *   1. Add a metadata entry to MANUFACTURING_PROCESSES in config/defaults.js
 *      (slug, name, description, icon, subProcesses, active) — this also seeds
 *      the `processes` DB table.
 *   2. Register its behavior here (or from a dedicated module that calls
 *      `defineProcess`): a price method on PricingEngine, a DFM function in
 *      fileParser, a default finish slug, and an optional preview sub-process.
 *   3. Seed materials/finishes rows with `process: "<slug>"` (admin CRUD or seed).
 * No edits to the pricing/parser/route dispatch are required.
 */

const { MANUFACTURING_PROCESSES } = require("../config/defaults");

// Behavior wiring per built-in process slug. `priceMethod` is a PricingEngine
// method name; `dfmFn` is a function name exported from parsers/fileParser.
const BUILTIN_BEHAVIOR = {
  sheetmetal: {
    priceMethod: "calculateSheetMetalPrice",
    dfmFn: "runSheetMetalDFM",
    defaultFinishSlug: "raw",
    previewSubProcess: undefined,
  },
  cnc: {
    priceMethod: "calculateCNCPrice",
    dfmFn: "runCNCDFM",
    defaultFinishSlug: "cnc-as-machined",
    previewSubProcess: "milling",
  },
  "3d-printing": {
    priceMethod: "calculatePrintPrice",
    dfmFn: "runPrintingDFM",
    defaultFinishSlug: "3dp-as-printed",
    previewSubProcess: "fdm",
  },
};

// Fallback wiring for an unknown/new process that hasn't declared behavior yet —
// treat it like sheet metal so it degrades safely rather than throwing.
const FALLBACK_BEHAVIOR = {
  priceMethod: "calculateSheetMetalPrice",
  dfmFn: "runSheetMetalDFM",
  defaultFinishSlug: "raw",
  previewSubProcess: undefined,
};

const processes = new Map();

/** Register (or replace) a process definition. */
function defineProcess(def) {
  if (!def || !def.slug) throw new Error("Process definition requires a slug");
  processes.set(def.slug, { active: true, ...def });
  return processes.get(def.slug);
}

/** Get a process definition by slug (undefined if unknown). */
function getProcess(slug) {
  return processes.get(slug);
}

/** Get a process definition by slug, falling back to sheet metal wiring. */
function resolveProcess(slug) {
  return processes.get(slug) || processes.get("sheetmetal") || { slug: "sheetmetal", ...FALLBACK_BEHAVIOR };
}

/** All registered process definitions. */
function listProcesses() {
  return [...processes.values()];
}

/** Active process definitions (what the UI/quote flow should offer). */
function activeProcesses() {
  return listProcesses().filter((p) => p.active !== false);
}

// ── Seed built-ins from the metadata source of truth ──────────────────
for (const meta of MANUFACTURING_PROCESSES) {
  defineProcess({ ...meta, ...(BUILTIN_BEHAVIOR[meta.slug] || FALLBACK_BEHAVIOR) });
}

module.exports = {
  defineProcess,
  getProcess,
  resolveProcess,
  listProcesses,
  activeProcesses,
};
