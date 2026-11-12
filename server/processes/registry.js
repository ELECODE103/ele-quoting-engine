/**
 * Manufacturing process registry.
 *
 * A "process" (sheet metal, CNC, 3D printing, …) is a first-class entity here:
 * metadata + the self-contained pricing/DFM behavior that tells the rest of the
 * app how to price and DFM-check it. The pricing engine, file parser, and routes
 * look processes up from this registry instead of hard-coding `switch (process)`
 * branches — so adding a new process is a folder under `server/processes/`, not
 * edits scattered across the codebase.
 *
 * This module is intentionally dependency-light: it requires only the pure
 * metadata/config from `defaults.js` and the leaf process folders (each of which
 * requires only ./pricing, ./dfm, ./shared). It must NOT require the pricing
 * engine or file parser (they require this), which keeps the graph acyclic.
 *
 * ── Adding a new process ──────────────────────────────────────────────
 *   1. Add a metadata entry to MANUFACTURING_PROCESSES in config/defaults.js
 *      (slug, name, description, icon, subProcesses, active) — this also seeds
 *      the `processes` DB table.
 *   2. Create a folder `server/processes/<slug>/` with an index.js exporting
 *      { slug, defaultFinishSlug, previewSubProcess, pricing, dfm }.
 *   3. Seed materials/finishes rows with `process: "<slug>"` (admin CRUD or seed).
 * No edits to the pricing/parser/route dispatch are required.
 */

const fs = require("fs");
const path = require("path");
const { MANUFACTURING_PROCESSES } = require("../config/defaults");

// Wiring for a process listed in MANUFACTURING_PROCESSES that has no folder of its own yet
// (used only while seeding the built-ins below). It is NOT a fallback for an unknown slug:
// resolveProcess refuses those (see below).
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

/** Thrown by resolveProcess for a slug that is not a registered process. */
class UnknownProcessError extends Error {
  constructor(slug) {
    super("Unknown manufacturing process");
    this.name = "UnknownProcessError";
    this.code = "process-unknown";
    // Kept short and printable for the log; never echoed to a customer.
    this.slug = typeof slug === "string" ? slug.slice(0, 40) : typeof slug;
  }
}

/**
 * Get a process definition by slug, or throw UnknownProcessError.
 *
 * There is no fallback. This used to answer with the sheet-metal definition for
 * any slug it did not know (a typo, a made-up word, "__proto__"), so a part
 * could be priced by a model that had nothing to do with it (independent review
 * 2026-11-11, F1). A caller that cannot name a registered process must stop,
 * not price. The registry is a Map, so "constructor" / "__proto__" are just
 * unknown slugs.
 */
function resolveProcess(slug) {
  const def = typeof slug === "string" ? processes.get(slug) : undefined;
  if (!def) throw new UnknownProcessError(slug);
  return def;
}

/** A registered process that is switched on (what a customer may price and buy), or null. */
function activeProcess(slug) {
  const def = typeof slug === "string" ? processes.get(slug) : undefined;
  return def && def.active !== false ? def : null;
}

/** All registered process definitions. */
function listProcesses() {
  return [...processes.values()];
}

/** Active process definitions (what the UI/quote flow should offer). */
function activeProcesses() {
  return listProcesses().filter((p) => p.active !== false);
}

// ── Auto-load process behavior from each subdirectory with an index.js ──
// Maps slug → behavior definition object exported by the folder.
const behaviorBySlug = {};
for (const entry of fs.readdirSync(__dirname, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const indexPath = path.join(__dirname, entry.name, "index.js");
  if (!fs.existsSync(indexPath)) continue;
  const def = require(indexPath);
  if (def && def.slug) behaviorBySlug[def.slug] = def;
}

// ── Seed built-ins from the metadata source of truth, merging behavior ──
for (const meta of MANUFACTURING_PROCESSES) {
  const behavior = behaviorBySlug[meta.slug] || FALLBACK_BEHAVIOR;
  defineProcess({ ...meta, ...behavior });
}

module.exports = {
  defineProcess,
  getProcess,
  resolveProcess,
  activeProcess,
  UnknownProcessError,
  listProcesses,
  activeProcesses,
};
