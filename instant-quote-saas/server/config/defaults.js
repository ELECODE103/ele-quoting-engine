/**
 * Default materials, pricing rules, and configuration.
 * This seeds the database on first run.
 */

const DEFAULT_MATERIALS = [
  {
    slug: "mild-steel",
    name: "Mild Steel",
    category: "Steel",
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

const DEFAULT_FINISHES = [
  { slug: "raw", name: "None (Raw)", pricePerPart: 0, pricePerSqIn: 0, active: true },
  { slug: "deburr", name: "Deburr", pricePerPart: 2.50, pricePerSqIn: 0.005, active: true },
  { slug: "deburr-grain", name: "Deburr + Grain (240 grit)", pricePerPart: 4.00, pricePerSqIn: 0.012, active: true },
  { slug: "powder-black", name: "Powder Coat — Black (Matte)", pricePerPart: 8.00, pricePerSqIn: 0.035, active: true },
  { slug: "powder-white", name: "Powder Coat — White (Gloss)", pricePerPart: 8.00, pricePerSqIn: 0.035, active: true },
  { slug: "powder-custom", name: "Powder Coat — Custom RAL", pricePerPart: 14.00, pricePerSqIn: 0.045, active: true },
  { slug: "anodize-clear", name: "Anodize — Clear (Aluminum only)", pricePerPart: 6.00, pricePerSqIn: 0.028, active: true },
  { slug: "anodize-black", name: "Anodize — Black (Aluminum only)", pricePerPart: 7.00, pricePerSqIn: 0.032, active: true },
  { slug: "zinc-plate", name: "Zinc Plating", pricePerPart: 5.00, pricePerSqIn: 0.022, active: true },
];

const DEFAULT_LEAD_TIMES = [
  { slug: "standard", name: "Standard", days: "7-10 business days", multiplier: 1.0, active: true },
  { slug: "expedited", name: "Expedited", days: "3-5 business days", multiplier: 1.35, active: true },
  { slug: "rush", name: "Priority Rush", days: "1-2 business days", multiplier: 1.85, active: true },
  { slug: "same-day", name: "Same Day", days: "Ships today (order by 10am)", multiplier: 2.50, active: true },
];

const DEFAULT_PRICING_RULES = {
  // Laser cutting cost per mm of cut perimeter, scaled by thickness
  laserCutRatePerMm: 0.0035,        // base rate per mm at 1mm thickness
  laserThicknessExponent: 1.6,       // cost scales as thickness^exponent

  // CNC bending cost per bend
  bendBaseCost: 2.50,                // per bend setup
  bendThicknessMultiplier: 3.0,      // additional cost per mm of thickness per bend

  // Hole / feature costs
  holeBaseCost: 0.35,                // per hole
  tapCost: 1.20,                     // per tapped hole
  countersinkCost: 0.80,             // per countersink

  // Minimum order value
  minimumPartPrice: 5.00,            // minimum charge per unique part
  minimumOrderTotal: 25.00,          // minimum order total

  // Volume discount tiers
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

  // Nesting efficiency estimate (material savings from nesting multiple parts)
  nestingEfficiencyBonus: 0.12,      // 12% material savings when nesting multiple parts

  // Markup / margin
  marginPercent: 0.30,               // 30% gross margin target

  // Shipping
  shippingBaseRate: 12.00,
  shippingPerKg: 2.50,
};

module.exports = {
  DEFAULT_MATERIALS,
  DEFAULT_FINISHES,
  DEFAULT_LEAD_TIMES,
  DEFAULT_PRICING_RULES,
};
