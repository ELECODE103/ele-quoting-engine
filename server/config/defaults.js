/**
 * Default materials, pricing rules, and configuration.
 * This seeds the database on first run.
 *
 * Supports three manufacturing processes:
 *   - sheetmetal: laser cutting, bending, hole punching
 *   - cnc: CNC milling and turning
 *   - 3d-printing: FDM, SLA, SLS additive manufacturing
 */

// ═══════════════════════════════════════════════════════════════
// SHEET METAL MATERIALS
// ═══════════════════════════════════════════════════════════════
const SHEETMETAL_MATERIALS = [
  {
    slug: "mild-steel",
    name: "Mild Steel",
    category: "Steel",
    process: "sheetmetal",
    grades: [
      { name: "A36 / 1008", density: 0.284 },
      { name: "A569 / HRPO", density: 0.284 },
      { name: "A1011 / HRS", density: 0.284 },
    ],
    thicknesses: [
      { mm: 0.9, inch: 0.036, label: '0.036" (20 ga)' },
      { mm: 1.2, inch: 0.048, label: '0.048" (18 ga)' },
      { mm: 1.5, inch: 0.06, label: '0.060" (16 ga)' },
      { mm: 1.9, inch: 0.075, label: '0.075" (14 ga)' },
      { mm: 2.7, inch: 0.105, label: '0.105" (12 ga)' },
      { mm: 3.4, inch: 0.135, label: '0.135" (10 ga)' },
      { mm: 4.8, inch: 0.188, label: '0.188" (3/16)' },
      { mm: 6.35, inch: 0.25, label: '0.250" (1/4)' },
      { mm: 9.5, inch: 0.375, label: '0.375" (3/8)' },
      { mm: 12.7, inch: 0.5, label: '0.500" (1/2)' },
    ],
    color: "#6B7280",
    pricePerKg: 1.10,
    active: true,
  },
  {
    slug: "stainless-304",
    name: "Stainless Steel 304",
    category: "Stainless",
    process: "sheetmetal",
    grades: [
      { name: "304 #4 Finish", density: 0.289 },
      { name: "304 2B Finish", density: 0.289 },
    ],
    thicknesses: [
      { mm: 0.9, inch: 0.036, label: '0.036" (20 ga)' },
      { mm: 1.2, inch: 0.048, label: '0.048" (18 ga)' },
      { mm: 1.5, inch: 0.06, label: '0.060" (16 ga)' },
      { mm: 1.9, inch: 0.075, label: '0.075" (14 ga)' },
      { mm: 2.7, inch: 0.105, label: '0.105" (12 ga)' },
      { mm: 3.4, inch: 0.135, label: '0.135" (10 ga)' },
      { mm: 4.8, inch: 0.188, label: '0.188" (3/16)' },
    ],
    color: "#9CA3AF",
    pricePerKg: 3.80,
    active: true,
  },
  {
    slug: "stainless-316",
    name: "Stainless Steel 316",
    category: "Stainless",
    process: "sheetmetal",
    grades: [
      { name: "316 2B Finish", density: 0.289 },
      { name: "316 #4 Finish", density: 0.289 },
    ],
    thicknesses: [
      { mm: 0.9, inch: 0.036, label: '0.036" (20 ga)' },
      { mm: 1.2, inch: 0.048, label: '0.048" (18 ga)' },
      { mm: 1.5, inch: 0.06, label: '0.060" (16 ga)' },
      { mm: 1.9, inch: 0.075, label: '0.075" (14 ga)' },
      { mm: 2.7, inch: 0.105, label: '0.105" (12 ga)' },
      { mm: 3.4, inch: 0.135, label: '0.135" (10 ga)' },
    ],
    color: "#A1A1AA",
    pricePerKg: 5.20,
    active: true,
  },
  {
    slug: "aluminum-5052",
    name: "Aluminum 5052",
    category: "Aluminum",
    process: "sheetmetal",
    grades: [
      { name: "5052-H32", density: 0.097 },
    ],
    thicknesses: [
      { mm: 1.0, inch: 0.04, label: '0.040" (18 ga)' },
      { mm: 1.3, inch: 0.05, label: '0.050" (16 ga)' },
      { mm: 1.6, inch: 0.063, label: '0.063" (14 ga)' },
      { mm: 2.0, inch: 0.08, label: '0.080" (12 ga)' },
      { mm: 2.3, inch: 0.09, label: '0.090" (11 ga)' },
      { mm: 3.2, inch: 0.125, label: '0.125" (1/8)' },
      { mm: 4.8, inch: 0.19, label: '0.190" (3/16)' },
      { mm: 6.35, inch: 0.25, label: '0.250" (1/4)' },
    ],
    color: "#D1D5DB",
    pricePerKg: 4.50,
    active: true,
  },
  {
    slug: "aluminum-6061",
    name: "Aluminum 6061",
    category: "Aluminum",
    process: "sheetmetal",
    grades: [
      { name: "6061-T6", density: 0.098 },
    ],
    thicknesses: [
      { mm: 1.6, inch: 0.063, label: '0.063" (14 ga)' },
      { mm: 2.0, inch: 0.08, label: '0.080" (12 ga)' },
      { mm: 3.2, inch: 0.125, label: '0.125" (1/8)' },
      { mm: 4.8, inch: 0.19, label: '0.190" (3/16)' },
      { mm: 6.35, inch: 0.25, label: '0.250" (1/4)' },
      { mm: 9.5, inch: 0.375, label: '0.375" (3/8)' },
      { mm: 12.7, inch: 0.5, label: '0.500" (1/2)' },
    ],
    color: "#E5E7EB",
    pricePerKg: 5.00,
    active: true,
  },
  {
    slug: "copper-c110",
    name: "Copper C110",
    category: "Copper",
    process: "sheetmetal",
    grades: [
      { name: "C110 Full Hard", density: 0.323 },
      { name: "C110 Half Hard", density: 0.323 },
    ],
    thicknesses: [
      { mm: 0.5, inch: 0.021, label: '0.021"' },
      { mm: 0.8, inch: 0.032, label: '0.032"' },
      { mm: 1.0, inch: 0.04, label: '0.040"' },
      { mm: 1.3, inch: 0.05, label: '0.050"' },
      { mm: 1.6, inch: 0.064, label: '0.064"' },
    ],
    color: "#D97706",
    pricePerKg: 12.00,
    active: true,
  },
  {
    slug: "brass-c260",
    name: "Brass C260",
    category: "Brass",
    process: "sheetmetal",
    grades: [
      { name: "C260 Half Hard", density: 0.308 },
    ],
    thicknesses: [
      { mm: 0.6, inch: 0.025, label: '0.025"' },
      { mm: 0.8, inch: 0.032, label: '0.032"' },
      { mm: 1.0, inch: 0.04, label: '0.040"' },
      { mm: 1.3, inch: 0.05, label: '0.050"' },
      { mm: 1.6, inch: 0.064, label: '0.064"' },
    ],
    color: "#CA8A04",
    pricePerKg: 8.50,
    active: true,
  },
];

// ═══════════════════════════════════════════════════════════════
// CNC MACHINING MATERIALS
// ═══════════════════════════════════════════════════════════════
const CNC_MATERIALS = [
  {
    slug: "cnc-aluminum-6061",
    name: "Aluminum 6061-T6",
    category: "Aluminum",
    process: "cnc",
    subProcess: "milling",
    grades: [{ name: "6061-T6", density: 0.098 }],
    machinability: 1.0,    // baseline (easy to machine)
    pricePerKg: 6.00,
    color: "#E5E7EB",
    active: true,
  },
  {
    slug: "cnc-aluminum-7075",
    name: "Aluminum 7075-T6",
    category: "Aluminum",
    process: "cnc",
    subProcess: "milling",
    grades: [{ name: "7075-T6", density: 0.102 }],
    machinability: 0.9,
    pricePerKg: 9.00,
    color: "#D1D5DB",
    active: true,
  },
  {
    slug: "cnc-stainless-304",
    name: "Stainless Steel 304",
    category: "Stainless",
    process: "cnc",
    subProcess: "milling",
    grades: [{ name: "304", density: 0.289 }],
    machinability: 0.45,   // difficult — slow feeds, hard on tooling
    pricePerKg: 5.50,
    color: "#9CA3AF",
    active: true,
  },
  {
    slug: "cnc-stainless-316",
    name: "Stainless Steel 316",
    category: "Stainless",
    process: "cnc",
    subProcess: "milling",
    grades: [{ name: "316", density: 0.289 }],
    machinability: 0.40,
    pricePerKg: 7.00,
    color: "#A1A1AA",
    active: true,
  },
  {
    slug: "cnc-mild-steel-1018",
    name: "Steel 1018",
    category: "Steel",
    process: "cnc",
    subProcess: "milling",
    grades: [{ name: "1018 Cold Rolled", density: 0.284 }],
    machinability: 0.70,
    pricePerKg: 2.50,
    color: "#6B7280",
    active: true,
  },
  {
    slug: "cnc-steel-4140",
    name: "Steel 4140",
    category: "Steel",
    process: "cnc",
    subProcess: "milling",
    grades: [{ name: "4140 Pre-hardened", density: 0.284 }],
    machinability: 0.55,
    pricePerKg: 4.00,
    color: "#52525B",
    active: true,
  },
  {
    slug: "cnc-brass-360",
    name: "Brass 360 (Free-machining)",
    category: "Brass",
    process: "cnc",
    subProcess: "milling",
    grades: [{ name: "C360", density: 0.308 }],
    machinability: 1.2,    // very easy, better than aluminum
    pricePerKg: 10.00,
    color: "#CA8A04",
    active: true,
  },
  {
    slug: "cnc-titanium-gr5",
    name: "Titanium Grade 5 (Ti-6Al-4V)",
    category: "Titanium",
    process: "cnc",
    subProcess: "milling",
    grades: [{ name: "Grade 5", density: 0.160 }],
    machinability: 0.25,   // very difficult
    pricePerKg: 35.00,
    color: "#78716C",
    active: true,
  },
  {
    slug: "cnc-delrin",
    name: "Delrin (Acetal/POM)",
    category: "Plastic",
    process: "cnc",
    subProcess: "milling",
    grades: [{ name: "Delrin 150", density: 0.051 }],
    machinability: 1.3,
    pricePerKg: 8.00,
    color: "#F5F5F4",
    active: true,
  },
  {
    slug: "cnc-nylon-6",
    name: "Nylon 6/6",
    category: "Plastic",
    process: "cnc",
    subProcess: "milling",
    grades: [{ name: "Nylon 6/6", density: 0.041 }],
    machinability: 1.1,
    pricePerKg: 12.00,
    color: "#FAFAF9",
    active: true,
  },
];

// ═══════════════════════════════════════════════════════════════
// 3D PRINTING MATERIALS
// ═══════════════════════════════════════════════════════════════
const PRINTING_MATERIALS = [
  // ─── FDM ───────────────────────────────────────────
  {
    slug: "fdm-pla",
    name: "PLA",
    category: "FDM",
    process: "3d-printing",
    subProcess: "fdm",
    density: 1.24,       // g/cm³
    pricePerCm3: 0.05,
    layerHeights: [0.1, 0.15, 0.2, 0.3],
    defaultLayerHeight: 0.2,
    color: "#60A5FA",
    active: true,
  },
  {
    slug: "fdm-abs",
    name: "ABS",
    category: "FDM",
    process: "3d-printing",
    subProcess: "fdm",
    density: 1.04,
    pricePerCm3: 0.06,
    layerHeights: [0.1, 0.15, 0.2, 0.3],
    defaultLayerHeight: 0.2,
    color: "#F97316",
    active: true,
  },
  {
    slug: "fdm-petg",
    name: "PETG",
    category: "FDM",
    process: "3d-printing",
    subProcess: "fdm",
    density: 1.27,
    pricePerCm3: 0.06,
    layerHeights: [0.1, 0.15, 0.2, 0.3],
    defaultLayerHeight: 0.2,
    color: "#34D399",
    active: true,
  },
  {
    slug: "fdm-nylon",
    name: "Nylon (PA12)",
    category: "FDM",
    process: "3d-printing",
    subProcess: "fdm",
    density: 1.01,
    pricePerCm3: 0.12,
    layerHeights: [0.1, 0.15, 0.2],
    defaultLayerHeight: 0.15,
    color: "#E5E7EB",
    active: true,
  },
  {
    slug: "fdm-tpu",
    name: "TPU (Flexible)",
    category: "FDM",
    process: "3d-printing",
    subProcess: "fdm",
    density: 1.21,
    pricePerCm3: 0.10,
    layerHeights: [0.15, 0.2, 0.3],
    defaultLayerHeight: 0.2,
    color: "#A78BFA",
    active: true,
  },
  {
    slug: "fdm-cf-nylon",
    name: "Carbon Fiber Nylon",
    category: "FDM",
    process: "3d-printing",
    subProcess: "fdm",
    density: 1.10,
    pricePerCm3: 0.25,
    layerHeights: [0.1, 0.15, 0.2],
    defaultLayerHeight: 0.15,
    color: "#1F2937",
    active: true,
  },
  // ─── SLA ───────────────────────────────────────────
  {
    slug: "sla-standard",
    name: "Standard Resin",
    category: "SLA",
    process: "3d-printing",
    subProcess: "sla",
    density: 1.18,
    pricePerCm3: 0.12,
    layerHeights: [0.025, 0.05, 0.1],
    defaultLayerHeight: 0.05,
    color: "#D1D5DB",
    active: true,
  },
  {
    slug: "sla-tough",
    name: "Tough Resin (ABS-like)",
    category: "SLA",
    process: "3d-printing",
    subProcess: "sla",
    density: 1.18,
    pricePerCm3: 0.18,
    layerHeights: [0.025, 0.05, 0.1],
    defaultLayerHeight: 0.05,
    color: "#6B7280",
    active: true,
  },
  {
    slug: "sla-flexible",
    name: "Flexible Resin",
    category: "SLA",
    process: "3d-printing",
    subProcess: "sla",
    density: 1.15,
    pricePerCm3: 0.20,
    layerHeights: [0.05, 0.1],
    defaultLayerHeight: 0.05,
    color: "#FBBF24",
    active: true,
  },
  {
    slug: "sla-dental",
    name: "Dental / Biocompatible Resin",
    category: "SLA",
    process: "3d-printing",
    subProcess: "sla",
    density: 1.20,
    pricePerCm3: 0.35,
    layerHeights: [0.025, 0.05],
    defaultLayerHeight: 0.025,
    color: "#F0FDF4",
    active: true,
  },
  // ─── SLS ───────────────────────────────────────────
  {
    slug: "sls-nylon-pa12",
    name: "Nylon PA12 (SLS)",
    category: "SLS",
    process: "3d-printing",
    subProcess: "sls",
    density: 1.01,
    pricePerCm3: 0.15,
    layerHeights: [0.1, 0.12],
    defaultLayerHeight: 0.1,
    color: "#F5F5F4",
    active: true,
  },
  {
    slug: "sls-nylon-pa11",
    name: "Nylon PA11 (SLS)",
    category: "SLS",
    process: "3d-printing",
    subProcess: "sls",
    density: 1.03,
    pricePerCm3: 0.18,
    layerHeights: [0.1, 0.12],
    defaultLayerHeight: 0.1,
    color: "#E7E5E4",
    active: true,
  },
  {
    slug: "sls-glass-filled-nylon",
    name: "Glass-filled Nylon (SLS)",
    category: "SLS",
    process: "3d-printing",
    subProcess: "sls",
    density: 1.22,
    pricePerCm3: 0.22,
    layerHeights: [0.1, 0.12],
    defaultLayerHeight: 0.1,
    color: "#D6D3D1",
    active: true,
  },
  {
    slug: "sls-tpu",
    name: "TPU (SLS Flexible)",
    category: "SLS",
    process: "3d-printing",
    subProcess: "sls",
    density: 1.13,
    pricePerCm3: 0.28,
    layerHeights: [0.1, 0.15],
    defaultLayerHeight: 0.1,
    color: "#A78BFA",
    active: true,
  },
];

// Combine all materials
const DEFAULT_MATERIALS = [
  ...SHEETMETAL_MATERIALS,
  ...CNC_MATERIALS,
  ...PRINTING_MATERIALS,
];

// ═══════════════════════════════════════════════════════════════
// FINISHES (process-specific)
// ═══════════════════════════════════════════════════════════════
const DEFAULT_FINISHES = [
  // Sheet metal finishes
  { slug: "raw", name: "None (Raw)", process: "sheetmetal", pricePerPart: 0, pricePerSqIn: 0, active: true },
  { slug: "deburr", name: "Deburr", process: "sheetmetal", pricePerPart: 2.50, pricePerSqIn: 0.005, active: true },
  { slug: "deburr-grain", name: "Deburr + Grain (240 grit)", process: "sheetmetal", pricePerPart: 4.00, pricePerSqIn: 0.012, active: true },
  { slug: "powder-black", name: "Powder Coat — Black (Matte)", process: "sheetmetal", pricePerPart: 8.00, pricePerSqIn: 0.035, active: true },
  { slug: "powder-white", name: "Powder Coat — White (Gloss)", process: "sheetmetal", pricePerPart: 8.00, pricePerSqIn: 0.035, active: true },
  { slug: "powder-custom", name: "Powder Coat — Custom RAL", process: "sheetmetal", pricePerPart: 14.00, pricePerSqIn: 0.045, active: true },
  { slug: "anodize-clear", name: "Anodize — Clear (Aluminum only)", process: "sheetmetal", pricePerPart: 6.00, pricePerSqIn: 0.028, active: true },
  { slug: "anodize-black", name: "Anodize — Black (Aluminum only)", process: "sheetmetal", pricePerPart: 7.00, pricePerSqIn: 0.032, active: true },
  { slug: "zinc-plate", name: "Zinc Plating", process: "sheetmetal", pricePerPart: 5.00, pricePerSqIn: 0.022, active: true },

  // CNC machining finishes
  { slug: "cnc-as-machined", name: "As Machined", process: "cnc", pricePerPart: 0, pricePerSqIn: 0, active: true },
  { slug: "cnc-bead-blast", name: "Bead Blasted", process: "cnc", pricePerPart: 5.00, pricePerSqIn: 0.015, active: true },
  { slug: "cnc-anodize-clear", name: "Anodize — Clear", process: "cnc", pricePerPart: 8.00, pricePerSqIn: 0.032, active: true },
  { slug: "cnc-anodize-black", name: "Anodize — Black", process: "cnc", pricePerPart: 9.00, pricePerSqIn: 0.035, active: true },
  { slug: "cnc-anodize-color", name: "Anodize — Color (specify)", process: "cnc", pricePerPart: 12.00, pricePerSqIn: 0.040, active: true },
  { slug: "cnc-powder-coat", name: "Powder Coat", process: "cnc", pricePerPart: 10.00, pricePerSqIn: 0.038, active: true },
  { slug: "cnc-nickel-plate", name: "Nickel Plating", process: "cnc", pricePerPart: 10.00, pricePerSqIn: 0.035, active: true },
  { slug: "cnc-chrome-plate", name: "Chrome Plating", process: "cnc", pricePerPart: 15.00, pricePerSqIn: 0.045, active: true },
  { slug: "cnc-passivation", name: "Passivation (Stainless)", process: "cnc", pricePerPart: 4.00, pricePerSqIn: 0.010, active: true },
  { slug: "cnc-black-oxide", name: "Black Oxide", process: "cnc", pricePerPart: 4.00, pricePerSqIn: 0.012, active: true },

  // 3D printing finishes
  { slug: "3dp-as-printed", name: "As Printed", process: "3d-printing", pricePerPart: 0, pricePerSqIn: 0, active: true },
  { slug: "3dp-support-removal", name: "Support Removal + Cleanup", process: "3d-printing", pricePerPart: 3.00, pricePerSqIn: 0.005, active: true },
  { slug: "3dp-sanding", name: "Sanding (smooth finish)", process: "3d-printing", pricePerPart: 6.00, pricePerSqIn: 0.018, active: true },
  { slug: "3dp-vapor-smooth", name: "Vapor Smoothing (SLS/FDM)", process: "3d-printing", pricePerPart: 8.00, pricePerSqIn: 0.025, active: true },
  { slug: "3dp-primer-paint", name: "Primer + Paint", process: "3d-printing", pricePerPart: 12.00, pricePerSqIn: 0.040, active: true },
  { slug: "3dp-dyeing", name: "Dyeing (SLS Nylon)", process: "3d-printing", pricePerPart: 5.00, pricePerSqIn: 0.015, active: true },
];

const DEFAULT_LEAD_TIMES = [
  { slug: "standard", name: "Standard", days: "7-10 business days", multiplier: 1.0, active: true },
  { slug: "expedited", name: "Expedited", days: "3-5 business days", multiplier: 1.35, active: true },
  { slug: "rush", name: "Priority Rush", days: "1-2 business days", multiplier: 1.85, active: true },
  { slug: "same-day", name: "Same Day", days: "Ships today (order by 10am)", multiplier: 2.50, active: true },
];

// ═══════════════════════════════════════════════════════════════
// PRICING RULES (per process)
// ═══════════════════════════════════════════════════════════════
const DEFAULT_PRICING_RULES = {
  // ─── SHEET METAL ─────────────────────────────────
  laserCutRatePerMm: 0.0035,
  laserThicknessExponent: 1.6,
  bendBaseCost: 2.50,
  bendThicknessMultiplier: 3.0,
  holeBaseCost: 0.35,
  tapCost: 1.20,
  countersinkCost: 0.80,

  // ─── CNC MACHINING ──────────────────────────────
  cncSetupCost: 35.00,             // one-time per part setup
  cncMachineRatePerHour: 85.00,    // $/hr machine time
  cncStockPaddingMm: 3.0,          // extra material around part
  cncRoughingRate: 25.0,           // cm³/hr material removal (roughing)
  cncFinishingRate: 8.0,           // cm³/hr material removal (finishing)
  cncFinishingPassRatio: 0.15,     // 15% of stock volume needs finish pass
  cncToolingCostBase: 5.00,        // per-part tooling wear estimate
  cncToolingMachinabilityScale: 2.0,  // scales inversely with machinability
  cncMinimumMachineTime: 0.25,     // minimum 15 min per part (hrs)
  cncTurningMultiplier: 0.85,      // turning is slightly faster than milling

  // ─── 3D PRINTING ────────────────────────────────
  printSetupCost: 5.00,            // per-build setup
  fdmMachineRatePerHour: 8.00,     // FDM printer cost/hr
  fdmPrintSpeedMmPerSec: 60,       // typical print speed
  fdmInfillPercent: 0.20,          // 20% infill default
  fdmSupportMaterialRatio: 0.15,   // 15% extra material for supports
  slaMachineRatePerHour: 20.00,    // SLA machine cost/hr
  slaLayerTimeSec: 8,              // seconds per layer (exposure + peel)
  slaSupportMaterialRatio: 0.10,
  slsMachineRatePerHour: 35.00,    // SLS is most expensive
  slsLayerTimeSec: 12,
  slsPackingEfficiency: 0.08,      // fraction of build volume used

  // ─── SHARED ──────────────────────────────────────
  minimumPartPrice: 5.00,
  minimumOrderTotal: 25.00,
  volumeDiscounts: [
    { minQty: 1, discount: 0 },
    { minQty: 5, discount: 0.05 },
    { minQty: 10, discount: 0.10 },
    { minQty: 25, discount: 0.15 },
    { minQty: 50, discount: 0.22 },
    { minQty: 100, discount: 0.28 },
    { minQty: 250, discount: 0.33 },
    { minQty: 500, discount: 0.38 },
    { minQty: 1000, discount: 0.42 },
  ],
  nestingEfficiencyBonus: 0.12,
  marginPercent: 0.30,
  shippingBaseRate: 12.00,
  shippingPerKg: 2.50,
};

// ═══════════════════════════════════════════════════════════════
// MANUFACTURING PROCESSES
// ═══════════════════════════════════════════════════════════════
const MANUFACTURING_PROCESSES = [
  {
    slug: "sheetmetal",
    name: "Sheet Metal",
    description: "Laser cutting, bending, and hole punching for flat sheet metal parts",
    icon: "sheetmetal",
    subProcesses: [],
    active: true,
  },
  {
    slug: "cnc",
    name: "CNC Machining",
    description: "Precision milling and turning from solid stock material",
    icon: "cnc",
    subProcesses: [
      { slug: "milling", name: "CNC Milling", description: "3-axis or 5-axis milling" },
      { slug: "turning", name: "CNC Turning", description: "Lathe operations for cylindrical parts" },
    ],
    active: true,
  },
  {
    slug: "3d-printing",
    name: "3D Printing",
    description: "Additive manufacturing — FDM, SLA, and SLS processes",
    icon: "3d-printing",
    subProcesses: [
      { slug: "fdm", name: "FDM", description: "Fused Deposition Modeling — best for prototypes & functional parts" },
      { slug: "sla", name: "SLA", description: "Stereolithography — high detail, smooth surface" },
      { slug: "sls", name: "SLS", description: "Selective Laser Sintering — strong, no supports needed" },
    ],
    active: true,
  },
];

module.exports = {
  DEFAULT_MATERIALS,
  SHEETMETAL_MATERIALS,
  CNC_MATERIALS,
  PRINTING_MATERIALS,
  DEFAULT_FINISHES,
  DEFAULT_LEAD_TIMES,
  DEFAULT_PRICING_RULES,
  MANUFACTURING_PROCESSES,
};
