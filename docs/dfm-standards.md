# DFM standards — Straightedge quoting engine

The design-for-manufacturability rules behind the instant quote, with the industry source for every threshold and how each one is applied to **this shop**:

| Machine | Capacity | Notes |
|---|---|---|
| Tormach 1100 + CNC Bridgeport (3-axis, 4th axis available) | travel 457 × 241 × 300 mm | smallest production end mill 1/16" (Ø1.59 mm) |
| Manual lathes | Ø250 × 600 mm between centres | plastics, brass, aluminum |
| Techno router | 59" × 96" bed (1499 × 2438 mm), 12" Z, 12-tool ATC | stock 48" × 96"; tools 1/16", 1/8", 1/4", 3/8" |
| FDM printers | up to 12 × 12 × 24" (305 × 305 × 610 mm) | PLA, ABS, PETG, nylon, TPU, CF-nylon |
| Formlabs SLA | ~6 × 6 × 7" (152 × 152 × 178 mm) | standard, tough, … resins |

Materials: acetal/Delrin, UHMW, HDPE, nylon, PEEK, Ultem, PTFE, polycarbonate, acrylic, PVC, PP, G-10, phenolic, 6061, brass.

Code: `server/processes/{cnc,routing,3d-printing}/dfm.js`, `server/processes/cnc/turning.js`, shared helpers in `server/processes/dfmKit.js`, and the feature adapter `server/processes/featureAdapter.js`. Tests: `server/processes/dfm-rules.test.js` (synthetic features), `server/parsers/dfm.test.js` (legacy path). Validation harness: `node tools/vet-quotes/dfm_vetting.js`.

## 1. Philosophy

Two tiers, as in `server/processes/shared.js`:

- **FAIL** (blocks instant checkout → RFQ) only for genuine un-makeability: the part exceeds every machine in the shop in every orientation, zero-thickness geometry, a non-manifold mesh, or a sharp internal vertical corner in a cavity measured on a B-rep.
- **WARN** for everything that is makeable but costs money, yield or tolerance. Every warning carries a `cost` hint (`minor` | `major`) for pricing to consume.
- **INFO** for capability notes and material advisories. Excluded from the score.

Every check records `{ id, label, severity, detail, cost, confidence, measured, threshold }`. `detail` states the measured value, the threshold and what to change (e.g. *"Hole Ø4.2 × 32.0 mm deep is 7.6× diameter; standard drills reach 6× reliably … Options: reduce depth, open the hole to Ø5.3 (6×), drill from both ends, or accept a per-hole peck-drilling adder"*).

**Confidence policy** (`dfmKit.gate`): a FAIL is only emitted when the feature behind it has confidence ≥ 0.9 (B-rep measured, or exact extents). At 0.6–0.9 it degrades to WARN, below 0.6 (or `"legacy"`) to INFO, and the detail is suffixed *"verify …"*. A WARN never blocks, so it is kept at any confidence but annotated. Legacy geometry (bounding box + mesh totals, today's parser) can therefore only FAIL on extents — exactly the behaviour the site had before.

**Material awareness** (`dfmKit.materialProfile`): thresholds switch on plastic vs metal and on flags — `brittle` (acrylic, G-10, phenolic), `hygroscopic` (nylon), `soft` (UHMW, HDPE, PP, PTFE, TPU), `amorphous` (PC, acrylic, Ultem, PVC — coolant stress-cracking), `stressRelief` (acetal, nylon, PC, PEEK, Ultem), `abrasive` (G-10, phenolic, CF-nylon), `highCost` (PEEK, Ultem), `warpProne` (ABS, nylon FDM). The API passes `materialSlug`/`materialName` with each quote.

## 2. Sources

| Key | Source | URL |
|---|---|---|
| Hubs-CNC | Hubs (Protolabs Network) — *How to design parts for CNC machining* (design-rules table) | https://hubs.com/knowledge-base/how-design-parts-cnc-machining |
| Protolabs-6 | Protolabs — *6 ways to optimize part design for CNC machining* | https://www.protolabs.com/resources/design-tips/6-ways-to-optimize-part-design-for-cnc-machining/ |
| Protolabs-cost | Protolabs — *CNC cost reduction tips* (PDF) | https://www.protolabs.com/media/3bjotobs/pl_cnc_cost_reduction_tips_en.pdf |
| Protolabs-turn | Protolabs — *Design guidelines: CNC turning* | https://www.protolabs.com/services/cnc-machining/cnc-turning/design-guidelines/ |
| Xometry-tips | Xometry Pro — *Design tips for CNC machining* | https://xometry.pro/en/?p=1975 |
| Xometry-thin | Xometry — *CNC machining: how to avoid high costs on thin walls* | https://www.xometry.com/blog/cnc-machining-thin-walls |
| Fictiv | Fictiv — *Optimizing part design for CNC machining* | https://www.fictiv.com/?p=20227 |
| Quadrant | Quadrant (now Mitsubishi Chemical Advanced Materials) — *Machining instructions for engineering plastics* | https://www.theplasticshop.co.uk/plastic_technical_data_sheets/engineering_plastics_machining_guide.pdf |
| Boedeker-mach | Boedeker Plastics — *Plastic machining guidelines* | https://www.boedeker.com/Technical-Resources/Plastic-Machining-Guidelines |
| Boedeker-anneal | Boedeker Plastics — *Plastic annealing guidelines* | https://boedeker.com/Technical-Resources/Technical-Library/Plastic-Annealing-Guidelines |
| Curbell | Curbell Plastics — *Plastic machining guidelines* and *Dimensional tolerance challenges* (slides) | https://www.curbellplastics.com/services-capabilities/fabrication-machined-parts/plastic-machining-guidelines/ · https://www.curbellplastics.com/wp-content/uploads/2023/10/Dimensional-Tolerance-Challenges-Slides.pdf |
| Ensinger | Ensinger — *How annealing improves machinability and dimensional stability* | https://www.ensingerplastics.com/en-us/injection-molding/blog/how-annealing-improves-machinability |
| SCS-CNC | SendCutSend — *CNC routing guidelines* / *Design guidelines for composite, plastic and wood* | https://sendcutsend.com/CNC-guidelines · https://sendcutsend.com/?p=5888 |
| SCS-tol | SendCutSend — *Basic tolerances and cut feature relationships* (sheet rules adapted to the router) | https://sendcutsend.com/blog/basic-tolerances-and-cut-feature-relationships/ |
| Biesse | Woodworking Network / Biesse — *5 steps to rout a clear edge on acrylic* | https://www.woodworkingnetwork.com/best-practices-guide/cutting-grinding-cutting-tools-grinders/how-rout-clear-edge-acrylic |
| Formlabs | Formlabs — *Design specifications for 3D models (Form 3)* | https://formlabs.com/support/Design-specifications-for-3D-models-form-3/ |
| Hubs-3DP | Hubs — *Design rules for 3D printing* table (FDM/SLA/SLS; mirrored copy) | https://storytelling.robotics.umich.edu/assets/images/designrulesfor3dprinting.pdf |
| Hubs-FDM | Hubs — *How to design parts for FDM 3D printing* | https://www.hubs.com/knowledge-base/how-design-parts-fdm-3d-printing/ |
| UZH-FDM | University of Zurich AMF — *Design guideline FDM* | https://www.amf.uzh.ch/dam/jcr:fd1ee024-1a98-488b-89ec-ffd85befa786/Design-Guideline-FDM.pdf |
| 3ERP | 3ERP — *How to design CNC turned parts* (L/D ≈ 3:1) | https://www.3erp.com/blog/how-to-design-cnc-turned-parts/ |
| MakerVerse | Wevolver / MakerVerse — *Best practices: designing for CNC turning* | https://wevolver.com/article/best-practices-designing-for-cnc-turning |
| shop | Straightedge shop rule (tooling on hand, machine capacity, experience) | — |

Blocked during research (fetch permission not granted; thresholds taken from the mirrors above): https://www.protolabs.com/services/cnc-machining/design-guidelines/ and https://www.hubs.com/knowledge-base/how-design-parts-cnc-machining/. OSH Cut's guideline pages were not reachable; the SendCutSend sheet rules stand in for the "OSH Cut-style" sheet rules.

Key numbers from the sources (for reference): Hubs-CNC — internal vertical radius ≥ ⅓ cavity depth, floor radius 0.5/1/none, wall 0.8 mm metal / 1.5 mm plastic (0.5 / 1.0 feasible), hole depth 4× (10× typical, 40× special), thread ≥ M6 and length 3× (1.5× min), cavity depth ≤ 4× width, min cavity 2.5 mm, ±0.1 mm typical, engraved 20 pt text, undercut clearance ≥ 4× depth. Protolabs-6 — min feature 0.5 mm, text stroke 0.5 mm, holes "much more than six diameters deep become a challenge", parts > 254 × 178 mm top/bottom only. Protolabs-cost — cavity depth ≤ 4× largest XY, H < 4 W, thread ≤ 3× dia + 0.5× relief, metal walls > 0.8 mm, part < blank − 3 mm. Protolabs-turn — Ø4.07–100 mm, length 1.27–229 mm, region Ø ≥ 0.76 mm, wall ≥ 0.5 mm, radial holes ≥ 2 mm (1 mm Al/brass), OD groove ≥ 1.2 mm (0.5 mm Al/brass), ±0.13 mm. Xometry-tips — 0.794 mm metal / 1.5 mm plastic walls, edge radius 130% of tool radius, cavity 3–4× (> 6× deep), hole depth 4× (10× possible), thread ≤ 2×, 2.5 mm min tool. Xometry-thin — 1/32" rule of thumb, H:T ≤ 10:1. Fictiv — 0.5 mm metal / 1.0 mm plastic, drill depth 6× (12× extended), end mill 5× dia (10× extended), tap 3:1. Quadrant — coolant past 2× dia, peck every 1.5× dia, tolerance 0.1–0.2% of nominal (min 0.05 mm), R ≥ 1 mm, chamfer ≥ 1 × 45°, nylon drying ≥ 24 h / 3 mm, plug thin tubes, light clamping. Boedeker-mach — ±0.001 in/in, thermal expansion up to 10× metal, amorphous plastics craze with petroleum coolants, anneal after heavy/asymmetric removal, balanced machining. Boedeker-anneal — schedules per material (e.g. Delrin 320 °F, 30 min per ¼"; PEEK 300→375 °F, 60 min per ¼"), "becomes more important as machining volume increases". SCS-CNC — 0.125" bit, min hole 0.125", inside R 0.063", dog-bones, min part 1" × 2", max removal 50%, tabs 0.1875" wide × ½ t. SCS-tol — hole ≥ 50% t, web ≥ 50% t (prefer 1–1.5× t), hole ≥ 1× d from edge, slot ≥ 1.5× w, ±0.005". Biesse — depth per pass ≈ 2× bit dia, O-flute, cast vs extruded acrylic. Formlabs — supported/unsupported wall 0.2 mm, unsupported overhang ≤ 5 mm and ≥ 10° from level, bridge 29 mm (5 × 3 beam), wires 0.2–1.5 mm by height, emboss 0.1 / engrave 0.15, clearance 0.5, hole 0.5, drain hole ≥ 2.5 mm. Hubs-3DP — FDM 0.8/0.8 walls, 45°, 0.6 × 2 text, 10 mm bridge, Ø2 hole, 0.5 clearance, 3 mm pin, ±0.5% (≥ ±0.5); SLA 0.5/1.0, 0.4 text, Ø0.5, 0.5 clearance, ±0.5% (≥ ±0.15); SLS 0.7, 1 mm text, Ø1.5, 0.3/0.1 clearance, ±0.3% (≥ ±0.3). Hubs-FDM — bridges < 5 mm clean, pins < 5 mm weak, holes print undersize (drill). UZH-FDM — 1.0 mm walls, 45°, Ø2 hole, Ø3 pin, 0.5 clearance, 1 mm emboss, 2 mm feature, 14 pt text. 3ERP — L/D ≈ 3:1 ideal. MakerVerse — 0.4 mm stock allowance, 0.5° draft on groove walls, thread relief where the OD is below the minor diameter.

## 3. CNC milling rules (`subProcess: "milling"`)

Feature fields are from `server/geometry/SCHEMA.md`. "Legacy" = what the adapter derives today.

| id | Rule | Threshold | Severity · cost | Source | Legacy behaviour |
|---|---|---|---|---|---|
| `cnc-mesh-integrity` | mesh manifold / watertight | `mesh.manifold === false` → FAIL; `watertight === false` → WARN major; self-intersections → WARN minor | FAIL / WARN | shop | skipped (not measured) |
| `cnc-min-wall-thickness` | `walls.minThickness` | plastic ≥ 1.5 rec / 1.0 feasible; brittle plastic ≥ 2.0 / 1.5; metal ≥ 0.8 / 0.5; ≤ 0.05 = zero thickness | < feasible WARN major; < rec WARN minor; zero → FAIL (conf ≥ 0.9) | Hubs-CNC, Xometry-tips, Fictiv, Boedeker-mach (acrylic) | bbox proxy, WARN only |
| `cnc-thin-area` | `walls.thinAreaFraction` | > 20% of area under 1 mm | WARN major | shop | skipped |
| `cnc-max-size` | extents vs travel, any orientation | 457 × 241 × 300; flat part that fits the router → WARN (reroute); ≤ 2 × 457 long → WARN (indexed, two setups); else FAIL | WARN major / FAIL | shop, Protolabs-6 (top/bottom only > 254 mm) | exact (conf 1.0) |
| `cnc-corner-radius` | `cornerRadii.minInternalVertical`, `pockets[].minCornerRadius` vs depth | R < 0.1 in a cavity > 2 mm deep → FAIL (conf ≥ 0.9); R < 0.79 (1/16" tool) → WARN major; brittle & R < 3 → WARN minor; R < depth/3 → WARN minor | FAIL / WARN | Hubs-CNC (R ≥ ⅓ depth), Protolabs-cost, Quadrant (R ≥ 1 mm), Boedeker-mach | INFO advisory |
| `cnc-floor-radius` | `cornerRadii.minInternalFloor` | 0 < R < 0.5 | WARN minor | Hubs-CNC (0.5 / 1 / none) | skipped |
| `cnc-pocket-ratio` | `pockets[].depthToWidthRatio` | ≤ 4 pass; 4–6 WARN minor; > 6 WARN major; > 10 WARN major (tool reach) | WARN | Hubs-CNC (4×), Xometry-tips (> 6 deep), Fictiv (5× tool dia) | bbox proportions, INFO |
| `cnc-hole-depth` | `holes[].depthToDiaRatio` | ≤ 4 rec; ≤ 6 reliable (pass, minor cost); 6–12 WARN minor (peck); > 12 WARN major (extended / both sides) | WARN | Hubs-CNC (4×/10×), Fictiv (6×/12×), Quadrant (peck 1.5×) | INFO with count |
| `cnc-hole-diameter` | `holes[].diameter` | < 1.0 → WARN major; 1.0–2.5 pass with minor cost | WARN | Hubs-CNC (≥ 1 mm), Protolabs-turn (1 mm), Xometry-tips (2.5 mm tool) | — |
| `cnc-thread-depth` | `holes[].kind === "tapped-candidate"` depth/dia | ≤ 3× pass; > 3× WARN minor; blind: 0.5× unthreaded; brittle → inserts | WARN / pass | Protolabs-cost, Hubs-CNC (3×, 1.5× min), Xometry-tips | — |
| `cnc-min-feature` | `slots[].width`, `profile.minSlotWidth` | < 1.0 WARN major; < 2.5 WARN minor | WARN | Protolabs-6 (0.5 mm floor), Xometry-tips (2.5 mm tool) | `cnc-tool-access` INFO |
| `cnc-tool-access` | `access.minSetups3Axis` | ≤ 2 pass; 3–4 WARN minor; ≥ 5 WARN major | WARN | Protolabs-6, shop | INFO |
| `cnc-undercut` | `access.undercutAreaFraction` | > 0 WARN minor; > 5% WARN major | WARN | Hubs-CNC (T-slot/dovetail, 4× clearance) | heuristic INFO |
| `cnc-thin-tall-features` | `walls.tallThinMaxAspect` | plastic ≤ 3:1, metal ≤ 4:1; > 8:1 plastic / > 10:1 metal → major | WARN | Protolabs-cost (H < 4W), Xometry-thin (10:1 cost ceiling), task spec (3:1 plastic) | bbox 5:1 WARN |
| `cnc-removal-efficiency` | volume / bbox | < 30% WARN minor; < 12% WARN major (matches the gate's LOW_VOLUME_RATIO) | WARN | shop; Hubs-CNC cost tips | exact |
| `cnc-stress-relief` | 1 − volume/bbox, `stressRelief` materials, part > 10 cm³ | > 60% removed | WARN minor | Boedeker-anneal, Curbell, Quadrant, Ensinger | exact |
| `cnc-clamping-distortion` | flat plastic plate | thickness < 3 mm and length > 100 mm | WARN minor | Boedeker-mach (light clamping) | shape guess |
| `cnc-small-part` | extents | two dims < 10 mm | WARN minor | Protolabs-turn (min Ø4 mm) | exact |
| `cnc-text` | `text.minStroke` | ≥ 0.5 mm, engraved | WARN major below | Protolabs-6 (0.020", 20 pt) | skipped |
| `cnc-moisture` | nylon | — | INFO | Boedeker-mach, Quadrant (24 h / 3 mm drying) | always |
| `cnc-brittle-material` | acrylic / G-10 / phenolic; walls < 3 mm | — | INFO (WARN minor with thin measured walls) | Boedeker-mach | INFO |
| `cnc-coolant` | amorphous plastics | — | INFO | Boedeker-mach, Quadrant | always |
| `cnc-abrasive-material` | G-10 / phenolic / CF | — | INFO minor | Curbell | always |
| `cnc-material-cost` | PEEK / Ultem | removal ratio shown | INFO | shop | always |
| `cnc-soft-material` | UHMW / HDPE / PP / PTFE | ±0.25 mm realistic | INFO | Quadrant (0.1–0.2%), Boedeker-mach | always |
| `cnc-tolerance` | capability note | ±0.13 mm plastics, ±0.25 soft, ±0.05 metal; + 0.1–0.2% of length > 250 mm | INFO | Quadrant, Boedeker-mach, Curbell | always |

26 ids. FAIL-capable: `cnc-mesh-integrity`, `cnc-min-wall-thickness` (zero thickness), `cnc-max-size` (exceeds every machine), `cnc-corner-radius` (sharp, B-rep). Everything else WARN/INFO.

## 4. Turning rules (`subProcess: "turning"`, `server/processes/cnc/turning.js`)

| id | Rule | Threshold | Severity · cost | Source | Legacy behaviour |
|---|---|---|---|---|---|
| `cnc-mesh-integrity` | as milling | | | | |
| `cnc-max-size` | `revolved.maxDiameter` × `length` | Ø250 × 600 | FAIL beyond (no larger machine in the shop) | shop | exact |
| `cnc-turning-geometry` | `shape.kind === "revolved"` | — | WARN minor if not | shop | two extents within 20% |
| `cnc-turn-ld-ratio` | length / maxDiameter | ≤ 3 pass; 3–8 WARN minor (tailstock); > 8 WARN major (steady rest); > 12 major | WARN | 3ERP, MakerVerse, shop | from extents |
| `cnc-turn-min-wall` | (OD − bore)/2 | metal ≥ 0.5; plastic ≥ 1.5; soft plastic ≥ 2.5; ≤ 0.05 FAIL | WARN major / FAIL | Protolabs-turn (0.5 mm), Quadrant & Boedeker-mach (plug thin tubes) | — |
| `cnc-turn-bore-depth` | length / bore | ≤ 4 pass; 4–8 WARN minor; > 8 WARN major; > 20 both ends | WARN | Hubs-CNC / Fictiv drill limits applied to bores | INFO if a hole is estimated |
| `cnc-turn-min-diameter` | `revolved.minDiameter` | < 1.0 WARN major; neck < 20% of OD and longer than 6× → WARN minor | WARN | Protolabs-turn (0.76 mm region) | — |
| `cnc-turn-small-part` | OD, length | Ø < 4 mm or length < 1.3 mm | WARN minor | Protolabs-turn (Ø4.07 × 1.27 mm) | exact |
| `cnc-turn-radial-holes` | holes with axis ⟂ revolve axis | plastic ≥ 2 mm, metal ≥ 1 mm; always a second op | WARN / pass minor | Protolabs-turn | — |
| `cnc-turn-grooves-threads` | advisory | OD groove ≥ 1.2 mm (0.5 metal); thread relief at shoulders; thread ≤ 3× | INFO | Protolabs-turn, MakerVerse | always |
| `cnc-soft-material`, `cnc-moisture`, `cnc-material-cost`, `cnc-brittle-material`, `cnc-tolerance` | material notes | | INFO | Quadrant, Boedeker-mach | always |

9 turning-specific ids (+ 6 shared). FAIL-capable: `cnc-max-size`, `cnc-turn-min-wall` (zero wall), `cnc-mesh-integrity`.

## 5. Routing rules (sheet / plate on the router)

Tool reach model: a profile tool cuts cleanly to ~3–4× its diameter in plastics (Biesse: depth ≈ 2× dia per pass; shop flute lengths) — 1/16" to 6 mm, 1/8" to 12.7 mm, 1/4" to 25.4 mm, 3/8" to 38 mm. The smallest tool that reaches the stock thickness sets the minimum inside radius and slot width.

| id | Rule | Threshold | Severity · cost | Source | Legacy behaviour |
|---|---|---|---|---|---|
| `rt-mesh-integrity` | as CNC | | | | |
| `rt-bed-size` | footprint, either orientation | 2438 × 1499 mm, Z ≤ 300 | FAIL | shop | exact |
| `rt-sheet-geometry` | thickness ≤ 25.4, width ≥ 1.5 × t, `shape.is25D` | not plate / 3D faces → WARN major (go to milling) | WARN | shop | proportions |
| `rt-thickness-match` | model vs selected stock | within max(0.6 mm, 12%) | WARN minor | shop | exact |
| `rt-corner-radius` | `profile.minInternalRadius` vs reach tool | sharp or R < tool radius → WARN major (dog-bone); R < 3.175 → pass minor (small tool); acrylic R < 3.175 → WARN minor | WARN / pass | SCS-CNC (R = bit radius, dog-bones), Biesse (acrylic) | INFO |
| `rt-slot-width` | `slots[].width`, `profile.minSlotWidth` | < reach tool dia → WARN major; < 6.35 → pass minor | WARN / pass | SCS-CNC (min cut = bit dia) | INFO with count |
| `rt-thin-web` | `walls.minThickness` (in-plane) | floor max(1.5, min(0.5 t, 3)); preferred max(2.5, min(1 t, 6.35)); ≤ 0.05 FAIL | WARN major / minor; FAIL | SCS-tol (≥ 50% t, prefer 1–1.5× t), shop caps | 2.5 mm proxy WARN |
| `rt-small-part` | footprint | < 10 mm across → WARN major (not holdable); < 25.4 → WARN minor (tabs, min charge); < 40 → INFO (tabs, witness mark) | WARN / INFO | SCS-CNC (1" × 2" min, tabs 0.1875" × ½ t) | exact |
| `rt-holes` | `holes[]` | < 1.59 → WARN major; d < 0.5 t → WARN minor (drilled, peck); counters add a tool pass; keep ≥ 1× d from edges | WARN / pass | SCS-CNC, SCS-tol (hole ≥ 50% t, 1× d edge, 1.5× slot) | INFO |
| `rt-pockets` | `pockets[]` | depth/width > 4 → WARN major; floor < max(1.5, 15% t) → WARN major; else pass minor | WARN / pass | Hubs-CNC (4:1), shop | skipped |
| `rt-material-removal` | 1 − profile.area / blank | > 50% WARN minor; > 75% WARN major | WARN | SCS-CNC (max 50% removal) | skipped |
| `rt-material-note` | acrylic / PC / soft / abrasive | edge quality, crazing, fuzz, tool wear | INFO | Biesse, Quadrant, Curbell | always |
| `rt-text` | `text.minStroke` | ≥ 0.8 mm (1.6 clean) | WARN major below | shop (V-bit) | skipped |
| `rt-tolerance` | capability | ±0.13 mm, ±0.25 soft, 68 °F | INFO | SCS-tol (±0.005"), Quadrant | always |
| `rt-nesting` | parts per 48 × 96 sheet | — | INFO | shop | exact |

15 ids. FAIL-capable: `rt-bed-size`, `rt-mesh-integrity`, `rt-thin-web` (zero web). A sharp inside corner on a routed outline never fails — it is always relievable with a dog-bone (SendCutSend adds them automatically), so it warns major.

## 6. 3D printing rules (`subProcess: "fdm" | "sla" | "sls"`)

| id | Rule | FDM | SLA | SLS | Severity · cost | Source |
|---|---|---|---|---|---|---|
| `print-mesh-integrity` | manifold / watertight | | | | FAIL / WARN major | shop |
| `print-min-wall` | `walls.minThickness` | 0.8 supported / 1.0 free-standing | 0.5 / 1.0 (Formlabs floor 0.2) | 0.7 | WARN minor below; ≤ 0.05 FAIL | Hubs-3DP, UZH-FDM, Formlabs |
| `print-thin-area` | `walls.thinAreaFraction` | > 20% | | | WARN minor | shop |
| `print-build-volume` | extents, any orientation | 610 × 305 × 305 | 178 × 152 × 152 (hint: fits FDM?) | 300³ | FAIL | shop |
| `print-overhang` | `overhang.areaFraction45`, `supportVolumeEstimate` | > 40% of area → WARN major; support vol > 30% of part → major cost | same | INFO (self-supporting) | WARN | Hubs-FDM (45°), Formlabs |
| `print-bridge-length` | `bridging.maxSpan` | > 10 mm WARN minor (sag visible > 5) | > 21 mm (Formlabs 29 mm for 5 × 3 beam) | n/a | WARN | Hubs-3DP, Hubs-FDM, Formlabs |
| `print-min-hole` | `holes[].diameter` | < 2.0; vertical holes print undersize → drill | < 0.5 | < 1.5 | WARN minor | Hubs-3DP, Hubs-FDM, Formlabs |
| `print-pins` | `bosses[]` | Ø < 3.0; height/dia > 10 | Ø < 0.5 (wires 0.2–1.5 by height) | Ø < 0.8 | WARN minor | Hubs-3DP, UZH-FDM, Hubs-FDM (< 5 weak), Formlabs |
| `print-small-features` | `slots[].width` | < 2.0 | < 0.2 | < 0.8 | WARN minor (INFO on legacy proxy) | Hubs-3DP, UZH-FDM |
| `print-text` | `text.minStroke` | 0.6 w × 2 h | 0.4 (Formlabs 0.1 emboss / 0.15 engrave) | 1.0 | WARN | Hubs-3DP, Formlabs |
| `print-clearance` | multi-body file | 0.5 | 0.5 | 0.3 / 0.1 | WARN minor | Hubs-3DP, UZH-FDM, Formlabs |
| `print-escape-holes` | shell-like part (< 35% of box, walls < 6) | — | ≥ 3.5 mm (Formlabs 2.5, Hubs 4) | 5 mm | INFO | Formlabs, Hubs-3DP |
| `print-volume-efficiency` | volume / bbox | < 30% | | | INFO | shop |
| `print-tall-thin` | aspect > 20 and wall < 1.5 | wobble | peel forces | | WARN minor | shop |
| `print-fdm-warping` | base area | > 5000 mm² warp-prone (ABS, nylon); > 15000 others | | | WARN minor | Hubs-FDM |
| `print-sla-islands` | advisory | | unsupported overhang ≤ 5 mm, ≥ 10° from level | | INFO | Formlabs |
| `print-tolerance` | capability | ±0.5% (≥ ±0.5 mm) | ±0.2% (≥ ±0.15) | ±0.3% (≥ ±0.3) | INFO | Hubs-3DP |

17 ids. FAIL-capable: `print-build-volume`, `print-mesh-integrity`, `print-min-wall` (zero thickness).

## 7. Validation — 17 reference parts (`tools/vet-quotes/dfm_vetting.js`)

Each part × configuration is run twice: **legacy** (the STL parsed by the real parser, rules through the adapter at confidence "legacy" — what the site does today) and **manifest-truth** (a `features` object hand-built from `manifest.json`/the description at confidence 1.0 — what the rules will see once the geometry module lands). `†` = cost hint `major`.

| Part | Config | Legacy adapter (today) | Manifest-truth features |
|---|---|---|---|
| plate_hole_pattern | routing:sheet:rt-hdpe | ok 100% — | ok 100% — |
| plate_hole_pattern | routing:sheet:rt-delrin | ok 100% — | ok 100% — |
| plate_hole_pattern | cnc:milling:cnc-delrin | ok 100% — | ok 100% — |
| plate_hole_pattern | cnc:milling:cnc-hdpe | ok 100% — | ok 100% — |
| pocketed_tray | routing:sheet:rt-hdpe | ok 100% — | ok 100% — |
| pocketed_tray | cnc:milling:cnc-hdpe | ok 100% — | ok 100% — |
| pocketed_tray | cnc:milling:cnc-delrin | ok 100% — | ok 100% — |
| conveyor_guide_rail | routing:sheet:rt-uhmw | ok 100% — | ok 100% — |
| conveyor_guide_rail | cnc:milling:cnc-uhmw | ok 90% warn: cnc-max-size† | ok 94% warn: cnc-max-size† |
| wear_strip | routing:sheet:rt-uhmw | ok 100% — | ok 100% — |
| wear_strip | cnc:milling:cnc-uhmw | ok 100% — | ok 100% — |
| star_wheel | routing:sheet:rt-delrin | ok 100% — | ok 100% — |
| star_wheel | cnc:milling:cnc-delrin | ok 100% — | ok 100% — |
| bracket_block | cnc:milling:cnc-delrin | ok 100% — | ok 95% warn: cnc-thread-depth |
| bracket_block | cnc:milling:cnc-peek | ok 100% — | ok 95% warn: cnc-thread-depth |
| bracket_block | cnc:milling:cnc-aluminum-6061 | ok 100% — | ok 95% warn: cnc-thread-depth |
| saddle_clamp | cnc:milling:cnc-uhmw | ok 100% — | ok 94% warn: cnc-thin-tall-features |
| saddle_clamp | cnc:milling:cnc-delrin | ok 100% — | ok 94% warn: cnc-thin-tall-features |
| saddle_clamp | cnc:milling:cnc-nylon | ok 100% — | ok 94% warn: cnc-thin-tall-features |
| bushing | cnc:turning:cnc-delrin | ok 100% — | ok 100% — |
| bushing | cnc:turning:cnc-ptfe | ok 100% — | ok 100% — |
| bushing | cnc:turning:cnc-brass-360 | ok 100% — | ok 100% — |
| bushing | cnc:milling:cnc-delrin | ok 100% — | ok 100% — |
| roller | cnc:turning:cnc-uhmw | ok 83% warn: cnc-turn-ld-ratio | ok 80% warn: cnc-turn-ld-ratio, cnc-turn-bore-depth† |
| roller | cnc:turning:cnc-nylon | ok 83% warn: cnc-turn-ld-ratio | ok 80% warn: cnc-turn-ld-ratio, cnc-turn-bore-depth† |
| roller | cnc:turning:cnc-delrin | ok 83% warn: cnc-turn-ld-ratio | ok 80% warn: cnc-turn-ld-ratio, cnc-turn-bore-depth† |
| spacer | cnc:turning:cnc-delrin | ok 100% — | ok 100% — |
| spacer | cnc:turning:cnc-aluminum-6061 | ok 100% — | ok 100% — |
| thin_wall_housing | cnc:milling:cnc-delrin | ok 83% warn: cnc-removal-efficiency, cnc-stress-relief | ok 80% warn: cnc-corner-radius, cnc-thin-tall-features†, cnc-removal-efficiency, cnc-stress-relief |
| thin_wall_housing | 3d-printing:fdm:fdm-abs | ok 90% warn: print-fdm-warping | ok 88% warn: print-fdm-warping |
| thin_wall_housing | 3d-printing:sla:sla-standard | ok 100% — | ok 100% — |
| thin_wall_housing | 3d-printing:fdm:fdm-pla | ok 100% — | ok 100% — |
| small_clip | routing:sheet:rt-delrin | ok 88% warn: rt-small-part | ok 92% warn: rt-small-part |
| small_clip | cnc:milling:cnc-delrin | ok 100% — | ok 100% — |
| small_clip | 3d-printing:fdm:fdm-pla | ok 100% — | ok 100% — |
| gear_disc | routing:sheet:rt-delrin | ok 100% — | ok 86% warn: rt-corner-radius†, rt-thin-web |
| gear_disc | cnc:milling:cnc-delrin | ok 100% — | ok 100% — |
| gear_disc | 3d-printing:fdm:fdm-nylon | ok 92% warn: print-fdm-warping | ok 92% warn: print-fdm-warping |
| oversize_panel | routing:sheet:rt-hdpe | **BLOCK** 67% fail: rt-bed-size | **BLOCK** 80% fail: rt-bed-size |
| oversize_panel | cnc:milling:cnc-hdpe | **BLOCK** 80% fail: cnc-max-size | **BLOCK** 88% fail: cnc-max-size |
| cube_20mm | cnc:milling:cnc-delrin | ok 100% — | ok 100% — |
| cube_20mm | cnc:milling:cnc-aluminum-6061 | ok 100% — | ok 100% — |
| cube_20mm | routing:sheet:rt-delrin | ok 75% warn: rt-sheet-geometry†, rt-small-part | ok 80% warn: rt-sheet-geometry†, rt-small-part |
| cube_20mm | 3d-printing:fdm:fdm-pla | ok 100% — | ok 100% — |
| drill_fixture_plate | routing:sheet:rt-hdpe | ok 100% — | ok 100% — |
| drill_fixture_plate | routing:sheet:rt-acrylic | ok 100% — | ok 100% — |
| drill_fixture_plate | routing:sheet:rt-aluminum-6061 | ok 100% — | ok 100% — |
| drill_fixture_plate | cnc:milling:cnc-delrin | ok 100% — | ok 100% — |
| drill_fixture_plate | cnc:milling:cnc-aluminum-6061 | ok 100% — | ok 100% — |
| seal_ring_peek | cnc:turning:cnc-peek | ok 100% — | ok 100% — |
| seal_ring_peek | cnc:turning:cnc-delrin | ok 100% — | ok 100% — |
| seal_ring_peek | cnc:turning:cnc-ptfe | ok 100% — | ok 100% — |

Reading the table:

- **Only `oversize_panel` blocks**, on both routing (`rt-bed-size`, 2600 mm > 2438 mm bed) and milling (`cnc-max-size`: exceeds the mill even indexed, and too long for the router) — exactly the part the manifest says "must trip the bed-size FAIL and RFQ gate". No other part fails on either path.
- `conveyor_guide_rail` on CNC warns `cnc-max-size†` (600 mm > 457 mm travel) with the reroute-to-router hint; on routing it passes.
- `roller` (turning) warns on L/D 4:1 (tailstock) and, with truth features, `cnc-turn-bore-depth†` — the Ø20 × 200 bore is 10× diameter, matching the manifest note "needs a long drill / boring bar". `bushing`, `spacer`, `seal_ring_peek` turn clean (the legacy adapter now recognises them as cylindrical from any two equal extents).
- `thin_wall_housing` on CNC warns on removal (17% of box → major), stress relief (Delrin, 83% removed), 16:1 walls (major) and R3 corners in a 37 mm cavity — the rules say what the manifest says: "natural 3D-print part". On FDM/SLA it is clean apart from an ABS warping warning on the 120 × 80 base.
- `bracket_block` with truth features warns `cnc-thread-depth` (Ø5 tap drill × 25 deep = 5× > 3×) — a correct Protolabs/Hubs call on an M6 through-tap in a 25 mm block; minor cost.
- `saddle_clamp` (40 mm tall, 9 mm cheeks → 4.4:1) warns thin-tall minor on the plastic 3:1 guideline.
- `gear_disc` on routing (truth) warns `rt-corner-radius†` (R1 tooth roots in 9.5 mm Delrin: the 1/8" tool that reaches leaves R1.59 — dog-bone or open the root) and `rt-thin-web` minor (3 mm tooth tips against a 6.35 mm preferred web).
- `small_clip` and `cube_20mm` on routing warn `rt-small-part` (tabs, minimum charge); the cube also warns it is not a sheet part. `pocketed_tray`, `plate_hole_pattern`, `wear_strip`, `star_wheel`, `drill_fixture_plate` are clean on every process.

Tuning done from this run: the routing web floor is capped at 3 mm (a 6.35 mm tray floor in 19 mm stock is not a thin web); a 25 mm wide strip counts as plate (`mid ≥ 1.5 × t`); stress relief uses bbox removal on parts > 10 cm³ (stock padding dominated tiny parts); print tall-thin only fires on walls < 1.5 mm.

## 8. Recommendations for `quoteGate.js` (not changed here)

The gate today routes to RFQ on `manufacturable === false`, a `warn` on `cnc-max-size`/`rt-bed-size`, volume ratio < 0.12 and big tickets. With the `cost` and `confidence` fields now on every check:

1. **Gate on `cost: "major"` warnings that are low-confidence or un-priced.** Add: `checks.some(c => c.severity === "warn" && c.cost === "major" && (c.confidence === "legacy" || c.confidence < 0.6 || c.verify))` → reason `dfm-major-unverified`. A major-cost feature the instant model cannot price confidently (deep bore, sharp routed corner, 1 mm tube wall) should be confirmed by a person; the same warning at confidence ≥ 0.9 can stay instant once pricing consumes the hint.
2. **Let pricing consume `cost` before gating on it.** Define a small adder table per id (e.g. `cnc-hole-depth` minor = +peck time per hole, `rt-corner-radius` major = +small-tool pass, `cnc-turn-bore-depth` major = +deep-hole time) in the pricing rules; once an id is priced, drop it from the gate list. Until then, major-cost warnings should gate.
3. **Keep `cnc-max-size`/`rt-bed-size` handling as is**, but note `cnc-max-size` can now be `fail` (exceeds every machine) as well as `warn` (router reroute / indexed) — both already route to RFQ via `dfm-fail` or `envelope`.
4. **Degraded fails** (`verify: true`, e.g. a sharp corner found at 0.7 confidence) should gate as RFQ with reason `dfm-verify`, not block; today they land as `warn` and pass through — acceptable only while geometry is legacy.
5. **Replace the gate's own `volumeRatio < 0.12`** with the `cnc-removal-efficiency` check at `cost: "major"` (same threshold, one source of truth).
6. **Do not gate on INFO** or on minor-cost warnings; those are the advisories a customer should see without losing instant checkout.

## 9. Schema notes for the geometry engineer

Fields consumed: `mesh.{manifold,watertight,selfIntersections}`, `aabb`, `obb`, `volume`, `shape.{kind,is25D,stockThickness,profile.{area,bboxW,bboxH,minInternalRadius,minSlotWidth},revolved.{axis,maxDiameter,length,minDiameter,boreDiameter,segments}}`, `holes[].{diameter,depth,axis,kind,depthToDiaRatio}`, `pockets[].{area,depth,minCornerRadius,depthToWidthRatio}`, `slots[].width`, `bosses[].{diameter,height}`, `text.{present,minStroke}`, `walls.{minThickness,thinAreaFraction,tallThinMaxAspect}`, `access.{minSetups3Axis,undercutAreaFraction}`, `cornerRadii.{minInternalVertical,minInternalFloor}`, `overhang.{areaFraction45,maxAngleFromVertical,supportVolumeEstimate}`, `bridging.maxSpan`, `stock.removalRatioBlock`, `confidence.*`.

Optional extensions the rules would use if present: `holes[].edgeDistance` (hole-to-edge rule, SCS-tol 1× d) and `walls.minInPlaneWeb` for flat parts (so a pocket floor is not reported as a web). `legacy.bodyCount` from the parser drives the assembly-clearance rule.
