# Straightedge messaging framework

For the copywriter implementing the launch copy. Evidence is in `research.md` (section numbers cited as R1–R6). Every factual claim here is tracked in `claims-audit.md`; where a line carries `[CONFIRM: …]`, do not publish it until the owner has answered. The existing ten-rule style sheet in `docs/copy-ui-review.md` stays in force; this document extends it.

---

## Owner decisions (2026-11-11)

The owner reviewed the live site and took it down over the first two items below. **These override everything further down this document where they conflict.** `node scripts/claims-check.js` fails the build on wording 1, 2, 4 and 5 rule out.

**1. Say what is done. Say nothing about what the shop lacks.**
No ISO line anywhere, in either direction: not "not certified", not "working toward", not "in progress", not "built to", not "ISO-style", no logo. No line about a CMM or any other equipment that is not in the building. Never claim or imply certification.
What the Quality page and every quality mention say instead: see decision 5, which replaces the wording first chosen here ("First-article inspection and a certificate of conformance with every production order. Material traceable to the lot."). "Material traceable to the lot." stands (fact `lot-traceability`). Other practices (material certs passed through, travelers, corrective action, written procedures, inspection tools) stay behind their own flags until he confirms each one. Do not invent a practice.

**2. No statement of shop size. Direct access is the benefit, said as "engineer-led".**
Never: "one person", "one-person shop", "one set of hands", "alone", any headcount, or advice to keep a second source because of the shop's size. Equally never the opposite: no "our team", "our engineers", "our machinists", "our experts", no departments. The brand deals square, so the copy does not imply staff that do not exist.
- Headlines, hero, stats, footer: engineer-led. Approved: **"Your quote and your parts are handled by the engineer who answers the phone."** In the same spirit: "Call and you reach the engineer running your job." (fact `engineer-led`). "The engineer", singular. His name and a stated title stay behind `owner-name` and `engineer-title`.
- Everywhere else: first person plural ("we", "our", "us"), no statement about size. No first person singular on pages, system emails or documents. "A person quotes it" is fine where the contrast is with the software.

**3. Confirmed facts to keep straight.**
Turning is not sold as its own operation: "milled and routed". Anodize and powder coat are sent out; bead blasting is done here. Lead times: Standard 7 to 10, Expedited 3 to 5 business days. A person quotes within 24 hours when the instant price does not apply. SLA printing uses Formlabs Grey, White, Clear, Tough 1500, Tough 2000, Rigid 10K, High Temp and ESD resins at 0.1 mm or 0.05 mm layers (fact `sla-resins`); no flexible or dental resin.

**4. Replacement parts are quoted from the physical part, not from a photo.**
His words: "For the replacement parts page I don't want them to send us a picture of the part. They need to send us the physical part." The door is "No CAD? Send us the part." The flow: a short request (what the part is and does, the machine, material if known, how many, how soon; no upload), then a reference to write on the box and the ship-to address, then we measure the part and send a price. The street address is given only after a request is sent (confirmation screen and email, from `server/config/shipFrom.json`); it never appears on a public page, in the page source or in structured data. Whether the original is returned and who pays shipping is answered in decision 6. Drop-off (`visits-welcome`) and how soon a price follows the part (`part-quote-time`) are still his to answer.

**5. Inspection paperwork is something the customer asks for, with a stated fee. (2026-11-11, later the same day, on reviewing draft PR #3. This supersedes the "with every production order" wording chosen earlier that day in decision 1.)**
His words: "First article and CoC with every production order. This should be specified by the client. Make them check a box before auto quote is sent in and add to the price to cover the added paperwork." So a first-article inspection report and a certificate of conformance do not come with every order. They are available on any order when the customer asks: a checkbox on the instant quote (off by default; it re-prices the quote and the fee is its own line through checkout, the order, the emails and the documents) or the same checkbox on the firm-quote form (stored with the request; the owner prices it in and the firm quote states whether the price includes it). Approved wording (fact `fai-coc`): **"A first-article inspection report and a signed certificate of conformance come with your order when you ask for them."** followed where there is room by "Tick the box on your quote. The price shows before you pay." Never "with every order", "with every production order", "standard" or "included". No dollar amount in static copy: the fee is two admin-editable pricing rules (`paperworkFeePerPart`, per part number; `paperworkFeePerOrder`, per order) and the quote tool shows the live number. The lot is written on the certificate, so say "the lot is on the certificate" only of an order that has one. The footer bar no longer carries a quality line: it says "Customer names and part numbers are never published."

**6. Replacement parts: the original goes back, and the price covers it. (2026-11-11, same review.)**
His words: "Make sure that me paying to ship the part back is included in the client's cost." The customer ships the worn part in at their cost. The request form has a box, ticked to start with: "Send my original part back with the order." When it is ticked we return the original with the finished parts, and the price we quote includes that return shipping (fact `part-return`, confirmed). The shop notification and the admin request view remind the owner: "Customer wants the original back — include return shipping in the price." How soon a price follows the part (`part-quote-time`) and drop-off (`visits-welcome`) are still unanswered: no timing promise and nothing about drop-off.

**7. SLA printers: a Formlabs Form 4 and a Form 3. (2026-11-11, same review.)**
Fact `sla-printer`, confirmed. The 3D printing page names both. No build volume in copy: the quote tool's size check passes a part that fits either printer (Form 4 200 × 125 × 210 mm, Form 3 145 × 145 × 185 mm, Formlabs' published volumes) and its message names the printer that applied.

**What this supersedes below.** Section 1: the one-sentence promise and the "What Straightedge is not" list. Section 2: "a clear statement on ISO" and the continuity plan as proof points; "the person who runs the machines" as a CTA label. Section 3: "made by the person who quotes them", pillar 2's "one person" wording, the "Not-ISO statement" in pillar 4. Section 4: rules 11 and 12, the "one person, I" row of the word list, rewrites 9 and 10 and the two that follow. Section 5: headline H3. Section 6: the one-person and ISO objection answers, and the first person singular in the rest (the answers stand in "we"); the no-drawing answer. Section 7: the stat "One person", "ISO status first" and "the one-person question" on Quality, "first person throughout" on About, the replacement-parts H1 and photo steps, the firm-quote "attach a photo" path. Section 8, item 8. Decision 5 also supersedes "First-article report and CoC as standard" (section 2), the first-article and certificate lines wherever they read as coming with the job (sections 3 and 6), and "with every production order" in the Quality notes of section 7. Read those passages as history, not as instructions.

---

## 1. Positioning

**Positioning statement**

For buyers and engineers at Midwestern equipment builders and plants who need machined plastic parts, Straightedge is the plastics machine shop in Wauconda, Illinois that shows the price on the page and puts the person who will cut the part on the phone. The regional plastics fabricators make you request a quote and wait; the instant-quote sites won't tell you who is making your part. Straightedge gives the price now, prints its tolerances and machine limits, and tells you plainly what plastic will and will not hold.

**Why this position** (R3.3): of fifteen competitors reviewed, none combines a price on the page with a named maker for milled, turned and pocketed plastic parts. The regional shops win on tenure, certification and scale, which Straightedge cannot match and should not pretend to. The platforms win on convenience, which Straightedge matches, and lose on accountability, where a one-person shop is at its strongest.

**The one-sentence promise**

> A price now, a straight answer about what the plastic will hold, and one person from quote to box.

Each clause maps to something checkable: the quote tool, the tolerance table, the phone number.

**What Straightedge is not, stated on the site in plain words**

- Not ISO 9001 certified.
- Not a high-volume house. One person, a handful of machines.
- Not a marketplace. Nothing is sent out. `[CONFIRM: nothing outsourced]`
- Not a metal shop that also does plastic, and not a plastics-only cleanroom either. `[CONFIRM: clean-down routine]`

Saying these is the positioning. A buyer who reads four honest limits believes the fifth sentence.

---

## 2. Audience profiles

### 2.1 The buyer — purchasing agent or OEM buyer

| | |
|---|---|
| **Who** | Buys machined components for a packaging-machinery or food-equipment builder. Has a drawing and an annual quantity. Not an engineer. Measured on price, on-time delivery and not being surprised. |
| **Their question** | "What happens when it's wrong, or when you're late?" |
| **Their fear** | Approving a tiny, uncertified supplier that fails, and having to explain it. A single point of failure. |
| **What they check first** | Address and phone. Whether you'll fill out their supplier form. Certification status. Lead time. Who they call. |
| **Proof they need** | W-9, COI, NDA turnaround. A clear statement on ISO. First-article report and CoC as standard. A written remake-or-refund term. A stated plan for continuity (their program and setup notes on request). Quantity-break pricing they can put in a spreadsheet. |
| **Words they use** | Lead time, on-time, cert, CoC, first article, blanket order, releases, terms, supplier form, quote, late (R1.2, R2.6). |
| **CTA** | Primary: **Request a firm quote** (they have a drawing and quantities over 100). Secondary: **Get the supplier packet** (W-9, COI, quality summary as one PDF). `[CONFIRM: packet exists]` |
| **Do not say to them** | "Partner." "Solutions." Anything implying scale. |

### 2.2 The design or manufacturing engineer

| | |
|---|---|
| **Who** | Designs the machine or the fixture. Has a STEP file. Needs 1 to 50 now and may need 500 later. Has been burned by a plastic part that was in tolerance at the shop and out of tolerance on the bench. |
| **Their question** | "Will this actually hold the dimension I need in this material, and what will it cost?" |
| **Their fear** | That their drawing is unreasonable and nobody will tell them until the parts arrive (R2.1: "Now these tolerances may be unreasonable"). Sending CAD into "a black hole" (R2.6). |
| **What they check first** | Tolerances in numbers. Machine envelope. Materials with grades. Whether they can get a price without an account or a call. |
| **Proof they need** | A per-material tolerance table. Machine list with travel. DFM notes that read like someone who has cut the material. A price breakdown. The physics stated correctly (expansion, moisture, stress relief). |
| **Words they use** | Delrin, UHMW, flatness, press fit, moves, warps, relaxes, burrs, stringy, DFM, STEP, tolerance stack, "is ±.002 too much to ask?" (R2.1, R2.3). |
| **CTA** | Primary: **Get an instant quote**. Secondary: **Call with a tolerance question** (the phone number, labeled as going to the person who runs the machines). |
| **Do not say to them** | "Tight tolerances." ".0001." Anything a plastics engineer knows is not true of plastic. |

### 2.3 The maintenance or plant engineer

| | |
|---|---|
| **Who** | Keeps a packaging or processing line running. Holding a worn wear strip, guide, starwheel pocket or bushing. No CAD. The OEM quoted six weeks, or is gone. |
| **Their question** | "Can you make me one of these, and when?" |
| **Their fear** | A line down. Being told to "submit an RFQ." Paying a minimum for one part and waiting anyway. |
| **What they check first** | A phone number. "Near me." Whether they need a drawing. Whether they can drop the part off. |
| **Proof they need** | The sentence "No drawing needed." A photo of a replacement part next to the worn original `[CONFIRM: such a photo exists and is the shop's own work]`. A drive time. A straight lead time. |
| **Words they use** | Replacement part, wear strip, guide, change part, discontinued, obsolete, "the OEM wants…", line down, bring it in, one-off (R2.7). |
| **CTA** | Primary: **Call 224-213-6727** or **Text a photo** `[CONFIRM: number accepts texts]`. Secondary: **Send a photo and dimensions** (the firm-quote form, which already accepts JPG/PNG). |
| **Do not say to them** | "Upload your CAD." "Reverse engineering services." "Legacy component reproduction." |

---

## 3. Message hierarchy

### Primary claim

**Machined plastic parts, priced on the page, made in Wauconda by the person who quotes them.**

### Pillars and proof

| Pillar | What it means | Proof to show | Status |
|---|---|---|---|
| **1. The price is on the page.** | Upload a file, see a price and a manufacturability check, pay by card up to 100 pieces. No account to look. Over 100, a firm quote from a person. | The quote tool itself. A worked price example on the home page (`docs/site-plan.md` Q11). The line "No account needed to see a price." | Verified flow. Price example `[CONFIRM]`. Quote turnaround `[CONFIRM: 24 h or one business day]`. |
| **2. You know who makes it.** | One shop, one address, one person who programs, runs and answers. Nothing brokered. | Name and photo of the owner on About `[CONFIRM: willing]`. Phone number in the header. "Come see the shop." Real photos. | `[CONFIRM: address, visits, nothing outsourced]` |
| **3. We tell you what plastic will do.** | Plastic moves with heat and moisture and relaxes after cutting. The shop says what each material will hold before cutting, and says when a drawing asks for something the material won't keep. | Per-material tolerance table. The "Watch out for" column on Materials. "Parts sit before they're measured." Design notes on each service page. | Physics verified (R2.1). Shop tolerances and practice `[CONFIRM]`. |
| **4. The limits are printed.** | Machine envelopes, sheet size, thickness range, corner radii, what gets sent to a person, what the shop won't do. | Machine list with travels. "When not to print." "For heavy aluminum production you may be better served by a dedicated metal shop." Not-ISO statement. | Machine facts `[CONFIRM: see audit A34, A35, A43, A54, A55]` |

Pillar 3 is the differentiator against regional shops that give no numbers and platforms that quote plastic like soft metal. Pillar 2 is the differentiator against platforms. Pillar 1 is the differentiator against regional shops. Pillar 4 is what makes the other three believable.

### Supporting messages (use where relevant, never in the hero)

- Drive distance and pickup for Lake, McHenry, northern Cook, Kenosha and Milwaukee.
- No drawing needed for replacement parts.
- Food-contact grades with the maker's compliance paper passed through.
- Print the prototype, machine the production part, same shop.
- First-article report and certificate of conformance.

---

## 4. Voice

The ten rules in `docs/copy-ui-review.md` stand. Additions for the launch:

**11. First person singular where it is one person.** The About page, the quality promise and every LinkedIn post say "I." Service and material pages may say "we" for the shop. Never "our team," "our experts," "our machinists."

**12. Concede before you claim.** If a strength has a matching weakness, state the weakness first. "This is a one-person shop. That means the person who quoted your part is the one cutting it. It also means I have one set of hands."

**13. No claims about other shops.** Describe what Straightedge does. Let the buyer draw the comparison. Never name a competitor or a marketplace anywhere on the site or in launch material.

**14. Plastic claims carry a material.** Not "we hold ±0.005"." Instead "±0.005" on acetal; UHMW and HDPE get ±0.010" because they move." `[CONFIRM: numbers]`

**15. Compliance words are used exactly.** "FDA-compliant grade," never "FDA-approved." "Complies with 21 CFR 177.xxxx per the manufacturer's statement," never "food safe." Never NSF, 3-A or USDA as attributes of the shop or its parts (R2.5).

**16. Never a customer, by name or by implication.** Describe work by part type and material only: "UHMW notched discs, 1/2", nested from sheet." Not "for a packaging OEM." Not "for a Fortune 500 food company." The shop's marketplace agreement bars naming or contacting those customers; the simplest rule is no customers at all until one says yes in writing.

**17. Dates and counts only if they will stay true.** No "last 60 days." No "over 500 parts shipped" unless there is a count and a plan to update it.

### Word lists

| Use | Avoid |
|---|---|
| print (body), drawing (forms and headings) | blueprint, schematic |
| part, piece, pcs | component, unit, item |
| shop | facility, plant, operation |
| price | pricing, investment |
| firm quote / instant quote | RFQ (in buyer-facing copy), estimate, proposal |
| lead time in business days | fast, quick, rapid, expedited (as an adjective) |
| ±0.005" on acetal | tight tolerances, precision, high-accuracy |
| holds size, moves, relaxes, grows | dimensionally stable (unless quoting a datasheet), superior stability |
| deburred, edges broken | finished to perfection, flawless |
| clean edge, no fuzz | superior surface finish |
| replacement part, wear part, change part | legacy component, aftermarket solution |
| food-contact grade, compliance statement | food safe, FDA approved, FDA certified, sanitary |
| one person, I | our team, our experts, family, craftsmen |
| Wauconda, Lake County, an hour from Milwaukee `[CONFIRM]` | Chicagoland area, Greater Chicago, the Midwest's premier |
| call, text, bring it in | reach out, connect, touch base, engage |
| we don't do that / send that elsewhere | unfortunately, at this time, we strive |
| made here | American craftsmanship, proudly made |
| setup, program, fixture, nest, sheet | process optimization, workflow |

Banned outright (extends the existing list): solutions, partner, capabilities as a noun for services, one-stop, turnkey, best-in-class, industry-leading, trusted, passionate, proud, excited, quality as an adjective, affordable, competitive, custom as filler, commitment, dedicated to, strive, ensure, journey, "machines like butter," any tagline, any exclamation mark.

### Ten before-and-after rewrites of lines now on the site

| # | Where | Now | Rewrite | Why |
|---|---|---|---|---|
| 1 | Home H1 | "Machined plastic parts. One to a few thousand." | "Machined plastic parts. Price now, made in Wauconda, Illinois." | The current line says what and how many. It omits the two things the first 30 seconds are spent checking: where, and how to get a price (R1.2). "A few thousand" is also a capacity claim awaiting confirmation (audit A7). |
| 2 | Home lede | "CNC milling, turning and routing in Delrin, UHMW, HDPE, nylon, PEEK and 6061. Upload a STEP or STL and get a price now. Over 100 pieces, the person who will run the job quotes it within 24 hours." | "Milled, turned and routed from Delrin, UHMW, HDPE, nylon and PEEK. Upload a STEP file and see the price; no account, no call. Over 100 pieces, or no CAD at all, the person who will cut the part quotes it within `[CONFIRM: 24 hours / one business day]`." | Adds the no-account fact, which is the answer to the engineer's first objection, and opens a door for the maintenance buyer. Drops 6061 from the first sentence; it dilutes "plastic" and is covered below. |
| 3 | Home stat | "Since 2017 — machining in Lake County" | "±0.005" — standard on acetal `[CONFIRM]`" | The year invites comparison with competitors founded in 1942–1985 and may not be accurate for machining (audit A5). A tolerance number is a fact engineers scan for and no regional competitor prints one. |
| 4 | Home gallery H2 | "Parts off the machines in the last 60 days." | "Recent work. Material, thickness and quantity under each." | Goes stale. The replacement tells the reader what the captions give them. |
| 5 | Machining lede | "Most machine shops treat plastic as the job they take when the aluminum runs out. We set the shop up around it: sharp tooling, light engagement, parts left to normalize before inspection, and programs saved for the reorder." | "Plastic is not soft aluminum. It grows with heat, relaxes after the cut and smears under a dull tool. So: cutters kept sharp and used only on plastic `[CONFIRM]`, light cuts, parts left to sit before they are measured, and the program saved for your reorder." | Removes a claim about other shops (rule 13, audit A31). Leads with physics an engineer will recognize as true (R2.1, R2.3). |
| 6 | Routing lede | "A router with a tool changer, a vacuum table and a 4' × 8' sheet is the cheapest way there is to make a flat plastic part in quantity." | "If your part is flat, cutting it from sheet on the router is usually the cheapest way to make it. Profiles, pockets, counterbores and chamfers in one setup, in stock from 1/16" to 1" thick `[CONFIRM]`." | "Cheapest way there is" is unprovable. Vacuum table is unconfirmed (audit A42). Pockets, counterbores and thickness to 1" are exactly what 2D sheet-cutting services do not offer (R3.2), stated without naming anyone. |
| 7 | Materials, acetal | "Stiff, dimensionally stable, low friction, machines like butter." | "Stiff, low friction, cuts cleanly and holds size better than any other plastic on this list." `[CONFIRM: owner agrees]` | Cliché out. Says the thing an engineer wants to know: this is the one to pick when a dimension matters. |
| 8 | Materials, acetal | "Natural acetal is FDA-compliant." | "Natural grades that comply with FDA food-contact rules are available. Tell us you need one; the maker's compliance statement comes with the lot." `[CONFIRM: documents obtainable]` | Compliance belongs to a grade from a maker, not to a color of plastic (R2.5, audit A63). |
| 9 | Quality, ISO | "If your supplier approval needs the certificate, tell us; if it needs the behavior, you already have it." | "We are not ISO 9001 certified. If your supplier approval requires the certificate, we are not your shop yet, and it is better you know that now. If it requires traceability, a first-article report and a corrective-action record, those come with the job." `[CONFIRM: all three exist]` | The original is clever and asserts its own conclusion. The rewrite concedes first (rule 12) and lets a buyer disqualify the shop quickly, which they will respect. |
| 10 | About | "That's small, and we don't pretend otherwise. It also means the DFM note on your quote came from the person who will hold your part, and the price you see is the price we'll build it for." | "That is one person. It means the note on your quote came from the person who will cut your part, and when you call you get an answer instead of a callback. It also means one set of hands: if your job needs more than this shop can run by your date, I will say so before you order." | States the number (rule 1). Switches to "I" (rule 11). Names the weakness and the behavior that manages it (rule 12). Drops the price promise, which is only true of instant orders (audit A87). |

Two more the copywriter should apply without discussion:

- Quality, "Nonconforming parts are replaced or reworked on our dime; we don't argue over a thousandth that's on the print." → "If a part does not meet the print, I remake it or refund it. `[CONFIRM: terms and exclusions]`" Shorter, first person, and a warranty has to be the owner's words.
- Quality, "No melted edges, no smeared bores." → "…so edges don't melt and bores don't smear." A practice, not a guarantee of outcome.

---

## 5. Headlines

### Home hero

| # | Headline | Serves | Risk |
|---|---|---|---|
| H1 | **Machined plastic parts. Price now, made in Wauconda, Illinois.** | All three audiences. States what, how to buy, and where. Place name helps local search (R5.2). | Plain. That is the point. |
| H2 | **Delrin, UHMW and HDPE parts, machined in Lake County. See the price before you call.** | Engineer and search. Material names are what they type (R5.1 A). | Long. Narrows to three materials. |
| H3 | **Upload the part. See the price. Talk to the person who will cut it.** | Engineer. Process as promise. | No material, no place. Reads like a platform until the third sentence. |
| H4 | **Machined plastic parts from a shop you can drive to.** | Buyer and maintenance within 90 minutes. The anti-marketplace line. | Useless to a reader in Ohio. No price message. |
| H5 | **Machined plastic parts. One to a few thousand.** (current) | Buyer. Signals range. | No place, no price, unconfirmed capacity. |

**Recommendation: H1**, with the eyebrow "Lake County, Illinois" replaced by "Plastics machine shop" so the eyebrow and headline are not both doing geography. Reasoning: a buyer vets under five suppliers and judges from the website (R1.1). In the first screen they need to learn that this is a plastics shop, that it is real and located somewhere, and that the price is available now. H1 is the only option that carries all three, and it does so with no adjective. H2 is the best alternative if the owner wants to lean into search for the three highest-volume materials; test it on the Machining page first.

Hero subhead (pairs with H1): rewrite 2 above.

Hero buttons: **Get an instant quote** · **No CAD? Send a photo** (replaces "See what we run," which is a scroll link and can become a text link below the buttons). The second button is the missing door for the maintenance buyer (`docs/site-plan.md`, Persona C).

### Machining page

| # | Headline | Note |
|---|---|---|
| M1 | **CNC machining for plastic. Tolerances stated by material.** | Recommended. Leads with the differentiator no competitor prints (R3.3). Requires the tolerance table `[CONFIRM]`. |
| M2 | **Delrin, UHMW, nylon and PEEK, milled and turned in Wauconda, Illinois.** | Search-first alternative. Use as the H1 if the table is not ready at launch. |
| M3 | **CNC machining, plastics first.** (current) | Keep as the eyebrow. As an H1 it does not say what "first" buys the customer. |

### Routing page

| # | Headline | Note |
|---|---|---|
| R1 | **Flat plastic parts cut from sheet. Pockets, counterbores and chamfers included.** | Recommended. Names the three operations that separate a router from laser and 2D services, in the buyer's words. |
| R2 | **HDPE, UHMW and acetal sheet, routed to your file on a 59" × 96" bed.** | Search-first alternative. Bed size is a hard fact buyers filter on `[CONFIRM: model and bed]`. |
| R3 | **Flat plastic parts, nested and cut by the sheet.** (current) | Good, accurate. Keep as fallback. "Nested" is shop language the buyer may not use. |

### 3D printing page

| # | Headline | Note |
|---|---|---|
| P1 | **Print the prototype. Machine the part.** (current) | Recommended. It is the only headline on the site that already states a position: printing here serves machining. Matches the scan-print-machine route trade press recommends for obsolete parts (R2.7). |
| P2 | **A printed fit check this week. The machined part after you approve it.** | Alternative that states the sequence and a time `[CONFIRM: lead time]`. |
| P3 | **FDM and SLA printing for prototypes, fixtures and short runs.** | Search-first. Use as the meta title, not the H1. |

---

## 6. Objection handling

Write these in first person. Each concedes, then states what is done about it. They belong on Quality and About, and in the owner's mouth on the phone.

**"You're a one-person shop. What if you get hurt, get busy, or quit?"**

> That is a fair question and the honest answer is that one person is a risk. Here is how I manage it. Every job has a traveler with the stock lot, the program revision and the setup. Your program, setup notes and first-article report are yours on request, so another shop can pick the part up from where I left it `[CONFIRM: owner will hand these over]`. I will not take a job I cannot finish by the date on the quote, and if something changes you hear it from me that day. For a part your line cannot run without, keep a second source or a shelf of spares. I would tell you that even if I had fifty people.

Short form for a page: "One person. Your program and setup notes are yours on request, so you are never locked to this shop."

**"You're not ISO 9001 certified."**

> Correct. If your supplier approval requires the certificate, I am not your shop yet. What comes with the job today: `[CONFIRM each]` a first-article report against your print, a certificate of conformance with the material lot, and the maker's material cert when you ask for it. If you want to audit how I do that, come look.

Do not say "working toward" unless there is a date or a registrar (audit A28).

**"A marketplace quoted this cheaper."**

> It may be cheaper there. What you get here for the difference: you know who is cutting it, you can call that person before and after, and the tolerance on the quote is one this material will actually hold in this shop. If none of that matters for this part, buy it there. If it does, send me the print.

Never name the marketplace. Never claim to be cheaper. The owner's own stated sales principle is that the shop competes on speed and directness, not price.

**"Can you handle the volume?"**

> Depends on the part. Flat parts off the router: thousands, because they come off by the sheet `[CONFIRM]`. Milled and turned parts: I am set up for one to a few hundred `[CONFIRM]`. If your quantity or your date is past what one person can run, the quote will say so and I will tell you who to call. Blanket orders with monthly releases suit this shop better than one large drop.

**"Why plastics only? We need the steel bracket too."**

> Plastic is what the shop is set up to do well, and doing one thing is how a small shop stays good at it. I also machine 6061 and brass when the mating part is metal. For steel, weldments and sheet metal, our parent company does that work `[CONFIRM: link and willingness]`. For heavy aluminum production you are better served by a metal shop, and I will say so.

**"Why should I trust your tolerances on plastic?"** (engineer; not in the brief but it is the real one)

> Because I will tell you when not to. Acetal will hold ±0.002" on a bore `[CONFIRM]`. UHMW will not, in any shop, because it moves with the weather. Parts sit before I measure them. If your print asks for something the material will not keep, you will hear that before I cut it, with what I would do instead.

**"I don't have a drawing."** (maintenance)

> You do not need one. Send a photo with a tape measure in it, or bring the worn part in. I measure it, draw it, and send you the drawing with the quote so you have it next time `[CONFIRM: policy and any drawing charge]`.

---

## 7. Page-by-page copy brief

Format: purpose, audience, search intent, H1, section order, must-include facts, must-not. `[CONFIRM]` items block publication of that line only.

### Home `/`

- **Purpose:** in one screen, say what, where, and that the price is here. Route three audiences to three doors.
- **Audience:** all three.
- **Search intent:** "plastic machining Illinois / Chicago / Wisconsin," "plastic machine shop," brand name.
- **Title tag:** `Plastic machining in Wauconda, Illinois | Straightedge`. **Meta:** "Machined plastic parts from a shop in Lake County, Illinois. Delrin, UHMW, HDPE, nylon and PEEK, milled, turned and routed. See a price online; no account needed."
- **H1:** H1 above.
- **Section order:**
  1. Hero: H1, rewritten lede, two buttons, file-type chips, real photo with caption.
  2. Stat row, four facts, all checkable: "Price now — to 100 pieces, by card"; "±0.005" — standard on acetal `[CONFIRM]`"; "59" × 96" — router bed"; "One person — quotes it, cuts it, answers the phone." Drop "Since 2017" and "13 engineering plastics" (move the count to Materials).
  3. **Three doors** (new): "I have a CAD file" → instant quote. "I have a drawing and a quantity" → firm quote. "I have a worn part and no drawing" → replacement parts page / phone. One sentence each. This replaces nothing; it sits above the process cards.
  4. Process cards (keep; apply rewrite 6 to the routing card; fix the FDM count).
  5. Recent work (rewrite 4). Captions: material, thickness, process, quantity. No customers. `[CONFIRM: every photo cleared]`
  6. A worked price example (new): one acetal block at 1, 10 and 100 pieces with material, setup and machine time shown. `[CONFIRM: owner approves publishing]` This is the single strongest trust signal for an engineer (`docs/site-plan.md` Q11).
  7. How it works (keep; step 01 gains "deleted after 7 days unless you order" `[CONFIRM: production setting]`).
  8. "Plastics move. We measure for it." (keep the heading; it is the best line on the site). Tighten the list to what is confirmed. Link to the tolerance table.
  9. **Where** (new): Wauconda on a simple map, drive times to four named places `[CONFIRM]`, pickup hours `[CONFIRM]`, "Central time. Phone answered `[hours]`."
  10. Closing CTA (keep "Have a print? Send it." Add under it: "No print? Send a photo.")
- **Must not:** any customer category presented as clients; any year; "few thousand" until confirmed.

### Machining `/machining`

- **Purpose:** convince an engineer the shop understands plastic, and give them numbers.
- **Audience:** engineer first, buyer second.
- **Search intent:** "delrin machining," "acetal machining," "UHMW machined parts," "plastic CNC machining," "PEEK machining."
- **Title tag:** `CNC machining of Delrin, UHMW, nylon and PEEK | Straightedge, Illinois`.
- **H1:** M1 (or M2 until the table exists).
- **Section order:**
  1. Hero with rewrite 5.
  2. **Tolerance table by material** (new). Columns: material; standard; tightest we quote; what moves it. Rows: acetal, nylon, UHMW, HDPE, PEEK, PTFE, polycarbonate. Cells from the owner `[CONFIRM: audit C11]`. Footnote: "Measured at room temperature after the parts have sat `[CONFIRM: how long]`. Plastic expands five to ten times as much as steel for the same temperature change, so tell us where the part lives."
  3. Machines and limits. Name each machine, its travel, and what it means for part size. `[CONFIRM: A34, A35]`
  4. What runs well here. Part types only, by material.
  5. Design notes that save you money (keep; these are the best-written lines on the page).
  6. **What we send elsewhere** (new, short): square inside corners, parts over the envelope, heavy aluminum production, tolerances a material will not hold.
  7. How metal and plastic share the shop (new, two sentences) `[CONFIRM: A33]`.
  8. Materials chips, gallery, related links.
- **Must include:** the phone number labeled "tolerance question? This rings the shop."
- **Must not:** claims about other machine shops; ".0001"; "precision."

### Routing `/routing`

- **Purpose:** show that flat parts with pockets and thickness belong here, priced by the sheet.
- **Audience:** buyer and engineer at packaging and conveyor builders; maintenance for guards and wear strips.
- **Search intent:** "HDPE CNC routing," "UHMW sheet cutting," "plastic CNC routing Illinois," "polycarbonate machine guard cut to size," "custom UHMW wear strips."
- **Title tag:** `CNC routing of HDPE, UHMW and acetal sheet | Straightedge, Illinois`.
- **H1:** R1.
- **Section order:** hero with rewrite 6; machine and limits with the nameplate facts `[CONFIRM: A43]` and thickness range; **what a router does that a flat-cutting service does not** (pockets, counterbores, chamfers, stock to 1", partial-depth cuts; no competitor named); what runs well here (only parts the shop has made `[CONFIRM: A47]`); design notes (keep; revise the tabs note if there is no vacuum table); sheet-yield note; gallery.
- **Must not:** "cheapest way there is"; "vacuum table" unless confirmed; star wheels and change parts unless made.

### 3D printing `/3d-printing`

- **Purpose:** position printing as the front end of machining, and be exact about machines.
- **Audience:** engineer; maintenance (fit-check a replacement before machining it).
- **Search intent:** low priority. "3D printing Lake County IL," "prototype then machine."
- **H1:** P1 (keep).
- **Section order:** hero (keep the lede; it is good); machines by model and build volume `[CONFIRM: A54, A55]`; what runs well; **When not to print** (keep; this section is the voice at its best); materials limited to what the listed machines run.
- **Must not:** SLS materials, dental or biocompatible resin, vapor smoothing or dyeing unless confirmed in-house; "four FDM machines" unless counted.

### Materials `/materials`

- **Purpose:** help someone pick, and rank for material terms.
- **Audience:** engineer; buyer checking a callout.
- **Search intent:** "delrin vs UHMW," "acetal vs nylon," "food grade UHMW," material + "machining."
- **H1:** keep "Pick the plastic by the job, not the catalog."
- **Changes:** add a tolerance column from the same owner-confirmed table; apply rewrites 7 and 8; replace "FDA grades available" wording per rule 15; change the closing card to "Ask. If we haven't cut it before, we'll say so."; add "13 plastics priced online" here as a subhead fact; link each of acetal, UHMW and HDPE to its own page when those exist.
- **Must not:** "FDA-compliant" as a blanket property; "USDA grades."

### Quality `/quality`

- **Purpose:** answer the buyer's question, "what happens when it's wrong," and let them disqualify the shop fast if they need a certificate.
- **Audience:** buyer.
- **Search intent:** none to speak of. This page is reached from the site and from supplier-approval checklists.
- **H1:** keep "What's in the box besides the parts."
- **Section order:** lede (keep); **ISO status first**, using rewrite 9; with every production order (define "production" `[CONFIRM]`); how plastic is different (keep, minus absolutes); when something is wrong (first person; warranty in the owner's words `[CONFIRM]`); **the one-person question** (new; the short-form objection answer); inspection equipment (only what is in the shop `[CONFIRM: A80]`); supplier paperwork with a download link for the packet.
- **Must not:** "working toward" without a date; "records you can audit" unless they exist; "68 °F" unless controlled.

### About `/about`

- **Purpose:** put a person behind the name. Explain the name once.
- **Audience:** buyer vetting; anyone deciding whether to call.
- **H1:** keep "A machine shop that deals square."
- **Changes:** first person throughout; owner's name and a photo at a machine `[CONFIRM: willing]`; rewrite 10; shorten the logo explanation to one sentence (it is for designers, not buyers); change "Who we work with" to "Who this shop is set up for" and describe needs, not client categories (audit A89); "Under one roof" lists only confirmed equipment and links to the parent for metal; paperwork list with confirmed items only; add address, hours, pickup.
- **Must not:** imply a client list; "since 2017" for machining unless true; "engineering" as a service unless licensed.

### Firm quote `/rfq`

- **Purpose:** make a drawing-and-quantity buyer and a no-CAD maintenance buyer both feel the form was built for them.
- **H1:** keep "Tell us what matters. We'll price the rest." It answers the engineer's fear directly (R2.2).
- **Changes:** turnaround stated once, in whatever form the owner confirms; a visible second path at the top: "No drawing? Attach a photo with a tape measure in it and say what the part does."; allow more than one attachment; add a "where the part lives" prompt (temperature, washdown, food contact) because it changes the material and the tolerance; keep the notes placeholder ("what went wrong with the last supplier") — it is exactly the buyer's language.
- **Must not:** the word "RFQ" in visible copy (existing rule 4).

### New pages

Build in this order. Each exists because a specific buyer types a specific thing (R5).

| Page | Search intent it serves | Audience | H1 | Must contain | Blocked until |
|---|---|---|---|---|---|
| **Replacement parts** `/replacement-parts` | "replacement plastic parts packaging machine," "obsolete machine part," "plastic part no drawing," "wear strip replacement," "machine shop near me" | Maintenance | **Worn plastic part, no drawing? Bring it in.** | Three steps: send a photo or bring the part; I measure and draw it; you approve a print or a printed fit-check, then I machine it. Part types in their words: wear strips, guides, lane dividers, bushings, rollers, guards. Phone number as the primary action. Drive times. That the drawing is theirs afterward. | Owner's no-CAD policy, drawing charge, walk-in hours (audit C22, C3). |
| **Food-contact materials** `/food-contact` | "FDA compliant plastic machining," "food grade UHMW parts," "food grade acetal," "21 CFR 177 UHMW" | Engineer and buyer at food-equipment builders and plants | **Food-contact plastics: what a machine shop can and cannot certify.** | Plain explainer: FDA compliance is a property of a specific grade under 21 CFR 177 and comes as a statement from the maker; NSF and 3-A apply to materials-by-supplier and to finished equipment, not to a machine shop. What comes with the job: maker's compliance statement, lot cert, CoC. Which grades: natural acetal, UHMW, HDPE, nylon, PP, PTFE. How metal work is kept away from these jobs. What Straightedge does not claim. | Distributor documents confirmed obtainable; clean-down routine (audit C23, C24). **Do not publish before both.** |
| **Packaging machinery parts** `/packaging-machinery` | "packaging machine change parts plastic," "UHMW guide rails custom," "conveyor wear strips custom" | OEM buyer, OEM engineer, plant maintenance | **Plastic wear parts and guides for packaging machinery.** | Part types the shop has made, by material. Why UHMW for guides and acetal for anything with a bore. Blanket orders and releases. The replacement-parts door. No customer names or categories. | List of part types actually made (audit C26). |
| **Shop and equipment** `/shop` | "[machine model] job shop," supplier-vetting visits | Buyer and engineer vetting | **The machines, their limits, and where to find us.** | Every machine by make, model and travel, from the nameplates. Inspection tools on hand. Address, hours, map, drive times, pickup. Photos of the actual machines. | Nameplate audit (audit C5–C9, C12). |
| **Delrin / acetal**, **UHMW**, **HDPE** `/materials/delrin` etc. | "delrin machining," "UHMW machining," "HDPE CNC routing" — the highest-confidence material terms (R5.1 A) | Engineer | "Delrin (acetal) machining: what it holds and what it costs." and parallels | What it is for; what it will hold here; what moves it; grades stocked or ordered; a worked price example; a real photo. | Tolerance table; price examples. |
| **Plastic machining near Chicago and Milwaukee** `/chicago-milwaukee` | "plastic machining Chicago," "plastic machining Milwaukee," "plastic machine shop Wisconsin" | Buyer | **Plastic machining an hour from Chicago and an hour from Milwaukee.** `[CONFIRM: times]` | One honest location page, not a page per suburb. Where the shop is, how long the drive is from named places, pickup, next-day ground zones. Competitors rank for "Chicago" without being there (R3.1, Interstate ships from Des Moines); Straightedge is actually within driving distance and can say so with real numbers. | Drive times and carrier zones checked. |

Do not build: competitor-comparison pages, city-by-city doorway pages, an "industries" page that lists sectors as if they were clients, or a blog. A one-person shop will not keep a blog alive; the material pages do that job and do not go stale.

---

## 8. Checklist for the copywriter

1. No line with `[CONFIRM]` ships until the owner answers the matching question in `claims-audit.md` section C.
2. Search the build for: partner, solutions, team, precision, tight, fast, cheapest, best, FDA-approved, food safe, Xometry, and any company name other than Straightedge and its parent. Each should return zero in customer-facing copy.
3. Every photo caption: material, thickness or size, process, quantity. No customer, no industry.
4. Every tolerance has a material next to it.
5. Every lead time is in business days and matches what the quote tool shows at checkout.
6. The phone number appears in the header, the hero of every service page, and the footer.
7. The home page has a door for someone with no CAD.
8. "I" on About, Quality promises and all launch posts; "we" elsewhere; never "our team."
