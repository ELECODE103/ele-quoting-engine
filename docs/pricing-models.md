# Pricing models

How the Straightedge quoting engine turns a part into a price. The price is tied to the part — setups, features, machined surface, material — not to a bounding box with a flat time floor. This document is the reference for the models in `server/processes/{cnc,routing,3d-printing}/pricing.js`, the rate card in `server/config/ruleSchema.js`, the feature adapter in `server/processes/featureAdapter.js`, and the calibration run in `tools/vet-quotes/results.md`.

Machine facts, tooling, feeds and setup habits come from the `fusion-cam-programmer` skill (`references/machines.md`, `references/feeds-speeds.md`, `references/wcs-and-setups.md`); where a number below is a shop fact rather than a calibration choice, that is the source. The vetting findings that drove the redesign are in `docs/quote-vetting-process.md` §5–§6.

## 1. Inputs: the part-feature view

Every model reads the part through `resolveFeatures(geometry, { subProcess, thicknessMm })` (`server/processes/featureAdapter.js`), which returns the `features` object described in `server/geometry/SCHEMA.md` plus a `derived` block and a `confidence` block.

- When `geometry.features` is present (the geometry module's recognition), it is used as-is; fields that are `null` fall back per field and the confidence for that field reads `"legacy"`. The line item's `meta.confidence.source` is `"features"`, `"mixed"` or `"legacy"`.
- When it is absent (today's parser), the adapter derives what the legacy scalars honestly give. Bounding box, volume and surface area are exact on every library part. The legacy parser's `estimatedHoles` and `estimatedPerimeter` are normal-bucket noise and are **not used** (the harness confirms: a Ø40 bore reads as "20 holes").

Legacy derivations, all verified against the vetting library:

| quantity | derivation | accuracy on the library |
|---|---|---|
| shape kind | flat when the thinnest extent ≤ 3/4" and ≤ 55 % of the next extent, or ≤ 1" and ≤ 25 %; revolved when turning is selected; else prismatic | 17/17 as intended (the 1" bracket is a block, the 1/2" rail is flat) |
| flat part: top area `A` | `A = (V + x) / t` (x = blind removal below) | 30 000 mm² on the tray (exact) |
| flat part: edge-equivalent length `E` | `E = (SA − 2V/t) / t` — the through-feature reading of the surface area | 624 mm on the plate (true 624), 1 373 on the rail (1 374), 912 on the wear strip (912) |
| flat part: outer perimeter | `2(W + H)` of the oriented box (a disc reads 4 % long, a gear 30 % short) | — |
| flat part: blind removal `x` | a pocket inflates `E` by `2x/t²`; `x = min(bbox·t − V, (E − 2(W+H)) · t² / 2)` | 259 cm³ on the tray (exact) |
| flat part: inner contours | `E − 2(W+H) − 2x/t²` — whatever the pocket reading does not explain | 345 mm on the drill plate (true 503) |
| revolved: diameter, length | the two near-equal box extents are the diameter | exact |
| revolved: bore | `d = √(4 (π/4 D² L − V) / (π L))` | Ø25.2 on the bushing (25), Ø20.1 on the roller (20), Ø45.2 on the seal ring (45) |
| setups (block) | 1 if the part keeps ≥ 35 % of its envelope, else 2 | — |
| support volume (printing) | `overhangFraction × SA × ½ height` | — |

The through-vs-pocket split is the one real ambiguity in the scalars; the rule above never double-counts volume and a feature list makes it exact. What the scalars cannot give — hole list, threads, wall thickness, corner radii, access directions — is where the `features` object matters, and the price says so: a block priced without a feature list carries a visible *unknown-feature allowance* (`cncLegacyFeatureAllowance`) and, when it has any removal, goes to review (`gateReviewOnLegacyFeatures`).

## 2. Model equations

All times in minutes per part unless marked *per lot*; costs = time ÷ 60 × the machine class rate. `mach` is the material's machinability (6061 = 1.0, Delrin 1.3, PEEK 0.9, G-10 0.6).

### 2.1 CNC milling (Tormach PCNC 1100)

```
stock      plate (w+2p)(h+2p)×s when the thickness matches a standard plate (±0.6 mm, plate ≥ part)
           else block (w+2p)(h+2p)(d+2p);   p = stockPaddingMm (3)
material   stock volume × density × $/kg × (1 + wasteFactor)

per lot    setup = cncSetupMinutesFirst + (setups−1) × cncSetupMinutesAdditional
                   + 4th-axis setup when setups > 2 and the part fits the trunnion (then setups = 2)
                   + cncInspectionMinutesPerLot
           setups = features.access.minSetups3Axis, +1 per X-travel length beyond 457 mm (indexed)

per part   saw             cncSawMinutesPerPart
           load/unload     setups × cncHandlingMinutesPerSetup
           face            (plate − part thickness) × area ÷ (cncFacingMrrCm3PerMin × mach)
           rough           featureRemoval ÷ (cncRoughingMrrCm3PerMin[class] × mach)
                           block: featureRemoval = bbox − part; flat: blind removal only
                           each pocket: × (refRadius ÷ cornerRadius)^exp when the corner is smaller than the 3/8" tool,
                                        × (1 + cncPocketDeepPenalty) when depth > cncPocketDeepRatio × width
           profile         flat: (outer + inner contour) × ⌈t ÷ cncMillDocMm⌉ ÷ (cncMillFeedMmPerMin × mach)
                           block: 2(w+h) side cleanup, same feed
           finish          machinedArea ÷ (cncFinishCm2PerMin[prismatic|freeform] × mach)
                           flat: edges only (faces come from the plate); block: whole surface
           holes           Σ cncDrillApproachMinutes + depth ÷ (cncDrillMmPerMin[band] × mach) × peck(depth/dia)
                           peck = 1 + cncPeckPenaltyPerDia × (depth/dia − cncPeckDepthRatio)+, capped at 12×D
                           > cncHelicalBoreMinDiaMm: helical bore = wall area ÷ finish rate + core ÷ MRR
                           tapped-candidate: + cncTapMinutesPerHole at the hand-work rate (no rigid tapping on the 1100)
                           counterbored / countersunk: + cncCounterboreMinutes
           walls           rough and finish × (1 + cncThinWallPenalty) when minThickness < cncThinWallMm,
                                            × (1 + cncTallWallPenalty) when tallThinMaxAspect > cncTallWallAspect
           tool changes    (2 + drill sizes + chamfer/profile + c'bore) × cncToolChangeMinutes
           inspect         cncInspectionMinutesPerPart
           allowance       block without feature list: cncLegacyFeatureAllowance × (face + profile + finish)
                           flat without feature list: hole-sized contours × cncDrillApproachMinutes
           floor           machine time ≥ saw + handling + machinedArea × cncMinMinutesPerCm2
tooling    machine hours × cncToolingPerMachineHour ÷ mach
```

### 2.2 Turning (manual lathe)

```
stock      bar = next standard diameter ≥ D + 2 × latheBarPaddingMm, length L + latheBarEndAllowanceMm
per lot    latheSetupMinutes
per part   load, face (1 end when parted off the bar, 2 when sawn)
           OD: (⌈(bar − D)/2 ÷ DOC⌉ + 1) passes × L ÷ (latheFeedMmPerMin[class] × mach)  (+ step passes to minDiameter)
           drill: L ÷ latheDrillMmPerMin[band] × peck; drills over 12 mm add a centre drill + pilot
           bore: when bore > latheMaxDrillMm, (⌈(bore − drill)/2 ÷ DOC⌉ + 1) passes × L ÷ (0.8 × feed)
           chamfer: edges × (latheChamferMinutes + D/10 × latheChamferMinutesPer10mmDia)
           operation changes: operations × latheToolChangeMinutes
           flip (or hand-deburr for parted pieces ≤ latheNoFlipMaxLengthMm), part off bar ÷ lathePartOffMmPerMin (or saw), inspect
```

### 2.3 Routing (Techno RG 5996)

```
material   blank (W + 2 kerf)(H + 2 kerf) × t ÷ routerNestYield × density × $/kg
cutter     1/4" default; 3/8" when t > 1/4" (feed × routerThickToolFeedFactor); 1/8" when an internal corner < routerSmallToolRadiusMm (feed × routerSmallToolFeedFactor); aluminum: 1/4" at routerMaxDocMm.aluminum
per part   cut      (outer + inner perimeter) × ⌈t ÷ maxDoc⌉ ÷ routerFeedMmPerMin[class]
           pockets  blind removal ÷ routerPocketCm3PerMin[class]
           plunges  (holes + slots + pockets, or inner length ÷ 40 mm capped at 12 without a feature list) × routerHoleSeconds
           de-tab   routerTabMinutesPerPart;  handle routerHandlingMinutesPerPart
           sheet    (routerSheetHandlingMinutes + tools × routerToolChangeSeconds) ÷ parts on the sheet
per lot    routerSetupMinutes
tooling    metres cut × routerToolWearPerMeter × (abrasive 3, aluminum 1.5)
```

### 2.4 Printing

```
FDM   shell = min(V, SA × fdmShellThicknessMm);  infill = (V − shell) × infill%;  supports = overhang support volume × fdmSupportDensity
      time = shell ÷ fdmDepositionMm3PerSec + (infill + supports) ÷ fdmInfillDepositionMm3PerSec + layers × fdmLayerOverheadSec
      post-process = fdmPostProcessMinutesBase + SA/100 cm² × fdmPostProcessMinutesPer100Cm2 (hand-work rate)
SLA   layers = height ÷ layer;  time = layers × (slaLayerTimeSec + slaScanTimeSecPerCm2 × meanSection),  meanSection = V ÷ height
      resin = V × (1 + slaSupportMaterialRatio);  post-process slaPostProcessMinutes (wash + cure)
SLS   same layer model at SLS rates; powder = V × (1 + (1/packing − 1) × (1 − reuse));  post-process slsPostProcessMinutes
per lot printSetupMinutes (hand-work rate);  floors fdm/sla/slsMinimumPartPrice
```

### 2.5 Shared tail

`subtotal = material + machine + hand work + tooling + setup/qty + finish` → quantity discount (`volumeDiscounts`, on the whole base) → multi-part nesting savings on the material share (`nestingEfficiencyBonus`) → margin (`price = cost ÷ (1 − marginPercent)`) → per-process floor. Every line item's `meta.costBuildup` lists each step as `{ step, minutes, dollars, basis }`; the dollars sum to the subtotal (tests check this), so the admin order view and the RFQ queue can show why.

## 3. Rule defaults and why

Rates, setup minutes and handling constants are calibration choices tuned against the shop's own time estimates in `tools/vet-quotes/parts/manifest.json`; cutting-physics numbers come from the skill:

- **Roughing MRR (plastic 13 cm³/min at machinability 1 → Delrin 16.9, HDPE 15.6; aluminum 8; steel 3).** The manifest's own reasoning uses "Tormach adaptive in HDPE ≈ 14 cm³/min". For 6061 the skill's chip-load math gives a 3/8" 2-flute at 5,140 RPM × 0.0015"/tooth = 15 ipm with 15 % WOC and 1×Ø DOC ≈ 5 cm³/min, a 1/2" tool ≈ 16; the 1.5 hp ceiling is ~33 (`feeds-speeds.md`: "MRR in aluminum beyond ~2 in³/min means you're kidding yourself"). 8 is the blend; the previous rule (900 cm³/h = 15 at machinability 1) had no discriminating power because the 15-minute floor hid it.
- **Finishing 45 cm²/min (prismatic).** A wall pass at 783 mm/min (Delrin, 0.003"/tooth) with 9.5 mm axial engagement is 74 cm²/min; a floor at 50 % step-over of a 3/8" tool is 37; approach and lead-ins pull the effective rate down. Freeform 10 cm²/min is a 3D scallop pass at ~1 mm step-over (vetting §6).
- **Mill profile feed 1,000 mm/min, DOC 9.6 mm.** 3/8" 2-flute at 5,140 RPM × 0.004"/tooth (acetal) = 41 ipm = 1,045 mm/min; DOC 1×Ø for plastics. 9.6 rather than 9.5 so 3/4" plate is two passes, not three.
- **Drill feeds 150/300/250/120 mm/min by diameter band, peck past 3×D.** Skill: chip-per-rev 0.002"–0.008", peck ≥ 3×D. Approach 0.2 min per hole covers spot, position, plunge and retract (the manifest reasons "~20 s each" for drilled holes).
- **Hand tapping 1 min per hole.** The 1100 has no rigid tapping (`machines.md`): spot + tap-drill in the program, tap by hand.
- **Setups: first 28 min, each additional 15, 4th axis +20, lot inspection 3.** The manifest uses 30 min for one-setup parts, 40–45 for two; the WCS doctrine (`wcs-and-setups.md`) is one WCS per setup with X/Y carried over and only Z re-touched, which is what the 15-minute increment reflects. 4th-axis envelope 150 × 300 mm is a placeholder until the trunnion is measured.
- **Load/unload 2 min per setup, saw 1 min, inspect 0.5 min per part.** Calibration; these are the terms that keep a 20 mm cube at ~5 minutes instead of 15.
- **Tooling $6 per machine hour ÷ machinability** replaces the per-piece $7.69–$11.11 hidden floor (vetting §5.9); G-10 at machinability 0.6 pays $10/h.
- **Lathe: 180 mm/min and 2.0 mm DOC in plastics, 150/1.5 in 6061, 60/1.0 in steel; drill 120→40 mm/min by size; 0.25 min per operation change; part-off 30 mm of diameter per minute; setup 15 min.** Manual-lathe-with-stops numbers calibrated to the manifest (bushing 8 min, roller 18, spacer 1.5, PEEK ring 6).
- **Router feeds soft 2,700, medium 2,700, brittle 1,800, abrasive 1,500, aluminum 1,800 mm/min.** Straight from the skill's chip-load table at the 18,000 RPM floor: 1/4" O-flute HDPE 0.006" × 18k = 2,740; acetal 2-flute 0.003" × 2 × 18k = 2,740; cast acrylic 0.002" × 2 × 18k = 1,830; aluminum 0.002" × 2 × 18k = 1,830 with DOC 2 mm ("conservative means shallower, not slower"). The previous feeds were 1.4–1.8× above chip load (vetting §5.6). Max DOC 6.5 / 9.6 mm (1×Ø for plastics) so 1/4" and 3/8" stock are one pass.
- **Router pocket rate 30 cm³/min (soft).** 3/8" O-flute, 6 mm DOC, 50 % step-over at 3,600 mm/min is ~100 theoretical; 30 is the vetting §6 recommendation and matches the tray's shop estimate within 15 %.
- **Router setup 20 min, sheet handling 6 min, de-tab 0.4 + handle 0.3 min.** Manifest uses 15–20 min; the vetting flagged the old $60 (38 min) setup as 2–2.5× on one-offs.
- **FDM 3.5 mm³/s walls, 8 mm³/s infill, 1.2 mm shell, $4/h.** 3.5 mm³/s ≈ 12.6 cm³/h, a Prusa-class average with accelerations; the manifest's "~60 g ABS, ~6 h" housing prints in 4.8 h. The $8/h printer rate was the single biggest reason FDM parts over-priced; $4/h plus hand post-processing at $65/h reproduces the manifest's $2/h machine + 10 min handling within 10 %.
- **SLA 7 s per layer + 0.3 s/cm² of mean section, $15/h, 12 min wash/cure.** The old footprint proxy made the thin-wall housing 34 h (vetting §5.3); mean section (V ÷ height) and a near-fixed exposure time make it 2.6 h.
- **Margin 30 %, quantity breaks, nesting bonus, shipping, floors** are unchanged from the previous rule set.

Full rate card (every rule, its default, unit and range; the admin page renders this list from `GET /api/admin/pricing/schema`):

#### Shop

| key | label | default | unit | range | help |
|---|---|---|---|---|---|
| `cncMachineRatePerHour` | Mill rate | 95 | $/h | 20–500 | What an hour on the Tormach costs the customer, machine running or being set up. |
| `latheRatePerHour` | Lathe rate | 85 | $/h | 20–500 | What an hour on the manual lathe costs the customer. |
| `routerMachineRatePerHour` | Router rate | 95 | $/h | 20–500 | What an hour on the Techno router costs the customer. |
| `laborRatePerHour` | Hand-work rate | 65 | $/h | 10–300 | Rate for work done away from a machine: hand tapping, deburring, inspection, print post-processing. |
| `marginPercent` | Margin | 0.3 | % | 0–0.9 | Share of the final price that is profit; 0.30 means cost is 70% of the price. |
| `minimumPartPrice` | Minimum CNC part price | 5 | $ | 0–1000 | No machined part ever sells for less than this per piece. |
| `routerMinimumPartPrice` | Minimum routed part price | 6 | $ | 0–1000 | No routed part ever sells for less than this per piece. |
| `fdmMinimumPartPrice` | Minimum FDM part price | 8 | $ | 0–1000 | Floor per FDM piece; covers removing it from the bed and checking it. |
| `slaMinimumPartPrice` | Minimum SLA part price | 12 | $ | 0–1000 | Floor per SLA piece; covers wash and cure handling. |
| `slsMinimumPartPrice` | Minimum SLS part price | 15 | $ | 0–1000 | Floor per SLS piece; covers depowdering and blasting. |
| `minimumOrderTotal` | Minimum order | 25 | $ | 0–5000 | Smallest order the shop will take, after shipping. |
| `rushMultipliers` | Rush multipliers | standard 1, expedited 1.35, rush 1.85, same-day 2.5 | × | per entry 1–5 | Price multiplier per lead-time option; 1.35 means 35% more for expedited. |
| `shippingBaseRate` | Shipping base | 12 | $ | 0–500 | Flat shipping charge per order before weight. |
| `shippingPerKg` | Shipping per kg | 2.5 | $/kg | 0–100 | Added to shipping for every kilogram of parts. |

#### Materials

| key | label | default | unit | range | help |
|---|---|---|---|---|---|
| `stockPaddingMm` | Stock padding | 3 | mm | 0–25 | Extra material on each side of the part when the blank is sawn from bar or plate. |
| `plateThicknessMatchMm` | Plate match tolerance | 0.6 | mm | 0–5 | If a flat part is within this of a standard plate thickness it is bought at that thickness and the faces are not machined. |
| `materialDefaultWasteFactor` | Default waste factor | 0.15 | % | 0–2 | Extra stock paid for (saw kerf, drops, ends) when the material record has no waste factor of its own. |
| `standardPlateThicknessesMm` | Standard plate thicknesses | 1.6, 3.2, 4.8, 6.35, 9.5, 12.7, 15.9, 19.05, 25.4, 31.75, 38.1, 50.8, 63.5, 76.2 | mm | per entry 0.1–200 | Plate sizes the shop can buy; flat parts are costed from the nearest one at or above their thickness. |
| `standardBarDiametersMm` | Standard bar diameters | 6.35, 9.5, 12.7, 15.9, 19.05, 22.2, 25.4, 28.6, 31.75, 38.1, 41.3, 44.45, 50.8, 57.15, 63.5, 69.85, 76.2, 88.9, 101.6, 127, 152.4 | mm | per entry 0.1–400 | Round bar sizes the shop can buy; turned parts are costed from the nearest one above the finished diameter. |

#### CNC Machining

| key | label | default | unit | range | help |
|---|---|---|---|---|---|
| `cncSetupMinutesFirst` | First setup | 28 | min | 0–480 | Minutes to program, fixture and first-article the first setup of a job; charged once per order line. |
| `cncSetupMinutesAdditional` | Each extra setup | 15 | min | 0–480 | Minutes for every additional setup (flip, second side); charged once per order line. |
| `cnc4thAxisSetupMinutes` | 4th-axis setup | 20 | min | 0–480 | Extra minutes to mount the 4th axis when a part needs more than two setups and fits the trunnion. |
| `cnc4thAxisMaxDiameterMm` | 4th-axis max swing | 150 | mm | 0–1000 | Largest part that fits the 4th axis; bigger parts stay multi-setup. |
| `cnc4thAxisMaxLengthMm` | 4th-axis max length | 300 | mm | 0–2000 | Longest part that fits between the 4th axis and tailstock. |
| `cncMaxTravelXMm` | Mill X travel | 457 | mm | 50–5000 | Parts longer than this need indexed setups (one extra setup per travel length). |
| `cncHandlingMinutesPerSetup` | Load/unload per setup | 2 | min | 0–60 | Minutes per part per setup to load, clamp, unload, brush off and break sharp edges. |
| `cncSawMinutesPerPart` | Saw blank | 1 | min | 0–60 | Minutes per part to saw the blank from bar or plate. |
| `cncToolChangeMinutes` | Tool change | 0.25 | min | 0–10 | Minutes per tool change per part (ATC swap plus approach). |
| `cncRoughingMrrCm3PerMin` | Roughing removal rate | plastic 13, aluminum 8, brass 10, steel 3, composite 7 | cm³/min | per entry 0.1–500 | Cubic centimetres per minute an adaptive roughing pass removes at machinability 1.0; scaled by each material's machinability. |
| `cncFacingMrrCm3PerMin` | Facing removal rate | 35 | cm³/min | 0.1–1000 | Cubic centimetres per minute a face mill skims off the outside of the blank at machinability 1.0. |
| `cncFinishCm2PerMin` | Finishing rate | prismatic 45, freeform 10 | cm²/min | per entry 0.1–1000 | Square centimetres of surface finished per minute at machinability 1.0: prismatic = walls and floors with an endmill, freeform = 3D scallop passes. |
| `cncDrillMmPerMin` | Drill feed | upTo3 150, upTo10 300, upTo20 250, over20 120 | mm/min | per entry 1–5000 | Millimetres per minute a drill advances, by diameter band, at machinability 1.0. |
| `cncDrillApproachMinutes` | Per-hole approach | 0.2 | min | 0–5 | Minutes per hole for positioning, spot drill, plunge and retract (the depth-based feed time is added on top). |
| `cncPeckDepthRatio` | Peck threshold | 3 | ×dia | 1–20 | Holes deeper than this many diameters are peck-drilled. |
| `cncPeckPenaltyPerDia` | Peck penalty | 0.25 | × | 0–2 | Extra time fraction for every diameter of depth beyond the peck threshold. |
| `cncHelicalBoreMinDiaMm` | Largest drill | 13 | mm | 1–100 | Holes bigger than this are helically bored with an endmill instead of drilled. |
| `cncTapMinutesPerHole` | Hand tap | 1 | min | 0–20 | Minutes per tapped hole; the Tormach has no rigid tapping so threads are tapped by hand. |
| `cncCounterboreMinutes` | Counterbore / countersink | 0.3 | min | 0–10 | Extra minutes per counterbored or countersunk hole. |
| `cncPocketCornerRefRadiusMm` | Reference corner radius | 4.8 | mm | 0.5–25 | Pocket corners at or above this radius take the standard 3/8" endmill; smaller corners force a smaller, slower tool. |
| `cncPocketCornerPenaltyExponent` | Small-corner penalty | 1 | — | 0–3 | How hard small corners slow the pocket: time scales by (reference ÷ corner radius) to this power. |
| `cncPocketDeepRatio` | Deep-pocket threshold | 3 | ×width | 1–20 | Pockets deeper than this many times their width get the deep-pocket penalty. |
| `cncPocketDeepPenalty` | Deep-pocket penalty | 0.5 | × | 0–5 | Extra time fraction on deep pockets (long tools, lighter cuts). |
| `cncThinWallMm` | Thin wall | 2 | mm | 0–20 | Walls thinner than this get the thin-wall penalty (light passes, chatter risk). |
| `cncThinWallPenalty` | Thin-wall penalty | 0.4 | × | 0–5 | Extra time fraction on finishing and feature roughing for thin-walled parts. |
| `cncTallWallAspect` | Tall wall | 8 | × | 1–50 | Walls taller than this many times their thickness get the tall-wall penalty. |
| `cncTallWallPenalty` | Tall-wall penalty | 0.3 | × | 0–5 | Extra time fraction on finishing for tall thin walls. |
| `cncMillFeedMmPerMin` | Profile feed | 1000 | mm/min | 10–10000 | Millimetres per minute for profiling a flat part's outline at machinability 1.0 (3/8" 2-flute at 5,140 RPM). |
| `cncMillDocMm` | Profile depth per pass | 9.6 | mm | 0.5–50 | Depth of cut per profile pass through plate (3/8" endmill, 1×Ø). |
| `cncInspectionMinutesPerPart` | Inspect per part | 0.5 | min | 0–30 | Minutes per part for in-process checks and final inspection. |
| `cncInspectionMinutesPerLot` | Inspect per lot | 3 | min | 0–120 | Minutes per order line for first-article inspection and paperwork. |
| `cncLegacyFeatureAllowance` | Unknown-feature allowance | 0.3 | % | 0–2 | Extra machine time on blocks priced without a feature list (holes, pockets and threads the old parser cannot see); 0.30 = 30% more. |
| `cncMinMinutesPerCm2` | Surface-area minimum | 0.01 | min/cm² | 0–1 | Machine time per part is never less than load/unload plus this many minutes per cm² of machined surface — a floor that scales with the part instead of a flat 15 minutes. |
| `cncToolingPerMachineHour` | Tooling wear | 6 | $/h | 0–200 | Dollars of cutter wear per machine hour at machinability 1.0; abrasive materials cost more via their machinability. |

#### Turning

| key | label | default | unit | range | help |
|---|---|---|---|---|---|
| `latheSetupMinutes` | Lathe setup | 15 | min | 0–240 | Minutes to set tooling and stops for a batch; charged once per order line. |
| `latheLoadMinutesPerPart` | Load per part | 0.4 | min | 0–30 | Minutes per piece to chuck or collet the stock. |
| `latheToolChangeMinutes` | Operation change | 0.25 | min | 0–10 | Minutes per operation on the manual lathe to swap tool, drill or boring bar (quick-change post). |
| `latheFlipMinutes` | Flip | 0.5 | min | 0–30 | Minutes to flip a piece for second-end work. |
| `latheFaceMinutes` | Face an end | 0.4 | min | 0–30 | Minutes per faced end. |
| `latheChamferMinutes` | Chamfer an edge | 0.1 | min | 0–30 | Minutes per chamfered edge (outside or bore) on a small part. |
| `latheChamferMinutesPer10mmDia` | Chamfer per diameter | 0.05 | min/10mm | 0–5 | Extra minutes per chamfered edge for every 10 mm of diameter. |
| `lathePartOffMmPerMin` | Part-off speed | 30 | mm/min | 1–500 | Millimetres of diameter parted off per minute. |
| `latheFeedMmPerMin` | Turning feed | plastic 180, aluminum 150, brass 180, steel 60, composite 120 | mm/min | per entry 1–5000 | Millimetres per minute the tool travels along the part for OD and boring passes, by material class. |
| `latheDocMm` | Depth of cut | plastic 2, aluminum 1.5, brass 1.5, steel 1, composite 1.5 | mm | per entry 0.05–20 | Radial depth per turning pass, by material class. |
| `latheDrillMmPerMin` | Lathe drill feed | upTo6 120, upTo13 100, upTo25 70, over25 40 | mm/min | per entry 1–5000 | Millimetres per minute for tailstock drilling, by diameter band. |
| `latheMaxDrillMm` | Largest lathe drill | 25 | mm | 1–100 | Bores bigger than this are drilled to this size then bored. |
| `latheBarPaddingMm` | Bar padding | 1 | mm | 0–20 | Radial allowance before rounding up to a standard bar size. |
| `latheBarEndAllowanceMm` | Bar per piece | 4 | mm | 0–50 | Extra bar length per piece for parting and facing. |
| `lathePartOffMaxLengthMm` | Part-off max length | 100 | mm | 0–1000 | Pieces shorter than this are parted off the bar; longer ones are sawn blanks. |
| `latheNoFlipMaxLengthMm` | No-flip length | 12 | mm | 0–500 | Parted-off pieces shorter than this are hand-deburred on the parted end instead of being flipped and chamfered. |
| `latheInspectionMinutesPerPart` | Inspect per part | 0.3 | min | 0–30 | Minutes per piece to check diameters. |
| `latheToolingPerMachineHour` | Lathe tooling wear | 3 | $/h | 0–200 | Dollars of insert and drill wear per lathe hour. |

#### Routing

| key | label | default | unit | range | help |
|---|---|---|---|---|---|
| `routerSetupMinutes` | Router setup | 20 | min | 0–240 | Minutes to nest, CAM, load the first sheet and prove the first part; charged once per order line. |
| `routerSheetHandlingMinutes` | Per sheet | 6 | min | 0–120 | Minutes per sheet to load, screw down, unload and clean; shared by every part on the sheet. |
| `routerToolChangeSeconds` | Tool change | 12 | s | 0–300 | Seconds per ATC change; happens once per tool per sheet. |
| `routerToolsPerJob` | Tools per job | 2 | — | 1–12 | Typical number of tools a routed part needs (profile cutter plus a drill or pocket tool). |
| `routerFeedMmPerMin` | Cut feed | soft 2700, medium 2700, brittle 1800, abrasive 1500, aluminum 1800 | mm/min | per entry 10–20000 | Millimetres per minute for the 1/4" cutter by material class, from chip load × flutes × 18,000 RPM. |
| `routerThickToolFeedFactor` | 3/8" tool feed factor | 1.25 | × | 0.1–3 | Feed multiplier when stock over 1/4" is cut with a 3/8" cutter. |
| `routerSmallToolFeedFactor` | 1/8" tool feed factor | 0.55 | × | 0.05–1 | Feed multiplier when internal corners under 1/8" radius force a 1/8" cutter. |
| `routerSmallToolRadiusMm` | Small-tool corner radius | 3.2 | mm | 0.5–10 | Internal corners smaller than this radius need the 1/8" cutter. |
| `routerMaxDocMm` | Depth per pass | eighth 3.2, quarter 6.5, threeEighths 9.6, aluminum 2 | mm | per entry 0.1–50 | Maximum depth of cut per pass for each cutter; plastics run 1×Ø, aluminum stays shallow. |
| `routerPocketCm3PerMin` | Pocket removal rate | soft 30, medium 25, brittle 18, abrasive 12, aluminum 5 | cm³/min | per entry 0.1–500 | Cubic centimetres per minute cleared from a pocket, by material class. |
| `routerHoleSeconds` | Per plunge | 4 | s | 0–60 | Seconds per hole or inner contour for the plunge and lead-in. |
| `routerTabMinutesPerPart` | De-tab per part | 0.4 | min | 0–30 | Minutes per part to snap tabs and clean the edge. |
| `routerHandlingMinutesPerPart` | Handle per part | 0.3 | min | 0–30 | Minutes per part to unload, inspect and pack. |
| `routerKerfMarginMm` | Kerf margin | 6 | mm | 0–50 | Material between nested parts (cutter diameter plus onion-skin), each side. |
| `routerNestYield` | Nest yield | 0.85 | % | 0.1–1 | Fraction of a sheet that becomes parts; the rest is paid for as waste. |
| `routerSheetWMm` | Sheet width | 1219 | mm | 100–3000 | Width of the stock sheet the nest is laid on. |
| `routerSheetHMm` | Sheet length | 2438 | mm | 100–4000 | Length of the stock sheet the nest is laid on. |
| `routerToolWearPerMeter` | Cutter wear | 0.35 | $/m | 0–50 | Dollars of cutter wear per metre cut in plastics. |
| `routerAbrasiveWearFactor` | Abrasive wear factor | 3 | × | 1–20 | Cutter wear multiplier for G-10 and phenolic. |
| `routerAluminumWearFactor` | Aluminum wear factor | 1.5 | × | 1–20 | Cutter wear multiplier for aluminum plate. |

#### Printing

| key | label | default | unit | range | help |
|---|---|---|---|---|---|
| `printSetupMinutes` | Print setup | 5 | min | 0–120 | Minutes to slice, load and start a job; charged once per order line at the hand-work rate. |
| `fdmMachineRatePerHour` | FDM printer rate | 4 | $/h | 0–200 | Cost per hour of FDM printer time. |
| `fdmDepositionMm3PerSec` | FDM wall deposition | 3.5 | mm³/s | 0.1–100 | Cubic millimetres per second laid down on walls and solid layers (speed × line width × layer height, with accelerations). |
| `fdmInfillDepositionMm3PerSec` | FDM infill deposition | 8 | mm³/s | 0.1–100 | Cubic millimetres per second laid down as sparse infill. |
| `fdmShellThicknessMm` | FDM shell | 1.2 | mm | 0.2–10 | Solid skin thickness (perimeters plus top/bottom) assumed around the part. |
| `fdmInfillPercent` | FDM default infill | 0.2 | % | 0.05–1 | Infill density when the customer does not choose one. |
| `fdmLayerOverheadSec` | FDM per-layer overhead | 2 | s | 0–60 | Seconds per layer for travel moves, retracts and layer change. |
| `fdmSupportDensity` | FDM support density | 0.15 | % | 0–1 | Support material volume as a fraction of the overhang volume it holds up. |
| `fdmPostProcessMinutesBase` | FDM post-process | 2 | min | 0–60 | Minutes per part to remove from the bed, pull supports and check. |
| `fdmPostProcessMinutesPer100Cm2` | FDM post-process per area | 1 | min/100cm² | 0–30 | Extra minutes per 100 cm² of part surface for support removal and cleanup. |
| `slaMachineRatePerHour` | SLA printer rate | 15 | $/h | 0–200 | Cost per hour of SLA printer time. |
| `slaLayerTimeSec` | SLA per layer | 7 | s | 0–120 | Seconds per layer for exposure and peel regardless of area. |
| `slaScanTimeSecPerCm2` | SLA per area | 0.3 | s/cm² | 0–20 | Seconds per square centimetre of mean cross-section per layer. |
| `slaSupportMaterialRatio` | SLA support ratio | 0.1 | % | 0–1 | Resin used for supports as a fraction of part volume. |
| `slaPostProcessMinutes` | SLA post-process | 12 | min | 0–120 | Minutes per part to wash, cure and remove supports. |
| `slsMachineRatePerHour` | SLS printer rate | 35 | $/h | 0–500 | Cost per hour of SLS printer time (shared across a packed build). |
| `slsLayerTimeSec` | SLS per layer | 12 | s | 0–120 | Seconds per layer for recoat and sweep. |
| `slsScanTimeSecPerCm2` | SLS per area | 2 | s/cm² | 0–20 | Seconds per square centimetre of mean cross-section per layer. |
| `slsPackingEfficiency` | SLS packing | 0.08 | % | 0.01–1 | Fraction of the build volume that is parts; the rest is loose powder. |
| `slsPowderReuseRatio` | SLS powder reuse | 0.5 | % | 0–0.95 | Fraction of un-fused powder recycled into the next build. |
| `slsPostProcessMinutes` | SLS post-process | 8 | min | 0–120 | Minutes per part to depowder and bead blast. |

#### Discounts

| key | label | default | unit | range | help |
|---|---|---|---|---|---|
| `volumeDiscounts` | Quantity breaks | 1:0, 5:0.05, 10:0.1, 25:0.15, 50:0.22, 100:0.28, 250:0.33, 500:0.38, 1000:0.42 | — | per entry 0–0.9 | Discount on the per-unit base at each quantity tier (0.10 = 10% off from that quantity up). |
| `nestingEfficiencyBonus` | Multi-part savings | 0.12 | % | 0–0.9 | Share of each part's material cost given back when an order has more than one part (shared sheets and setups). |

#### Gate

| key | label | default | unit | range | help |
|---|---|---|---|---|---|
| `rfqQuantityThreshold` | Instant-order quantity limit | 100 | pcs | 1–100000 | Quantities above this always go to a person for a quote. |
| `bigTicketLineTotal` | Big-ticket line | 5000 | $ | 0–1000000 | A single line over this amount is confirmed by hand before payment. |
| `lowVolumeRatio` | Hollow-part flag | 0.12 | % | 0–1 | CNC parts using less than this fraction of their stock envelope are reviewed (multi-setup or 4th-axis jobs). |
| `gateReviewOnLegacyFeatures` | Review blocks without features | 1 | 0/1 | 0–1 | Set to 1 to send machined blocks priced without a feature list (legacy geometry only) to a person; flat and turned parts price well without one. |
| `gateReviewThinWallMm` | Thin-wall review | 1 | mm | 0–20 | CNC parts with walls thinner than this go to review. |

#### Sheet Metal (inactive)

| key | label | default | unit | range | help |
|---|---|---|---|---|---|
| `laserCutRatePerMm` | Laser cut rate | 0.0035 | $/mm | 0–10 | Dollars per millimetre of laser cut at 1 mm thickness. |
| `laserThicknessExponent` | Laser thickness exponent | 1.6 | — | 0–5 | How fast cut cost grows with thickness. |
| `bendBaseCost` | Bend cost | 2.5 | $ | 0–100 | Dollars per bend at 1 mm thickness. |
| `bendThicknessMultiplier` | Bend thickness multiplier | 3 | — | 0–20 | How fast bend cost grows with thickness. |
| `holeBaseCost` | Hole cost | 0.35 | $ | 0–50 | Dollars per punched hole. |
| `tapCost` | Tap cost | 1.2 | $ | 0–50 | Dollars per tapped hole. |
| `countersinkCost` | Countersink cost | 0.8 | $ | 0–50 | Dollars per countersink. |


## 4. Calibration against the shop's estimates

Harness: `tools/vet-quotes/run_vetting.js` against a fresh production-mode server on :3010 (`docs/quote-vetting-process.md` §1), 17 parts × 53 configurations × qty 1/10/25/100/250 = 265 quotes, graded at qty 1/10/25 against the manifest's shop-estimate midpoints (`$95/h`, 30 % margin, no volume discount beyond setup amortisation). **Before** = commit d62bd57 with the shipped defaults; **after** = this branch's defaults. Ratio = engine ÷ estimate.

| | before median | before spread | before quotes > 2× off | after median | after spread | after quotes > 2× off |
|---|---|---|---|---|---|---|
| CNC (99 quotes) | ×1.81 | 0.65–8.63 | 33 | **×0.93** | 0.47–1.97 | 1 |
| Routing (39) | ×1.66 | 0.51–3.26 | 15 | **×1.16** | 0.58–2.41 | 4 |
| 3D printing (18) | ×1.08 | 0.48–19.98 | 6 | **×1.07** | 0.69–1.81 | 0 |
| All (156) | ×1.70 | 0.48–19.98 | 54 | **×0.97** | 0.47–2.41 | 5 |
| flat-sheet family (66) | ×1.52 | 0.49–4.45 | | ×0.97 | 0.58–2.41 | |
| pocket-plate (9) | ×1.68 | 0.51–2.39 | | ×1.36 | 0.95–1.62 | |
| machined-block (33) | ×1.18 | 0.60–4.52 | | ×0.93 | 0.47–1.97 | |
| turned (36) | ×2.06 | 1.69–8.63 | | ×0.92 | 0.65–1.64 | |
| enclosure (12) | ×0.76 | 0.48–19.98 | | ×1.12 | 0.99–1.81 | |

Hard rules: 0 fails before and after (prices fall with quantity, routing beats CNC on every flat part, turning within 0.5–2× of milling, PEEK > Delrin, floors hold, qty > 100 gated, oversize panel gated). Warnings fell from 88 to 31; the 57 that went away were all `vs-shop-estimate` and `machine-time-red-flag`.

The five quotes still outside 0.5–2×, and why:

| quote | after ÷ est | reason |
|---|---|---|
| bracket_block, 6061, qty 25 | ×0.47 | Legacy geometry: the four tapped holes and the hand-tapping are invisible to the scalars (the Delrin bracket reads ×0.52–0.73). The line is gated `legacy-features` for review; with a feature list the same part prices ×0.9–1.1 (see `cnc.test.js`, "feature-rich block"). |
| small_clip, routed, qty 25 | ×2.01 | The $6 router floor (`routerMinimumPartPrice`) against a $2.98 estimate — a floor doing its job on a 20 × 10 mm part. |
| drill_fixture_plate, routed 6061 plate, qty 1/10/25 | ×2.1–2.4 | The manifest has no aluminum routing estimate; the harness compares against the HDPE estimate (3.5 min). Aluminum at 2 mm DOC is 7 passes at 1,800 mm/min ≈ 9 min, which is what the skill's router-aluminum rules say. |

Other notes on the after column: the 20 mm cube at qty 1 is ×1.95 (setup-dominated, the acceptance table allows 2×); the pocketed tray on CNC is ×1.4–1.6 because its estimate is internally inconsistent (259 cm³ at the stated 14 cm³/min is 18.5 min, the estimate says 14); SLA on the housing is ×1.8 of the *FDM* estimate and below CNC, inside the §3 band. The full per-quote table (before, after, estimate, ratio, gate) is at the end of this document; `tools/vet-quotes/results.md` holds the complete run.

## 5. What the owner must calibrate after the first 10 real jobs

Follow `docs/quote-vetting-process.md` §7 (capture the engine's assumptions at order time — `meta.costBuildup` now gives them step by step — record actuals on the traveler, compute the ratios). The knobs, in the order the evidence will probably point at them:

1. **Rates and margin** (`Shop`): `cncMachineRatePerHour`, `latheRatePerHour`, `routerMachineRatePerHour`, `laborRatePerHour`, `marginPercent`. Everything scales with these; confirm them before touching a model knob.
2. **Setup minutes** (`cncSetupMinutesFirst`, `cncSetupMinutesAdditional`, `latheSetupMinutes`, `routerSetupMinutes`): compare to program + fixture + first-article time on the traveler. These dominate every qty-1 price.
3. **Per-part handling** (`cncHandlingMinutesPerSetup`, `cncSawMinutesPerPart`, `cncInspectionMinutesPerPart`, `routerTabMinutesPerPart`, `routerHandlingMinutesPerPart`, `latheLoadMinutesPerPart`, `latheToolChangeMinutes`): stopwatch five parts of a batch. These are the calibration terms that replaced the 15-minute floor and are the least physically grounded.
4. **Roughing MRR by class** (`cncRoughingMrrCm3PerMin`) and **finishing rate** (`cncFinishCm2PerMin`): compare spindle time from the control against `costBuildup` "rough features" + "finish surfaces" on pocketed parts (tray, housing). Adjust the class value, not machinability, unless one material is consistently off.
5. **Router feeds** (`routerFeedMmPerMin`): the chip-load numbers assume the first-run × 0.8 override is turned back up; if the shop runs 80 % permanently, scale the table by 0.8. `routerPocketCm3PerMin` from the first pocketed router job.
6. **Lathe feeds / DOC** (`latheFeedMmPerMin`, `latheDocMm`) and the drill table from the first bushing batch; `latheChamferMinutes`, `latheNoFlipMaxLengthMm` from how the shop actually handles second-end chamfers.
7. **Printing** (`fdmDepositionMm3PerSec`, `fdmMachineRatePerHour`, `fdmPostProcessMinutesBase`, `slaLayerTimeSec`): read the slicer's time estimate for the first ten prints and set the deposition rate so the engine matches it; the rest is the hand time at the wash station.
8. **Unknown-feature allowance** (`cncLegacyFeatureAllowance`) and the **review switch** (`gateReviewOnLegacyFeatures`): once the geometry module ships `features`, these stop mattering; until then, after ten blocks compare the allowance with the hole/thread time the machinist actually logged. The 4th-axis envelope (`cnc4thAxisMaxDiameterMm`, `cnc4thAxisMaxLengthMm`) needs the trunnion's real swing.
9. **Material** (`pricePerKg` per material on the Materials page, `stockPaddingMm`, `wasteFactor`, `routerNestYield`): from the first invoices; PEEK and Ultem are where padding and waste move real money.
10. **Floors** (`minimumPartPrice`, `routerMinimumPartPrice`, `fdm/sla/slsMinimumPartPrice`): only if small parts are losing money after the per-part handling terms are right.

Model gaps that remain (not knobs): a legacy flat part with slots reads them as hole-sized contours; a legacy block's setups are a volume-ratio guess (1 or 2); corner-radius and wall penalties act only with a feature list; the SLA/SLS orientation assumes the part prints lying on its largest face; routing aluminum has no shop estimate yet.

## 6. Full per-quote table (qty 1 / 10 / 25)

| part | configuration | qty | before | after | shop est. | before ÷ est | after ÷ est |
|---|---|---|---|---|---|---|---|
| plate_hole_pattern | routing:rt-hdpe@6.35 | 1 | $92.13 | $63.33 | $38.41 | ×2.40 | ×1.65 |
| plate_hole_pattern | routing:rt-hdpe@6.35 | 10 | $13.49 | $8.63 | $7.87 | ×1.71 | ×1.10 |
| plate_hole_pattern | routing:rt-hdpe@6.35 | 25 | $8.37 | $6.00 | $5.84 | ×1.43 | ×1.03 |
| plate_hole_pattern | routing:rt-delrin@6.35 | 1 | $94.47 | $65.32 | $38.41 | ×2.46 | ×1.70 |
| plate_hole_pattern | routing:rt-delrin@6.35 | 10 | $15.60 | $10.42 | $7.87 | ×1.98 | ×1.32 |
| plate_hole_pattern | routing:rt-delrin@6.35 | 25 | $10.36 | $6.80 | $5.84 | ×1.77 | ×1.16 |
| plate_hole_pattern | cnc:cnc-delrin | 1 | $113.73 | $86.95 | $86.65 | ×1.31 | ×1.00 |
| plate_hole_pattern | cnc:cnc-delrin | 10 | $50.29 | $21.46 | $25.58 | ×1.97 | ×0.84 |
| plate_hole_pattern | cnc:cnc-delrin | 25 | $44.22 | $16.69 | $21.51 | ×2.06 | ×0.78 |
| plate_hole_pattern | cnc:cnc-hdpe | 1 | $111.81 | $85.55 | $86.65 | ×1.29 | ×0.99 |
| plate_hole_pattern | cnc:cnc-hdpe | 10 | $48.56 | $20.19 | $25.58 | ×1.90 | ×0.79 |
| plate_hole_pattern | cnc:cnc-hdpe | 25 | $42.59 | $15.50 | $21.51 | ×1.98 | ×0.72 |
| pocketed_tray | routing:rt-hdpe@19.1 | 1 | $100.28 | $90.56 | $73.25 | ×1.37 | ×1.24 |
| pocketed_tray | routing:rt-hdpe@19.1 | 10 | $20.82 | $33.14 | $32.54 | ×0.64 | ×1.02 |
| pocketed_tray | routing:rt-hdpe@19.1 | 25 | $15.29 | $28.25 | $29.82 | ×0.51 | ×0.95 |
| pocketed_tray | cnc:cnc-hdpe | 1 | $178.86 | $141.78 | $107.88 | ×1.66 | ×1.31 |
| pocketed_tray | cnc:cnc-hdpe | 10 | $108.91 | $70.80 | $46.80 | ×2.33 | ×1.51 |
| pocketed_tray | cnc:cnc-hdpe | 25 | $99.58 | $63.29 | $42.73 | ×2.33 | ×1.48 |
| pocketed_tray | cnc:cnc-delrin | 1 | $181.74 | $147.25 | $107.88 | ×1.68 | ×1.36 |
| pocketed_tray | cnc:cnc-delrin | 10 | $111.49 | $75.73 | $46.80 | ×2.38 | ×1.62 |
| pocketed_tray | cnc:cnc-delrin | 25 | $102.02 | $67.94 | $42.73 | ×2.39 | ×1.59 |
| conveyor_guide_rail | routing:rt-uhmw@12.7 | 1 | $99.28 | $68.15 | $43.40 | ×2.29 | ×1.57 |
| conveyor_guide_rail | routing:rt-uhmw@12.7 | 10 | $19.93 | $12.97 | $12.87 | ×1.55 | ×1.01 |
| conveyor_guide_rail | routing:rt-uhmw@12.7 | 25 | $14.45 | $9.20 | $10.83 | ×1.33 | ×0.85 |
| conveyor_guide_rail | cnc:cnc-uhmw | 1 | $122.05 | $138.01 | $131.44 | ×0.93 | ×1.05 (RFQ: envelope) |
| conveyor_guide_rail | cnc:cnc-uhmw | 10 | $57.77 | $39.93 | $39.83 | ×1.45 | ×1.00 (RFQ: envelope) |
| conveyor_guide_rail | cnc:cnc-uhmw | 25 | $51.28 | $32.41 | $33.72 | ×1.52 | ×0.96 (RFQ: envelope) |
| wear_strip | routing:rt-uhmw@9.5 | 1 | $93.49 | $64.68 | $39.39 | ×2.37 | ×1.64 |
| wear_strip | routing:rt-uhmw@9.5 | 10 | $14.71 | $9.85 | $8.85 | ×1.66 | ×1.11 |
| wear_strip | routing:rt-uhmw@9.5 | 25 | $9.52 | $6.25 | $6.82 | ×1.40 | ×0.92 |
| wear_strip | cnc:cnc-uhmw | 1 | $114.02 | $89.91 | $87.46 | ×1.30 | ×1.03 |
| wear_strip | cnc:cnc-uhmw | 10 | $50.55 | $24.12 | $26.39 | ×1.92 | ×0.91 |
| wear_strip | cnc:cnc-uhmw | 25 | $44.46 | $19.20 | $22.32 | ×1.99 | ×0.86 |
| star_wheel | routing:rt-delrin@12.7 | 1 | $101.05 | $71.45 | $49.09 | ×2.06 | ×1.46 |
| star_wheel | routing:rt-delrin@12.7 | 10 | $21.52 | $15.93 | $18.56 | ×1.16 | ×0.86 |
| star_wheel | routing:rt-delrin@12.7 | 25 | $15.95 | $12.00 | $16.52 | ×0.97 | ×0.73 |
| star_wheel | cnc:cnc-delrin | 1 | $130.97 | $93.50 | $99.35 | ×1.32 | ×0.94 |
| star_wheel | cnc:cnc-delrin | 10 | $65.80 | $27.35 | $38.28 | ×1.72 | ×0.71 |
| star_wheel | cnc:cnc-delrin | 25 | $58.86 | $22.26 | $34.21 | ×1.72 | ×0.65 |
| bracket_block | cnc:cnc-delrin | 1 | $114.01 | $100.55 | $139.24 | ×0.82 | ×0.72 (RFQ: legacy-features) |
| bracket_block | cnc:cnc-delrin | 10 | $50.54 | $33.70 | $57.81 | ×0.87 | ×0.58 (RFQ: legacy-features) |
| bracket_block | cnc:cnc-delrin | 25 | $44.46 | $28.25 | $52.38 | ×0.85 | ×0.54 (RFQ: legacy-features) |
| bracket_block | cnc:cnc-peek | 1 | $166.49 | $153.37 | $194.37 | ×0.86 | ×0.79 (RFQ: legacy-features) |
| bracket_block | cnc:cnc-peek | 10 | $97.77 | $81.24 | $112.94 | ×0.87 | ×0.72 (RFQ: legacy-features) |
| bracket_block | cnc:cnc-peek | 25 | $89.06 | $73.15 | $107.51 | ×0.83 | ×0.68 (RFQ: legacy-features) |
| bracket_block | cnc:cnc-aluminum-6061 | 1 | $118.38 | $108.50 | $160.64 | ×0.74 | ×0.68 (RFQ: legacy-features) |
| bracket_block | cnc:cnc-aluminum-6061 | 10 | $54.47 | $40.86 | $79.21 | ×0.69 | ×0.52 (RFQ: legacy-features) |
| bracket_block | cnc:cnc-aluminum-6061 | 25 | $48.17 | $35.01 | $73.78 | ×0.65 | ×0.47 (RFQ: legacy-features) |
| bracket_block | cnc:cnc-delrin+deburr | 1 | $117.79 | $104.33 | $139.24 | ×0.85 | ×0.75 (RFQ: legacy-features) |
| bracket_block | cnc:cnc-delrin+deburr | 10 | $53.94 | $37.10 | $57.81 | ×0.93 | ×0.64 (RFQ: legacy-features) |
| bracket_block | cnc:cnc-delrin+deburr | 25 | $47.66 | $31.46 | $52.38 | ×0.91 | ×0.60 (RFQ: legacy-features) |
| saddle_clamp | cnc:cnc-uhmw | 1 | $114.05 | $106.38 | $111.81 | ×1.02 | ×0.95 (RFQ: legacy-features) |
| saddle_clamp | cnc:cnc-uhmw | 10 | $50.58 | $38.95 | $40.56 | ×1.25 | ×0.96 (RFQ: legacy-features) |
| saddle_clamp | cnc:cnc-uhmw | 25 | $44.49 | $33.21 | $35.81 | ×1.24 | ×0.93 (RFQ: legacy-features) |
| saddle_clamp | cnc:cnc-delrin | 1 | $114.12 | $104.51 | $111.81 | ×1.02 | ×0.93 (RFQ: legacy-features) |
| saddle_clamp | cnc:cnc-delrin | 10 | $50.63 | $37.26 | $40.56 | ×1.25 | ×0.92 (RFQ: legacy-features) |
| saddle_clamp | cnc:cnc-delrin | 25 | $44.54 | $31.62 | $35.81 | ×1.24 | ×0.88 (RFQ: legacy-features) |
| saddle_clamp | cnc:cnc-nylon | 1 | $115.87 | $108.00 | $111.81 | ×1.04 | ×0.97 (RFQ: legacy-features) |
| saddle_clamp | cnc:cnc-nylon | 10 | $52.21 | $40.41 | $40.56 | ×1.29 | ×1.00 (RFQ: legacy-features) |
| saddle_clamp | cnc:cnc-nylon | 25 | $46.03 | $34.59 | $35.81 | ×1.29 | ×0.97 (RFQ: legacy-features) |
| bushing | cnc:cnc-delrin | 1 | $110.89 | $46.83 | $55.62 | ×1.99 | ×0.84 |
| bushing | cnc:cnc-delrin | 10 | $47.73 | $17.56 | $25.09 | ×1.90 | ×0.70 |
| bushing | cnc:cnc-delrin | 25 | $41.80 | $15.03 | $23.05 | ×1.81 | ×0.65 |
| bushing | cnc:cnc-ptfe | 1 | $119.08 | $51.44 | $55.62 | ×2.14 | ×0.92 |
| bushing | cnc:cnc-ptfe | 10 | $55.10 | $21.70 | $25.09 | ×2.20 | ×0.87 |
| bushing | cnc:cnc-ptfe | 25 | $48.76 | $18.95 | $23.05 | ×2.12 | ×0.82 |
| bushing | cnc:cnc-brass-360 | 1 | $121.25 | $54.55 | $55.62 | ×2.18 | ×0.98 |
| bushing | cnc:cnc-brass-360 | 10 | $57.06 | $24.50 | $25.09 | ×2.27 | ×0.98 |
| bushing | cnc:cnc-brass-360 | 25 | $50.61 | $21.59 | $23.05 | ×2.20 | ×0.94 |
| bushing | cnc:cnc-delrin(milling-for-comparison) | 1 | $110.89 | $91.41 | $55.62 | ×1.99 | ×1.64 (RFQ: legacy-features) |
| bushing | cnc:cnc-delrin(milling-for-comparison) | 10 | $47.73 | $25.48 | $25.09 | ×1.90 | ×1.02 (RFQ: legacy-features) |
| bushing | cnc:cnc-delrin(milling-for-comparison) | 25 | $41.80 | $20.49 | $23.05 | ×1.81 | ×0.89 (RFQ: legacy-features) |
| roller | cnc:cnc-uhmw | 1 | $176.57 | $84.57 | $94.89 | ×1.86 | ×0.89 |
| roller | cnc:cnc-uhmw | 10 | $106.84 | $51.52 | $54.17 | ×1.97 | ×0.95 |
| roller | cnc:cnc-uhmw | 25 | $97.63 | $47.11 | $51.46 | ×1.90 | ×0.92 |
| roller | cnc:cnc-nylon | 1 | $178.86 | $89.52 | $94.89 | ×1.88 | ×0.94 |
| roller | cnc:cnc-nylon | 10 | $108.90 | $55.98 | $54.17 | ×2.01 | ×1.03 |
| roller | cnc:cnc-nylon | 25 | $99.58 | $51.32 | $51.46 | ×1.94 | ×1.00 |
| roller | cnc:cnc-delrin | 1 | $164.04 | $84.83 | $94.89 | ×1.73 | ×0.89 |
| roller | cnc:cnc-delrin | 10 | $95.57 | $51.76 | $54.17 | ×1.76 | ×0.96 |
| roller | cnc:cnc-delrin | 25 | $86.98 | $47.33 | $51.46 | ×1.69 | ×0.92 |
| spacer | cnc:cnc-delrin | 1 | $109.29 | $37.57 | $26.72 | ×4.09 | ×1.41 |
| spacer | cnc:cnc-delrin | 10 | $46.29 | $9.23 | $6.36 | ×7.28 | ×1.45 |
| spacer | cnc:cnc-delrin | 25 | $40.44 | $7.17 | $5.01 | ×8.07 | ×1.43 |
| spacer | cnc:cnc-aluminum-6061 | 1 | $112.61 | $37.82 | $26.72 | ×4.21 | ×1.42 |
| spacer | cnc:cnc-aluminum-6061 | 10 | $49.27 | $9.44 | $6.36 | ×7.75 | ×1.48 |
| spacer | cnc:cnc-aluminum-6061 | 25 | $43.26 | $7.37 | $5.01 | ×8.63 | ×1.47 |
| thin_wall_housing | cnc:cnc-delrin | 1 | $156.08 | $210.69 | $169.13 | ×0.92 | ×1.25 (RFQ: legacy-features) |
| thin_wall_housing | cnc:cnc-delrin | 10 | $88.40 | $105.34 | $87.70 | ×1.01 | ×1.20 (RFQ: legacy-features) |
| thin_wall_housing | cnc:cnc-delrin | 25 | $80.21 | $94.18 | $82.27 | ×0.97 | ×1.14 (RFQ: legacy-features) |
| thin_wall_housing | 3d-printing:fdm-abs | 1 | $31.99 | $59.32 | $54.23 | ×0.59 | ×1.09 |
| thin_wall_housing | 3d-printing:fdm-abs | 10 | $23.01 | $47.12 | $44.05 | ×0.52 | ×1.07 |
| thin_wall_housing | 3d-printing:fdm-abs | 25 | $21.36 | $44.11 | $43.37 | ×0.49 | ×1.02 |
| thin_wall_housing | 3d-printing:sla-standard | 1 | $984.55 | $95.33 | $54.23 | ×18.16 | ×1.76 |
| thin_wall_housing | 3d-printing:sla-standard | 10 | $880.31 | $79.53 | $44.05 | ×19.98 | ×1.81 |
| thin_wall_housing | 3d-printing:sla-standard | 25 | $831.04 | $74.72 | $43.37 | ×19.16 | ×1.72 |
| thin_wall_housing | 3d-printing:fdm-pla | 1 | $31.45 | $58.05 | $54.23 | ×0.58 | ×1.07 |
| thin_wall_housing | 3d-printing:fdm-pla | 10 | $22.52 | $45.98 | $44.05 | ×0.51 | ×1.04 |
| thin_wall_housing | 3d-printing:fdm-pla | 25 | $20.91 | $43.03 | $43.37 | ×0.48 | ×0.99 |
| small_clip | routing:rt-delrin@3.2 | 1 | $89.14 | $61.44 | $35.55 | ×2.51 | ×1.73 |
| small_clip | routing:rt-delrin@3.2 | 10 | $10.80 | $6.93 | $5.02 | ×2.15 | ×1.38 |
| small_clip | routing:rt-delrin@3.2 | 25 | $6.00 | $6.00 | $2.98 | ×2.01 | ×2.01 |
| small_clip | cnc:cnc-delrin | 1 | $109.29 | $80.99 | $63.37 | ×1.72 | ×1.28 |
| small_clip | cnc:cnc-delrin | 10 | $46.29 | $16.10 | $12.48 | ×3.71 | ×1.29 |
| small_clip | cnc:cnc-delrin | 25 | $40.44 | $11.63 | $9.09 | ×4.45 | ×1.28 |
| small_clip | 3d-printing:fdm-pla | 1 | $8.00 | $11.29 | $16.33 | ×0.49 | ×0.69 |
| small_clip | 3d-printing:fdm-pla | 10 | $8.00 | $8.00 | $6.15 | ×1.30 | ×1.30 |
| small_clip | 3d-printing:fdm-pla | 25 | $8.00 | $8.00 | $5.48 | ×1.46 | ×1.46 |
| gear_disc | routing:rt-delrin@9.5 | 1 | $92.75 | $64.23 | $42.84 | ×2.17 | ×1.50 |
| gear_disc | routing:rt-delrin@9.5 | 10 | $14.05 | $9.44 | $12.31 | ×1.14 | ×0.77 |
| gear_disc | routing:rt-delrin@9.5 | 25 | $8.89 | $6.00 | $10.27 | ×0.87 | ×0.58 |
| gear_disc | cnc:cnc-delrin | 1 | $111.81 | $90.66 | $94.73 | ×1.18 | ×0.96 |
| gear_disc | cnc:cnc-delrin | 10 | $48.56 | $24.79 | $33.65 | ×1.44 | ×0.74 |
| gear_disc | cnc:cnc-delrin | 25 | $42.58 | $19.84 | $29.58 | ×1.44 | ×0.67 |
| gear_disc | 3d-printing:fdm-nylon | 1 | $30.55 | $26.00 | $29.00 | ×1.05 | ×0.90 |
| gear_disc | 3d-printing:fdm-nylon | 10 | $21.71 | $17.13 | $18.82 | ×1.15 | ×0.91 |
| gear_disc | 3d-printing:fdm-nylon | 25 | $20.14 | $15.78 | $18.14 | ×1.11 | ×0.87 |
| oversize_panel | routing:rt-hdpe@12.7 | 1 | $214.72 | $168.34 | $199.06 | ×1.08 | ×0.85 (RFQ: dfm-fail) |
| oversize_panel | routing:rt-hdpe@12.7 | 10 | $123.82 | $114.86 | $137.99 | ×0.90 | ×0.83 (RFQ: dfm-fail) |
| oversize_panel | routing:rt-hdpe@12.7 | 25 | $112.57 | $106.17 | $133.92 | ×0.84 | ×0.79 (RFQ: dfm-fail) |
| oversize_panel | cnc:cnc-hdpe | 1 | $1462.02 | $428.18 | — | — | — (RFQ: envelope) |
| oversize_panel | cnc:cnc-hdpe | 10 | $1263.75 | $191.16 | — | — | — (RFQ: envelope) |
| oversize_panel | cnc:cnc-hdpe | 25 | $1190.26 | $168.31 | — | — | — (RFQ: envelope) |
| cube_20mm | cnc:cnc-delrin | 1 | $109.59 | $82.16 | $42.20 | ×2.60 | ×1.95 |
| cube_20mm | cnc:cnc-delrin | 10 | $46.56 | $17.15 | $11.66 | ×3.99 | ×1.47 |
| cube_20mm | cnc:cnc-delrin | 25 | $40.70 | $12.62 | $9.63 | ×4.23 | ×1.31 |
| cube_20mm | cnc:cnc-aluminum-6061 | 1 | $112.98 | $83.07 | $42.20 | ×2.68 | ×1.97 |
| cube_20mm | cnc:cnc-aluminum-6061 | 10 | $49.61 | $17.96 | $11.66 | ×4.25 | ×1.54 |
| cube_20mm | cnc:cnc-aluminum-6061 | 25 | $43.57 | $13.39 | $9.63 | ×4.52 | ×1.39 |
| cube_20mm | routing:rt-delrin@19.1 | 1 | $88.66 | $62.00 | $36.32 | ×2.44 | ×1.71 |
| cube_20mm | routing:rt-delrin@19.1 | 10 | $10.37 | $7.43 | $5.78 | ×1.79 | ×1.28 |
| cube_20mm | routing:rt-delrin@19.1 | 25 | $6.00 | $6.00 | $3.75 | ×1.60 | ×1.60 |
| cube_20mm | 3d-printing:fdm-pla | 1 | $10.12 | $13.47 | $16.98 | ×0.60 | ×0.79 |
| cube_20mm | 3d-printing:fdm-pla | 10 | $8.00 | $8.00 | $6.80 | ×1.18 | ×1.18 |
| cube_20mm | 3d-printing:fdm-pla | 25 | $8.00 | $8.00 | $6.12 | ×1.31 | ×1.31 |
| drill_fixture_plate | routing:rt-hdpe@12.7 | 1 | $98.29 | $71.12 | $48.41 | ×2.03 | ×1.47 |
| drill_fixture_plate | routing:rt-hdpe@12.7 | 10 | $19.03 | $15.64 | $17.88 | ×1.06 | ×0.87 |
| drill_fixture_plate | routing:rt-hdpe@12.7 | 25 | $13.60 | $11.72 | $15.84 | ×0.86 | ×0.74 |
| drill_fixture_plate | routing:rt-acrylic@12.7 | 1 | $103.71 | $76.32 | $48.41 | ×2.14 | ×1.58 |
| drill_fixture_plate | routing:rt-acrylic@12.7 | 10 | $23.91 | $20.32 | $17.88 | ×1.34 | ×1.14 |
| drill_fixture_plate | routing:rt-acrylic@12.7 | 25 | $18.21 | $16.15 | $15.84 | ×1.15 | ×1.02 |
| drill_fixture_plate | routing:rt-aluminum-6061@12.7 | 1 | $141.90 | $101.67 | $48.41 | ×2.93 | ×2.10 |
| drill_fixture_plate | routing:rt-aluminum-6061@12.7 | 10 | $58.28 | $43.14 | $17.88 | ×3.26 | ×2.41 |
| drill_fixture_plate | routing:rt-aluminum-6061@12.7 | 25 | $50.67 | $37.69 | $15.84 | ×3.20 | ×2.38 |
| drill_fixture_plate | cnc:cnc-delrin | 1 | $153.93 | $109.26 | $112.05 | ×1.37 | ×0.98 |
| drill_fixture_plate | cnc:cnc-delrin | 10 | $86.47 | $41.54 | $50.98 | ×1.70 | ×0.81 |
| drill_fixture_plate | cnc:cnc-delrin | 25 | $78.39 | $35.65 | $46.91 | ×1.67 | ×0.76 |
| drill_fixture_plate | cnc:cnc-aluminum-6061 | 1 | $179.55 | $117.58 | $133.44 | ×1.35 | ×0.88 |
| drill_fixture_plate | cnc:cnc-aluminum-6061 | 10 | $109.52 | $49.02 | $72.37 | ×1.51 | ×0.68 |
| drill_fixture_plate | cnc:cnc-aluminum-6061 | 25 | $100.16 | $42.72 | $68.30 | ×1.47 | ×0.63 |
| seal_ring_peek | cnc:cnc-peek | 1 | $128.82 | $56.09 | $58.64 | ×2.20 | ×0.96 |
| seal_ring_peek | cnc:cnc-peek | 10 | $63.87 | $25.89 | $28.11 | ×2.27 | ×0.92 |
| seal_ring_peek | cnc:cnc-peek | 25 | $57.04 | $22.90 | $26.07 | ×2.19 | ×0.88 |
| seal_ring_peek | cnc:cnc-delrin | 1 | $110.56 | $45.84 | $50.58 | ×2.19 | ×0.91 |
| seal_ring_peek | cnc:cnc-delrin | 10 | $47.43 | $16.67 | $20.04 | ×2.37 | ×0.83 |
| seal_ring_peek | cnc:cnc-delrin | 25 | $41.52 | $14.20 | $18.01 | ×2.31 | ×0.79 |
| seal_ring_peek | cnc:cnc-ptfe | 1 | $117.77 | $49.09 | $58.64 | ×2.01 | ×0.84 |
| seal_ring_peek | cnc:cnc-ptfe | 10 | $53.92 | $19.59 | $28.11 | ×1.92 | ×0.70 |
| seal_ring_peek | cnc:cnc-ptfe | 25 | $47.64 | $16.95 | $26.07 | ×1.83 | ×0.65 |
