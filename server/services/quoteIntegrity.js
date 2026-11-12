/**
 * Quote integrity — the rules every price passes through before it is shown,
 * stored or charged (independent review 2026-11-11, F1 and F2).
 *
 * routes/api.js `priceQuote` is the one place a price is computed (instant
 * quote, saved quote, reorder, checkout re-pricing). It calls into this module
 * for the three things that keep that price honest:
 *
 *   resolveLine      a WHITELIST of what may be priced. The process must be a
 *                    registered, active process; the material must be listed
 *                    and belong to that process; grade, sub-process, stock
 *                    thickness, finish, layer height, infill and quantity must
 *                    each come from the catalog entry they belong to. Anything
 *                    else is refused with a `code` — never replaced by a
 *                    default. An option the chosen process does not have
 *                    (infill on a machined part) is not read at all.
 *   assertSane       a final floor under the computed price: finite and
 *                    positive, not below an independent estimate of the raw
 *                    material in the part, not below the engine's own cost,
 *                    and not sitting on the order minimum while its cost is
 *                    far above it. A price that fails is refused and reported
 *                    to the owner, not sold.
 *   fingerprint      a hash of exactly what was priced (each part's stored
 *                    geometry and its validated configuration). It is kept on
 *                    the quote; checkout prices again and compares
 *                    (judgeCheckout), and the order keeps a snapshot of it.
 *
 * Nothing here computes or changes a price. The pricing models are untouched.
 */
const crypto = require("crypto");
const registry = require("../processes/registry");
const shopFacts = require("../shopFacts");
const dxf = require("../geometry/dxf");
const ruleSchema = require("../config/ruleSchema");
const { resolveFeatures, materialClassOf } = require("../processes/featureAdapter");
const { createThrottle } = require("../security/throttle");

const MAX_QUANTITY = 1000000;
const LB_IN3_TO_G_CM3 = 27.6799;
const QUOTE_VALID_DAYS = 30; // the price hold the site promises (quote page, checkout page, quote PDF)

// ─── Refusals ──────────────────────────────────────────────────

/**
 * A refusal the routes answer as-is: `status`, `message` (written for the
 * buyer) and `extra` (always a machine-readable `code`; `field` names the
 * selector the page should reset; `partId` the line).
 */
class Refusal extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = "QuoteRefusal";
    this.status = status;
    this.expose = true;
    this.code = code;
    this.extra = { code, ...extra };
  }
}

/** Every code this module (and the checkout comparison built on it) can answer with. */
const CODES = Object.freeze({
  // configuration (400): reset the named selector
  "process-not-offered": "process",
  "material-not-offered": "material",
  "material-process-mismatch": "material",
  "grade-not-offered": "grade",
  "sub-process-not-offered": "subProcess",
  "thickness-required": "thickness",
  "thickness-not-offered": "thickness",
  "finish-not-offered": "finish",
  "finish-not-for-material": "finish",
  "layer-height-not-offered": "layerHeight",
  "infill-out-of-range": "infill",
  "quantity-invalid": "quantity",
  "lead-time-not-offered": "leadTime",
  "config-invalid": null,
  // catalog or engine trouble (409 / 422 / 503): nothing for the buyer to fix
  "material-unavailable": null,
  "pricing-unavailable": null,
  "price-check-failed": null,
});

// ─── Owner reports ─────────────────────────────────────────────

const reportMail = createThrottle({ windowMs: 24 * 60 * 60 * 1000, max: 5 });

/**
 * A price (or a catalog entry) failed a check: log it where the owner looks
 * (the deploy log, with a fixed tag) and send the shop a short note, a few a
 * day at most. Never throws.
 */
function reportToOwner(kind, detail = {}) {
  try {
    // A warm-up pass of the yielding pricing runner (services/pricingMemo.js) says nothing: the final
    // pass meets the same failure and reports it, once.
    if (require("./pricingMemo").warming()) return;
    const safe = JSON.stringify(detail, (k, v) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v));
    console.error(`[price-integrity] ${kind} ${safe}`);
    if (reportMail.peek("owner").limited) return;
    reportMail.hit("owner");
    const mailer = require("./mailer");
    const to = mailer.shopNotifyAddress && mailer.shopNotifyAddress();
    if (!to) return;
    Promise.resolve(mailer.send({
      to,
      subject: "Straightedge: a price was held back for review",
      text: [
        "The quote tool refused to show or sell a price because it failed an automatic check.",
        "Nothing was charged. The buyer was offered a firm quote instead.",
        "",
        `Check: ${kind}`,
        `Detail: ${safe}`,
        "",
        "If this keeps happening for ordinary parts, look at the material's price and density in Admin, and at the pricing rules.",
      ].join("\n"),
      template: "price-integrity",
    })).catch(() => {});
  } catch { /* reporting must never break pricing */ }
}

// ─── Small helpers ─────────────────────────────────────────────

const positive = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
const num = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
const cents = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** JSON with keys in a fixed order, so the same data always hashes the same. */
function canonical(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return "null";
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

function sha(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 40);
}

// ─── Catalog rules ─────────────────────────────────────────────

// Processes where the technology is a property of the material (a resin is SLA, a
// sheet is routed): the sub-process is the material's, and a request may only repeat it.
const SUBPROCESS_FROM_MATERIAL = new Set(["3d-printing", "routing"]);
// Processes whose materials are sold by the layer.
const LAYERED = new Set(["3d-printing"]);

/**
 * Which materials a finish can go on. The catalog says so in the finish's name
 * ("Anodize — Clear (aluminum)", "Polished Edges (clear acrylic / polycarbonate)");
 * this is the same statement in a form the server can check. A finish that is not
 * named here (as-machined, deburr, anything the owner adds) goes on any material of
 * its process.
 */
const isMetal = (m) => ["aluminum", "brass", "steel"].includes(materialClassOf(m));
const slugHas = (m, ...words) => words.some((w) => String(m.slug || "").includes(w) || String(m.name || "").toLowerCase().includes(w));
const FINISH_MATERIAL_RULES = {
  "cnc-anodize-clear": (m) => materialClassOf(m) === "aluminum",
  "cnc-anodize-black": (m) => materialClassOf(m) === "aluminum",
  "cnc-anodize-color": (m) => materialClassOf(m) === "aluminum",
  "cnc-bead-blast": isMetal,
  "cnc-powder-coat": isMetal,
  "cnc-nickel-plate": isMetal,
  "cnc-chrome-plate": isMetal,
  "cnc-passivation": (m) => materialClassOf(m) === "steel",
  "cnc-black-oxide": (m) => materialClassOf(m) === "steel",
  "cnc-polish-clear": (m) => slugHas(m, "acrylic", "polycarbonate"),
  "rt-polish-clear": (m) => slugHas(m, "acrylic", "polycarbonate"),
  "3dp-vapor-smooth": (m) => m.subProcess === "fdm" || m.subProcess === "sls",
  "3dp-dyeing": (m) => m.subProcess === "sls",
};

/** May this finish be put on this material? (Both already known to belong to the same process.) */
function finishFitsMaterial(finish, material) {
  const rule = Object.prototype.hasOwnProperty.call(FINISH_MATERIAL_RULES, finish.slug) ? FINISH_MATERIAL_RULES[finish.slug] : null;
  return rule ? Boolean(rule(material)) : true;
}

/** Is this finish one a buyer may be shown and sold for this process? */
function finishOffered(finish, processSlug) {
  return Boolean(finish) && finish.active !== false && shopFacts.finishListed(finish) && finish.process === processSlug;
}

/** Is this material one a buyer may be shown and sold? */
function materialOffered(material) {
  return Boolean(material) && Boolean(material.active) && shopFacts.materialListed(material);
}

/** Density in g/cm³ of the chosen grade (catalog lb/in³), else the material's own g/cm³; null when neither is there. */
function densityOf(material, gradeName) {
  const grade = (material.grades || []).find((g) => g && g.name === gradeName);
  const lbIn3 = Number(grade && grade.density);
  if (Number.isFinite(lbIn3) && lbIn3 > 0) return lbIn3 * LB_IN3_TO_G_CM3;
  const gcm3 = Number(material.density);
  return Number.isFinite(gcm3) && gcm3 > 0 ? gcm3 : null;
}

/**
 * The fields of a material record the process's pricing model reads. A model
 * that finds one missing carries on with a built-in figure (a density, a price
 * per kilo); that is fine for a preview and wrong for a sale, so a record that
 * is incomplete is not priced for a buyer at all.
 * @returns {string|null} what is missing, or null
 */
function materialProblem(material, processSlug, def, gradeName) {
  if (LAYERED.has(processSlug)) {
    if (!positive(Number(material.pricePerCm3))) return "price per cm³";
    if (!positive(Number(material.density))) return "density";
    const subs = (def.subProcesses || []).map((s) => s.slug);
    if (!subs.includes(material.subProcess)) return "sub-process";
    const heights = Array.isArray(material.layerHeights) ? material.layerHeights : [];
    if (!positive(Number(material.defaultLayerHeight)) && heights.length === 0) return "layer height";
    return null;
  }
  if (!positive(Number(material.pricePerKg || material.costPerKg))) return "price per kg";
  if (!positive(densityOf(material, gradeName))) return "density";
  if (processSlug === "cnc" && !positive(Number(material.machinability))) return "machinability";
  if (processSlug === "routing" && !ruleSchema.FEED_CLASSES.includes(material.feedClass)) return "feed class";
  return null;
}

/** The stored rules must be the complete, validated set (services/pricingAdmin.js). A hand-built or partial object is not priced from. */
function assertRulesComplete(rules) {
  const missing = [];
  if (!rules || typeof rules !== "object") missing.push("(no rules)");
  else {
    for (const key of ruleSchema.schemaKeys()) {
      const v = rules[key];
      if (v === undefined || v === null || (typeof v === "number" && !Number.isFinite(v))) missing.push(key);
    }
  }
  if (missing.length) {
    reportToOwner("pricing rules incomplete", { missing: missing.slice(0, 12), count: missing.length });
    throw new Refusal(503, "pricing-unavailable", "We can't price parts online right now. Try again in a few minutes, or send us the part for a firm quote.", { offerRfq: true });
  }
}

// ─── The whitelist ─────────────────────────────────────────────

/**
 * Validate one configured line against the catalog and return what pricing may
 * use. Throws a Refusal for anything that is not on offer.
 *
 * @param {object} config   cleaned request fields (routes/api.js cleanConfig)
 * @param {object} ctx      { part, materials, finishes }
 * @returns {{ def, process, subProcess, material, grade, thicknessMm, finish, quantity, layerHeight, infill, is2D, normalized }}
 */
function resolveLine(config, { part, materials, finishes }) {
  const partId = config.partId;
  const bad = (code, message, extra = {}) => new Refusal(400, code, message, { partId, field: CODES[code] || undefined, ...extra });
  const name = part.fileName || "This part";

  // Numbers are numbers, and none of them is negative.
  for (const key of ["thicknessMm", "quantity", "layerHeight", "infill"]) {
    const v = config[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw bad(key === "quantity" ? "quantity-invalid" : "config-invalid", key === "quantity" ? "Enter a whole number of pieces, 1 or more." : "That setup isn't one we can price. Reload the page and try again.", { field: CODES[key === "quantity" ? "quantity-invalid" : "config-invalid"] || key });
    }
  }

  // Quantity: whole pieces. (Whether a quantity can be bought without a person looking at it is the quote gate's call.)
  const quantity = config.quantity;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    throw bad("quantity-invalid", `Enter a whole number of pieces, from 1 to ${MAX_QUANTITY.toLocaleString("en-US")}.`);
  }

  // Material: in the catalog, switched on, listed.
  const material = typeof config.materialSlug === "string" ? materials.find((m) => m.slug === config.materialSlug) : null;
  if (!materialOffered(material)) {
    throw bad("material-not-offered", "That material isn't available. Pick another material.");
  }

  // Process: named by the request, or the one the material belongs to. Registered and switched on.
  const processSlug = config.process !== undefined && config.process !== "" ? config.process : material.process;
  const def = registry.activeProcess(processSlug);
  if (!def) throw bad("process-not-offered", "That process isn't one we quote online. Pick CNC machining, CNC routing or 3D printing.");
  if (material.process !== def.slug) {
    throw bad("material-process-mismatch", `That material isn't offered for ${def.name}. Pick a material from the list for ${def.name}.`);
  }

  // A DXF is a flat drawing: it is routed, in a sheet material, at a thickness the buyer picks,
  // once its units are settled. This is the one tie between a kind of file and a process.
  const is2D = dxf.is2D(part.geometry);
  if (is2D) {
    if (def.slug !== "routing") {
      throw bad("dxf-routing-only", `${name}: a DXF is a 2D profile, so it can only be quoted for CNC routing (sheet and plate cut on the router). Switch the process to CNC routing, or upload a STEP, STL, IGES or 3MF model for machining or printing.`, { field: "process" });
    }
    if (part.geometry.profile2d.units?.needsConfirmation) {
      throw bad("dxf-units-required", `${name}: choose whether this drawing is in inches or millimetres before we price it.`, { field: "units" });
    }
  }

  // Grade: one of the material's, or its first when none is named.
  let grade = "";
  const grades = Array.isArray(material.grades) ? material.grades.filter((g) => g && g.name) : [];
  if (grades.length) {
    if (config.grade === undefined || config.grade === "") grade = grades[0].name;
    else if (grades.some((g) => g.name === config.grade)) grade = config.grade;
    else throw bad("grade-not-offered", "That grade isn't available for this material. Pick a grade from the list.");
  }

  // Sub-process: one the process has; for printed and routed materials, the material's own.
  const subs = (def.subProcesses || []).map((s) => s.slug);
  let subProcess = config.subProcess !== undefined && config.subProcess !== "" ? config.subProcess : "";
  if (SUBPROCESS_FROM_MATERIAL.has(def.slug)) {
    if (subProcess && subProcess !== material.subProcess) throw bad("sub-process-not-offered", "That option doesn't go with this material. Pick the material again.");
    subProcess = material.subProcess || "";
  } else if (subs.length) {
    if (!subProcess) subProcess = def.previewSubProcess || subs[0];
    if (!subs.includes(subProcess)) throw bad("sub-process-not-offered", "That operation isn't one we offer for this process.");
  } else if (subProcess) {
    throw bad("sub-process-not-offered", "That operation isn't one we offer for this process.");
  }

  // The record must carry what the model reads (price, density, class): no built-in stand-ins.
  const problem = materialProblem(material, def.slug, def, grade);
  if (problem) {
    reportToOwner("material record incomplete", { material: material.slug, process: def.slug, missing: problem });
    throw new Refusal(409, "material-unavailable", "We can't price that material online right now. Pick another material, or send us the part for a firm quote.", { partId, field: "material", offerRfq: true });
  }

  // Stock thickness: for a material sold by thickness, one of the thicknesses it comes in.
  let thicknessMm = 0;
  const stock = (Array.isArray(material.thicknesses) ? material.thicknesses : []).map((t) => Number(t && t.mm)).filter((mm) => Number.isFinite(mm) && mm > 0);
  if (stock.length) {
    const want = config.thicknessMm;
    if (!(want > 0)) {
      throw is2D
        ? bad("dxf-thickness-required", `${name}: select a stock thickness — a DXF has no thickness of its own.`, { field: "thickness" })
        : bad("thickness-required", `${name}: select a stock thickness.`);
    }
    const match = stock.find((mm) => Math.abs(mm - want) < 0.011);
    if (match === undefined) throw bad("thickness-not-offered", "That thickness isn't stocked in this material. Pick a thickness from the list.");
    thicknessMm = match;
  }

  // Finish: named, or the process's standard finish; listed, of this process, and one that goes on this material.
  const finishSlug = config.finishSlug !== undefined && config.finishSlug !== "" ? config.finishSlug : def.defaultFinishSlug;
  const finish = typeof finishSlug === "string" ? finishes.find((f) => f.slug === finishSlug) : null;
  if (!finishOffered(finish, def.slug)) throw bad("finish-not-offered", "That finish isn't available for this process. Pick a finish from the list.");
  if (!finishFitsMaterial(finish, material)) throw bad("finish-not-for-material", `${finish.name} isn't done on ${material.name}. Pick another finish.`);

  // Layer height and infill exist only where the process has them.
  let layerHeight;
  let infill;
  if (LAYERED.has(def.slug)) {
    const offered = (Array.isArray(material.layerHeights) ? material.layerHeights : []).map(Number).filter((h) => Number.isFinite(h) && h > 0);
    if (config.layerHeight > 0) {
      const hit = offered.find((h) => Math.abs(h - config.layerHeight) < 1e-6);
      if (offered.length ? hit === undefined : (config.layerHeight < 0.02 || config.layerHeight > 1)) {
        throw bad("layer-height-not-offered", "That layer height isn't offered for this material. Pick one from the list.");
      }
      layerHeight = offered.length ? hit : config.layerHeight;
    }
    if (subProcess === "fdm" && config.infill !== undefined && config.infill !== null) {
      if (!(config.infill >= 0.05 && config.infill <= 1)) throw bad("infill-out-of-range", "Infill is between 5% and 100%.");
      infill = config.infill;
    }
  }

  const normalized = { partId, process: def.slug, subProcess, materialSlug: material.slug, grade, thicknessMm, finishSlug: finish.slug, quantity, layerHeight: layerHeight ?? null, infill: infill ?? null };
  return { def, process: def.slug, subProcess, material, grade, thicknessMm, finish, quantity, layerHeight, infill, is2D, normalized };
}

/** The lead time a quote is priced on: in the catalog, switched on, listed. */
function resolveLeadTime(slug, leadTimes) {
  const leadTime = typeof slug === "string" ? leadTimes.find((lt) => lt.slug === slug) : null;
  if (!leadTime || !leadTime.active || !shopFacts.leadTimeListed(leadTime)) {
    throw new Refusal(400, "lead-time-not-offered", "Invalid lead time", { field: "leadTime" });
  }
  const m = Number(leadTime.multiplier);
  if (!Number.isFinite(m) || m < 1) {
    reportToOwner("lead time has no usable multiplier", { leadTime: leadTime.slug });
    throw new Refusal(409, "pricing-unavailable", "That lead time can't be priced online right now. Choose Standard, or call us.", { field: "leadTime" });
  }
  return leadTime;
}

// ─── What a routed 3D model needs a person for ─────────────────

/**
 * A 3D model routed from stock thinner than the model itself cannot be made as
 * drawn, and its material is priced at the thinner stock. The DFM check only
 * warns ("Stock Thickness Match"); a person confirms before money moves.
 * @returns {{partId, code, message}|null}
 */
function stockReason(line, part) {
  if (line.process !== "routing" || line.is2D || !(line.thicknessMm > 0)) return null;
  let thin = 0;
  try { thin = resolveFeatures(part.geometry || {}, { thicknessMm: line.thicknessMm }).f.obb.d; } catch { return null; }
  if (!(thin > 0)) return null;
  if (thin - line.thicknessMm <= Math.max(0.6, thin * 0.12)) return null;
  return {
    partId: line.normalized.partId,
    code: "stock-thinner-than-model",
    message: `The model is ${thin.toFixed(1)} mm thick but ${line.thicknessMm} mm stock is selected — a person confirms the stock before this is ordered`,
  };
}

/** The gate with the integrity reasons added (never removes one). */
function withIntegrityReasons(gate, lines, parts) {
  const extra = lines.map((line, i) => stockReason(line, parts[i])).filter(Boolean);
  if (!extra.length) return gate;
  return { ...gate, requiresRfq: true, reasons: [...(gate.reasons || []), ...extra] };
}

// ─── The floor ─────────────────────────────────────────────────

const FLOOR_SLACK = 0.6;        // the independent material estimate is deliberately loose: it must never trip on an honest price
const MINIMUM_FAR_ABOVE = 1.5;  // "cost far above the order minimum"

/** The discounts the rules allow for this quantity and order (same lookup as processes/shared.js). */
function allowedDiscount(rules, quantity, linesInOrder) {
  const tiers = Array.isArray(rules.volumeDiscounts) ? rules.volumeDiscounts : [];
  const tier = [...tiers].sort((a, b) => a.minQty - b.minQty).reverse().find((t) => quantity >= t.minQty);
  const clamp = (v) => (Number.isFinite(Number(v)) ? Math.min(0.9, Math.max(0, Number(v))) : 0);
  return { volume: tier ? clamp(tier.discount) : 0, nesting: linesInOrder > 1 ? clamp(rules.nestingEfficiencyBonus) : 0 };
}

/**
 * What the raw material in one piece costs at the catalog price, worked out
 * here from the part's volume — not taken from the pricing model. Stock is
 * always at least the part, so an honest price never falls under it.
 */
function rawMaterialPerPiece(line, part) {
  const geometry = line.is2D ? dxf.materialize(part.geometry, line.thicknessMm) : (part.geometry || {});
  const { f } = resolveFeatures(geometry, { thicknessMm: line.thicknessMm, subProcess: line.subProcess });
  const box = f.obb.w * f.obb.h * f.obb.d;
  const mm3 = Math.max(0, Math.min(Number(f.volume) || 0, box > 0 ? box : Infinity));
  const cm3 = mm3 / 1000;
  if (LAYERED.has(line.process)) {
    // FDM lays down at least the infill share of the volume; resin and powder at least the volume.
    return cm3 * Number(line.material.pricePerCm3) * (line.subProcess === "fdm" ? 0.05 : 1);
  }
  const density = densityOf(line.material, line.grade);
  return (cm3 * density / 1000) * Number(line.material.pricePerKg || line.material.costPerKg);
}

/**
 * The final check on a computed quote. Throws a Refusal (422 `price-check-failed`)
 * and reports to the owner when a line or the order is not a price we would sell at.
 * Small parts at the order minimum pass: their cost is under the minimum, which is
 * what the minimum is for.
 *
 * @param {object} quote   pricingEngine.calculateOrderQuote result
 * @param {Array}  lines   resolveLine results, in line order
 * @param {Array}  parts   the part rows, in line order
 * @param {object} rules   the rules the quote was priced under
 */
function assertSane(quote, lines, parts, rules) {
  const fail = (check, detail) => {
    reportToOwner(check, detail);
    return new Refusal(422, "price-check-failed", "We couldn't confirm this price automatically, so we haven't shown it. Send us the part and we'll quote it by hand.", { offerRfq: true, ...(detail.partId ? { partId: detail.partId } : {}) });
  };
  const items = Array.isArray(quote && quote.lineItems) ? quote.lineItems : [];
  if (items.length !== lines.length || items.length === 0) throw fail("line count", { priced: items.length, configured: lines.length });

  let costTotal = 0;
  items.forEach((li, i) => {
    const line = lines[i];
    const ident = { partId: line.normalized.partId, process: line.process, material: line.material.slug, quantity: line.quantity };
    const unit = Number(li.perUnit && li.perUnit.final);
    const total = Number(li.lineTotal);
    if (!positive(unit) || !positive(total)) throw fail("line price is not a positive number", { ...ident, unit: li.perUnit && li.perUnit.final, lineTotal: li.lineTotal });
    if (li.quantity !== line.quantity || li.partId !== line.normalized.partId) throw fail("line does not match its configuration", ident);
    if (li.meta && li.meta.process !== line.process) throw fail("line priced by another process's model", { ...ident, pricedAs: li.meta.process });
    if (li.meta && li.meta.materialSlug !== line.material.slug) throw fail("line priced in another material", { ...ident, pricedIn: li.meta.materialSlug });
    if (Math.abs(total - unit * line.quantity) > 0.011) throw fail("line total is not unit price × quantity", { ...ident, unit, lineTotal: total });

    // The engine's own cost for this piece, after the discounts it gave: the price cannot be under it (margin is never negative).
    const cost = Number(li.perUnit.subtotal) - (Number(li.perUnit.discountAmount) || 0) - (Number(li.perUnit.nestingSavings) || 0);
    if (!Number.isFinite(cost) || cost < 0) throw fail("line cost is not a number", { ...ident, cost });
    if (unit + 1e-6 < cost) throw fail("line price is below its computed cost", { ...ident, unit, cost });
    costTotal += cost * line.quantity;
    // Whatever the rate card's margin and quantity breaks are set to, a piece is not sold for less than
    // the engine's own figure for the material in it (payments review F-12).
    const material = Number(li.perUnit.material);
    if (Number.isFinite(material) && material > 0 && unit + 1e-6 < material) throw fail("line price is below its own material cost", { ...ident, unit, material: Number(material.toFixed(4)) });

    // An independent look at the material in the part.
    let raw;
    try { raw = rawMaterialPerPiece(line, parts[i]); } catch (err) { throw fail("material estimate failed", { ...ident, error: String(err && err.message).slice(0, 120) }); }
    if (!Number.isFinite(raw) || raw < 0) throw fail("material estimate is not a number", { ...ident, raw });
    const d = allowedDiscount(rules, line.quantity, items.length);
    const floor = raw * FLOOR_SLACK * (1 - d.volume) * (1 - d.nesting);
    if (unit + 1e-6 < floor) throw fail("line price is below the material in the part", { ...ident, unit, materialEstimate: Number(raw.toFixed(4)), floor: Number(floor.toFixed(4)) });
  });

  const orderTotal = Number(quote.orderTotal);
  const subtotal = Number(quote.subtotal);
  if (!positive(orderTotal) || !positive(subtotal)) throw fail("order total is not a positive number", { orderTotal: quote.orderTotal, subtotal: quote.subtotal });
  for (const key of ["leadTimeSurcharge", "shippingEstimate", "paperworkFee"]) {
    const v = Number(quote[key]);
    if (!Number.isFinite(v) || v < -1e-9) throw fail(`${key} is not a non-negative number`, { [key]: quote[key] });
  }
  const linesTotal = items.reduce((s, li) => s + Number(li.lineTotal), 0);
  if (Math.abs(linesTotal - subtotal) > 0.011) throw fail("subtotal is not the sum of the lines", { subtotal, linesTotal });
  if (orderTotal + 0.011 < subtotal) throw fail("order total is below its parts", { orderTotal, subtotal });
  const minimum = Number(rules.minimumOrderTotal) || 0;
  const beforePaperwork = orderTotal - (Number(quote.paperworkFee) || 0);
  if (minimum > 0 && beforePaperwork <= minimum + 0.005 && costTotal > minimum * MINIMUM_FAR_ABOVE) {
    throw fail("order sits on the minimum while its cost is far above it", { orderTotal, minimum, cost: Number(costTotal.toFixed(2)) });
  }
}

// ─── Fingerprints ──────────────────────────────────────────────

// Recorded with a parse but not a measurement of the part: how long each stage took. Two reads of
// the same file differ in these and in nothing else, so they are left out of the hash at any depth.
const NOT_GEOMETRY = /^(timings?|elapsedMs|parseMs|durationMs)$/;
function measuredOnly(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(measuredOnly);
  const out = {};
  for (const [k, v] of Object.entries(value)) if (!NOT_GEOMETRY.test(k)) out[k] = measuredOnly(v);
  return out;
}

/**
 * Hash of a part's stored geometry as pricing reads it. The preview mesh is not part of a price,
 * and neither are the parser's stage timings; everything else is.
 */
function geometryHash(geometry) {
  const { meshData, ...measured } = geometry && typeof geometry === "object" ? geometry : {};
  return sha(canonical(measuredOnly(measured)));
}

/** What the shop builds from, kept with the order so the traveler can be checked against what was charged. */
function partSnapshot(part, line, hash) {
  const g = part.geometry || {};
  const bb = g.boundingBox || {};
  return {
    // `hash`: geometryHash(part.geometry) when the caller has it already (it is tens of ms for a dense drawing).
    geometryHash: typeof hash === "string" && hash ? hash : geometryHash(g),
    units: g.units || "mm",
    sourceUnit: line.is2D ? (g.profile2d && g.profile2d.units && g.profile2d.units.unit) || g.sourceUnit || null : null,
    dimsMm: {
      x: Number(bb.width) || 0,
      y: Number(bb.height) || 0,
      z: line.is2D ? line.thicknessMm : Number(bb.depth) || 0,
    },
    volumeMm3: line.is2D ? null : Number(g.volume) || 0,
    is2D: Boolean(line.is2D),
  };
}

/**
 * The integrity record of a priced quote: one fingerprint per line (part,
 * stored geometry, validated configuration) and one for the whole quote.
 */
function fingerprintQuote({ lines, parts, leadTimeSlug, paperwork, rules, leadTimeMultiplier, gate, geometryHashes }) {
  const perLine = lines.map((line, i) => {
    // geometryHashes[i], when given, IS geometryHash(parts[i].geometry): worked out once per part by the caller.
    const snapshot = partSnapshot(parts[i], line, Array.isArray(geometryHashes) ? geometryHashes[i] : undefined);
    // The snapshot carries the validated configuration too (process, material, grade, stock thickness,
    // finish, quantity), so the order's documents can print exactly what was priced.
    const { partId: _id, ...setup } = line.normalized;
    return { partId: line.normalized.partId, fingerprint: sha(canonical({ geometry: snapshot.geometryHash, config: line.normalized })), snapshot: { ...snapshot, ...setup, materialName: line.material.name, finishName: line.finish.name } };
  });
  const priceBasis = {
    rules,
    leadTimeMultiplier,
    materials: lines.map((l) => l.material),
    finishes: lines.map((l) => l.finish),
  };
  return {
    v: 1,
    fingerprint: sha(canonical({ lines: perLine.map((l) => l.fingerprint), leadTimeSlug, paperwork: Boolean(paperwork) })),
    rulesHash: sha(canonical(priceBasis)),
    requiresRfq: Boolean(gate && gate.requiresRfq),
    pricedAt: new Date().toISOString(),
    lines: perLine,
  };
}

// ─── Checkout: stored quote vs. today's price ──────────────────

const HELD_PRICE_FLOOR = 0.5; // a held price under half of today's is not honoured without a look

/**
 * Compare a stored quote with the same configuration priced again now (current
 * geometry, current rules, the gate run again).
 *
 *   charge / "current"  today's price is the stored price (to the cent)
 *   charge / "held"     the rules or catalog prices moved, but the parts, the
 *                       configuration and the gate result are exactly what was
 *                       priced, and the quote is inside its validity window:
 *                       the stored price is honoured
 *   changed             anything else: the buyer is shown today's price first
 *   review              the gate now says a person must look at it
 *
 * @param {object} p  { quote, priced: { quote, gate, integrity }, isAdmin, now }
 */
function judgeCheckout({ quote, priced, isAdmin = false, now = Date.now() }) {
  const stored = quote.config && quote.config.integrity;
  const storedTotal = cents(quote.orderTotal);
  const freshTotal = cents(priced.quote.orderTotal);
  if (priced.gate.requiresRfq && !isAdmin) return { action: "review", reasons: priced.gate.reasons || [] };
  // "Today's price is the stored price": the totals agree to the cent, and so does every line.
  const storedLines = Array.isArray(quote.lineItems) ? quote.lineItems : [];
  const freshLines = priced.quote.lineItems || [];
  const linesAgree = storedLines.length === freshLines.length
    && storedLines.every((li, i) => li && li.partId === freshLines[i].partId && Number(li.quantity) === Number(freshLines[i].quantity) && Math.abs(cents(li.lineTotal) - cents(freshLines[i].lineTotal)) <= 0.01);
  if (Math.abs(freshTotal - storedTotal) <= 0.01 && linesAgree) return { action: "charge", basis: "current", total: storedTotal };
  const sameThing = Boolean(stored) && stored.v === 1 && !stored.stale && stored.fingerprint === priced.integrity.fingerprint;
  const expiresAt = quoteExpiry(quote);
  const inWindow = expiresAt !== null && expiresAt > now;
  const gateUnchanged = Boolean(stored) && stored.requiresRfq === false && !(quote.gate && quote.gate.requiresRfq);
  if (sameThing && inWindow && gateUnchanged && storedTotal >= freshTotal * HELD_PRICE_FLOOR && positive(storedTotal)) {
    return { action: "charge", basis: "held", total: storedTotal };
  }
  return { action: "changed", previousTotal: storedTotal, newTotal: freshTotal, why: !stored || stored.v !== 1 ? "not-fingerprinted" : stored.stale ? "part-changed" : sameThing ? "price-moved-too-far" : "parts-or-setup-changed" };
}

/** When (ms) the price hold on a stored quote ends; a quote saved before the hold existed counts from when it was last touched. */
function quoteExpiry(quote) {
  const t = quote.expiresAt
    ? new Date(quote.expiresAt).getTime()
    : new Date(quote.updatedAt || quote.createdAt || 0).getTime() + QUOTE_VALID_DAYS * 864e5;
  return Number.isFinite(t) ? t : null;
}

/**
 * The owner's firm-quote amount (the admin RFQ screen). It is the owner's
 * number and is honoured as typed — but it must be a real amount of money.
 * @returns {{ok: true, total: number} | {ok: false, error: string}}
 */
function firmQuoteAmount(value, { sending = false } = {}) {
  const n = num(value);
  if (!Number.isFinite(n) || n < 0 || n > 10000000) return { ok: false, error: "Invalid quoted total" };
  const total = cents(n);
  if (sending && !(total > 0)) return { ok: false, error: "Enter the quoted total before sending the quote" };
  return { ok: true, total };
}

module.exports = {
  Refusal, CODES, MAX_QUANTITY, QUOTE_VALID_DAYS,
  resolveLine, resolveLeadTime, assertRulesComplete, assertSane, withIntegrityReasons,
  finishOffered, finishFitsMaterial, materialOffered, materialProblem, densityOf,
  geometryHash, partSnapshot, fingerprintQuote, canonical,
  judgeCheckout, quoteExpiry, firmQuoteAmount, reportToOwner, rawMaterialPerPiece,
  FLOOR_SLACK, MINIMUM_FAR_ABOVE, HELD_PRICE_FLOOR,
};
