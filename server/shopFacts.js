/**
 * Owner-confirmed shop facts (shared/shop-facts.json), server side.
 *
 * The public catalog endpoints use this to keep options the owner has not
 * confirmed out of the quote tool: SLS and dental-resin materials, vapor
 * smoothing and dyeing, and the rush / same-day lead times. It only filters
 * what is LISTED to buyers. Pricing, the quote gate and the admin screens
 * are untouched, and flipping `confirmed` to true brings an option back.
 */
const data = require("../shared/shop-facts.json");

function ok(id) {
  const f = data.facts[id];
  return !!f && f.confirmed === true && f.value !== "" && f.value != null && f.value !== false;
}

function materialListed(m) {
  if (m.subProcess === "sls" || /\bSLS\b/.test(m.name || "")) return ok("sls-offered");
  return true;
}

function finishListed(f) {
  if (f.slug === "3dp-vapor-smooth" || f.slug === "3dp-dyeing") return ok("print-vapor-dye");
  return true;
}

function leadTimeListed(lt) {
  if (lt.slug === "same-day") return ok("lead-same-day");
  if (lt.slug === "rush") return ok("lead-rush");
  return true;
}

// Finishes done by an outside finisher (owner, 2026-11-10: anodize and powder
// coat are sent out; bead blasting is done here). A part with one of these
// ships on the Standard lead time only (owner, 2026-11-11). Keep in step with
// SENT_OUT_FINISHES in client/src/facts.js.
const SENT_OUT_FINISHES = new Set(["cnc-anodize-clear", "cnc-anodize-black", "cnc-anodize-color", "cnc-powder-coat"]);
const finishSentOut = (slug) => SENT_OUT_FINISHES.has(slug);
/** May a quote with these finish slugs be bought on this lead time? */
function leadTimeAllowsFinishes(leadTime, finishSlugs = []) {
  return !leadTime || leadTime.slug === "standard" || !finishSlugs.some(finishSentOut);
}

/** The fact's value run through `fn` when the owner has confirmed it, else `fallback` ("" by default). */
function when(id, fn = (v) => v, fallback = "") {
  return ok(id) ? fn(data.facts[id].value) : fallback;
}

/**
 * Catalog grade names carry "(FDA)". Food-contact compliance belongs to a
 * maker's grade and lot, so emails and documents say it only once the owner has
 * confirmed the statements can be had (same rule as gradeLabel in client/src/facts.js).
 */
function gradeLabel(name) {
  const s = String(name || "");
  if (!/\(FDA\)/.test(s)) return s;
  return ok("food-docs")
    ? s.replace(/\s*\(FDA\)/, ", food-contact grade (maker's compliance statement on request)")
    : s.replace(/\s*\(FDA\)/, "");
}

// Tolerance facts by material, matched on the catalog slug or name (same table as client/src/facts.js).
const TOLERANCE_FACTS = [
  ["tol-acetal", ["delrin", "acetal"]], ["tol-nylon", ["nylon"]], ["tol-uhmw", ["uhmw"]], ["tol-hdpe", ["hdpe"]],
  ["tol-peek", ["peek"]], ["tol-ptfe", ["ptfe"]], ["tol-polycarbonate", ["polycarbonate"]], ["tol-polypropylene", ["polypropylene"]],
];
/** The owner-confirmed standard tolerance for a material (slug or name), or "" when none is confirmed. */
function standardTolerance(text) {
  const hay = String(text || "").toLowerCase();
  const hit = TOLERANCE_FACTS.find(([, keys]) => keys.some((k) => hay.includes(k)));
  if (!hit || !ok(hit[0])) return "";
  const v = data.facts[hit[0]].value;
  return (v && typeof v === "object" ? v.standard : v) || "";
}

/** The name the business signs with: the legal name once the owner has confirmed it, else the trading name. */
function businessName(brand) {
  return ok("legal-name") ? data.facts["legal-name"].value : brand.name;
}

module.exports = { ok, when, materialListed, finishListed, leadTimeListed, SENT_OUT_FINISHES, finishSentOut, leadTimeAllowsFinishes, gradeLabel, businessName, standardTolerance };
