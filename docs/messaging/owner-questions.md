# Questions only you can answer

The site is live-ready without any of these. Every sentence that depends on you is switched off until you say yes, and the page reads complete without it. Each answer below switches copy on.

**How to answer.** Open `shared/shop-facts.json`, find the id shown in `code`, check that `value` says exactly what you will stand behind (fix it if not), change `"confirmed": false` to `true`, commit and deploy. No code changes. A fact with an empty `value` needs your words or your number first; it stays off until it has them.

Proposed values came from the old site copy and from notes of earlier working sessions. They are proposals. Where the two disagreed, the question says so.

Ordered by how much launch copy each answer unlocks.

## Answered on 2026-11-11 (recorded in `shared/shop-facts.json`)

| id | Your answer | What it changed |
|---|---|---|
| `fai-coc`, `lot-traceability` | "A first-article inspection report and a signed certificate of conformance come with your order when you ask for them." "Material traceable to the lot." (Revised 2026-11-11 on reviewing draft PR #3: both are an option the customer ticks on the quote or the firm-quote form, with a fee; this replaces "with every production order".) | The Quality page is built on it; home step 4, About, the food-contact page and the launch kit use it; the quote tool and the firm-quote form carry the checkbox, and the fee is two rules in the pricing console (per part number, per order). Every statement about what the shop is not certified to or does not own is gone |
| `part-return` | "Make sure that me paying to ship the part back is included in the client's cost." (2026-11-11) | The send-the-part form has a box, ticked to start with: "Send my original part back with the order." The customer ships the part in at their cost; the original goes back with the finished parts; the price quoted includes that return shipping, and the shop email and admin view remind you to price it in |
| `sla-printer` | A Formlabs Form 4 and a Form 3 (2026-11-11) | The 3D printing page names both; the quote tool's size check passes a part that fits either printer |
| `engineer-led` | "Your quote and your parts are handled by the engineer who answers the phone." | Replaces every statement of shop size. The site speaks as "we" |
| `sla-resins` | Formlabs Grey, White, Clear, Tough 1500, Tough 2000, Rigid 10K, High Temp and ESD, at 0.1 mm or 0.05 mm layers | 3D printing page and the materials page |
| `dental-resin` | Not in the resin list | Stays hidden |
| `replacement-from-part` | Replacement parts are quoted from the physical part, not a photo | Home door and buttons, the replacement-parts page, the request form, its confirmation and emails |

## New questions from those answers

These are the only things the new replacement-parts flow does not say yet. Each has an empty `value` in `shared/shop-facts.json`; write the sentence you want printed, set `confirmed` to true.

| id | Question | Until you answer, the site says |
|---|---|---|
| `part-quote-time` | How soon after the part arrives do you send the price? | Nothing about timing: "We measure it and send you a price." |
| `visits-welcome` | Can a customer drop the part off instead of shipping it? (Same flag as before.) | Nothing about drop-off |
| `no-cad-drawing` | After you measure the part, does the customer get a drawing back, and is there a charge? (Same flag as before.) | "You get a price before anything is cut." |
| `engineer-title`, `owner-name` | Your name on About, and "mechanical engineer" as a stated title? | "The engineer", no name |

Questions 2, 4 and 8 below were written before these answers; where they mention sending a photo, texting a photo or working alone, read them with the decisions above.

---

## 1. The photos (do this first: they are on the site now)

All 14 photos are showing, with **no captions**. For each one: is it your own direct work, or cleared to publish? Any photo of a part made on a marketplace job has to come down, caption or no caption. Then: is the caption right?

| id | File | Proposed caption |
|---|---|---|
| `photo-tray-stack-edge` | tray-stack-edge.jpg (home hero) | HDPE, 3/4", router-cut and pocketed. |
| `photo-tray-stack-router` | tray-stack-router.jpg | HDPE trays, 3/4" thick. Pocketed and cut from sheet, 40 pcs. |
| `photo-acetal-clamps` | acetal-clamps.jpg | Black acetal clamps. Milled, 5 pcs. |
| `photo-fourth-axis` | fourth-axis.jpg | Acetal on the 4th axis. 35 pcs. |
| `photo-disc-stacks` | disc-stacks.jpg | UHMW notched discs, 1/2", cut from sheet. |
| `photo-uhmw-rack` | uhmw-rack.jpg | UHMW rack bar, milled profile. |
| `photo-brackets-inspection` | brackets-inspection.jpg | Acetal saddle brackets on the surface plate. |
| `photo-dish-part` | dish-part.jpg | Acetal dish, turned and milled. |
| `photo-cups-lot` | cups-lot.jpg | UHMW cups, 11 pcs. |
| `photo-disc-router-bed` | disc-router-bed.jpg | UHMW disc on the router bed. |
| `photo-hdpe-plate` | hdpe-plate.jpg | HDPE plate, drilled pattern. |
| `photo-disc-hand` | disc-hand.jpg | UHMW, 1/2", off the router. |
| `photo-fdm-print` | fdm-print.jpg | FDM print on the build plate. |
| `photo-phenolic-prototype` | phenolic-prototype.jpg | SLA housing with machined phenolic and acetal plates. |

Unlocks: every caption on six pages, and the home heading "Recent work. Material, thickness and quantity under each." To remove a photo, delete it from the page lists (`GALLERY` in `LandingPage.jsx`, `hero`/`gallery` in `data/services.js`); ask and it is a two-minute job.

## 2. Do you turn parts for customers? (`turning`, `lathe-capacity`)

One line: yes or no, and the lathe (make, CNC or manual, largest diameter and length). Until yes, the site says "milled and routed" everywhere and never "turned". The quote tool still offers a turning operation; if the answer is no, that needs switching off in the admin.

Unlocks: "turned" in the home hero, the machining H1 and lists, the parts-by-type page, every material page, the quote-tool blurb, and all the launch posts.

## 3. Tolerance by material (`tol-acetal`, `tol-uhmw`, `tol-hdpe`, `tol-nylon`, `tol-peek`, `tol-ptfe`, `tol-polycarbonate`, `tol-polypropylene`, `tol-routing`)

For each plastic: the standard tolerance you will be held to, and the tightest you will quote. Proposed: acetal ±0.005" standard, ±0.002" on a called-out feature; UHMW and HDPE ±0.010". The rest are blank.

Unlocks: the tolerance table on the machining page (it appears as soon as one row is confirmed, and the page headline changes to "CNC machining for plastic. Tolerances stated by material."), the "±0.005" standard on acetal" home stat, a tolerance column on the materials page, a number on each material page, LinkedIn post 5 and the Thomasnet text.

## 4. How fast is a firm quote? (`quote-turnaround`, `quote-valid`)

Proposed: 24 hours, valid 30 days. An earlier note of yours said two business days. Whatever you can keep alone in a busy week.

Unlocks: "within 24 hours" in about a dozen places (home hero and steps, firm-quote page and its confirmation, replacement parts, quality, material pages, quote tool, meta descriptions) and in post 1, the launch email and Thomasnet.

## 5. The machines, from the nameplates (`mill-tormach`, `mill-bridgeport`, `fourth-axis`, `threads-inserts`, `router-model`, `router-bed`, `router-spindle`, `router-workholding`, `router-thickness`, `router-aluminum`, `fdm-printers`, `sla-printer`, `print-accuracy`, `print-finishing`)

- Router: the old site said Techno HD-II, 5 hp, 12-position changer, vacuum table. Earlier notes say Techno RG 5996, 4 hp, tool changer, screws and clamps to a spoilboard. Read the plate.
- Printers: SLA is answered (2026-11-11): a Formlabs Form 4 and a Form 3. FDM is still open: the old site listed a Raise3D N2 Plus and three Creality K2 Plus; earlier notes say one K2 Plus. List what is in the building.
- Mills: Tormach PCNC 1100 and a CNC Bridgeport; which carries the 4th axis.

Unlocks: the "Machines and limits" lists on all three service pages (today they state only what the quote tool enforces), the router-bed home stat, posts 1 and 4.

## 6. Paperwork with the order (`fai-coc`, `material-certs`, `traveler`, `corrective-action`, `written-procedures`)

First-article report and certificate of conformance: answered 2026-11-11. Any order, when the customer ticks the box, for a fee (pricing console: per part number and per order; the starting values are placeholders for you to set). Still open: Can you pass a material cert through? Does every job get a traveler? Do written procedures exist today?

Unlocks: "Paperwork with the order" on Quality (today it says "ask and the quote will state it"), the second half of the ISO paragraph, home step 4, post 6.

## 7. When it is wrong, and when you are not there (`warranty`, `continuity-handover`, `capacity`)

- Your warranty in your own words, with exclusions. Proposed: "If a part does not meet the print, I remake it or refund it."
- Will you hand a customer their program, setup notes and first-article report on request? This is the strongest answer to "what if the one person gets hurt", and it only works if it is real.
- Quantity range by process. Proposed: milled, one to a few hundred; routed, thousands by the sheet.

Unlocks: the warranty line on Quality, the continuity sentence on Quality and About, post 6.

## 8. Replacement parts and the shop door (`no-cad-drawing`, `visits-welcome`, `shop-hours`, `phone-texts`, `site-visits`, `drive-times`, `min-order`)

- No drawing: do you measure and draw the part, does the customer get the drawing, is there a charge?
- May customers drop a part off and pick orders up? Hours? (Zoning and insurance are your call.)
- Does 224-213-6727 take texts with photos?
- Will you drive out to look at a machine?
- Drive times to Milwaukee, Kenosha, Rockford, Elk Grove Village, checked on a map.
- Any minimum order.

Unlocks: the replacement-parts headline changes from "Send a photo." to "Bring it in.", step 2 becomes "I measure it and draw it", the "Where" strip on the home page gains hours, pickup and drive times, "Come see the shop." on About, post 3, the Google profile text.

## 9. Food contact (`food-docs`, `food-cleaning`)

Will your distributor supply the maker's compliance statement and lot cert for natural acetal, UHMW, HDPE, nylon and PP, and have you received one? What is the cleaning step before a food-contact job on a machine that also cuts metal with coolant (your words)?

Unlocks: "What comes with the job" on the food-contact page, the food line on every material page, and the grade names in the quote tool (today "UHMW — natural (FDA)" is shown as "UHMW — natural"; confirmed, it reads "UHMW — natural, food-contact grade (maker's compliance statement on request)").

## 10. Who and what the company is (`legal-name`, `parent-company`, `founded-year`, `owner-name`, `engineer-title`, `about-origin`, `under-one-roof`, `sam-registered`, `paperwork-packet`, `net-terms`)

Is "Straightedge Manufacturing LLC" filed (earlier notes say the entity was formed under another name)? May the site name the parent and link to it for metal work? What year, and what does it refer to? Your name on About? "Mechanical engineer"? Two sentences of your own on why plastics became its own shop (direct work only). W-9, COI and NDA within a business day? Net terms?

Unlocks: the legal line in the footer and structured data, your name and title on About, the paperwork list on About and Quality, "NDA on request".

---

## Smaller ones

| id | Question | Unlocks |
|---|---|---|
| `nothing-outsourced` | Is everything sold here made in your shop? | "Not a marketplace. Nothing is sent out." on About; a sentence on 3D printing; post 6 |
| `practice-rest`, `inspect-68f` | Do parts sit before you measure them? Temperature-controlled inspection? | "Plastics move. We measure for it." on home; lines on Quality and machining |
| `practice-sharp-light`, `practice-programs-saved`, `practice-air-blast`, `nylon-dry` | Plastic-only cutters, light cuts, saved programs, air blast, nylon cut dry? | The machining lede (framework rewrite 5) and two Quality lines |
| `clean-down` | What you do when plastic follows metal on a machine (your words) | A line on machining |
| `insp-*` (8) | Each inspection tool in the shop today | The tool list on Quality. Earlier notes: gage pins, 8" caliper, height gage on hand |
| `edge-polish` | Do you polish polycarbonate and acrylic edges? | Routing, two material pages |
| `acetal-holds-best` | Agree acetal holds size best on the list? | One clause on Materials |
| `price-example` | Three real prices for one acetal block at 1, 10, 100 | A price example on the home page |
| `file-encryption`, `file-retention` | Encryption key set in production? Files deleted after 7 days? | Wording in home step 1 |
| `lead-standard` | Standard lead time you will be held to | Marketing pages only |

## Things a flag switches off in the quote tool today

These were on the old site with nothing behind them, so they are hidden from buyers until you confirm. Flip the flag to bring one back.

| id | Hidden now |
|---|---|
| `lead-same-day` | "Same Day, ships today (order by 10am)" at checkout. The audit says not to promise it. |
| `lead-rush` | "Priority Rush, 1-2 business days" at checkout. |
| `sls-offered` | Four SLS materials (no SLS machine is listed). If you sell them, they are made elsewhere and the site has to say so. |
| `dental-resin` | "Dental / Biocompatible Resin". |
| `print-vapor-dye` | Vapor smoothing and dyeing finishes. |

## Still on the site and not behind a flag (your decision needed)

1. **Standard 7-10 and Expedited 3-5 business days at checkout.** A buyer pays against these. They are editable in the admin; the site cannot check out without at least one.
2. **"Within 24 hours" in the firm-quote confirmation email and in the quote tool's "needs a person" message.** Both are written in server files that another change is in progress on. They follow `quoteTurnaroundHours` in `shared/brand.json`; change the number there if 24 is wrong.
3. **Tolerance sentences on the quote tool's DFM tab** ("Standard ±0.005" on plastics, ±0.010" on soft plastics, ±0.002" on metals; held at 68 °F"). Same reason. They should follow question 3.
4. **Turning as an operation in the quote tool** (question 2).
5. **States listed as the service area in the structured data** (IL, WI, IN, IA, MI, MN, MO, OH).
6. **Past-contacts email list**: leave out anyone you know only through a marketplace job.
