/**
 * Pricing rule schema — the rate card.
 *
 * Every pricing knob the engine reads is declared here once, with a group, a
 * plain-language label and help line, a unit, a type and a safe range. The
 * admin UI renders the pricing page from this list generically; the API uses
 * it to validate and clamp saves; `loadPricingRules()` uses it to merge stored
 * values over the defaults so a database from an older version always has a
 * complete rule set.
 *
 * Storage shape is unchanged: `pricingDB` holds one row `{ rules: { key: value } }`.
 * Keys that still mean the same thing as before (marginPercent, volumeDiscounts,
 * minimumPartPrice, the router feed table, …) keep their old names so tuned
 * values carry over; keys for models that no longer exist are simply ignored.
 *
 * Rule record:
 *   { key, group, label, help, unit, type: "number"|"percent"|"currency"|"table",
 *     min, max, default, tableSpec? }
 * `tableSpec` describes a table rule for the UI:
 *   { kind: "map", keys: [...], valueType, unit, min, max }   — fixed-key lookup
 *   { kind: "rows", columns: [{ key, label, type, min, max }] } — list of rows
 *
 * Everything here is plain JSON-serializable data.
 */

const GROUPS = [
  { id: "shop", label: "Shop", help: "Hourly rates, margin, price floors, rush and shipping — the numbers every quote starts from." },
  { id: "materials", label: "Materials", help: "Stock buying rules. Per-material prices, machinability and stock forms live on the Materials page; these are the shared rules." },
  { id: "cnc", label: "CNC Machining", help: "How long milling takes on the Tormach PCNC 1100: setups, roughing, finishing, holes, pockets, walls, inspection." },
  { id: "turning", label: "Turning", help: "How long lathe work takes: chuck, face, turn, drill, bore, part off." },
  { id: "routing", label: "Routing", help: "How long sheet parts take on the Techno 59\" × 96\" router: feeds, passes, pockets, tabs, nesting." },
  { id: "printing", label: "Printing", help: "FDM, SLA and SLS printer rates, speeds and post-processing." },
  { id: "discounts", label: "Discounts", help: "Quantity breaks and multi-part order savings." },
  { id: "gate", label: "Gate", help: "When a quote goes to a person instead of straight to checkout." },
  { id: "sheetmetal", label: "Sheet Metal (inactive)", help: "Kept for the inactive sheet-metal process; nothing on the live site reads these." },
];

const MATERIAL_CLASSES = ["plastic", "aluminum", "brass", "steel", "composite"];
const FEED_CLASSES = ["soft", "medium", "brittle", "abrasive", "aluminum"];
const DRILL_BANDS = ["upTo3", "upTo10", "upTo20", "over20"];

const num = (key, group, label, help, unit, def, min, max, extra = {}) =>
  ({ key, group, label, help, unit, type: "number", min, max, default: def, ...extra });
const money = (key, group, label, help, unit, def, min, max) =>
  ({ key, group, label, help, unit, type: "currency", min, max, default: def });
const pct = (key, group, label, help, def, min, max) =>
  ({ key, group, label, help, unit: "%", type: "percent", min, max, default: def });
const map = (key, group, label, help, unit, keys, def, min, max) =>
  ({ key, group, label, help, unit, type: "table", min, max, default: def, tableSpec: { kind: "map", keys, valueType: "number", unit, min, max } });

const RULES = [
  // ─── Shop ──────────────────────────────────────────────────────────────────
  money("cncMachineRatePerHour", "shop", "Mill rate", "What an hour on the Tormach costs the customer, machine running or being set up.", "$/h", 95, 20, 500),
  money("latheRatePerHour", "shop", "Lathe rate", "What an hour on the manual lathe costs the customer.", "$/h", 85, 20, 500),
  money("routerMachineRatePerHour", "shop", "Router rate", "What an hour on the Techno router costs the customer.", "$/h", 95, 20, 500),
  money("laborRatePerHour", "shop", "Hand-work rate", "Rate for work done away from a machine: hand tapping, deburring, inspection, print post-processing.", "$/h", 65, 10, 300),
  pct("marginPercent", "shop", "Margin", "Share of the final price that is profit; 0.30 means cost is 70% of the price.", 0.30, 0, 0.9),
  money("minimumPartPrice", "shop", "Minimum CNC part price", "No machined part ever sells for less than this per piece.", "$", 5, 0, 1000),
  money("routerMinimumPartPrice", "shop", "Minimum routed part price", "No routed part ever sells for less than this per piece.", "$", 6, 0, 1000),
  money("fdmMinimumPartPrice", "shop", "Minimum FDM part price", "Floor per FDM piece; covers removing it from the bed and checking it.", "$", 8, 0, 1000),
  money("slaMinimumPartPrice", "shop", "Minimum SLA part price", "Floor per SLA piece; covers wash and cure handling.", "$", 12, 0, 1000),
  money("slsMinimumPartPrice", "shop", "Minimum SLS part price", "Floor per SLS piece; covers depowdering and blasting.", "$", 15, 0, 1000),
  money("minimumOrderTotal", "shop", "Minimum order", "Smallest order the shop will take, after shipping.", "$", 25, 0, 5000),
  map("rushMultipliers", "shop", "Rush multipliers", "Price multiplier per lead-time option; 1.35 means 35% more for expedited.", "×",
    ["standard", "expedited", "rush", "same-day"], { standard: 1.0, expedited: 1.35, rush: 1.85, "same-day": 2.5 }, 1, 5),
  money("shippingBaseRate", "shop", "Shipping base", "Flat shipping charge per order before weight.", "$", 12, 0, 500),
  money("shippingPerKg", "shop", "Shipping per kg", "Added to shipping for every kilogram of parts.", "$/kg", 2.5, 0, 100),

  // ─── Materials (shared stock rules; per-material fields are on the Materials page) ──
  num("stockPaddingMm", "materials", "Stock padding", "Extra material on each side of the part when the blank is sawn from bar or plate.", "mm", 3.0, 0, 25),
  num("plateThicknessMatchMm", "materials", "Plate match tolerance", "If a flat part is within this of a standard plate thickness it is bought at that thickness and the faces are not machined.", "mm", 0.6, 0, 5),
  pct("materialDefaultWasteFactor", "materials", "Default waste factor", "Extra stock paid for (saw kerf, drops, ends) when the material record has no waste factor of its own.", 0.15, 0, 2),
  { key: "standardPlateThicknessesMm", group: "materials", label: "Standard plate thicknesses", help: "Plate sizes the shop can buy; flat parts are costed from the nearest one at or above their thickness.", unit: "mm", type: "table", min: 0.1, max: 200,
    default: [1.6, 3.2, 4.8, 6.35, 9.5, 12.7, 15.9, 19.05, 25.4, 31.75, 38.1, 50.8, 63.5, 76.2], tableSpec: { kind: "rows", columns: [{ key: "value", label: "Thickness (mm)", type: "number", min: 0.1, max: 200 }] } },
  { key: "standardBarDiametersMm", group: "materials", label: "Standard bar diameters", help: "Round bar sizes the shop can buy; turned parts are costed from the nearest one above the finished diameter.", unit: "mm", type: "table", min: 0.1, max: 400,
    default: [6.35, 9.5, 12.7, 15.9, 19.05, 22.2, 25.4, 28.6, 31.75, 38.1, 41.3, 44.45, 50.8, 57.15, 63.5, 69.85, 76.2, 88.9, 101.6, 127, 152.4], tableSpec: { kind: "rows", columns: [{ key: "value", label: "Diameter (mm)", type: "number", min: 0.1, max: 400 }] } },

  // ─── CNC Machining (Tormach PCNC 1100, 3-axis, 10-pocket ATC, no rigid tapping) ──
  num("cncSetupMinutesFirst", "cnc", "First setup", "Minutes to program, fixture and first-article the first setup of a job; charged once per order line.", "min", 28, 0, 480),
  num("cncSetupMinutesAdditional", "cnc", "Each extra setup", "Minutes for every additional setup (flip, second side); charged once per order line.", "min", 15, 0, 480),
  num("cnc4thAxisSetupMinutes", "cnc", "4th-axis setup", "Extra minutes to mount the 4th axis when a part needs more than two setups and fits the trunnion.", "min", 20, 0, 480),
  num("cnc4thAxisMaxDiameterMm", "cnc", "4th-axis max swing", "Largest part that fits the 4th axis; bigger parts stay multi-setup.", "mm", 150, 0, 1000),
  num("cnc4thAxisMaxLengthMm", "cnc", "4th-axis max length", "Longest part that fits between the 4th axis and tailstock.", "mm", 300, 0, 2000),
  num("cncMaxTravelXMm", "cnc", "Mill X travel", "Parts longer than this need indexed setups (one extra setup per travel length).", "mm", 457, 50, 5000),
  num("cncHandlingMinutesPerSetup", "cnc", "Load/unload per setup", "Minutes per part per setup to load, clamp, unload, brush off and break sharp edges.", "min", 2.0, 0, 60),
  num("cncSawMinutesPerPart", "cnc", "Saw blank", "Minutes per part to saw the blank from bar or plate.", "min", 1.0, 0, 60),
  num("cncToolChangeMinutes", "cnc", "Tool change", "Minutes per tool change per part (ATC swap plus approach).", "min", 0.25, 0, 10),
  map("cncRoughingMrrCm3PerMin", "cnc", "Roughing removal rate", "Cubic centimetres per minute an adaptive roughing pass removes at machinability 1.0; scaled by each material's machinability.", "cm³/min",
    MATERIAL_CLASSES, { plastic: 13, aluminum: 8, brass: 10, steel: 3, composite: 7 }, 0.1, 500),
  num("cncFacingMrrCm3PerMin", "cnc", "Facing removal rate", "Cubic centimetres per minute a face mill skims off the outside of the blank at machinability 1.0.", "cm³/min", 35, 0.1, 1000),
  map("cncFinishCm2PerMin", "cnc", "Finishing rate", "Square centimetres of surface finished per minute at machinability 1.0: prismatic = walls and floors with an endmill, freeform = 3D scallop passes.", "cm²/min",
    ["prismatic", "freeform"], { prismatic: 45, freeform: 10 }, 0.1, 1000),
  map("cncDrillMmPerMin", "cnc", "Drill feed", "Millimetres per minute a drill advances, by diameter band, at machinability 1.0.", "mm/min",
    DRILL_BANDS, { upTo3: 150, upTo10: 300, upTo20: 250, over20: 120 }, 1, 5000),
  num("cncDrillApproachMinutes", "cnc", "Per-hole approach", "Minutes per hole for positioning, spot drill, plunge and retract (the depth-based feed time is added on top).", "min", 0.2, 0, 5),
  num("cncPeckDepthRatio", "cnc", "Peck threshold", "Holes deeper than this many diameters are peck-drilled.", "×dia", 3, 1, 20),
  num("cncPeckPenaltyPerDia", "cnc", "Peck penalty", "Extra time fraction for every diameter of depth beyond the peck threshold.", "×", 0.25, 0, 2),
  num("cncHelicalBoreMinDiaMm", "cnc", "Largest drill", "Holes bigger than this are helically bored with an endmill instead of drilled.", "mm", 13, 1, 100),
  num("cncTapMinutesPerHole", "cnc", "Hand tap", "Minutes per tapped hole; the Tormach has no rigid tapping so threads are tapped by hand.", "min", 1.0, 0, 20),
  num("cncCounterboreMinutes", "cnc", "Counterbore / countersink", "Extra minutes per counterbored or countersunk hole.", "min", 0.3, 0, 10),
  num("cncPocketCornerRefRadiusMm", "cnc", "Reference corner radius", "Pocket corners at or above this radius take the standard 3/8\" endmill; smaller corners force a smaller, slower tool.", "mm", 4.8, 0.5, 25),
  num("cncPocketCornerPenaltyExponent", "cnc", "Small-corner penalty", "How hard small corners slow the pocket: time scales by (reference ÷ corner radius) to this power.", "", 1.0, 0, 3),
  num("cncPocketDeepRatio", "cnc", "Deep-pocket threshold", "Pockets deeper than this many times their width get the deep-pocket penalty.", "×width", 3, 1, 20),
  num("cncPocketDeepPenalty", "cnc", "Deep-pocket penalty", "Extra time fraction on deep pockets (long tools, lighter cuts).", "×", 0.5, 0, 5),
  num("cncThinWallMm", "cnc", "Thin wall", "Walls thinner than this get the thin-wall penalty (light passes, chatter risk).", "mm", 2.0, 0, 20),
  num("cncThinWallPenalty", "cnc", "Thin-wall penalty", "Extra time fraction on finishing and feature roughing for thin-walled parts.", "×", 0.4, 0, 5),
  num("cncTallWallAspect", "cnc", "Tall wall", "Walls taller than this many times their thickness get the tall-wall penalty.", "×", 8, 1, 50),
  num("cncTallWallPenalty", "cnc", "Tall-wall penalty", "Extra time fraction on finishing for tall thin walls.", "×", 0.3, 0, 5),
  num("cncMillFeedMmPerMin", "cnc", "Profile feed", "Millimetres per minute for profiling a flat part's outline at machinability 1.0 (3/8\" 2-flute at 5,140 RPM).", "mm/min", 1000, 10, 10000),
  num("cncMillDocMm", "cnc", "Profile depth per pass", "Depth of cut per profile pass through plate (3/8\" endmill, 1×Ø).", "mm", 9.6, 0.5, 50),
  num("cncInspectionMinutesPerPart", "cnc", "Inspect per part", "Minutes per part for in-process checks and final inspection.", "min", 0.5, 0, 30),
  num("cncInspectionMinutesPerLot", "cnc", "Inspect per lot", "Minutes per order line for first-article inspection and paperwork.", "min", 3, 0, 120),
  pct("cncLegacyFeatureAllowance", "cnc", "Unknown-feature allowance", "Extra machine time on blocks priced without a feature list (holes, pockets and threads the old parser cannot see); 0.30 = 30% more.", 0.30, 0, 2),
  num("cncMinMinutesPerCm2", "cnc", "Surface-area minimum", "Machine time per part is never less than load/unload plus this many minutes per cm² of machined surface — a floor that scales with the part instead of a flat 15 minutes.", "min/cm²", 0.01, 0, 1),
  money("cncToolingPerMachineHour", "cnc", "Tooling wear", "Dollars of cutter wear per machine hour at machinability 1.0; abrasive materials cost more via their machinability.", "$/h", 6, 0, 200),

  // ─── Turning (manual lathe with stops) ────────────────────────────────────
  num("latheSetupMinutes", "turning", "Lathe setup", "Minutes to set tooling and stops for a batch; charged once per order line.", "min", 15, 0, 240),
  num("latheLoadMinutesPerPart", "turning", "Load per part", "Minutes per piece to chuck or collet the stock.", "min", 0.4, 0, 30),
  num("latheToolChangeMinutes", "turning", "Operation change", "Minutes per operation on the manual lathe to swap tool, drill or boring bar (quick-change post).", "min", 0.25, 0, 10),
  num("latheFlipMinutes", "turning", "Flip", "Minutes to flip a piece for second-end work.", "min", 0.5, 0, 30),
  num("latheFaceMinutes", "turning", "Face an end", "Minutes per faced end.", "min", 0.4, 0, 30),
  num("latheChamferMinutes", "turning", "Chamfer an edge", "Minutes per chamfered edge (outside or bore) on a small part.", "min", 0.1, 0, 30),
  num("latheChamferMinutesPer10mmDia", "turning", "Chamfer per diameter", "Extra minutes per chamfered edge for every 10 mm of diameter.", "min/10mm", 0.05, 0, 5),
  num("lathePartOffMmPerMin", "turning", "Part-off speed", "Millimetres of diameter parted off per minute.", "mm/min", 30, 1, 500),
  map("latheFeedMmPerMin", "turning", "Turning feed", "Millimetres per minute the tool travels along the part for OD and boring passes, by material class.", "mm/min",
    MATERIAL_CLASSES, { plastic: 180, aluminum: 150, brass: 180, steel: 60, composite: 120 }, 1, 5000),
  map("latheDocMm", "turning", "Depth of cut", "Radial depth per turning pass, by material class.", "mm",
    MATERIAL_CLASSES, { plastic: 2.0, aluminum: 1.5, brass: 1.5, steel: 1.0, composite: 1.5 }, 0.05, 20),
  map("latheDrillMmPerMin", "turning", "Lathe drill feed", "Millimetres per minute for tailstock drilling, by diameter band.", "mm/min",
    ["upTo6", "upTo13", "upTo25", "over25"], { upTo6: 120, upTo13: 100, upTo25: 70, over25: 40 }, 1, 5000),
  num("latheMaxDrillMm", "turning", "Largest lathe drill", "Bores bigger than this are drilled to this size then bored.", "mm", 25, 1, 100),
  num("latheBarPaddingMm", "turning", "Bar padding", "Radial allowance before rounding up to a standard bar size.", "mm", 1.0, 0, 20),
  num("latheBarEndAllowanceMm", "turning", "Bar per piece", "Extra bar length per piece for parting and facing.", "mm", 4, 0, 50),
  num("lathePartOffMaxLengthMm", "turning", "Part-off max length", "Pieces shorter than this are parted off the bar; longer ones are sawn blanks.", "mm", 100, 0, 1000),
  num("latheNoFlipMaxLengthMm", "turning", "No-flip length", "Parted-off pieces shorter than this are hand-deburred on the parted end instead of being flipped and chamfered.", "mm", 12, 0, 500),
  num("latheInspectionMinutesPerPart", "turning", "Inspect per part", "Minutes per piece to check diameters.", "min", 0.3, 0, 30),
  money("latheToolingPerMachineHour", "turning", "Lathe tooling wear", "Dollars of insert and drill wear per lathe hour.", "$/h", 3, 0, 200),

  // ─── Routing (Techno RG 5996, 18–24k RPM, ATC) ───────────────────────────
  num("routerSetupMinutes", "routing", "Router setup", "Minutes to nest, CAM, load the first sheet and prove the first part; charged once per order line.", "min", 20, 0, 240),
  num("routerSheetHandlingMinutes", "routing", "Per sheet", "Minutes per sheet to load, screw down, unload and clean; shared by every part on the sheet.", "min", 6, 0, 120),
  num("routerToolChangeSeconds", "routing", "Tool change", "Seconds per ATC change; happens once per tool per sheet.", "s", 12, 0, 300),
  num("routerToolsPerJob", "routing", "Tools per job", "Typical number of tools a routed part needs (profile cutter plus a drill or pocket tool).", "", 2, 1, 12),
  map("routerFeedMmPerMin", "routing", "Cut feed", "Millimetres per minute for the 1/4\" cutter by material class, from chip load × flutes × 18,000 RPM.", "mm/min",
    FEED_CLASSES, { soft: 2700, medium: 2700, brittle: 1800, abrasive: 1500, aluminum: 1800 }, 10, 20000),
  num("routerThickToolFeedFactor", "routing", "3/8\" tool feed factor", "Feed multiplier when stock over 1/4\" is cut with a 3/8\" cutter.", "×", 1.25, 0.1, 3),
  num("routerSmallToolFeedFactor", "routing", "1/8\" tool feed factor", "Feed multiplier when internal corners under 1/8\" radius force a 1/8\" cutter.", "×", 0.55, 0.05, 1),
  num("routerSmallToolRadiusMm", "routing", "Small-tool corner radius", "Internal corners smaller than this radius need the 1/8\" cutter.", "mm", 3.2, 0.5, 10),
  map("routerMaxDocMm", "routing", "Depth per pass", "Maximum depth of cut per pass for each cutter; plastics run 1×Ø, aluminum stays shallow.", "mm",
    ["eighth", "quarter", "threeEighths", "aluminum"], { eighth: 3.2, quarter: 6.5, threeEighths: 9.6, aluminum: 2.0 }, 0.1, 50),
  map("routerPocketCm3PerMin", "routing", "Pocket removal rate", "Cubic centimetres per minute cleared from a pocket, by material class.", "cm³/min",
    FEED_CLASSES, { soft: 30, medium: 25, brittle: 18, abrasive: 12, aluminum: 5 }, 0.1, 500),
  num("routerHoleSeconds", "routing", "Per plunge", "Seconds per hole or inner contour for the plunge and lead-in.", "s", 4, 0, 60),
  num("routerTabMinutesPerPart", "routing", "De-tab per part", "Minutes per part to snap tabs and clean the edge.", "min", 0.4, 0, 30),
  num("routerHandlingMinutesPerPart", "routing", "Handle per part", "Minutes per part to unload, inspect and pack.", "min", 0.3, 0, 30),
  num("routerKerfMarginMm", "routing", "Kerf margin", "Material between nested parts (cutter diameter plus onion-skin), each side.", "mm", 6, 0, 50),
  pct("routerNestYield", "routing", "Nest yield", "Fraction of a sheet that becomes parts; the rest is paid for as waste.", 0.85, 0.1, 1),
  num("routerSheetWMm", "routing", "Sheet width", "Width of the stock sheet the nest is laid on.", "mm", 1219, 100, 3000),
  num("routerSheetHMm", "routing", "Sheet length", "Length of the stock sheet the nest is laid on.", "mm", 2438, 100, 4000),
  money("routerToolWearPerMeter", "routing", "Cutter wear", "Dollars of cutter wear per metre cut in plastics.", "$/m", 0.35, 0, 50),
  num("routerAbrasiveWearFactor", "routing", "Abrasive wear factor", "Cutter wear multiplier for G-10 and phenolic.", "×", 3, 1, 20),
  num("routerAluminumWearFactor", "routing", "Aluminum wear factor", "Cutter wear multiplier for aluminum plate.", "×", 1.5, 1, 20),

  // ─── Printing ─────────────────────────────────────────────────────────────
  num("printSetupMinutes", "printing", "Print setup", "Minutes to slice, load and start a job; charged once per order line at the hand-work rate.", "min", 5, 0, 120),
  money("fdmMachineRatePerHour", "printing", "FDM printer rate", "Cost per hour of FDM printer time.", "$/h", 4, 0, 200),
  num("fdmDepositionMm3PerSec", "printing", "FDM wall deposition", "Cubic millimetres per second laid down on walls and solid layers (speed × line width × layer height, with accelerations).", "mm³/s", 3.5, 0.1, 100),
  num("fdmInfillDepositionMm3PerSec", "printing", "FDM infill deposition", "Cubic millimetres per second laid down as sparse infill.", "mm³/s", 8, 0.1, 100),
  num("fdmShellThicknessMm", "printing", "FDM shell", "Solid skin thickness (perimeters plus top/bottom) assumed around the part.", "mm", 1.2, 0.2, 10),
  pct("fdmInfillPercent", "printing", "FDM default infill", "Infill density when the customer does not choose one.", 0.20, 0.05, 1),
  num("fdmLayerOverheadSec", "printing", "FDM per-layer overhead", "Seconds per layer for travel moves, retracts and layer change.", "s", 2, 0, 60),
  pct("fdmSupportDensity", "printing", "FDM support density", "Support material volume as a fraction of the overhang volume it holds up.", 0.15, 0, 1),
  num("fdmPostProcessMinutesBase", "printing", "FDM post-process", "Minutes per part to remove from the bed, pull supports and check.", "min", 2, 0, 60),
  num("fdmPostProcessMinutesPer100Cm2", "printing", "FDM post-process per area", "Extra minutes per 100 cm² of part surface for support removal and cleanup.", "min/100cm²", 1.0, 0, 30),
  money("slaMachineRatePerHour", "printing", "SLA printer rate", "Cost per hour of SLA printer time.", "$/h", 15, 0, 200),
  num("slaLayerTimeSec", "printing", "SLA per layer", "Seconds per layer for exposure and peel regardless of area.", "s", 7, 0, 120),
  num("slaScanTimeSecPerCm2", "printing", "SLA per area", "Seconds per square centimetre of mean cross-section per layer.", "s/cm²", 0.3, 0, 20),
  pct("slaSupportMaterialRatio", "printing", "SLA support ratio", "Resin used for supports as a fraction of part volume.", 0.10, 0, 1),
  num("slaPostProcessMinutes", "printing", "SLA post-process", "Minutes per part to wash, cure and remove supports.", "min", 12, 0, 120),
  money("slsMachineRatePerHour", "printing", "SLS printer rate", "Cost per hour of SLS printer time (shared across a packed build).", "$/h", 35, 0, 500),
  num("slsLayerTimeSec", "printing", "SLS per layer", "Seconds per layer for recoat and sweep.", "s", 12, 0, 120),
  num("slsScanTimeSecPerCm2", "printing", "SLS per area", "Seconds per square centimetre of mean cross-section per layer.", "s/cm²", 2.0, 0, 20),
  pct("slsPackingEfficiency", "printing", "SLS packing", "Fraction of the build volume that is parts; the rest is loose powder.", 0.08, 0.01, 1),
  pct("slsPowderReuseRatio", "printing", "SLS powder reuse", "Fraction of un-fused powder recycled into the next build.", 0.5, 0, 0.95),
  num("slsPostProcessMinutes", "printing", "SLS post-process", "Minutes per part to depowder and bead blast.", "min", 8, 0, 120),

  // ─── Discounts ────────────────────────────────────────────────────────────
  { key: "volumeDiscounts", group: "discounts", label: "Quantity breaks", help: "Discount on the per-unit base at each quantity tier (0.10 = 10% off from that quantity up).", unit: "", type: "table", min: 0, max: 0.9,
    default: [
      { minQty: 1, discount: 0 }, { minQty: 5, discount: 0.05 }, { minQty: 10, discount: 0.10 }, { minQty: 25, discount: 0.15 },
      { minQty: 50, discount: 0.22 }, { minQty: 100, discount: 0.28 }, { minQty: 250, discount: 0.33 }, { minQty: 500, discount: 0.38 }, { minQty: 1000, discount: 0.42 },
    ],
    tableSpec: { kind: "rows", columns: [{ key: "minQty", label: "From quantity", type: "number", min: 1, max: 1000000 }, { key: "discount", label: "Discount", type: "percent", min: 0, max: 0.9 }] } },
  pct("nestingEfficiencyBonus", "discounts", "Multi-part savings", "Share of each part's material cost given back when an order has more than one part (shared sheets and setups).", 0.12, 0, 0.9),

  // ─── Gate ─────────────────────────────────────────────────────────────────
  num("rfqQuantityThreshold", "gate", "Instant-order quantity limit", "Quantities above this always go to a person for a quote.", "pcs", 100, 1, 100000),
  money("bigTicketLineTotal", "gate", "Big-ticket line", "A single line over this amount is confirmed by hand before payment.", "$", 5000, 0, 1000000),
  pct("lowVolumeRatio", "gate", "Hollow-part flag", "CNC parts using less than this fraction of their stock envelope are reviewed (multi-setup or 4th-axis jobs).", 0.12, 0, 1),
  num("gateReviewOnLegacyFeatures", "gate", "Review blocks without features", "Set to 1 to send machined blocks priced without a feature list (legacy geometry only) to a person; flat and turned parts price well without one.", "0/1", 1, 0, 1),
  num("gateReviewThinWallMm", "gate", "Thin-wall review", "CNC parts with walls thinner than this go to review.", "mm", 1.0, 0, 20),

  // ─── Sheet metal (inactive process) ───────────────────────────────────────
  money("laserCutRatePerMm", "sheetmetal", "Laser cut rate", "Dollars per millimetre of laser cut at 1 mm thickness.", "$/mm", 0.0035, 0, 10),
  num("laserThicknessExponent", "sheetmetal", "Laser thickness exponent", "How fast cut cost grows with thickness.", "", 1.6, 0, 5),
  money("bendBaseCost", "sheetmetal", "Bend cost", "Dollars per bend at 1 mm thickness.", "$", 2.5, 0, 100),
  num("bendThicknessMultiplier", "sheetmetal", "Bend thickness multiplier", "How fast bend cost grows with thickness.", "", 3.0, 0, 20),
  money("holeBaseCost", "sheetmetal", "Hole cost", "Dollars per punched hole.", "$", 0.35, 0, 50),
  money("tapCost", "sheetmetal", "Tap cost", "Dollars per tapped hole.", "$", 1.2, 0, 50),
  money("countersinkCost", "sheetmetal", "Countersink cost", "Dollars per countersink.", "$", 0.8, 0, 50),
];

/**
 * Per-material fields the admin Materials page exposes the same way. These
 * live on each material record (materialsDB), not in the rules blob.
 */
const MATERIAL_FIELD_SCHEMA = [
  { key: "pricePerKg", label: "Stock price", help: "Landed cost of the stock per kilogram (rod, plate or sheet).", unit: "$/kg", type: "currency", min: 0, max: 10000, processes: ["cnc", "routing", "sheetmetal"] },
  { key: "pricePerCm3", label: "Material price", help: "Cost per cubic centimetre of printed material including supports.", unit: "$/cm³", type: "currency", min: 0, max: 100, processes: ["3d-printing"] },
  { key: "machinability", label: "Machinability", help: "How fast this cuts relative to 6061 aluminum (1.0); Delrin 1.3 roughs 30% faster.", unit: "×", type: "number", min: 0.05, max: 5, processes: ["cnc"] },
  { key: "materialClass", label: "Material class", help: "Which rate-card column applies: plastic, aluminum, brass, steel or composite.", unit: "", type: "enum", options: MATERIAL_CLASSES, processes: ["cnc", "routing"] },
  { key: "feedClass", label: "Router feed class", help: "Which router feed and pocket rate applies: soft, medium, brittle, abrasive or aluminum.", unit: "", type: "enum", options: FEED_CLASSES, processes: ["routing"] },
  { key: "stockForms", label: "Stock forms", help: "Forms this material is bought in (plate, rod, sheet); turning needs rod, flat parts prefer plate.", unit: "", type: "list", options: ["plate", "rod", "sheet", "block"], processes: ["cnc", "routing"] },
  { key: "wasteFactor", label: "Waste factor", help: "Extra stock paid for beyond the blank (kerf, drops, ends); overrides the shared default.", unit: "%", type: "percent", min: 0, max: 2, processes: ["cnc", "routing"] },
  { key: "density", label: "Density", help: "Grams per cubic centimetre for printed materials (CNC grades carry lb/in³ on each grade).", unit: "g/cm³", type: "number", min: 0.1, max: 25, processes: ["3d-printing"] },
];

// ─── helpers ────────────────────────────────────────────────────────────────

const RULE_BY_KEY = Object.fromEntries(RULES.map((r) => [r.key, r]));

function deepClone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** Fresh copy of every rule's default value, keyed by rule key. */
function defaultRules() {
  const out = {};
  for (const r of RULES) out[r.key] = deepClone(r.default);
  return out;
}

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

/**
 * Validate and clamp one value against its rule. Returns { ok, value, error }.
 * Scalars: finite number clamped to [min, max]. Map tables: every known key
 * clamped, unknown keys dropped, missing keys filled from the default. Row
 * tables: each row validated per column; a row missing a column is rejected.
 */
function sanitizeValue(rule, raw) {
  if (!rule) return { ok: false, error: "unknown rule" };
  if (rule.type !== "table") {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, error: `${rule.key} must be a number` };
    return { ok: true, value: clamp(n, rule.min, rule.max) };
  }
  const spec = rule.tableSpec || {};
  if (spec.kind === "map") {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: `${rule.key} must be an object` };
    const value = {};
    for (const k of spec.keys) {
      const n = Number(raw[k] !== undefined ? raw[k] : rule.default[k]);
      if (!Number.isFinite(n)) return { ok: false, error: `${rule.key}.${k} must be a number` };
      value[k] = clamp(n, spec.min, spec.max);
    }
    return { ok: true, value };
  }
  if (spec.kind === "rows") {
    if (!Array.isArray(raw)) return { ok: false, error: `${rule.key} must be a list` };
    const cols = spec.columns;
    const value = [];
    for (const row of raw) {
      if (cols.length === 1 && cols[0].key === "value") {
        const n = Number(row && typeof row === "object" ? row.value : row);
        if (!Number.isFinite(n)) return { ok: false, error: `${rule.key} entries must be numbers` };
        value.push(clamp(n, cols[0].min, cols[0].max));
        continue;
      }
      if (!row || typeof row !== "object") return { ok: false, error: `${rule.key} rows must be objects` };
      const clean = {};
      for (const c of cols) {
        const n = Number(row[c.key]);
        if (!Number.isFinite(n)) return { ok: false, error: `${rule.key}.${c.key} must be a number` };
        clean[c.key] = clamp(n, c.min, c.max);
      }
      value.push(clean);
    }
    if (rule.key === "volumeDiscounts") value.sort((a, b) => a.minQty - b.minQty);
    return { ok: true, value };
  }
  return { ok: false, error: `${rule.key} has no table spec` };
}

/**
 * Sanitize a partial rule object (an admin save). Unknown keys are dropped.
 * Returns { rules, errors } — `rules` holds only the valid, clamped values.
 */
function sanitizeRules(partial = {}) {
  const rules = {};
  const errors = [];
  for (const [k, v] of Object.entries(partial || {})) {
    const rule = RULE_BY_KEY[k];
    if (!rule) continue;
    const r = sanitizeValue(rule, v);
    if (r.ok) rules[k] = r.value; else errors.push(r.error);
  }
  return { rules, errors };
}

/**
 * Schema defaults with stored values laid over them. Invalid stored values
 * fall back to the default; unknown keys are kept out of the engine except
 * `seedVersion`, which the seeder uses.
 */
function mergeRules(stored = {}) {
  const out = defaultRules();
  const src = stored && typeof stored === "object" ? stored : {};
  for (const [k, v] of Object.entries(src)) {
    const rule = RULE_BY_KEY[k];
    if (!rule) continue;
    const r = sanitizeValue(rule, v);
    if (r.ok) out[k] = r.value;
  }
  if (src.seedVersion !== undefined) out.seedVersion = src.seedVersion;
  return out;
}

/** The schema as the admin UI consumes it: groups with their rules in order. */
function describeSchema() {
  return {
    groups: GROUPS.map((g) => ({ ...g, rules: RULES.filter((r) => r.group === g.id).map((r) => deepClone(r)) })),
    materialFields: deepClone(MATERIAL_FIELD_SCHEMA),
  };
}


// ═══════════════════════════════════════════════════════════════
// Admin-console view of the schema (services/pricingAdmin.js,
// services/calibration.js and the Pricing console render from this).
// Same rules, decorated with the UI hints the console expects:
//   shape/rows/columns for tables, step, `simple` (shown in the Simple view),
//   `calibration` (which knob the Calibration tab nudges per process).
// ═══════════════════════════════════════════════════════════════
const SIMPLE_KEYS = new Set([
  "cncMachineRatePerHour", "latheRatePerHour", "routerMachineRatePerHour", "laborRatePerHour",
  "marginPercent", "minimumPartPrice", "routerMinimumPartPrice", "minimumOrderTotal",
  "cncSetupMinutesFirst", "routerSetupMinutes", "fdmMachineRatePerHour",
  "rfqQuantityThreshold", "bigTicketLineTotal",
]);

// role: "rate" = time per unit of work (inverse: higher rate → less time);
//       "floor" = a minimum that small parts sit on; "cost" = $/h.
const CALIBRATION = {
  cncRoughingMrrCm3PerMin: { process: "cnc", subProcess: "milling", relation: "inverse", role: "rate" },
  cncMinMinutesPerCm2:     { process: "cnc", subProcess: "milling", relation: "direct",  role: "floor" },
  cncMachineRatePerHour:   { process: "cnc", relation: "direct", role: "cost" },
  latheFeedMmPerMin:       { process: "cnc", subProcess: "turning", relation: "inverse", role: "rate" },
  latheRatePerHour:        { process: "cnc", subProcess: "turning", relation: "direct", role: "cost" },
  routerFeedMmPerMin:      { process: "routing", relation: "inverse", role: "rate" },
  routerMachineRatePerHour:{ process: "routing", relation: "direct", role: "cost" },
  fdmDepositionMm3PerSec:  { process: "3d-printing", subProcess: "fdm", relation: "inverse", role: "rate" },
  fdmMachineRatePerHour:   { process: "3d-printing", subProcess: "fdm", relation: "direct", role: "cost" },
  slaLayerTimeSec:         { process: "3d-printing", subProcess: "sla", relation: "direct", role: "rate" },
  slaMachineRatePerHour:   { process: "3d-printing", subProcess: "sla", relation: "direct", role: "cost" },
  slsLayerTimeSec:         { process: "3d-printing", subProcess: "sls", relation: "direct", role: "rate" },
  slsMachineRatePerHour:   { process: "3d-printing", subProcess: "sls", relation: "direct", role: "cost" },
};

const ROW_LABELS = {
  standard: "Standard", expedited: "Expedited", rush: "Priority rush", "same-day": "Same day",
  soft: "Soft plastics — HDPE, UHMW, PVC, PP", medium: "Acetal, nylon, polycarbonate", brittle: "Brittle — cast acrylic",
  abrasive: "Abrasive — G-10, phenolic", aluminum: "Aluminum plate",
  plastic: "Plastics", brass: "Brass", steel: "Steel", composite: "Composites",
  upTo3: "≤ 3 mm", upTo10: "3–10 mm", upTo20: "10–20 mm", over20: "> 20 mm",
  prismatic: "Prismatic", freeform: "Freeform",
};

function stepFor(r) {
  if (r.type === "percent") return 0.01;
  const span = (r.max ?? 100) - (r.min ?? 0);
  if (span <= 2) return 0.05;
  if (span <= 20) return 0.1;
  if (span <= 200) return 0.5;
  if (span <= 2000) return 1;
  return 10;
}

function adaptDescriptor(r) {
  const d = { ...deepClone(r), step: stepFor(r) };
  if (SIMPLE_KEYS.has(r.key)) d.simple = true;
  if (CALIBRATION[r.key]) d.calibration = { ...CALIBRATION[r.key] };
  if (r.type === "table") {
    const spec = r.tableSpec || {};
    if (spec.kind === "map") {
      d.shape = "map";
      d.rows = spec.keys.map((k) => ({ key: k, label: ROW_LABELS[k] || k }));
      d.min = spec.min; d.max = spec.max;
    } else {
      d.shape = "rows";
      d.columns = (spec.columns || []).map((c) => ({ ...c, label: c.label || c.key }));
      if (spec.sortBy) d.sortBy = spec.sortBy;
      if (r.key === "volumeDiscounts") { d.sortBy = d.sortBy || "minQty"; d.minRows = 1; d.maxRows = 20; }
    }
  }
  return d;
}

const RULE_SCHEMA = RULES.map(adaptDescriptor);
const RULE_GROUPS = GROUPS.map((g) => ({ key: g.id, label: g.label, blurb: g.help }));

function schemaDefaults() { return defaultRules(); }
function schemaKeys() { return RULES.map((r) => r.key); }
function getDescriptor(key) { return RULE_SCHEMA.find((d) => d.key === key) || null; }

function fmtBound(desc, n) {
  if (desc.type === "percent") return `${Math.round(n * 100)} %`;
  return desc.unit ? `${n} ${desc.unit}` : String(n);
}

// Rules that only make sense as whole numbers (counts, piece thresholds).
const INTEGER_KEYS = new Set(["rfqQuantityThreshold", "routerToolsPerJob"]);

function validateScalar(desc, raw) {
  const n = Number(raw);
  if (raw === "" || raw === null || raw === undefined || typeof raw === "boolean" || !Number.isFinite(n)) return { ok: false, error: `${desc.label} must be a number` };
  if (INTEGER_KEYS.has(desc.key) && !Number.isInteger(n)) return { ok: false, error: `${desc.label} must be a whole number` };
  if (desc.min !== undefined && n < desc.min) return { ok: false, error: `${desc.label} must be at least ${fmtBound(desc, desc.min)}` };
  if (desc.max !== undefined && n > desc.max) return { ok: false, error: `${desc.label} must be at most ${fmtBound(desc, desc.max)}` };
  return { ok: true, value: n };
}

// Strict table check for admin input: unknown rows, missing columns and
// out-of-range cells are errors (mergeRules() clamps instead).
function validateTable(desc, raw) {
  const spec = desc.tableSpec || {};
  const inRange = (n, min, max) => (min === undefined || n >= min) && (max === undefined || n <= max);
  if (spec.kind === "map") {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: `${desc.label} must be a table of rows` };
    for (const k of Object.keys(raw)) if (!spec.keys.includes(k)) return { ok: false, error: `${desc.label}: unknown row "${k}"` };
    const value = {};
    for (const k of spec.keys) {
      const n = Number(raw[k] !== undefined ? raw[k] : desc.default[k]);
      if (!Number.isFinite(n)) return { ok: false, error: `${desc.label} › ${ROW_LABELS[k] || k} must be a number` };
      if (!inRange(n, spec.min, spec.max)) return { ok: false, error: `${desc.label} › ${ROW_LABELS[k] || k} must be between ${spec.min} and ${spec.max}` };
      value[k] = n;
    }
    return { ok: true, value };
  }
  if (!Array.isArray(raw)) return { ok: false, error: `${desc.label} must be a list of rows` };
  if (desc.minRows && raw.length < desc.minRows) return { ok: false, error: `${desc.label} needs at least ${desc.minRows} row(s)` };
  if (desc.maxRows && raw.length > desc.maxRows) return { ok: false, error: `${desc.label} can have at most ${desc.maxRows} rows` };
  const cols = spec.columns || [];
  const value = [];
  for (const row of raw) {
    if (cols.length === 1 && cols[0].key === "value") {
      const n = Number(row && typeof row === "object" ? row.value : row);
      if (!Number.isFinite(n)) return { ok: false, error: `${desc.label} entries must be numbers` };
      if (!inRange(n, cols[0].min, cols[0].max)) return { ok: false, error: `${desc.label} entries must be between ${cols[0].min} and ${cols[0].max}` };
      value.push(n);
      continue;
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) return { ok: false, error: `${desc.label} rows must have ${cols.map((c) => c.label || c.key).join(" and ")}` };
    const clean = {};
    for (const c of cols) {
      const n = Number(row[c.key]);
      if (row[c.key] === undefined || row[c.key] === "" || !Number.isFinite(n)) return { ok: false, error: `${desc.label} › ${c.label || c.key} must be a number` };
      if (!inRange(n, c.min, c.max)) return { ok: false, error: `${desc.label} › ${c.label || c.key} must be between ${c.min} and ${c.max}` };
      clean[c.key] = n;
    }
    value.push(clean);
  }
  const sortBy = spec.sortBy || (desc.key === "volumeDiscounts" ? "minQty" : null);
  if (sortBy) {
    for (let i = 1; i < value.length; i++) {
      if (!(value[i][sortBy] > value[i - 1][sortBy])) return { ok: false, error: `${desc.label} rows must be in ascending ${sortBy} order with no duplicates` };
    }
  }
  return { ok: true, value };
}

/**
 * Admin-save validation: unknown keys and out-of-range values are ERRORS
 * (the console shows them inline), not silently clamped like mergeRules().
 * Returns { ok, errors: [{ key, message }], values }.
 */
function validateRules(candidate, { partial = true } = {}) {
  const errors = [];
  const values = {};
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { ok: false, errors: [{ key: "", message: "Rules must be an object" }], values };
  }
  for (const key of Object.keys(candidate)) {
    if (!RULE_BY_KEY[key]) errors.push({ key, message: `Unknown rule "${key}"` });
  }
  for (const desc of RULE_SCHEMA) {
    if (!(desc.key in candidate)) {
      if (!partial) errors.push({ key: desc.key, message: `${desc.label} is missing` });
      continue;
    }
    const r = desc.type === "table" ? validateTable(desc, candidate[desc.key]) : validateScalar(desc, candidate[desc.key]);
    if (!r.ok) errors.push({ key: desc.key, message: r.error });
    else values[desc.key] = r.value;
  }
  return { ok: errors.length === 0, errors, values };
}

module.exports = {
  GROUPS,
  RULES,
  RULE_BY_KEY,
  MATERIAL_CLASSES,
  FEED_CLASSES,
  MATERIAL_FIELD_SCHEMA,
  defaultRules,
  sanitizeValue,
  sanitizeRules,
  mergeRules,
  describeSchema,
  // admin-console API
  RULE_SCHEMA,
  RULE_GROUPS,
  schemaDefaults,
  schemaKeys,
  getDescriptor,
  validateRules,
};
