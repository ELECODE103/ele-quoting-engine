/**
 * Pricing preview — prices a fixed set of reference parts with a candidate
 * rule set so the owner can see what a change does BEFORE saving it.
 *
 * The parts are six of the vetting library in tools/vet-quotes/parts (real STL
 * geometry, parsed once and cached). Each part is priced for every process it
 * makes sense on, at quantities 1 / 10 / 100, with both the candidate rules
 * and the currently saved rules so the client can show deltas.
 */
const fs = require("fs");
const path = require("path");
const { parseSTL } = require("../parsers/fileParser");
const { PricingEngine } = require("./pricingEngine");
const { DEFAULT_MATERIALS } = require("../config/defaults");

const PARTS_DIR = path.join(__dirname, "..", "..", "tools", "vet-quotes", "parts");
const QUANTITIES = [1, 10, 100];

/**
 * The six reference parts and the lines each is priced on. Chosen to cover
 * every process and the part families the shop actually sees: a flat plate,
 * a pocketed tray, a machined block, a turned bushing, a thin-wall enclosure
 * and a toothed disc.
 */
const REFERENCE_PARTS = [
  {
    id: "plate_hole_pattern", name: "Plate with 6 holes", family: "flat sheet",
    summary: "150 × 100 × ¼\" plate, six M6 clearance holes — the bread-and-butter router part.",
    lines: [
      { process: "routing", subProcess: "sheet", materialSlug: "rt-hdpe", thicknessMm: 6.35 },
      { process: "cnc", subProcess: "milling", materialSlug: "cnc-delrin" },
    ],
  },
  {
    id: "pocketed_tray", name: "Pocketed tray", family: "pocket plate",
    summary: "200 × 150 × ¾\" tray with a 170 × 120 pocket ½\" deep.",
    lines: [
      { process: "routing", subProcess: "sheet", materialSlug: "rt-hdpe", thicknessMm: 19.1 },
      { process: "cnc", subProcess: "milling", materialSlug: "cnc-hdpe" },
    ],
  },
  {
    id: "bracket_block", name: "Bracket block", family: "machined block",
    summary: "100 × 60 × 25 mm block with a pocket and four tapped holes.",
    lines: [
      { process: "cnc", subProcess: "milling", materialSlug: "cnc-delrin" },
      { process: "cnc", subProcess: "milling", materialSlug: "cnc-aluminum-6061" },
    ],
  },
  {
    id: "bushing", name: "Bushing Ø40 × 30", family: "turned",
    summary: "Ø40 × 30 mm bushing with a Ø25 bore — manual lathe work.",
    lines: [
      { process: "cnc", subProcess: "turning", materialSlug: "cnc-delrin" },
      { process: "cnc", subProcess: "turning", materialSlug: "cnc-brass-360" },
    ],
  },
  {
    id: "thin_wall_housing", name: "Thin-wall housing", family: "enclosure",
    summary: "120 × 80 × 40 mm open-top box, 2.5 mm walls — a natural print part.",
    lines: [
      { process: "cnc", subProcess: "milling", materialSlug: "cnc-delrin" },
      { process: "3d-printing", subProcess: "fdm", materialSlug: "fdm-abs" },
      { process: "3d-printing", subProcess: "sla", materialSlug: "sla-standard" },
    ],
  },
  {
    id: "gear_disc", name: "Toothed disc Ø80", family: "flat sheet",
    summary: "Ø80 × 10 mm disc with 24 teeth and a Ø12 bore — lots of short edges.",
    lines: [
      { process: "routing", subProcess: "sheet", materialSlug: "rt-delrin", thicknessMm: 9.5 },
      { process: "cnc", subProcess: "milling", materialSlug: "cnc-delrin" },
      { process: "3d-printing", subProcess: "fdm", materialSlug: "fdm-nylon" },
    ],
  },
];

let geometryCache = null;

/** Parse the reference STLs once (meshData stripped) and cache them. */
function loadReferenceGeometry() {
  if (geometryCache) return geometryCache;
  const cache = {};
  for (const part of REFERENCE_PARTS) {
    const file = path.join(PARTS_DIR, `${part.id}.stl`);
    if (!fs.existsSync(file)) { cache[part.id] = null; continue; }
    try {
      const g = parseSTL(fs.readFileSync(file));
      delete g.meshData;
      cache[part.id] = g;
    } catch (err) {
      console.error(`pricingPreview: could not parse ${file}: ${err.message}`);
      cache[part.id] = null;
    }
  }
  geometryCache = cache;
  return cache;
}

function engineMinutes(meta) {
  if (!meta) return null;
  if (meta.process === "cnc" && Number.isFinite(meta.machineTimeHours)) return meta.machineTimeHours * 60;
  if (meta.process === "routing" && Number.isFinite(meta.cycleMinutes)) return meta.cycleMinutes;
  if (meta.process === "3d-printing" && Number.isFinite(meta.printTimeHours)) return meta.printTimeHours * 60;
  return null;
}

function round2(n) { return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; }

function priceLine(engine, geometry, line, material, qty) {
  const result = engine.calculatePartPrice({
    geometry,
    material,
    grade: material.grades?.[0]?.name || "",
    thicknessMm: line.thicknessMm || 0,
    finish: null,
    quantity: qty,
    process: line.process,
    subProcess: line.subProcess,
    totalPartsInOrder: 1,
  });
  return {
    unit: round2(result.perUnit?.final),
    lineTotal: round2(result.lineTotal),
    minutes: round2(engineMinutes(result.meta)),
  };
}

/**
 * @param {Object} candidateRules — full effective rules to preview
 * @param {Object} [baseRules]    — the currently saved rules, for deltas (optional)
 * @param {Object} [opts]
 * @param {Array}  [opts.materials] — material records (defaults to the shipped catalog)
 * @returns {{ quantities, parts: Array, generatedAt }}
 */
function run(candidateRules, baseRules = null, { materials = DEFAULT_MATERIALS } = {}) {
  const geometry = loadReferenceGeometry();
  const candidate = new PricingEngine(candidateRules);
  const base = baseRules ? new PricingEngine(baseRules) : null;
  const bySlug = new Map(materials.map((m) => [m.slug, m]));

  const parts = REFERENCE_PARTS.map((part) => {
    const g = geometry[part.id];
    const lines = part.lines.map((line) => {
      const material = bySlug.get(line.materialSlug) || DEFAULT_MATERIALS.find((m) => m.slug === line.materialSlug);
      const out = {
        process: line.process,
        subProcess: line.subProcess,
        materialSlug: line.materialSlug,
        materialName: material ? material.name : line.materialSlug,
        thicknessMm: line.thicknessMm || null,
        at: {},
      };
      if (!g || !material) { out.error = !g ? "reference geometry missing" : "material not found"; return out; }
      for (const qty of QUANTITIES) {
        try {
          const now = priceLine(candidate, g, line, material, qty);
          const was = base ? priceLine(base, g, line, material, qty) : null;
          out.at[qty] = { ...now, baseUnit: was ? was.unit : null, baseMinutes: was ? was.minutes : null };
        } catch (err) {
          out.at[qty] = { error: err.message };
        }
      }
      return out;
    });
    return {
      id: part.id,
      name: part.name,
      family: part.family,
      summary: part.summary,
      bbox: g ? { w: round2(g.boundingBox.width), h: round2(g.boundingBox.height), d: round2(g.boundingBox.depth) } : null,
      volumeCm3: g ? round2(g.volume / 1000) : null,
      lines,
    };
  });

  return { quantities: QUANTITIES, parts, generatedAt: new Date().toISOString() };
}

module.exports = { run, loadReferenceGeometry, REFERENCE_PARTS, QUANTITIES };
