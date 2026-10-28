/**
 * Pricing rule schema — the rate card the admin pricing console is built from.
 *
 * PLACEHOLDER. A parallel effort is replacing the flat DEFAULT_PRICING_RULES
 * with a schema-described rate card at this path. Until it lands, this file
 * wraps the current DEFAULT_PRICING_RULES keys so the console, the validation
 * layer, the audit log and the calibration tab can all be built generically
 * against the descriptor shape below. When the real schema drops in, nothing in
 * routes/api.js, services/pricingAdmin.js or the client needs to change as long
 * as it exports the same things from this module:
 *
 *   RULE_SCHEMA   — array of descriptors (see shape below)
 *   RULE_GROUPS   — ordered list of { key, label, blurb } for the left nav
 *   schemaDefaults() — { key: default } for every descriptor
 *   schemaKeys()     — whitelist of editable keys
 *   validateRules(candidate, { partial }) — { ok, errors:[{key,message}], values }
 *
 * Descriptor shape:
 *   {
 *     key:     'cncMachineRatePerHour',       // the key in the rules object
 *     group:   'cnc',                         // one of RULE_GROUPS[].key
 *     label:   'Mill rate',                   // short, as the owner says it
 *     help:    'One sentence the owner can act on.',
 *     unit:    '$/hr' | 'min' | 'hr' | '%' | 'mm' | 'cm³/hr' | 'mm/min' | 's' | '×' | '' ,
 *     type:    'number' | 'percent' | 'currency' | 'integer' | 'table',
 *     min, max, step,                         // numeric bounds (percent: 0..1 fractions)
 *     default: 95,
 *     simple:  true,                          // shown in the "Simple" view
 *     calibration: { process: 'cnc', relation: 'inverse', role: 'rate' },   // optional, see services/calibration.js
 *     // type 'table' only:
 *     shape:   'map' | 'rows',
 *     rows:    [{ key:'soft', label:'Soft plastics' }],   // shape 'map': fixed keys, one number each
 *     columns: [{ key:'minQty', label:'From qty', type:'integer', min, max, unit }],  // shape 'rows'
 *     sortBy:  'minQty',                       // shape 'rows': rows must ascend on this column
 *   }
 *
 * percent values are stored as fractions (0.30) and shown as 30 %.
 */
const { DEFAULT_PRICING_RULES } = require("./defaults");
let brand = {};
try { brand = require("../../shared/brand.json"); } catch { /* optional */ }

const D = DEFAULT_PRICING_RULES;

const RULE_GROUPS = [
  { key: "shop", label: "Shop", blurb: "Rates, margin and floors that every quote uses." },
  { key: "cnc", label: "CNC Machining", blurb: "Tormach / Bridgeport / lathe work priced from stock removed." },
  { key: "routing", label: "Routing", blurb: "Flat and plate parts on the 59 × 96 router, priced from cut length." },
  { key: "printing", label: "Printing", blurb: "FDM, SLA and SLS priced from volume and print time." },
  { key: "discounts", label: "Discounts", blurb: "Quantity breaks and multi-part nesting." },
  { key: "gate", label: "Gate", blurb: "When a quote stops being instant and goes to you for a firm price." },
  { key: "sheetmetal", label: "Sheet Metal (inactive)", blurb: "Kept for ELE sheet-metal work; the process is switched off for Straightedge." },
];

// ───────────────────────────────────────────────────────────────
const RULE_SCHEMA = [
  // ─── SHOP ────────────────────────────────────────────────
  {
    key: "marginPercent", group: "shop", label: "Margin", unit: "%", type: "percent",
    min: 0, max: 0.8, step: 0.01, default: D.marginPercent, simple: true,
    help: "Profit added on top of cost on every part (price = cost ÷ (1 − margin)). 30 % means a $70 cost sells for $100. Raise it when you are turning work away; lower it to win a market you want.",
  },
  {
    key: "minimumPartPrice", group: "shop", label: "Minimum part price", unit: "$", type: "currency",
    min: 0, max: 500, step: 0.5, default: D.minimumPartPrice, simple: true,
    help: "The least any single CNC part can sell for, no matter how small. Covers handling a part at all: bag, label, inspect. Routing and printing have their own floors below.",
  },
  {
    key: "minimumOrderTotal", group: "shop", label: "Minimum order", unit: "$", type: "currency",
    min: 0, max: 2000, step: 1, default: D.minimumOrderTotal, simple: true,
    help: "The smallest order you will take, after shipping. An order that prices below this is bumped up to it. Set it to what it costs you to open a job folder.",
  },
  {
    key: "shippingBaseRate", group: "shop", label: "Shipping base", unit: "$", type: "currency",
    min: 0, max: 200, step: 0.5, default: D.shippingBaseRate,
    help: "Flat shipping charge on every order before weight. Match it to what a small UPS Ground box actually costs you.",
  },
  {
    key: "shippingPerKg", group: "shop", label: "Shipping per kg", unit: "$/kg", type: "currency",
    min: 0, max: 50, step: 0.25, default: D.shippingPerKg,
    help: "Shipping added per kilogram of parts. Raise it if heavy orders keep costing more to ship than they were charged.",
  },

  // ─── CNC MACHINING ───────────────────────────────────────
  {
    key: "cncMachineRatePerHour", group: "cnc", label: "Mill / lathe rate", unit: "$/hr", type: "currency",
    min: 20, max: 400, step: 1, default: D.cncMachineRatePerHour, simple: true,
    help: "What an hour of spindle time on the Tormach or the lathe costs the customer before margin. Machine, operator and overhead together. Raise it if CNC jobs are landing below what you would charge by hand.",
  },
  {
    key: "cncSetupCost", group: "cnc", label: "CNC setup per job", unit: "$", type: "currency",
    min: 0, max: 1000, step: 1, default: D.cncSetupCost, simple: true,
    help: "One-time charge per CNC job, split across the quantity: program, fixture, indicate, set WCS, touch off tools, first article. $45 is about half an hour at the mill rate. Raise it if first parts take longer than you think.",
  },
  {
    key: "cncMinimumMachineTime", group: "cnc", label: "Minimum machine time", unit: "hr", type: "number",
    min: 0, max: 2, step: 0.05, default: D.cncMinimumMachineTime, simple: true,
    calibration: { process: "cnc", relation: "direct", role: "floor" },
    help: "The least spindle time any CNC part is charged, per piece (0.25 = 15 minutes). Small parts sit on this floor, so it sets the price of spacers and clips. Lower it toward 0.1 if simple parts price too high; raise it if they come in cheap.",
  },
  {
    key: "cncRoughingRate", group: "cnc", label: "Roughing removal rate", unit: "cm³/hr", type: "number",
    min: 50, max: 10000, step: 10, default: D.cncRoughingRate,
    calibration: { process: "cnc", relation: "inverse", role: "rate" },
    help: "How much 6061 the mill clears per hour when roughing (900 ≈ 15 cm³/min on the Tormach). Plastics go faster by each material's machinability. If actual cycle times run longer than quoted, lower this; shorter, raise it.",
  },
  {
    key: "cncFinishingRate", group: "cnc", label: "Finishing rate", unit: "cm³/hr", type: "number",
    min: 20, max: 5000, step: 10, default: D.cncFinishingRate,
    help: "Equivalent volume rate for finish passes. Finish time = (stock volume × finishing share) ÷ this. Lower it if finish passes and tool changes eat more of the job than the quote shows.",
  },
  {
    key: "cncFinishingPassRatio", group: "cnc", label: "Finishing share of stock", unit: "%", type: "percent",
    min: 0, max: 1, step: 0.01, default: D.cncFinishingPassRatio,
    help: "Share of the stock volume that gets a finish pass. 15 % is a plain block; raise it for parts with a lot of finished faces.",
  },
  {
    key: "cncStockPaddingMm", group: "cnc", label: "Stock padding", unit: "mm", type: "number",
    min: 0, max: 25, step: 0.5, default: D.cncStockPaddingMm,
    help: "Extra material added on every face of the part to size the stock blank. It drives material cost AND the volume to remove, so a plate gets costed from thicker stock than you buy. 1.5 mm is honest for plate; 3 mm for sawn bar.",
  },
  {
    key: "cncToolingCostBase", group: "cnc", label: "Tooling wear per part", unit: "$", type: "currency",
    min: 0, max: 50, step: 0.5, default: D.cncToolingCostBase,
    help: "Tool wear charged on every CNC piece, scaled up for hard-to-machine stock. It is a hidden floor: at $5 a tiny spacer carries the same wear as a 40-minute roller. $1.50–2 is typical for plastics.",
  },
  {
    key: "cncToolingMachinabilityScale", group: "cnc", label: "Tooling machinability scale", unit: "×", type: "number",
    min: 0, max: 10, step: 0.1, default: D.cncToolingMachinabilityScale,
    help: "Multiplies tooling wear by this ÷ the material's machinability. G-10 (0.6) pays 3.3× the wear of 6061 at 2.0. Leave it unless abrasive stock is killing more tools than you charge for.",
  },
  {
    key: "cncTurningMultiplier", group: "cnc", label: "Turning time multiplier", unit: "×", type: "number",
    min: 0.1, max: 5, step: 0.05, default: D.cncTurningMultiplier,
    help: "Turned parts' machine time × this. Above 1 means the lathe is slower per piece than the mill model; a batch of bushings on the manual lathe with stops is usually faster, 0.6–0.8.",
  },

  // ─── ROUTING ─────────────────────────────────────────────
  {
    key: "routerMachineRatePerHour", group: "routing", label: "Router rate", unit: "$/hr", type: "currency",
    min: 20, max: 400, step: 1, default: D.routerMachineRatePerHour, simple: true,
    help: "What an hour of spindle time on the Techno router costs the customer before margin. Raise it if routed jobs are landing below what you would charge by hand.",
  },
  {
    key: "routerSetupCost", group: "routing", label: "Router setup per job", unit: "$", type: "currency",
    min: 0, max: 1000, step: 1, default: D.routerSetupCost, simple: true,
    help: "One-time charge per routing job, split across the quantity: nest, CAM, load the sheet, first article. $60 makes every one-off at least $88; $45 is 25–30 minutes at the router rate if you want to win one-offs.",
  },
  {
    key: "routerMinimumPartPrice", group: "routing", label: "Minimum routed part", unit: "$", type: "currency",
    min: 0, max: 500, step: 0.5, default: D.routerMinimumPartPrice, simple: true,
    help: "The least any routed part can sell for. Small parts at qty 100 hit this; raise it if de-tabbing and inspecting a piece costs more than this.",
  },
  {
    key: "routerFeedMmPerMin", group: "routing", label: "Cut feed by material class", unit: "mm/min", type: "table",
    shape: "map", min: 100, max: 20000, step: 50, default: D.routerFeedMmPerMin,
    rows: [
      { key: "soft", label: "Soft — HDPE, UHMW, PVC, PP" },
      { key: "medium", label: "Medium — acetal, nylon, polycarbonate" },
      { key: "brittle", label: "Brittle — cast acrylic" },
      { key: "abrasive", label: "Abrasive — G-10, phenolic" },
      { key: "aluminum", label: "Aluminum plate" },
    ],
    calibration: { process: "routing", relation: "inverse", role: "rate" },
    help: "Cutting feed for each material class; cycle time = cut length ÷ feed. Use chip load × flutes × RPM (a ¼\" O-flute in HDPE at 0.006\"/tooth and 18,000 RPM is 2,740 mm/min). Lower a class if those jobs run longer than quoted.",
  },
  {
    key: "routerMaxPassDepthMm", group: "routing", label: "Max depth per pass", unit: "mm", type: "number",
    min: 0.5, max: 30, step: 0.5, default: D.routerMaxPassDepthMm,
    help: "Deepest single pass in plastics. Stock thicker than this gets more passes, so 6.0 makes ¼\" (6.35 mm) sheet a two-pass cut; 6.5 makes it one. Aluminum is fixed at 1.5 mm.",
  },
  {
    key: "routerHoleSeconds", group: "routing", label: "Seconds per hole", unit: "s", type: "number",
    min: 0, max: 60, step: 0.5, default: D.routerHoleSeconds,
    help: "Plunge and drill time charged per detected hole. The hole count from STL files is rough, so keep this small until the geometry reader counts holes reliably.",
  },
  {
    key: "routerToolChangeSeconds", group: "routing", label: "Tool change", unit: "s", type: "number",
    min: 0, max: 120, step: 1, default: D.routerToolChangeSeconds,
    help: "Seconds per ATC tool change; the model assumes two changes per part. Measure one on the Techno and put it here.",
  },
  {
    key: "routerHandlingMinutesPerPart", group: "routing", label: "Handling per part", unit: "min", type: "number",
    min: 0, max: 30, step: 0.1, default: D.routerHandlingMinutesPerPart,
    help: "Minutes to unload, de-tab, deburr and inspect each routed piece. Time yourself on ten parts and divide.",
  },
  {
    key: "routerKerfMarginMm", group: "routing", label: "Blank margin per side", unit: "mm", type: "number",
    min: 0, max: 30, step: 0.5, default: D.routerKerfMarginMm,
    help: "Material allowed around each part in the nest (tool diameter plus onion-skin). It sizes the blank the customer pays for.",
  },
  {
    key: "routerNestYield", group: "routing", label: "Nest yield", unit: "%", type: "percent",
    min: 0.2, max: 1, step: 0.01, default: D.routerNestYield,
    help: "Share of a sheet that becomes parts; the rest is scrap the customer pays for. 85 % is a good nest of rectangles; drop it for round or odd parts.",
  },
  {
    key: "routerToolWearPerMeter", group: "routing", label: "Tool wear per meter cut", unit: "$/m", type: "currency",
    min: 0, max: 10, step: 0.05, default: D.routerToolWearPerMeter,
    help: "Cutter wear per meter of cut length (abrasive stock pays 3×, aluminum 1.5×). A $30 O-flute that lasts 100 m of HDPE is $0.30.",
  },

  // ─── PRINTING ────────────────────────────────────────────
  {
    key: "printSetupCost", group: "printing", label: "Print setup per job", unit: "$", type: "currency",
    min: 0, max: 200, step: 0.5, default: D.printSetupCost,
    help: "One-time charge per print job, split across the quantity: slice, plate, start the build. Raise it if every print needs hand prep.",
  },
  {
    key: "fdmMachineRatePerHour", group: "printing", label: "FDM printer rate", unit: "$/hr", type: "currency",
    min: 0.5, max: 100, step: 0.5, default: D.fdmMachineRatePerHour, simple: true,
    calibration: { process: "3d-printing", subProcess: "fdm", relation: "direct", role: "cost" },
    help: "What an hour of FDM printer time costs the customer before margin. Printers run unattended, so this is mostly machine depreciation and power.",
  },
  {
    key: "fdmPrintSpeedMmPerSec", group: "printing", label: "FDM print speed", unit: "mm/s", type: "number",
    min: 5, max: 500, step: 5, default: D.fdmPrintSpeedMmPerSec,
    calibration: { process: "3d-printing", subProcess: "fdm", relation: "inverse", role: "rate" },
    help: "Head speed the time estimate is built from. Lower it if actual print times run longer than quoted (thin-walled parts usually do).",
  },
  {
    key: "fdmInfillPercent", group: "printing", label: "FDM default infill", unit: "%", type: "percent",
    min: 0.05, max: 1, step: 0.05, default: D.fdmInfillPercent,
    help: "Infill assumed when the customer does not pick one. More infill means more material and time.",
  },
  {
    key: "fdmSupportMaterialRatio", group: "printing", label: "FDM support material", unit: "%", type: "percent",
    min: 0, max: 1, step: 0.05, default: D.fdmSupportMaterialRatio,
    help: "Extra material charged for supports, as a share of the part's material.",
  },
  {
    key: "fdmMinimumPartPrice", group: "printing", label: "Minimum FDM part", unit: "$", type: "currency",
    min: 0, max: 500, step: 0.5, default: D.fdmMinimumPartPrice,
    help: "Floor for an FDM part; covers pulling supports and bagging it.",
  },
  {
    key: "slaMachineRatePerHour", group: "printing", label: "SLA printer rate", unit: "$/hr", type: "currency",
    min: 0.5, max: 200, step: 0.5, default: D.slaMachineRatePerHour,
    calibration: { process: "3d-printing", subProcess: "sla", relation: "direct", role: "cost" },
    help: "What an hour of resin printer time costs the customer before margin, including wash and cure station time.",
  },
  {
    key: "slaLayerTimeSec", group: "printing", label: "SLA seconds per layer", unit: "s", type: "number",
    min: 0.5, max: 120, step: 0.5, default: D.slaLayerTimeSec,
    calibration: { process: "3d-printing", subProcess: "sla", relation: "direct", role: "rate" },
    help: "Fixed exposure plus peel time per layer. Read it off a real print: total time ÷ layers, minus the area term below.",
  },
  {
    key: "slaScanTimeSecPerCm2", group: "printing", label: "SLA seconds per cm² per layer", unit: "s/cm²", type: "number",
    min: 0, max: 10, step: 0.05, default: D.slaScanTimeSecPerCm2,
    help: "Extra time per layer per cm² of footprint. It is charged on the whole bounding-box footprint, so a hollow box is badly over-charged above ~0.1; keep it low until the model uses true cross-sections.",
  },
  {
    key: "slaSupportMaterialRatio", group: "printing", label: "SLA support resin", unit: "%", type: "percent",
    min: 0, max: 1, step: 0.05, default: D.slaSupportMaterialRatio,
    help: "Extra resin charged for supports, as a share of the part's volume.",
  },
  {
    key: "slaMinimumPartPrice", group: "printing", label: "Minimum SLA part", unit: "$", type: "currency",
    min: 0, max: 500, step: 0.5, default: D.slaMinimumPartPrice,
    help: "Floor for a resin part; covers wash, cure and support removal.",
  },
  {
    key: "slsMachineRatePerHour", group: "printing", label: "SLS printer rate", unit: "$/hr", type: "currency",
    min: 0.5, max: 500, step: 0.5, default: D.slsMachineRatePerHour,
    calibration: { process: "3d-printing", subProcess: "sls", relation: "direct", role: "cost" },
    help: "What an hour of SLS time costs the customer before margin (outsourced builds: your vendor's rate plus handling).",
  },
  {
    key: "slsLayerTimeSec", group: "printing", label: "SLS seconds per layer", unit: "s", type: "number",
    min: 0.5, max: 120, step: 0.5, default: D.slsLayerTimeSec,
    calibration: { process: "3d-printing", subProcess: "sls", relation: "direct", role: "rate" },
    help: "Fixed recoat and sweep time per layer.",
  },
  {
    key: "slsScanTimeSecPerCm2", group: "printing", label: "SLS seconds per cm² per layer", unit: "s/cm²", type: "number",
    min: 0, max: 10, step: 0.05, default: D.slsScanTimeSecPerCm2,
    help: "Laser scan time per cm² of footprint per layer. Same bounding-box caveat as SLA.",
  },
  {
    key: "slsPackingEfficiency", group: "printing", label: "SLS build packing", unit: "%", type: "percent",
    min: 0.01, max: 1, step: 0.01, default: D.slsPackingEfficiency,
    help: "Share of the build volume that is parts. The rest is powder the customer pays a share of.",
  },
  {
    key: "slsPowderReuseRatio", group: "printing", label: "SLS powder reuse", unit: "%", type: "percent",
    min: 0, max: 0.95, step: 0.05, default: D.slsPowderReuseRatio,
    help: "Share of un-fused powder that goes back into the next build (PA12 is about 50 %). Higher means cheaper parts.",
  },
  {
    key: "slsMinimumPartPrice", group: "printing", label: "Minimum SLS part", unit: "$", type: "currency",
    min: 0, max: 500, step: 0.5, default: D.slsMinimumPartPrice,
    help: "Floor for an SLS part; covers de-powdering and blasting.",
  },

  // ─── DISCOUNTS ───────────────────────────────────────────
  {
    key: "volumeDiscounts", group: "discounts", label: "Quantity breaks", unit: "", type: "table",
    shape: "rows", default: D.volumeDiscounts, sortBy: "minQty", minRows: 1, maxRows: 20,
    columns: [
      { key: "minQty", label: "From qty", type: "integer", min: 1, max: 100000, unit: "pcs" },
      { key: "discount", label: "Discount", type: "percent", min: 0, max: 0.9, unit: "%" },
    ],
    help: "Price break off the whole per-piece cost (material included) once an order reaches the quantity. It stacks on top of setup being spread across more pieces, so keep the steps modest.",
  },
  {
    key: "nestingEfficiencyBonus", group: "discounts", label: "Multi-part nesting bonus", unit: "%", type: "percent",
    min: 0, max: 0.5, step: 0.01, default: D.nestingEfficiencyBonus,
    help: "Discount on the material share of each line when an order has more than one part (they share sheets and stock). 12 % is modest; 0 turns it off.",
  },

  // ─── GATE ────────────────────────────────────────────────
  {
    key: "rfqQuantityThreshold", group: "gate", label: "Instant-order quantity limit", unit: "pcs", type: "integer",
    min: 1, max: 100000, step: 1, default: Number(brand.rfqQuantityThreshold) || 100, simple: true,
    help: "Above this many pieces on one line the customer gets a budget price and a request-a-quote button instead of checkout. Production runs are quoted by you.",
  },
  {
    key: "bigTicketLineTotal", group: "gate", label: "Big-ticket line total", unit: "$", type: "currency",
    min: 0, max: 1000000, step: 100, default: 5000,
    help: "A single line over this amount is confirmed by hand before the customer can pay. A wrong model assumption on a $5,000 line costs real money; lower it while the model is young.",
  },
  {
    key: "lowVolumeRatio", group: "gate", label: "Complex-geometry ratio", unit: "", type: "number",
    min: 0, max: 1, step: 0.01, default: 0.12,
    help: "CNC parts that use less than this share of their stock envelope (part volume ÷ stock volume) go to RFQ: they are usually multi-setup or 4th-axis jobs the instant model under-prices. Raise toward 0.2 to catch more.",
  },

  // ─── SHEET METAL (inactive process; kept editable) ───────
  {
    key: "laserCutRatePerMm", group: "sheetmetal", label: "Laser cut per mm", unit: "$/mm", type: "currency",
    min: 0, max: 1, step: 0.0005, default: D.laserCutRatePerMm,
    help: "Cost per mm of laser cut at 1 mm thick. Sheet metal is switched off for Straightedge; this only matters if you turn it on.",
  },
  {
    key: "laserThicknessExponent", group: "sheetmetal", label: "Laser thickness exponent", unit: "", type: "number",
    min: 0.5, max: 3, step: 0.1, default: D.laserThicknessExponent,
    help: "How fast laser cost grows with thickness (cost ∝ thickness^this).",
  },
  {
    key: "bendBaseCost", group: "sheetmetal", label: "Bend base cost", unit: "$", type: "currency",
    min: 0, max: 100, step: 0.25, default: D.bendBaseCost,
    help: "Charge per bend at thin gauge.",
  },
  {
    key: "bendThicknessMultiplier", group: "sheetmetal", label: "Bend thickness multiplier", unit: "×", type: "number",
    min: 0, max: 20, step: 0.1, default: D.bendThicknessMultiplier,
    help: "How much a bend cost grows with thickness.",
  },
  {
    key: "holeBaseCost", group: "sheetmetal", label: "Hole cost", unit: "$", type: "currency",
    min: 0, max: 50, step: 0.05, default: D.holeBaseCost,
    help: "Charge per punched or cut hole.",
  },
  {
    key: "tapCost", group: "sheetmetal", label: "Tap cost", unit: "$", type: "currency",
    min: 0, max: 50, step: 0.1, default: D.tapCost,
    help: "Charge per tapped hole.",
  },
  {
    key: "countersinkCost", group: "sheetmetal", label: "Countersink cost", unit: "$", type: "currency",
    min: 0, max: 50, step: 0.1, default: D.countersinkCost,
    help: "Charge per countersink.",
  },
];

// Any DEFAULT_PRICING_RULES key the list above forgot still gets a generic
// descriptor so it stays editable and whitelisted (defensive: the defaults may
// gain keys before the real schema lands).
const described = new Set(RULE_SCHEMA.map((r) => r.key));
for (const [key, value] of Object.entries(D)) {
  if (described.has(key)) continue;
  if (typeof value === "number") {
    RULE_SCHEMA.push({
      key, group: "shop", label: key, unit: "", type: "number",
      min: 0, max: Math.max(1000, value * 100), step: 0.01, default: value,
      help: "No description yet. It is one of the engine's pricing rules; change it only if you know what it does.",
    });
  }
}

// ───────────────────────────────────────────────────────────────
function schemaDefaults() {
  const out = {};
  for (const r of RULE_SCHEMA) out[r.key] = clone(r.default);
  return out;
}

function schemaKeys() {
  return RULE_SCHEMA.map((r) => r.key);
}

function getDescriptor(key) {
  return RULE_SCHEMA.find((r) => r.key === key);
}

function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function checkScalar(desc, value, label) {
  const n = Number(value);
  if (value === "" || value === null || value === undefined || !Number.isFinite(n)) {
    return { error: `${label} must be a number` };
  }
  if (desc.type === "integer" && !Number.isInteger(n)) return { error: `${label} must be a whole number` };
  if (desc.min !== undefined && n < desc.min) return { error: `${label} must be at least ${fmt(desc, desc.min)}` };
  if (desc.max !== undefined && n > desc.max) return { error: `${label} must be at most ${fmt(desc, desc.max)}` };
  return { value: n };
}

function fmt(desc, n) {
  if (desc.type === "percent") return `${Math.round(n * 100)} %`;
  return desc.unit ? `${n} ${desc.unit}` : String(n);
}

function checkTable(desc, value) {
  if (desc.shape === "map") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { error: `${desc.label} must be a table of numbers` };
    const out = {};
    const rows = desc.rows && desc.rows.length ? desc.rows.map((r) => r.key) : Object.keys(desc.default || {});
    for (const k of Object.keys(value)) {
      if (!rows.includes(k)) return { error: `${desc.label}: unknown row "${k}"` };
    }
    for (const k of rows) {
      const v = value[k] !== undefined ? value[k] : (desc.default || {})[k];
      const res = checkScalar(desc, v, `${desc.label} › ${k}`);
      if (res.error) return res;
      out[k] = res.value;
    }
    return { value: out };
  }
  // rows
  if (!Array.isArray(value)) return { error: `${desc.label} must be a list of rows` };
  if (desc.minRows && value.length < desc.minRows) return { error: `${desc.label} needs at least ${desc.minRows} row(s)` };
  if (desc.maxRows && value.length > desc.maxRows) return { error: `${desc.label} can have at most ${desc.maxRows} rows` };
  const out = [];
  for (let i = 0; i < value.length; i++) {
    const row = value[i];
    if (!row || typeof row !== "object") return { error: `${desc.label} row ${i + 1} is not a row` };
    const cleaned = {};
    for (const col of desc.columns || []) {
      const res = checkScalar(col, row[col.key], `${desc.label} row ${i + 1} › ${col.label}`);
      if (res.error) return res;
      cleaned[col.key] = res.value;
    }
    out.push(cleaned);
  }
  if (desc.sortBy) {
    for (let i = 1; i < out.length; i++) {
      if (out[i][desc.sortBy] <= out[i - 1][desc.sortBy]) {
        return { error: `${desc.label}: rows must go up in "${desc.sortBy}" (row ${i + 1})` };
      }
    }
  }
  return { value: out };
}

/**
 * Validate a candidate rules object against the schema.
 * @param {Object} candidate — keys to check
 * @param {Object} [opts]
 * @param {boolean} [opts.partial=true] — when false, every schema key must be present
 * @returns {{ ok: boolean, errors: Array<{key:string,message:string}>, values: Object }}
 */
function validateRules(candidate, { partial = true } = {}) {
  const errors = [];
  const values = {};
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { ok: false, errors: [{ key: "", message: "Rules must be an object" }], values };
  }
  const known = new Set(schemaKeys());
  for (const key of Object.keys(candidate)) {
    if (!known.has(key)) errors.push({ key, message: `Unknown rule "${key}"` });
  }
  for (const desc of RULE_SCHEMA) {
    if (!(desc.key in candidate)) {
      if (!partial) errors.push({ key: desc.key, message: `${desc.label} is missing` });
      continue;
    }
    const res = desc.type === "table" ? checkTable(desc, candidate[desc.key]) : checkScalar(desc, candidate[desc.key], desc.label);
    if (res.error) errors.push({ key: desc.key, message: res.error });
    else values[desc.key] = res.value;
  }
  return { ok: errors.length === 0, errors, values };
}

module.exports = { RULE_SCHEMA, RULE_GROUPS, schemaDefaults, schemaKeys, getDescriptor, validateRules };
