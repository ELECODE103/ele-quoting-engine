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
  listProcesses,
  activeProcesses,
};
