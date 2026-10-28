/**
 * DFM rule kit — shared helpers for the per-process DFM modules.
 *
 * Pure leaf (no pricing, parser or registry imports). Provides:
 *   - check()            build a check record with the standard shape
 *   - gate()             degrade a severity when the feature behind it is not trusted
 *   - materialProfile()  material-aware flags (plastic/metal, brittle, hygroscopic, …)
 *   - fmt helpers
 *
 * Check record shape (consumed by the client DFM panel, quoteGate and pricing):
 *   {
 *     id, label,                       stable id + human label
 *     pass: bool,                      severity === "pass"
 *     severity: pass|info|warn|fail,   see shared.js — only fail blocks
 *     detail: string,                  measured value, threshold, what to change
 *     cost: none|minor|major,          pricing hint
 *     confidence: number|"legacy"|"n/a", from the feature the rule used
 *     measured?: number|object, threshold?: number|object, unit?: string,
 *     verify?: true                    set when the severity was degraded for low confidence
 *   }
 */

const COST = { NONE: "none", MINOR: "minor", MAJOR: "major" };

/** Confidence below this is "low": a fail degrades to info, a warn is annotated "verify". */
const LOW_CONFIDENCE = 0.6;
/** A FAIL is only emitted at or above this confidence (B-rep measured, exact extents). */
const FAIL_CONFIDENCE = 0.9;

function isLegacy(conf) {
  return conf === "legacy" || conf == null;
}
function confNumber(conf) {
  if (isLegacy(conf)) return 0;
  if (conf === "n/a") return 1; // rules that use no measured feature (pure advisories)
  const n = Number(conf);
  return Number.isFinite(n) ? n : 0;
}
function isLow(conf) {
  return confNumber(conf) < LOW_CONFIDENCE;
}

/**
 * Apply the two-tier/confidence policy to a desired severity.
 *   fail  → needs confidence ≥ 0.9, otherwise warn (≥0.6) or info (<0.6) with verify
 *   warn  → kept (even on legacy geometry: it never blocks), annotated verify when low
 *   info/pass → unchanged
 * Returns { severity, verify }.
 */
function gate(desired, confidence) {
  const c = confNumber(confidence);
  if (desired === "fail") {
    if (c >= FAIL_CONFIDENCE) return { severity: "fail", verify: false };
    if (c >= LOW_CONFIDENCE) return { severity: "warn", verify: true };
    return { severity: "info", verify: true };
  }
  if (desired === "warn") return { severity: "warn", verify: isLow(confidence) };
  return { severity: desired, verify: false };
}

/**
 * Build a check. `severity` is the desired tier; it is passed through gate().
 * When degraded, " — verify: measured at low confidence" is appended to detail.
 */
function check(spec) {
  const { id, label, severity: desired, detail, cost = COST.NONE, confidence = "n/a" } = spec;
  const g = gate(desired, confidence);
  const rec = {
    id,
    label,
    pass: g.severity === "pass",
    severity: g.severity,
    detail: g.verify && desired !== g.severity
      ? `${detail} — verify: this came from a low-confidence feature estimate, so it is shown as ${g.severity === "info" ? "an advisory" : "a warning"} rather than a hard stop`
      : g.verify
        ? `${detail} — verify against the model; this estimate is low confidence`
        : detail,
    cost,
    confidence: isLegacy(confidence) ? "legacy" : confidence,
  };
  if (g.verify) rec.verify = true;
  if (spec.measured !== undefined) rec.measured = spec.measured;
  if (spec.threshold !== undefined) rec.threshold = spec.threshold;
  if (spec.unit) rec.unit = spec.unit;
  if (spec.ref) rec.ref = spec.ref; // short source tag, e.g. "Hubs CNC / Protolabs"
  return rec;
}

// ─── formatting ─────────────────────────────────────────────────────────────
function mm(n, d = 1) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "?";
  return `${x.toFixed(d)} mm`;
}
function dia(n, d = 1) {
  const x = Number(n);
  return Number.isFinite(x) ? `Ø${x.toFixed(d)}` : "Ø?";
}
function ratio(n, d = 1) {
  const x = Number(n);
  return Number.isFinite(x) ? `${x.toFixed(d)}×` : "?×";
}
function num(n) {
  if (n == null || n === "" || typeof n === "boolean") return null;
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}

// ─── material profiles ──────────────────────────────────────────────────────
/**
 * Material-aware flags. Resolves from options.materialSlug / options.material /
 * options.materialName and falls back to options.materialType ("plastic"|"metal").
 *
 *   isPlastic, isMetal
 *   soft         UHMW / HDPE / PP / PTFE / TPU — flexes under tool & clamp, holds ±0.25 mm not ±0.13
 *   brittle      acrylic, G-10, phenolic — chips/cracks at sharp corners and thin webs
 *   amorphous    acrylic, PC, Ultem, PVC — stress-crack with petroleum coolants; anneal
 *   hygroscopic  nylon (also PA FDM) — moisture growth, needs conditioning
 *   stressRelief acetal, nylon, PC, PEEK, Ultem — heavy/asymmetric removal → intermediate anneal
 *   abrasive     G-10, phenolic, CF-nylon — carbide only, tool wear
 *   highCost     PEEK, Ultem — stock dominates price
 *   warpProne    FDM ABS / nylon — large flat bases lift
 *   flexible     TPU
 */
const FAMILY_LABEL = {
  acetal: "acetal (Delrin)", uhmw: "UHMW", hdpe: "HDPE", pp: "polypropylene", ptfe: "PTFE", "cf-nylon": "CF nylon",
  nylon: "nylon", peek: "PEEK", ultem: "Ultem", polycarbonate: "polycarbonate", acrylic: "acrylic", pvc: "PVC",
  g10: "G-10", phenolic: "phenolic", abs: "ABS", petg: "PETG", pla: "PLA", tpu: "TPU", resin: "SLA resin",
  aluminum: "aluminum", brass: "brass", stainless: "stainless", steel: "steel", plastic: "plastic", metal: "metal",
};

function materialProfile(options = {}) {
  const slug = String(options.materialSlug || (options.material && options.material.slug) || "").toLowerCase();
  const name = String(options.materialName || (options.material && options.material.name) || "").toLowerCase();
  const key = slug || name; // slug is authoritative; the display name is only a fallback
  const type = options.materialType === "metal" ? "metal" : options.materialType === "plastic" ? "plastic" : null;

  const has = (...re) => re.some((r) => r.test(key));
  const p = {
    key: slug || name || type || "unknown",
    family: "unknown",
    isPlastic: type === "plastic",
    isMetal: type === "metal",
    soft: false, brittle: false, amorphous: false, hygroscopic: false,
    stressRelief: false, abrasive: false, highCost: false, warpProne: false, flexible: false,
    label: null,
  };

  if (has(/delrin|acetal|pom/)) Object.assign(p, { family: "acetal", isPlastic: true, isMetal: false, stressRelief: true });
  else if (has(/uhmw/)) Object.assign(p, { family: "uhmw", isPlastic: true, isMetal: false, soft: true });
  else if (has(/hdpe|polyethylene/)) Object.assign(p, { family: "hdpe", isPlastic: true, isMetal: false, soft: true });
  else if (has(/polypropylene|\bpp\b/)) Object.assign(p, { family: "pp", isPlastic: true, isMetal: false, soft: true });
  else if (has(/ptfe|teflon/)) Object.assign(p, { family: "ptfe", isPlastic: true, isMetal: false, soft: true });
  else if (has(/cf-nylon|carbon/)) Object.assign(p, { family: "cf-nylon", isPlastic: true, isMetal: false, abrasive: true, hygroscopic: true });
  else if (has(/nylon|polyamide|\bpa\b/)) Object.assign(p, { family: "nylon", isPlastic: true, isMetal: false, hygroscopic: true, stressRelief: true, warpProne: true });
  else if (has(/peek/)) Object.assign(p, { family: "peek", isPlastic: true, isMetal: false, highCost: true, stressRelief: true });
  else if (has(/ultem|pei/)) Object.assign(p, { family: "ultem", isPlastic: true, isMetal: false, highCost: true, amorphous: true, stressRelief: true });
  else if (has(/polycarbonate|\bpc\b|lexan/)) Object.assign(p, { family: "polycarbonate", isPlastic: true, isMetal: false, amorphous: true, stressRelief: true });
  else if (has(/acrylic|pmma|plexi/)) Object.assign(p, { family: "acrylic", isPlastic: true, isMetal: false, brittle: true, amorphous: true });
  else if (has(/pvc/)) Object.assign(p, { family: "pvc", isPlastic: true, isMetal: false, amorphous: true });
  else if (has(/g-?10|fr-?4|garolite/)) Object.assign(p, { family: "g10", isPlastic: true, isMetal: false, abrasive: true, brittle: true });
  else if (has(/phenolic|micarta/)) Object.assign(p, { family: "phenolic", isPlastic: true, isMetal: false, abrasive: true, brittle: true });
  else if (has(/abs/)) Object.assign(p, { family: "abs", isPlastic: true, isMetal: false, warpProne: true });
  else if (has(/petg/)) Object.assign(p, { family: "petg", isPlastic: true, isMetal: false });
  else if (has(/pla/)) Object.assign(p, { family: "pla", isPlastic: true, isMetal: false });
  else if (has(/tpu|flex/)) Object.assign(p, { family: "tpu", isPlastic: true, isMetal: false, flexible: true, soft: true });
  else if (has(/sla-|resin/)) Object.assign(p, { family: "resin", isPlastic: true, isMetal: false, brittle: /standard|clear/.test(key) });
  else if (has(/aluminum|aluminium|6061|7075/)) Object.assign(p, { family: "aluminum", isPlastic: false, isMetal: true });
  else if (has(/brass|360/)) Object.assign(p, { family: "brass", isPlastic: false, isMetal: true });
  else if (has(/stainless|304|316/)) Object.assign(p, { family: "stainless", isPlastic: false, isMetal: true });
  else if (has(/steel|1018/)) Object.assign(p, { family: "steel", isPlastic: false, isMetal: true });
  else if (type === "plastic") Object.assign(p, { family: "plastic" });
  else if (type === "metal") Object.assign(p, { family: "metal" });
  else Object.assign(p, { family: "plastic", isPlastic: true }); // Straightedge is a plastics shop: default plastic

  p.label = options.materialName || (options.material && options.material.name) || FAMILY_LABEL[p.family] || (p.isMetal ? "metal" : "plastic");
  return p;
}


// ─── generic rule helpers shared by every process ───────────────────────────
function meshIntegrity(prefix, f, conf) {
  const out = [];
  if (f.mesh.manifold === false) {
    out.push(check({ id: `${prefix}-mesh-integrity`, label: "Mesh Integrity", severity: "fail", cost: COST.MAJOR, confidence: conf.mesh,
      detail: `The mesh is non-manifold (edges shared by more or fewer than two faces), so the solid, its volume and toolpaths cannot be computed. Re-export from the CAD solid (STEP preferred) or repair the mesh` }));
  } else if (f.mesh.watertight === false) {
    out.push(check({ id: `${prefix}-mesh-integrity`, label: "Mesh Integrity", severity: "warn", cost: COST.MAJOR, confidence: conf.mesh,
      detail: `The mesh is not watertight (open edges). Volume and wall measurements are approximate and CAM needs a closed solid; re-export as STEP or close the holes in the mesh` }));
  } else if (f.mesh.selfIntersections === true) {
    out.push(check({ id: `${prefix}-mesh-integrity`, label: "Mesh Integrity", severity: "warn", cost: COST.MINOR, confidence: conf.mesh,
      detail: `The mesh self-intersects in places. Usually harmless for pricing, but CAM may need a repaired model` }));
  }
  return out;
}

function toleranceNote(mat, longest, id) {
  const std = mat.isMetal ? "±0.05 mm (±0.002\")" : mat.soft ? "±0.25 mm (±0.010\")" : "±0.13 mm (±0.005\")";
  const pct = longest > 250 && mat.isPlastic ? ` On a ${longest.toFixed(0)} mm part add 0.1–0.2% of length for thermal movement (${(longest * 0.001).toFixed(2)}–${(longest * 0.002).toFixed(2)} mm).` : "";
  return check({ id, label: "Tolerance Capability", severity: "info", confidence: "n/a", ref: "Quadrant/Boedeker",
    detail: `Standard ${std} on ${mat.label}${mat.hygroscopic ? " (dry)" : ""}.${pct} Call out the features that need tighter and we hold those; uncalled dimensions follow ISO 2768-m` });
}

module.exports = {
  meshIntegrity, toleranceNote,
  COST, LOW_CONFIDENCE, FAIL_CONFIDENCE,
  check, gate, isLegacy, isLow, confNumber,
  mm, dia, ratio, num,
  materialProfile,
};
