# Straightedge claims audit

Audited 2026-11-09 against branch `straightedge-retool` at `a091d38`.

## Rules

- **VERIFIED** — the claim is about the software or the published contact details, and the repo proves it (code, config or `shared/brand.json`). The repo cannot verify anything about the physical shop.
- **CONFIRM** — needs the owner's yes before launch. Most shop claims are here. That is not a judgment that they are false; it is that nothing in the repo can prove them, and the brand is "deals square."
- **REMOVE** — unsupported, contradicted, unprovable by nature, or a risk under the Xometry partner agreement. Replacement wording is given where one exists.
- **Conflict** notes cite things the owner said in earlier working sessions (recorded in the assistant's memory of this project). They may be out of date. They are flagged because the site and the owner's own earlier statements disagree, and only he can say which is current.

The copywriter should not ship any CONFIRM line until the owner has answered it. The consolidated question list is at the end.

---

## A. Current site

### Brand facts (`shared/brand.json`, footer, meta)

| # | Claim | Status | Note |
|---|---|---|---|
| A1 | Name "Straightedge"; legal name "Straightedge Manufacturing LLC" | CONFIRM | Earlier notes say the entity was formed as Nord MFG LLC. Confirm the legal name change or DBA is filed before the site and paperwork say "Straightedge Manufacturing LLC." |
| A2 | "an Illinois LLC wholly owned by Erik Lutz Enterprise LLC" | CONFIRM | Consistent with earlier statements. Confirm state of organization. |
| A3 | Phone 224-213-6727, quotes@straightedgemfg.com, straightedgemfg.com | VERIFIED (config) | Confirm the mailbox exists and is monitored, and that the number rings the shop. |
| A4 | Wauconda, Lake County, Illinois | CONFIRM | Confirm the shop address may be published and visitors are welcome (zoning, insurance). "Come see the shop" depends on it. |
| A5 | `foundedYear: 2017` → "Since 2017 machining in Lake County" (home stat) | CONFIRM / likely REMOVE | 2017 appears to be the parent company's start. Straightedge is new, and the parent's history is fabrication and vehicle work. "Machining since 2017" is only true if CNC machining has run since then. Safer: "Shop open since 2017" on About, and drop it from the stat row. |
| A6 | Footer: "Your files stay private. NDA on request." | VERIFIED in part | Encryption and purge exist in code (A22). "Private" also depends on who has admin access. NDA turnaround is a promise the owner must be willing to keep. |

### Home page (`LandingPage.jsx`)

| # | Claim | Status | Note |
|---|---|---|---|
| A7 | "Machined plastic parts. One to a few thousand." | CONFIRM | "A few thousand" on a Tormach 1100, a manual-tool-change Bridgeport and one person is a capacity claim. True for routed parts by the sheet; questionable for milled parts. Suggest "One to a few hundred milled; thousands routed" or simply drop the range. |
| A8 | "CNC milling, turning and routing in Delrin, UHMW, HDPE, nylon, PEEK and 6061" | CONFIRM | Confirm PEEK has actually been machined here. Confirm turning (see A35). |
| A9 | "Upload a STEP or STL and get a price now." Formats .step .stp .stl .iges .3mf | VERIFIED (code, exercised in `docs/copy-ui-review.md`) | |
| A10 | "Over 100 pieces, the person who will run the job quotes it within 24 hours." | VERIFIED as config; CONFIRM as promise | Threshold 100 and 24 h are in `brand.json`. The owner's earlier stated standard for written quotes was two business days. `docs/site-plan.md` Q8 asks the same. If it cannot be held on a production day, say "one business day." |
| A11 | Hero caption: "HDPE, 3/4" — router-cut and pocketed. A production lot, not a prototype." | CONFIRM | See A19 on photos. |
| A12 | Stat: "Instant price and checkout to 100 pcs" | VERIFIED (code: `quoteGate`) | Also gated on DFM fail, oversize and lines over $5,000. "To 100 pcs" is slightly generous; the How-it-works step states the exceptions, which is enough. |
| A13 | Stat: "13 engineering plastics priced online" | VERIFIED (config) | `server/config/defaults.js` seeds 13 plastics for CNC: acetal, UHMW, HDPE, nylon, PEEK, Ultem, PTFE, polycarbonate, acrylic, PVC, polypropylene, G-10, phenolic. Calling acrylic, PVC, G-10 and phenolic "engineering plastics" is loose; "13 plastics" is exact. |
| A14 | Stat: "FAI — first-article report with every production order" | CONFIRM | Define "production order" (quantity? any order over the instant limit?). Confirm it is free and that the report format exists. `docs/site-plan.md` Q10. |
| A15 | "Tormach and Bridgeport mills with a 4th axis, lathes for round work" | CONFIRM | Tormach PCNC 1100 and a CNC Bridgeport match earlier statements. 4th axis: one photo supports it; confirm which machine. "Lathes" plural: see A35. |
| A16 | "59" × 96" router with a tool changer" | CONFIRM | Bed size and tool changer match earlier statements. |
| A17 | "The cheapest way to make a flat plastic part in quantity." | REMOVE | Unprovable superlative. Use "Usually the cheapest way to make a flat plastic part in quantity." |
| A18 | "Four FDM machines up to 12" × 12" × 24", SLA for fine detail." | CONFIRM | Known open question. Printing page lists Raise3D N2 Plus + three Creality K2 Plus + "large-format FDM" = four or five. Earlier statements mention one K2 Plus. Count them and name them, or say "FDM machines up to 12" × 12" × 24"" with no count. |
| A19 | Gallery: "Parts off the machines in the last 60 days." with captions and quantities (40 pcs, 5 pcs, 35 pcs, 11 pcs) | REMOVE the 60-day line; CONFIRM the photos | (1) "Last 60 days" goes stale; use "Recent work." (2) **Xometry risk:** if any photographed part was made on a Xometry job, publishing it may breach the partner agreement or the end customer's confidentiality even with no name shown. The owner must confirm each photo is of his own direct work or is cleared. (3) Confirm each caption's material and quantity. (4) `docs/copy-ui-review.md` notes the acetal clamps are captioned as "the machined version of a printed prototype" on the printing page; confirm or drop that caption. |
| A20 | "Customer names and part numbers withheld. Yours will be too." | CONFIRM | Fine as a promise. Keep. |
| A21 | "No sales call unless you want one." | VERIFIED (flow) | No account is needed to price; account only at checkout. |
| A22 | "the file is encrypted at rest and purged on a schedule" | VERIFIED (code) | `server/services/fileCrypto.js` and `fileRetention.js` (default 168 h). Confirm the encryption key is set in production and state the schedule: "deleted after 7 days unless you order." |
| A23 | "a manufacturability check written for our machines, not a generic one" | CONFIRM | `docs/copy-ui-review.md` says the CNC DFM wording is still generic and its corner-radius rule (≥1 mm) disagrees with the machining page (1/16"). True for routing, not yet for CNC. Fix the DFM text or soften to "checked against our machine limits." |
| A24 | "Production orders get a first-article inspection report and a certificate of conformance in the box. Reorders use the same program and fixture." | CONFIRM | As A14. Confirm fixtures are kept. |
| A25 | "Every production lot sees the surface plate before it sees a box." | CONFIRM | Earlier statements list gage pins, an 8" caliper and a height gage on hand, with the rest of an inspection list being purchased. Confirm a granite surface plate is in the shop. |
| A26 | "We machine to the print, let parts normalize, and inspect at 68 °F with gage pins, calipers, a height gage and a surface plate." | CONFIRM | Is there a temperature-controlled inspection area? If not, say "at room temperature after the parts have sat" and drop 68 °F. |
| A27 | "material certs passed through on request" | CONFIRM | Depends on buying from distributors who supply lot certs and on keeping them with the job. |
| A28 | "Working toward ISO 9001 registration: documented inspection, traceability and corrective-action procedures now, the audit next." | CONFIRM | Only true if written procedures exist today and a registrar or date is planned. If procedures are being written, say "We are not ISO 9001 certified. We are writing the procedures now." |
| A29 | "Reorders run on the saved program and fixture, so the hundredth part matches the first." | CONFIRM / soften | "Matches" is absolute. Use "so a reorder is cut the same way as the first lot." |
| A30 | "Either way you're talking to the person who runs the machine." | CONFIRM | True while it is a one-person shop. Keep; revisit at first hire. |

### Machining page (`ServicePage.jsx`, machining)

| # | Claim | Status | Note |
|---|---|---|---|
| A31 | "Most machine shops treat plastic as the job they take when the aluminum runs out." | REMOVE | A statement about other shops that cannot be supported (research 2.8). Replace with what plastic does and what this shop does about it. |
| A32 | "We set the shop up around it: sharp tooling, light engagement, parts left to normalize before inspection, and programs saved for the reorder." | CONFIRM | Earlier statements: the same CNC machines also cut aluminum and steel, and the mill has flood coolant. "Set up around plastic" overstates it unless there is plastic-only tooling and a clean-down routine. See A33. |
| A33 | "Plastics first; 6061 and brass when the job calls for it." "We machine both; we just lead with plastic." | CONFIRM | Honest. But the trade press case for a plastics specialist is contamination from metal chips and cutting oil (research 2.4). The owner must say what the routine is when a plastic job follows a metal one: coolant off or drained, machine wiped down, dedicated cutters. That routine is copy. Without it, do not imply a clean plastics-only environment, especially near food-contact claims. |
| A34 | "Tormach PCNC 1100 and a CNC Bridgeport — 3-axis with 4th-axis indexing. Work envelope 18" × 9.5" × 12" (457 × 241 × 300 mm)." | CONFIRM | Envelope reads as the Tormach's X/Y travel; Z looks generous once a vise and tool are in. Confirm usable part size, and whether the Bridgeport's larger travel should be stated separately. |
| A35 | "Lathes for round work to Ø10" × 24"." | CONFIRM | Known open question. Earlier statements mention one Kalamazoo lathe. Is it CNC or manual? What swing and length? If manual, turned parts in quantity are slow and the quote engine should gate them. State the actual machine. |
| A36 | "Standard tolerance ±0.005" (±0.13 mm) on plastics, ±0.002" on called-out features. Metals ±0.002" standard." | CONFIRM | Known open question. The owner has described the Tormach as low-rigidity. ±0.002" on a called-out feature in acetal is plausible; in UHMW, HDPE, nylon or PTFE it is not something to promise flat. Recommend a per-material table the owner signs off (framework, Materials brief). "Metals ±0.002" standard" is tighter than Xometry's ±0.005" default for metals; confirm or loosen. |
| A37 | "Threads tapped or thread-milled; inserts installed on request. Press fits sized for the material, not the chart." | CONFIRM | Earlier note: the Tormach has no rigid tapping. Fine if thread-milled or tapped offline; confirm inserts are stocked or bought per job. |
| A38 | "Inside corners carry a tool radius — 1/16" minimum, 1/8" is cheaper." "Walls under 0.060" in acetal and nylon chatter; 0.090" and up machines cleanly." | CONFIRM | Design guidance; owner's experience. Must match the DFM engine's rules (A23). |
| A39 | "Square corners mean a broach or an EDM job somewhere else." | CONFIRM | Keep; it is honest about a limit. |
| A40 | Materials chips: Delrin, UHMW, HDPE, nylon 6/6 & cast, PEEK, Ultem, PTFE, polycarbonate, acrylic, PVC, polypropylene, G-10/FR-4, phenolic, 6061-T6, brass 360 | VERIFIED as priced online (config); CONFIRM as machined | Confirm each has been cut here, or mark the untested ones "quoted on request." G-10 and phenolic dust needs extraction; confirm the shop will take them. |
| A41 | Captions: "Acetal on the 4th axis — 35 pieces, one setup." "Turned and milled acetal dish." "UHMW cups — 11 pcs." | CONFIRM | As A19. |

### Routing page

| # | Claim | Status | Note |
|---|---|---|---|
| A42 | "A router with a tool changer, a vacuum table and a 4' × 8' sheet is the cheapest way there is to make a flat plastic part in quantity." | REMOVE "cheapest way there is"; CONFIRM vacuum table | Earlier statement: workholding on the router is screws and clamps to a spoilboard. If there is no vacuum table, remove it. It also changes the small-part guidance (tabs, screw holes in the skeleton). |
| A43 | "Techno HD-II: 59" × 96" bed, 12" under the gantry, 12-position tool changer, 5 hp spindle." | CONFIRM | **Conflict.** Earlier statements name the router both as a Techno HD-II and as a Techno RG 5996, give the spindle as 4 hp, and do not state the tool-changer count. Read the nameplate and print what it says. Naming the wrong machine on a page whose promise is "name the machine" is the worst kind of error for this brand. |
| A44 | "Stock from 1/16" to 1" in plastics; 1/2" in aluminum. Full 48" × 96" sheets; oversize on request." | CONFIRM | The bed is 59" wide; "oversize on request" should state the true maximum (59" × 96"?). |
| A45 | "Profile tolerance ±0.005" (±0.13 mm) typical." | CONFIRM | SendCutSend publishes the same figure for routed plastics, so it is a credible number. Confirm on large HDPE/UHMW parts, where the page already admits movement. |
| A46 | "we cut, let them relax, and measure at 68 °F" | CONFIRM | As A26. |
| A47 | "Conveyor and packaging wear parts: guides, rails, lane dividers, wear strips, star wheels and change parts in UHMW and acetal." | CONFIRM | Listed as "what runs well here." Has the shop made each of these? If some are aspirations, move them under "can make" or list only what has been made. Do not attribute any to a customer. |
| A48 | "with polished edges when they show" | CONFIRM | Flame or buff polishing capability. |
| A49 | "6061 plate to 1/2"" | CONFIRM | |
| A50 | "Holes 1/8" and up are interpolated to size; smaller ones are drilled. Tell us the thread and we tap offline." | CONFIRM | |
| A51 | "The DFM panel tells you how many of your part fit on a sheet." | VERIFIED (per copy review: routing DFM is in voice and nests) | Spot-check in the running app. |
| A52 | Meta: "Nested runs from 10 to thousands of parts." | CONFIRM | Capacity claim. |
| A53 | Caption: "HDPE trays, 3/4" thick — pocketed, nested, 40 to the run." | CONFIRM | As A19. |

### 3D printing page

| # | Claim | Status | Note |
|---|---|---|---|
| A54 | "Raise3D N2 Plus, 12" × 12" × 24" dual-extruder. Three Creality K2 Plus at ~12" × 12" × 14" for parallel runs. Large-format FDM for oversize." | CONFIRM | Known open question. Earlier statements: one K2 Plus (350 × 350 mm bed). Count and name. "Large-format FDM for oversize" names no machine; state it or cut it. |
| A55 | "Formlabs SLA for engineering resins, ~6" × 6" × 7"." | CONFIRM | **Conflict.** Earlier statement: Formlabs Form 4, build volume 200 × 125 × 210 mm (about 7.9" × 4.9" × 8.3"). Print the real model and volume. |
| A56 | "Typical FDM accuracy ±0.2 mm; SLA ±0.1 mm." | CONFIRM | |
| A57 | "Supports removed, surfaces sanded or vapor-smoothed on request. Painting and dyeing available." | CONFIRM | Vapor smoothing and dyeing are listed in config as SLS finishes. Does the shop do them? If not, REMOVE. |
| A58 | SLS materials in the printing material list (PA12 SLS, PA11 SLS, glass-filled nylon SLS, SLS TPU) and "Dental / Biocompatible Resin"; an "SLS" process option in config | REMOVE unless outsourced and disclosed | Known open question. No SLS machine is listed. Either deactivate these in the seed data, or state plainly "SLS is made by a partner shop" (which contradicts "the person who runs the job"). "Dental / biocompatible" implies a regulated use; remove. |
| A59 | "Same shop, same person, so the print and the machined part agree." | CONFIRM | True only if nothing is outsourced (A58). |
| A60 | "Patterns and masters for casting and thermoforming." | CONFIRM | Has the shop done it? |

### Materials page

| # | Claim | Status | Note |
|---|---|---|---|
| A61 | "Every material below is priced online." | VERIFIED (config) | |
| A62 | Acetal: "machines like butter" | REMOVE | Cliché, and off-voice. "Machines cleanly and holds size." |
| A63 | "Natural acetal is FDA-compliant." "FDA grades available" (HDPE, PP) | REMOVE as written | Compliance belongs to a specific grade from a specific maker, not to "natural acetal" in general (research 2.5). Replace: "Natural grades that comply with 21 CFR 177 for food contact are available. We buy the grade you specify and pass the maker's compliance statement through with the lot." Only after the owner confirms the documents are obtainable from his distributor (C-list Q9). |
| A64 | Config grade names "UHMW — natural (FDA)", "HDPE — natural (FDA)" | CONFIRM | Same issue inside the quote tool. Rename "natural, food-contact grade (compliance statement on request)" once confirmed. |
| A65 | Nylon: "Absorbs moisture and grows — up to 2–3% in wet service." | VERIFIED against source | Curbell's white paper reports 2% length growth for nylon 6 at saturation. "Up to about 2%" is the supported figure; 3% is not sourced. |
| A66 | PEEK: "Continuous service to about 480 °F"; Ultem "to about 340 °F" | CONFIRM | Typical datasheet values; cite the stock maker's datasheet or soften to "see the datasheet." |
| A67 | "Best abrasion resistance of any common plastic" (UHMW); "Slipperiest material we run" (PTFE); "Chemical resistance close to PTFE at a fraction of the price" (PP) | CONFIRM / soften | Comparative claims. The UHMW one is conventional wisdom; add "among" or cite a datasheet. PP "close to PTFE" overstates; use "resists most acids and bases." |
| A68 | "We machine it dry and tell you the as-shipped size." (nylon) | CONFIRM | A process promise. |
| A69 | "Vespel, Torlon, PPS, PVDF, Kynar, filled grades, customer-supplied stock — ask. If a distributor stocks it, we can run it." | REMOVE the last sentence | "We can run it" is a blanket capability claim. Use "Ask. If we haven't cut it before, we'll say so." |
| A70 | 6061: "for heavy aluminum production you may be better served by a dedicated metal shop." | Keep | Honest; needs no confirmation. |

### Quality page

| # | Claim | Status | Note |
|---|---|---|---|
| A71 | "First-article inspection report … recorded with the instrument used." | CONFIRM | As A14. |
| A72 | "Certificate of conformance stating material, grade, lot and drawing revision." | CONFIRM | Requires recording stock lot per job. |
| A73 | "Material certs passed through from the distributor on request. FDA / USDA grades identified on the paperwork." | CONFIRM | Known open question (food-contact documentation). "USDA grades" is not a thing a shop identifies; USDA acceptance rests on the maker's FDA guaranty (research 2.5). Drop "USDA." |
| A74 | "Traceability: each job has a traveler tying stock lot, program revision, machine and inspection to your PO." | VERIFIED in part (a traveler page exists in the app: `JobTravelerPage.jsx`); CONFIRM it is used on every job | |
| A75 | "Clamping distorts plastic. Fixtures are built to hold without crushing, and thin parts are cut in steps so they don't spring." | CONFIRM | Practice claim. |
| A76 | "Sharp, polished tooling and air blast instead of flood where the material wants it. No melted edges, no smeared bores." | CONFIRM; REMOVE the absolute | The Tormach has air blast (earlier statement). "No melted edges, no smeared bores" is a guarantee of outcome; say "to keep edges from melting and bores from smearing." |
| A77 | "You get a person on the phone the same day — the person who ran the job." | CONFIRM | A service-level promise. Vacations, sick days? |
| A78 | "Nonconforming parts are replaced or reworked on our dime; we don't argue over a thousandth that's on the print." | CONFIRM | This is a warranty. `docs/site-plan.md` Q5 asks for the owner's wording and exclusions. Do not publish until he sets terms. |
| A79 | "A corrective-action note goes in the job file so the reorder doesn't repeat it." | CONFIRM | |
| A80 | Inspection equipment: "Granite surface plate and height gage; gage pin sets, thread gages; calipers to 8", micrometers; bore gages and indicators for turned work; handheld 3D scanner" | CONFIRM | **Partial conflict.** Earlier statements (Sept 2026): gage pin sets, an 8" caliper and a height gage on hand; the rest being bought. List only what is in the shop today. Confirm calibration status if the page mentions calibration procedures. |
| A81 | ISO paragraph: "written procedures for inspection, calibration, traceability and corrective action, and records you can audit." | CONFIRM | As A28. "Records you can audit" invites an audit. |
| A82 | "If your supplier approval needs the certificate, tell us; if it needs the behavior, you already have it." | REMOVE | Clever, and asserts the outcome. Replacement in the framework. |
| A83 | "Supplier-qualification forms, W-9, certificate of insurance and NDAs returned within a business day." | CONFIRM | Confirm Straightedge Manufacturing LLC (not only the parent) is the named insured. |

### About page

| # | Claim | Status | Note |
|---|---|---|---|
| A84 | "a fabrication and engineering shop … that has been building custom equipment, vehicle upfits and one-off machines since 2017" | CONFIRM | As A5. |
| A85 | "Plastics became its own business because the work kept coming — guides, wear parts, trays, fixtures, replacement parts for machines nobody supports anymore — and because most machine shops don't want it." | CONFIRM / rewrite | "The work kept coming" must be true of direct customers, not only marketplace jobs. "Most machine shops don't want it" is the owner's view; phrase it as his ("In my experience…"). If much of the plastics experience came through Xometry, say "contract work" and name nothing. |
| A86 | "The shop is run by a mechanical engineer who programs the machines, runs them, and answers the phone." | CONFIRM | Confirm the degree or title. If licensed (PE), say so; if not, "mechanical engineer" by training is fine in Illinois marketing copy as long as it does not offer engineering services to the public as a PE. The page elsewhere says "Design and engineering" — keep it to "design." |
| A87 | "the price you see is the price we'll build it for" | CONFIRM | True for instant orders. For gated quotes the page number is budgetary. Add "on instant orders." |
| A88 | "Under one roof: Design and engineering, 3D scanning and printing, CNC milling and routing, plasma and laser cutting, press-brake forming, TIG/MIG/laser welding, paint and powder." | CONFIRM | Earlier statements support plasma, MIG, a hobby-class laser engraver. Laser cutting, press brake, laser welding and powder coat are not supported by anything I have. List what is in the building. |
| A89 | "Who we work with: Packaging and food-equipment OEMs, automation integrators, maintenance departments…, labs and medical-device teams…" | REMOVE as a customer claim | This reads as a client list by category. Unless the owner has direct customers in each, it invents customers. Reframe as "Who this shop is set up for." If any of these came through Xometry, they are not his customers to cite. |
| A90 | "Lake County, the northern suburbs, Kenosha and Milwaukee are a drive; everywhere else is a box." | Keep | Geography. Fine. |
| A91 | "Net terms for approved accounts; card checkout for everything else" | CONFIRM | `docs/site-plan.md` Q4. |
| A92 | "Registered on SAM.gov for federal work" | CONFIRM | The registration I know of is the parent's. If Straightedge Manufacturing LLC is not itself registered, say "Our parent company is registered on SAM.gov" or remove. |
| A93 | "Come see the shop." | CONFIRM | As A4. |

### RFQ page and quote tool

| # | Claim | Status | Note |
|---|---|---|---|
| A94 | "Firm quotes come back within 24 hours and hold for 30 days." | CONFIRM | 24 h as A10. "Hold for 30 days" with resin prices moving: owner's call. |
| A95 | "from the person who will run the job" | CONFIRM | As A30. |
| A96 | Lead-time options: Standard 7–10 business days; Expedited 3–5; Priority Rush 1–2; **Same Day "Ships today (order by 10am)"** | Same Day: REMOVE. Others: CONFIRM | Known open question. A one-person shop cannot promise same-day shipment of a machined part ordered by 10 am, on any day, without stock on the shelf and an empty machine. Deactivate in `server/config/defaults.js`. Rush 1–2 days is also a promise against an unknown queue; either gate it behind a phone call or remove. The lead time shown at checkout is the most consequential claim on the site, because the buyer pays against it. |
| A97 | Login/Register: "You don't need an account to get a price." | VERIFIED (flow) | |

---

## B. Claims in the proposed messaging

Every factual claim introduced in `messaging-framework.md` and `launch-plan.md`. Drafts carry `[CONFIRM: …]` markers at the same points.

| # | Proposed claim | Status | Depends on |
|---|---|---|---|
| B1 | "See the price before you talk to anyone" / "price now" | VERIFIED (flow) | — |
| B2 | "No account needed to see a price" | VERIFIED (flow) | — |
| B3 | "Made in Wauconda, Illinois" / "machined here, not sent out" | CONFIRM | Nothing outsourced, including SLS (A58) and any finishing. |
| B4 | "The person who quotes it machines it and answers the phone" | CONFIRM | A30. |
| B5 | "One person" / "one-person shop" stated openly | CONFIRM | Owner's comfort with saying it. It is already on About ("That's small"). |
| B6 | Per-material tolerance table | CONFIRM | A36. Table cells are blank for the owner to fill. |
| B7 | "Standard lead time [N] business days" on marketing pages | CONFIRM | A96. |
| B8 | "No minimum order" or "minimum order $[X]" | CONFIRM | Does the engine enforce a minimum line or order charge? State whichever is true. |
| B9 | "Not ISO 9001 certified" | VERIFIED by the site's own text | — |
| B10 | "First-article report and certificate of conformance" as standard | CONFIRM | A14. |
| B11 | "We machine food-contact grades and pass the maker's compliance statement and lot cert through" | CONFIRM | A63, A73, A33. |
| B12 | "We do not claim NSF, 3-A or FDA approval for parts; those apply to materials and finished equipment" | VERIFIED against source | Boedeker, research 2.5. |
| B13 | "No CAD? Send a photo and dimensions, or bring the part in" | CONFIRM | Owner willing to take no-CAD jobs, any drawing charge, walk-in policy (`docs/site-plan.md` Q9, Q6). |
| B14 | "Plastic expands several times more than steel with temperature" | VERIFIED against source | Curbell: HDPE 6.7 vs steel 0.65 ×10⁻⁵ in/in/°F (about ten times); MD+DI says "five times." Use "five to ten times." |
| B15 | "Nylon grows about 2% when saturated" | VERIFIED against source | Curbell white paper, nylon 6. |
| B16 | Drive times: Milwaukee, Kenosha, Rockford, Elk Grove Village, Madison | CONFIRM | Not checked against a map. Placeholders in drafts. |
| B17 | "Parts thicker than 1/2", pocketed, counterbored or chamfered" as things the router does that 2D sheet-cutting services do not | VERIFIED for the competitor limit (SendCutSend page: 0.118–0.500", 2D only); CONFIRM for the shop (A44) | Do not name the competitor on the site. |
| B18 | "Standard ±0.005" on plastics" compared with marketplaces' default | VERIFIED for the comparison (Xometry page: ±0.010" plastics default); CONFIRM for the shop (A36) | Do not name the competitor on the site. The owner is a Xometry partner; the launch materials never mention Xometry. |
| B19 | "Central time; phone answered [hours]" | CONFIRM | Hours. |
| B20 | "Pickup in Wauconda" | CONFIRM | A4. |
| B21 | "Files deleted after 7 days unless you order" | VERIFIED as code default | Confirm production setting. |
| B22 | "Replacement or refund if a part doesn't meet the print" | CONFIRM | A78. |
| B23 | Backup plan for the one-person risk: "your program, fixture notes and drawing are yours on request" | CONFIRM | Owner must be willing to hand over CAM files and setup notes. This is the strongest answer to the single-point-of-failure objection, and it only works if it is real. |
| B24 | LinkedIn posts: every shop fact (machines, materials, the 100-piece limit) | Mixed | Each post lists its own dependencies. Posts 2 and 5 describe plastic behavior from cited sources and need only the owner's agreement that it matches his experience. |
| B25 | "Since 2017" in boilerplate | CONFIRM | A5. Boilerplate is drafted without a year; add one only when confirmed. |

---

## C. Questions for the owner

Answer these and every CONFIRM above resolves. Grouped so it can be done in one sitting at the shop with a tape measure.

**Legal and identity**
1. Is the LLC's legal name now Straightedge Manufacturing LLC (or a filed DBA)? Is it the named insured on the COI? Is it, or only the parent, registered on SAM.gov?
2. What does 2017 refer to, and has CNC machining run since then?
3. May the street address be published and may customers visit and pick up? Hours?
4. "Mechanical engineer": degree, and any license?

**Machines (read the nameplates)**
5. Router: exact make and model (HD-II or RG 5996?), spindle horsepower, tool-changer positions, vacuum table or screws and clamps, maximum sheet.
6. Lathe: make, CNC or manual, swing and length, how many.
7. Mills: usable part envelope on the Tormach and on the Bridgeport; which carries the 4th axis.
8. Printers: list every FDM machine by model and count; the SLA model and build volume. Is any SLS, vapor smoothing or dyeing done in-house? If not, are those to be removed or disclosed as outsourced?
9. What else is truly "under one roof": laser cutting, press brake, laser welding, powder coat?
10. When a plastic job follows a metal job on the same machine, what is the clean-down routine? Is there plastic-only tooling?

**Tolerances and inspection**
11. Fill in the tolerance the shop will commit to as standard, and the tightest it will quote, for each of: acetal, UHMW, HDPE, nylon, PEEK, PTFE, polycarbonate, on the mill, the lathe and the router.
12. Inspection tools in the shop today. Surface plate? Micrometers? Bore gages? Thread gages? 3D scanner? Any calibration records?
13. Is there a temperature-controlled place to inspect, or should "68 °F" go?
14. What counts as a "production order" for the first-article report and CoC, and are they free?
15. Do written procedures for inspection, traceability and corrective action exist today? Is an ISO 9001 audit actually planned?

**Commercial promises**
16. Lead times you will be held to, alone, in a busy week: standard, expedited, rush. Confirm Same Day is removed.
17. Firm quote in 24 hours or one business day? Valid for 30 days?
18. Warranty wording: remake or refund, and exclusions.
19. Minimum order or minimum line charge?
20. Net terms: for whom, and when?
21. Will you hand a customer their CAM program and setup notes on request (the continuity promise)?
22. No-CAD replacement parts: taking them? Charge for drawing the part? Site visits?

**Food contact**
23. Which distributor(s) supply your stock, and will they provide the maker's FDA compliance statement and lot cert for natural acetal, UHMW, HDPE, nylon and PP? Have you received one before?
24. Will you machine food-contact parts on machines that also run metal with coolant, and with what cleaning step?

**Work and photos**
25. For each of the 14 photos in `client/public/photos/`: is it your own direct work or cleared for publication? Any from marketplace jobs must come down.
26. Which part types on the routing page (guides, lane dividers, star wheels, change parts) have you actually made?
27. Which materials on the list have you actually cut? Any you want marked "on request"?
28. Do you have any direct customer who would allow a named or unnamed reference? If not, the site launches with none, which is fine.
29. Past-contacts email: who is on the list, and are any of them contacts that originated through Xometry? Those are excluded.
