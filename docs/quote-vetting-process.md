# Quote vetting process

How to check that the instant-quote engine prices parts the way the shop would, before launch and every time a pricing rule changes. The harness lives in `tools/vet-quotes/`; the results of the latest run are committed next to it (`results.md`, `results.csv`, `results.json`).

The idea: a fixed library of 17 reference parts that look like real Straightedge work (plates, trays, guide rails, star wheels, brackets, bushings, rollers, spacers, a thin-wall housing, a tiny clip, a gear, an oversize panel, a 20 mm cube, a PEEK ring) is quoted through the real API at quantities 1 / 10 / 25 / 100 / 250, and every answer is compared against (a) hard rules the engine must never break, (b) an independent shop-time estimate built from the machine feeds in the `fusion-cam-programmer` skill, and (c) public price points. Anything that moves outside the bands is listed with the pricing-rule knob that controls it.

## 1. Running it

Prerequisites: Node 22, Python 3 with numpy (no CAD software, no other Python packages).

```bash
# 0. one-time
npm install && npm run build

# 1. generate the reference parts (writes tools/vet-quotes/parts/*.stl + manifest.json)
python3 tools/vet-quotes/generate_parts.py

# 2. start a throw-away server on port 3010 with a fresh database
rm -rf data && NODE_ENV=production PORT=3010 USE_SQLITE=true JWT_SECRET=test \
  STRIPE_SECRET_KEY=sk_test_dummy node server/index.js &

# 3. quote every part × configuration × quantity and grade the answers
env -u HTTPS_PROXY -u HTTP_PROXY -u http_proxy -u https_proxy NO_PROXY=localhost \
  node tools/vet-quotes/run_vetting.js            # --base http://host:port  --only part_id,…  --qtys 1,10

# 4. (optional) try pricing-rule changes offline against the recorded run, no server needed
node tools/vet-quotes/whatif.js --set cncMinimumMachineTime=0.15 --set cncToolingCostBase=2 --process cnc --qty 10
```

Notes

- The generator checks every mesh is closed (each edge shared by exactly two triangles, analytic volume matches) and refuses to write a broken one; the manifest records the true volume, hole/slot/pocket counts and cut perimeter so the parser's estimates can be graded.
- `run_vetting.js` sends a fresh `X-Forwarded-For` per request because the server rate-limits 200 API calls / 50 uploads per 15 minutes per IP and trusts one proxy hop in production mode. That only works against a local test server. Never point the harness at production: it creates ~270 parts and quotes in the database.
- `whatif.js` imports `server/processes/*/pricing.js` directly with `DEFAULT_PRICING_RULES` + your overrides. It does not touch the engine or the database. Nested rules use dots: `--set routerFeedMmPerMin.soft=3000`.
- To test a *stored* (admin-tuned) rule set instead of the defaults, just run step 3 against a server that has them — the API uses whatever rules are in its database.

## 2. Reading the output

`results.md` has four parts:

1. **Summary** — quote count, number of sanity-check fails/warnings, and a per-check table (which checks fired, on which parts).
2. **Per-part results** — for each part: what it is, the shop-time reasoning behind the estimate, a *true vs parsed* geometry table (bounding box, volume, holes/slots/pockets, cut perimeter, "estimated thickness"), and a quote table: unit price, line total, the engine's time (`machineTimeHours` for CNC, `cycleMinutes`/passes for routing, `printTimeHours` for 3D printing), DFM score and any FAIL, the gate decision (`instant` or `RFQ [codes]`), the shop estimate midpoint and the ratio **engine ÷ estimate**.
3. **Sanity checks** — every violation, with severity.
4. **BENCHMARK** — engine price at qty 1/10/25 next to an empty *Owner's price* column and a *Public benchmark* column fed from `tools/vet-quotes/benchmarks.json` (real published figures only, each with its URL).

`results.csv` is one row per quote with the same fields plus the cost breakdown (`materialCost`, `machineCost`, `toolingCost`, `setupPerUnit`, `finishCost`, `discount`), stock size and removal volume the CNC model assumed, parts-per-sheet for routing, and the parsed-vs-true geometry columns. Open it in a spreadsheet and pivot on `part`/`label`.

How to read the ratio column: **×1.0** means the engine matches the shop estimate; the estimate uses the engine's own $95/h and 30 % margin, so the ratio isolates the time + material model. The estimate has no volume-discount beyond setup amortisation, so at qty 100/250 the engine will read low — that is the discount table (`volumeDiscounts`), a policy choice, not a model error. Judge the model on qty 1 / 10 / 25.

### Sanity checks (what each one means)

| check | severity | rule |
|---|---|---|
| `price-falls-with-qty` | fail | unit price never rises with quantity for the same configuration |
| `routing-cheaper-than-cnc` | fail | a flat sheet part ≤ 1" thick is cheaper routed than milled, same material family, every quantity |
| `turning-vs-milling` | fail | pricing a turned part as `turning` lands within 0.5–2× of pricing it as `milling` |
| `peek-above-delrin` | fail | PEEK is dearer than Delrin for the same part |
| `minimum-price` | fail | unit price ≥ `minimumPartPrice` (CNC), `routerMinimumPartPrice`, `fdm/sla/slsMinimumPartPrice` |
| `qty-over-100-gated` | fail | qty > 100 always returns `gate.requiresRfq` with code `quantity`; qty ≤ 100 never does |
| `oversize-gated` | fail/warn | the 2600 × 300 panel is gated on every process with a size reason (`dfm-fail` or `envelope`) |
| `machine-time-red-flag` | fail/warn | a hand-sized part (≤ 150 mm) with > 4 h CNC/router time, or > 12 h print time |
| `vs-shop-estimate` | warn | engine price < 50 % or > 200 % of the shop estimate at qty 1/10/25 |
| `price-per-cm3-outlier` | warn | $/cm³ at qty 10 more than 4× or less than ¼ of the process median |
| `parser-volume` / `parser-holes` / `parser-perimeter` | warn | parsed volume > 2 % off; hole count ≥ 3 off or > 50 % off; cut perimeter outside 0.67–1.5× true |

## 3. Acceptance criteria per part type

The engine is ready to launch for a part type when every quote of that type passes the hard rules and sits inside the band below at qty 1, 10 and 25 (ratio = engine ÷ shop estimate, or ÷ the owner's own price once the Owner's column is filled).

| part type (library examples) | band | why that band |
|---|---|---|
| flat sheet, routed (`plate_hole_pattern`, `wear_strip`, `conveyor_guide_rail`, `star_wheel`, `gear_disc`, `drill_fixture_plate`) | 0.8–1.5× at qty 10/25; qty 1 may run to 2× (setup dominated) | the bread-and-butter product; losing money here compounds fast |
| flat sheet, milled (same parts on `cnc`) | 0.8–2.0×, and always above the routed price | these should push the customer to routing, not undercut it |
| pocketed plate / tray (`pocketed_tray`) | 0.8–1.5× on both processes, and routing within 2× of CNC | today routing ignores the pocket (see finding 2) |
| machined block (`bracket_block`, `saddle_clamp`, `cube_20mm`) | 0.8–1.5× for blocks with features; the cube may run 2× | a block with a pocket and tapped holes must price above a plain plate of the same stock |
| turned (`bushing`, `roller`, `spacer`, `seal_ring_peek`) | 0.7–1.5×; small turned parts ≤ 2× at qty 25 | manual-lathe parts are cheap per piece in batches; the engine must not price a Ø12 spacer like a bracket |
| thin-wall / enclosure (`thin_wall_housing`) | CNC 0.8–1.5×; FDM 0.7–1.5×; SLA ≤ 2× and never > CNC | SLA must not be the most expensive way to make a plastic box |
| tiny part (`small_clip`) | routing/FDM at or near the floor price; CNC ≤ 3× | floors are doing the work here — check they are sane, not that the model is |
| oversize (`oversize_panel`) | gated (`requiresRfq`) on every process, with a size reason | the budgetary price can be anything, the button must say RFQ |
| any part, qty > 100 | gated with code `quantity` | production runs are quoted by a person |

Parser accuracy is not a launch blocker as long as the pricing rules do not lean on the fields that are noise (see finding 7), but `parser-volume` must be clean: volume is the one input every model uses.

## 4. Which knob to turn for which miss

All names are keys of the rate card in `server/config/ruleSchema.js` (grouped Shop / Materials / CNC Machining / Turning / Routing / Printing / Discounts / Gate; every key has a label, a help line, a unit and a range, and the admin pricing page renders from that list). The models themselves, their equations and the justification for each default are in `docs/pricing-models.md`. Run `whatif.js` with the proposed value before saving it; nested tables use dots (`--set routerFeedMmPerMin.soft=3000`). Every quote's `meta.costBuildup` lists the steps (`{ step, minutes, dollars, basis }`) so you can see which term is off before picking a knob.

| symptom | knob(s) | direction / note |
|---|---|---|
| every CNC price is off by the same factor | `cncMachineRatePerHour`, `marginPercent` | rates first, models second |
| qty-1 CNC prices high/low, batches fine | `cncSetupMinutesFirst`, `cncSetupMinutesAdditional`, `cncInspectionMinutesPerLot` | per-lot minutes; the 4th-axis charge is `cnc4thAxisSetupMinutes` |
| small CNC parts (spacer, clip, cube) off per piece | `cncHandlingMinutesPerSetup`, `cncSawMinutesPerPart`, `cncInspectionMinutesPerPart`, `cncToolChangeMinutes`, `cncMinMinutesPerCm2` | these replaced the flat 15-minute floor; there is no flat floor left |
| pocketed / hollowed parts (tray, housing) off | `cncRoughingMrrCm3PerMin.<class>`, `cncFacingMrrCm3PerMin` | cm³/min at machinability 1.0, scaled by each material's machinability; compare "rough features" in the build-up with spindle time |
| feature-rich parts off, removal fine | `cncFinishCm2PerMin.prismatic` (walls/floors) or `.freeform` (3D scallop) | cm²/min of machined surface |
| holes mis-priced | `cncDrillApproachMinutes`, `cncDrillMmPerMin.<band>`, `cncPeckDepthRatio`, `cncPeckPenaltyPerDia`, `cncTapMinutesPerHole`, `cncCounterboreMinutes`, `cncHelicalBoreMinDiaMm` | need a feature list; without one a block gets `cncLegacyFeatureAllowance` and flat parts one approach per hole-sized contour |
| tight corners / deep pockets under-priced | `cncPocketCornerRefRadiusMm`, `cncPocketCornerPenaltyExponent`, `cncPocketDeepRatio`, `cncPocketDeepPenalty` | feature list only |
| thin / tall walls under-priced | `cncThinWallMm`, `cncThinWallPenalty`, `cncTallWallAspect`, `cncTallWallPenalty` | feature list only |
| plate parts carry too much facing / stock | `stockPaddingMm`, `plateThicknessMatchMm`, `standardPlateThicknessesMm` | flat parts and blocks at a standard plate thickness are bought as plate with no Z padding |
| PEEK/Ultem blanks priced wrong | material `pricePerKg`, `wasteFactor` (Materials page), `stockPaddingMm`, `standardBarDiametersMm` | turned parts use the next standard bar |
| tooling line wrong | `cncToolingPerMachineHour`, `latheToolingPerMachineHour`, `routerToolWearPerMeter` | per machine hour ÷ machinability, no per-piece floor |
| turned parts over/under | `latheSetupMinutes`, `latheFeedMmPerMin.<class>`, `latheDocMm.<class>`, `latheDrillMmPerMin.<band>`, `latheToolChangeMinutes`, `latheChamferMinutes`, `lathePartOffMmPerMin`, `latheNoFlipMaxLengthMm`, `latheRatePerHour` | the OD/bore/drill/part-off steps are each in the build-up |
| routed parts too dear at qty 1 | `routerSetupMinutes` | 20 min of nest + CAM + first article |
| routed cycle time wrong | `routerFeedMmPerMin.<class>`, `routerMaxDocMm.<cutter>`, `routerThickToolFeedFactor`, `routerSmallToolFeedFactor` | chip load × flutes × 18k RPM (skill); 1/4" and 3/8" plastics are one pass |
| routed pockets wrong | `routerPocketCm3PerMin.<class>` | cm³/min cleared |
| holes / inner contours on the router | `routerHoleSeconds` | per plunge; counts come from the feature list, else inner edge length ÷ 40 mm |
| per-sheet work (load, tool changes) | `routerSheetHandlingMinutes`, `routerToolChangeSeconds`, `routerToolsPerJob`, `routerSheetWMm/HMm` | shared by the parts on a sheet, not charged per part |
| routed part floor | `routerMinimumPartPrice`, `routerTabMinutesPerPart`, `routerHandlingMinutesPerPart` | |
| FDM too dear / cheap | `fdmMachineRatePerHour`, `fdmDepositionMm3PerSec`, `fdmInfillDepositionMm3PerSec`, `fdmShellThicknessMm`, `fdmPostProcessMinutesBase`, `fdmPostProcessMinutesPer100Cm2` | thin-wall parts are shell-dominated; compare the slicer's time with `meta.printTimeHours` |
| SLA / SLS off | `slaLayerTimeSec`, `slaScanTimeSecPerCm2`, `slaPostProcessMinutes`, `sls*` | scan time is charged on the mean cross-section (volume ÷ height), not the footprint |
| volume breaks too generous / too stingy | `volumeDiscounts`, `nestingEfficiencyBonus` | |
| gate too eager / too lax | `rfqQuantityThreshold`, `bigTicketLineTotal`, `lowVolumeRatio`, `gateReviewOnLegacyFeatures`, `gateReviewThinWallMm` | now rules, not code constants |
| anything cheaper than it should be at the bottom end | `minimumPartPrice`, `fdm/sla/slsMinimumPartPrice`, `minimumOrderTotal` | floors |
All names are keys of `DEFAULT_PRICING_RULES` in `server/config/defaults.js`, described (label, plain-language help, unit, allowed range, default) in `server/config/ruleSchema.js`, and editable from the admin **Pricing** tab (nested feed table and discount tiers included). The console prices six of the reference parts below live as you type — the same numbers `whatif.js` gives — and every save needs a one-line note that goes into the pricing history (`History` button; any earlier rule set can be restored). Run `whatif.js` for the full 17-part library before saving a big change.

| symptom | knob(s) | direction / note |
|---|---|---|
| every simple CNC part costs the same (~$110 @1, ~$47 @10) | `cncMinimumMachineTime` | the 0.25 h floor is what you are seeing; lower it (0.10–0.15) and let the roughing/finishing terms carry |
| tiny CNC parts (spacer, clip, cube) absurd per piece | `cncToolingCostBase`, `cncMinimumMachineTime` | tooling is $5 × 2 ÷ machinability per piece regardless of size; drop the base to 1.5–2 |
| plate parts on CNC carry too much "removal" | `cncStockPaddingMm` | padding is added on all six faces, so a 1/4" plate is costed from 1/2" stock; 1.5 mm halves the fake removal |
| turned parts over-priced | `cncTurningMultiplier` | 1.2 means "slower than the mill"; a batch of bushings on a manual lathe with stops is faster per piece — 0.6–0.8 |
| big removal parts (tray, roller) over/under | `cncRoughingRate` (cm³/h at machinability 1.0), `cncFinishingRate`, `cncFinishingPassRatio` | 900 cm³/h ≈ 15 cm³/min matches the Tormach in 6061 (chip-load limited at 5,140 RPM); plastics scale by `machinability`. Finishing is 15 % of *stock* volume at 400 cm³/h — it grows with stock size, not surface area |
| PEEK/Ultem blanks priced wrong | material `pricePerKg` (per material, admin materials page), `cncStockPaddingMm` | material = bbox + padding, so padding matters most on $130/kg stock |
| routed parts too dear at qty 1 | `routerSetupCost` | $60 per job is ≥ $88 for any qty-1 router part; 40–45 = 25–30 min of nest + CAM + first article |
| routed cycle time wrong | `routerFeedMmPerMin.{soft,medium,brittle,abrasive,aluminum}`, `routerMaxPassDepthMm` | feeds should come from chip load × flutes × RPM (skill: 1/4" O-flute HDPE 0.006" × 18k = 2,740 mm/min; acrylic 2-flute 0.002" × 2 × 18k = 1,830). `routerMaxPassDepthMm` = 6.0 makes 1/4" (6.35 mm) stock a two-pass cut; 6.5 fixes it |
| holes mis-priced on the router | `routerHoleSeconds` | 4 s per detected hole, but the detected count is noise (finding 7); keep it small until the parser counts holes |
| routed part floor | `routerMinimumPartPrice` | $6 is hit at qty 100 for most small parts; raise if de-tab/inspection costs more |
| volume breaks too generous / too stingy | `volumeDiscounts` | applies to the whole per-unit base (material included), on top of setup amortisation |
| SLA absurd | `slaScanTimeSecPerCm2`, `slaLayerTimeSec` | scan time is charged on the bounding-box footprint for every layer; 1.5 s/cm² makes a 120 × 80 × 40 box 34 h |
| FDM thin-wall parts under-priced | `fdmInfillPercent`, `fdmPrintSpeedMmPerSec`, `fdmMachineRatePerHour` | printed volume = part × (infill + 0.3 shell); thin-walled parts are ~100 % perimeter, so raise infill or slow the speed |
| anything cheaper than it should be at the bottom end | `minimumPartPrice`, `fdmMinimumPartPrice`, `slaMinimumPartPrice`, `minimumOrderTotal` | floors |
| gate too eager / too lax | `rfqQuantityThreshold`, `bigTicketLineTotal`, `lowVolumeRatio` (admin pricing console → Gate) | the defaults come from `shared/brand.json` and `server/services/quoteGate.js`; the saved rule wins |

## 5. Findings from the 2026-10-28 run (defaults as shipped, commit d62bd57)

> Historical: these findings drove the feature-based models in `docs/pricing-models.md`. The knob names below are the old flat rule keys; the after-run with the new models is in `docs/pricing-models.md` §4 and `tools/vet-quotes/results.md` (median engine ÷ estimate ×0.97, 5 of 156 quotes outside 0.5–2×, all explained there).

265 quotes, 0 hard-rule fails, 88 warnings. The rules the engine must never break all hold: prices fall monotonically with quantity, routing beats CNC on every flat part, PEEK > Delrin, every floor is respected, qty 250 is always an RFQ, the oversize panel is gated on both processes (bed-size FAIL on routing, mill-envelope on CNC) and the 600 mm guide rail is gated on CNC for exceeding X travel. What is wrong is the *level* and *shape* of the prices:

1. **The CNC time model has no discriminating power.** 10 of the 17 parts (23 of 34 CNC configurations) sit on the 15-minute floor (`cncMinimumMachineTime`), so a 20 mm cube ($109.59 @1, $46.56 @10), a Ø12 × 6 spacer ($109.29 / $46.29), a Ø60 PEEK ring and a 100 × 60 × 25 bracket with a pocket and four tapped holes ($114.01 / $50.54) all price within 5 % of each other. Time is "stock − part" volume only; there is no term for holes, pockets, faces or setups. Median engine ÷ estimate for CNC is ×1.9, spread 0.65–8.6.
   *Knobs:* `cncMinimumMachineTime` 0.25 → **0.15**, `cncToolingCostBase` 5 → **2**, `cncStockPaddingMm` 3 → **1.5**, `cncRoughingRate` 900 → **1100**. Offline (`whatif.js`) this moves the CNC median to ×1.15 (spread 0.43–4.6): plates/bushings/star wheel land at 0.9–1.2×, but the bracket drops to ×0.55 because nothing in the model sees its features. That is the limit of knob tuning — see §6.
2. **Routing ignores pockets.** The 200 × 150 × 3/4" tray (259 cm³ pocket) is quoted at 2.4 min cycle / $20.82 @10 on the router versus 42 min / $108.91 on the mill — the same part, 5× apart, and the router number is ~0.5× the shop estimate. Routing cycle time is profile length ÷ feed + 4 s per "hole"; there is no removal term at all. No knob fixes this (§6).
3. **SLA is broken by the footprint proxy.** The thin-wall housing on `sla-standard` = 33.8 h, $984.55 @1 (30× the FDM price, 6× the CNC price); it is gated only because the line crosses $5,000 at qty 10. Scan time is 1.5 s/cm² × the *bounding-box* footprint (96 cm²) × 800 layers.
   *Knob:* `slaScanTimeSecPerCm2` 1.5 → **0.1** gives 3.9 h / $131 @1, inside 2.5× of the estimate; the right fix is to scale the footprint by part ÷ bbox volume (§6).
4. **FDM under-prices thin-walled parts.** Same housing: 1.89 h, $31.99 @1 / $23.01 @10 vs ~$54 / $44 estimated (0.52–0.59×). The printed-volume formula (infill + 0.3 shell) assumes a chunky part; a 2.5 mm-wall box is almost all perimeter. `fdmPrintSpeedMmPerSec` 60 → **45** is a safe partial fix (solid parts like the gear disc stay within ×1.6); the honest fix uses surface area × wall thickness for the shell term.
5. **Routing qty-1 prices are 2–2.5× the estimate** on every small part ($88–$101 for anything, including a 20 × 10 × 3 clip) because `routerSetupCost` = $60 is amortised over one piece; the only published competitor price point (SendCutSend, ABS .125" 3.5 × 3.5 in, $7.42 @1 with no setup fee) is an order of magnitude lower. Qty 10/25 are 1.1–1.7× — fine. *Knob:* `routerSetupCost` 60 → **45** (25–30 min at $95/h) if the shop wants one-offs; keep 60 if it does not.
6. **Router feeds are 1.4–1.8× faster than chip-load math allows, and 1/4" stock is a two-pass cut.** `routerFeedMmPerMin.soft` = 5,000 (197 ipm) vs 2,740 for a 1/4" O-flute at 0.006"/tooth and 18,000 RPM (3,650 for a 3/8"); `medium` 3,800 vs 2,700; `brittle` 3,000 vs 1,830. `routerMaxPassDepthMm` = 6.0 < 6.35, so the most common sheet gets two passes. The two errors roughly cancel today, which is why routing medians look fine; they will not cancel on a long-profile part. *Knobs:* soft **3000**, medium **2700**, brittle **1800**, aluminum **1800** (the skill says never slower than chip load at 18k), `routerMaxPassDepthMm` **6.5**.
7. **`estimatedHoles` is noise, and `estimatedPerimeter` is 1.5–2× high on plain plates.** Holes: bushing 20 (has 1), roller 20 (1), seal ring 20 (1), drill fixture plate 4 (has 20), saddle clamp 10 (2), wear strip 6 (0 holes, 4 slots). The count comes from normal-direction buckets, so a 48-facet bore reads as "20 holes" and twenty 32-facet holes read as "4". Perimeter: plate 1,000 mm (true 624), oversize panel 11,600 (5,925) — the formula subtracts only 70 % of two face areas, then caps at 4 × (W + H). Everything downstream of these two fields (`routerHoleSeconds`, the interpolated-hole cut length, the undercut and slot DFM notes) is driven by noise. Volume and bounding box are exact on every part.
8. **Turning is priced as milling.** `cncTurningMultiplier` = 1.2 never acts because turned parts sit on the time floor; `bushing` prices identically as `turning` and `milling` ($110.89). With the floor lowered, 1.2 makes the roller 41 min / $107 @10 (estimate 18 min / $54); **0.6** lands it at 15 min / $46.
9. **Per-piece tooling is a hidden $7.69–$11.11 floor.** `cncToolingCostBase` × `cncToolingMachinabilityScale` ÷ machinability is charged per part independent of time, so a spacer carries the same wear charge as a 40-minute roller. Drop the base to 2 (or make it per machine-hour in code).
10. **The gate works, with one gap.** `big-ticket` ($5,000 line) catches the SLA disaster and every 250-piece CNC line; `envelope` catches the 600 mm rail; `dfm-fail` catches the panel. But `complex-geometry` (volume ratio < 0.12) never fired on the thin-wall housing (ratio 0.17) or the bracket (0.91) — the two parts the time model under-prices most. Consider raising `LOW_VOLUME_RATIO` to 0.2 or gating on surface-area ÷ volume once that is in the model.

A conservative launch rule set from this run: `cncMinimumMachineTime 0.15`, `cncToolingCostBase 2`, `cncStockPaddingMm 1.5`, `cncRoughingRate 1100`, `cncTurningMultiplier 0.6`, `routerSetupCost 45`, `routerFeedMmPerMin {soft 3000, medium 2700, brittle 1800, abrasive 1500, aluminum 1800}`, `routerMaxPassDepthMm 6.5`, `slaScanTimeSecPerCm2 0.1`, `fdmPrintSpeedMmPerSec 45`. It errs toward over-pricing simple parts and under-pricing feature-rich blocks, which is the safer side only if the owner reviews CNC blocks by hand (see the gate note above).

## 6. Model gaps that knobs cannot fix (code changes, with evidence)

Status: every item below is implemented by the feature-based models (`docs/pricing-models.md` §2) except the parser items, which belong to the geometry module (`server/geometry/SCHEMA.md`); until it ships `features`, the adapter derives hole-free equivalents from surface area and volume.

- **CNC: add a feature/surface term.** Surface area is parsed exactly on every part. `finishMinutes = surfaceArea_cm² ÷ finishRate_cm²PerMin` (≈ 8–10 cm²/min for a 3/8" endmill at 1 mm step-over, 40 ipm) replaces the stock-volume finishing term and separates the bracket (228 cm²) from the cube (24 cm²). Keep a per-part handling constant (load/unload, deburr) instead of a 15-min machine floor.
- **CNC: pad stock per axis.** Plate stock is bought at thickness; pad X/Y by 3 mm and Z by 0 when the part's thinnest dimension matches a stock plate size (±0.6 mm). Removes 110 cm³ of fake removal on the 1/4" plate.
- **Routing: add a pocket term.** `pocketCm3 = flatArea × thickness − partVolume` (all three are good numbers); `pocketMinutes = pocketCm3 ÷ routerRemovalCm3PerMin` with ~30 cm³/min for soft plastics (3/8" O-flute, 6 mm DOC, 50 % step-over at 3,600 mm/min is ~100 cm³/min theoretical). Tray: 259 cm³ → +8.6 min, which is what the shop estimate says.
- **Routing: charge tool changes per sheet, not per part.** `routerToolChangeSeconds × 2` is added to every part's cycle; in a nest it happens once per sheet (`partsPerSheet` is already computed).
- **SLA/SLS: use the real mean cross-section.** `layerAreaCm2 × (partVolume ÷ bboxVolume)` instead of the footprint. Thin-wall housing: 96 cm² → 16 cm².
- **FDM: shell volume from surface area.** `shell = surfaceArea × wallThickness(≈1.2 mm)`, `infill = (volume − shell) × infill%`. The thin-wall housing then prints in ~4.5 h, not 1.9.
- **Parser: count holes from the mesh, not from normal buckets.** Cluster cylindrical facets by axis + radius (the `fusion-cam-programmer` geometry-inventory approach) and report diameter and depth per hole; derive the cut perimeter from the top-face polygon (or `2 × (flatArea − faceArea) ÷ thickness` with the *actual* face area), not from total surface area with a 0.7 fudge.
- **Turning: time from length, not volume.** OD passes = length ÷ feed-per-rev × RPM, bore/drill time from depth; a Ø50 × 200 roller is two OD passes and one deep drill, not 317 cm³ of "removal".

## 7. Calibration loop after launch (first 10 orders)

Run this for the first ten paid jobs of each process, then monthly.

1. **Capture the engine's assumptions at order time.** For every ordered line save: `meta.machineTimeHours` / `meta.cycleMinutes` / `meta.printTimeHours`, `meta.geometrySummary` (stock, removal, volume ratio), the per-unit breakdown and the rules version. The admin order view already shows these; add them to the traveler header so the machinist sees the number the customer paid for.
2. **Record actuals on the traveler, then in the admin Calibration tab.** Setup minutes (program + fixture + first article), cycle minutes per piece (spindle time from the control, or stopwatch), hand time per piece (de-tab, deburr, tap, inspect), material actually bought (stock size and price), tooling consumed, scrap count. The Calibration tab lists every finished order line with the engine's minutes per piece next to an *Actual min/pc* box; type the cycle minutes there (and a note). It computes the per-process `actual ÷ engine` median and, after three measured jobs, suggests one conservative knob change (halfway toward the measured ratio, pointing at the minimum-time floor when that is what priced the parts) with a button that carries it into the Pricing console as an unsaved draft.
3. **Compute the three ratios per job:** `engineTime ÷ actualTime`, `engineMaterial ÷ actualMaterial`, `enginePrice ÷ (actualCost ÷ (1 − margin))`. Put them in a sheet with the part's family (flat-sheet / pocket-plate / machined-block / turned / enclosure / tiny) and the parser's volume ratio and surface area.
4. **After 10 jobs per process, adjust one knob family at a time**, largest median error first, using §4 to pick the knob and `whatif.js` to see what it does to the reference library before saving it. Rules of thumb:
   - time ratio off but material fine → rates (`cncRoughingRate`, `routerFeedMmPerMin`, `fdmPrintSpeedMmPerSec`) or floors (`cncMinimumMachineTime`);
   - material ratio off → `pricePerKg` per material (admin materials page), `cncStockPaddingMm`, `routerKerfMarginMm`, `routerNestYield`;
   - price ratio off while time and material are fine → `cncSetupCost` / `routerSetupCost`, `cncToolingCostBase`, `marginPercent`, `volumeDiscounts`;
   - one family off while the others are fine → that is a model gap (§6), not a knob; gate that family to RFQ (`quoteGate.js`) until the model is fixed.
5. **Re-run the harness** (`generate_parts.py` once, `run_vetting.js` after every rule save) and keep `results.md` in the commit that changes the rules, so the price history of the 17 reference parts is in git.
6. **Fill the Owner's price column** in the BENCHMARK table from the travelers (or from Xometry's instant quote of the same STL files — the shop is a partner and can run the 17 files through xometry.com in ten minutes). Once that column exists it replaces the shop estimate as the target band in §3.
7. **Stop criteria:** median price ratio within 0.85–1.15 and no family outside 0.7–1.5 for two consecutive months → stop monthly tuning, re-run only when rules, materials or machines change.
