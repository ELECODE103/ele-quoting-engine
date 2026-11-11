# Straightedge site: copy and UI review

Reviewed 2026-10-28 against the `straightedge-retool` branch. Every public route was built, served in production mode, and screenshotted at 1360 px and 390 px with Playwright, then exercised: upload of a 300 × 200 × 12.7 mm STL, process switch (CNC → routing → printing → CNC), the DFM tab, quantity 150 (RFQ gate), the RFQ form (empty submit, then a real submit).

The existing copy is in voice and mostly right. The work here is tightening, fixing inconsistencies, fixing what broke on a phone, and making the quote flow read as one product instead of a marketing site bolted to an app. Final screenshots are in `docs/screenshots/` (home and quote, 1360 and 390).

Severity: **S1** broken or embarrassing, **S2** confusing or inconsistent, **S3** polish.

---

## S1: broken or ugly UI

### 1. The quote builder had a different header from the rest of the site (and it broke on phones)
**Where:** `components/Header.jsx` (used by `/quote`, `/checkout`, `/dashboard`, `/orders`, `/admin`).
**Wrong:** A separate header with three Title Case links ("Materials", "Instant Quote", "Sign In"), no way back to Machining/Routing/Quality/About, no mobile menu. At 390 px the nav stacked vertically beside the wordmark and pushed the page down. A buyer clicking "Get an instant quote" landed in what looked like a different app.
**Fix:** One `SiteHeader` component used by `PublicLayout` and by `Header`. Same links, same mobile menu, same CTA. On `/quote` the CTA becomes an active "Instant quote" link instead of a button that goes nowhere. Signed-in users get "My orders" / "Admin" and "Sign out".
Before: `Materials · Instant Quote · Sign In` → After: `Machining · Routing · 3D Printing · Materials · Quality · About · Sign in · Get an instant quote`.

### 2. Mobile menu: misaligned CTA, no close state
**Where:** `PublicLayout.jsx`, `global.css`.
**Wrong:** The "Get an instant quote" button inside the open menu kept its desktop `margin-left: 8px`, so it sat indented and narrower than the links above it. The toggle showed ☰ whether open or closed, with `aria-label="Menu"`.
**Fix:** Button fills the menu width; toggle shows ✕ when open; `aria-label` reads "Open menu" / "Close menu"; `aria-controls` points at the link list. The hamburger now kicks in at 1024 px (was 720 px) because seven links plus two actions don't fit a tablet.

### 3. Quote builder on a phone: process switcher clipped, price cut off, viewer caption wrapped into a pile
**Where:** `QuoteBuilder.jsx`, `ProcessPicker.jsx`, `global.css`.
**Wrong:** The compact process switcher was `inline-flex` with no wrap, so "3D Printing" ran off the right edge. The price badge was `margin-left: auto` in a non-wrapping row, so "$195.92" was clipped. The 3D viewer footer had four spans in a non-wrapping flex row that wrapped mid-phrase ("11.811" × / 7.874"").
**Fix:** `.proc-seg` wraps; the toolbar wraps and the price drops to its own line under 480 px; the viewer footer wraps, drops the triangle count (nobody buying a part needs it), and hides "Drag to orbit" on phones.

### 4. Materials table on a phone showed two of six columns with no hint that it scrolled
**Where:** `MaterialsPage.jsx`, `global.css`.
**Wrong:** A six-column table inside `overflow-x: auto`. On 390 px you saw "Material" and half of "Grades"; "Good for / Why it works / Watch out for" — the whole point of the page — was off-screen.
**Fix:** Under 720 px the table becomes one card per material with a small label above each cell (`data-label` + `::before`). Desktop is unchanged.

### 5. Mojibake in DFM text and the order drawer
**Where:** `server/processes/cnc/dfm.js`, `3d-printing/dfm.js`, `sheetmetal/dfm.js`, `client/src/components/OrderDetailDrawer.jsx`.
**Wrong:** Double-encoded UTF-8: "Ã±0.05mm", "mmÂ²", "Â·". Visible on the DFM tab for every CNC part.
**Fix:** Replaced with ±, ², ·. Text only; no pricing or gate logic touched. While there, the CNC tolerance note now matches what the site promises:
Before: `Standard CNC tolerance: Ã±0.05mm. Precision work available: Ã±0.025mm (higher cost)`
After: `Standard ±0.005" (±0.13 mm) on plastics, ±0.002" on metals. Call out the features that need tighter and we hold those`

### 6. Big numbers had no thousands separator
**Where:** `utils/format.js`.
**Wrong:** "$14262.26" on the RFQ-gated quote. Reads like a typo at a glance.
**Fix:** `formatCurrency` uses `toLocaleString`: "$14,262.26". Negative values render "-$25.88" (was "$-25.88" on the discount row).

### 7. Button-styled links were underlined
**Where:** `global.css`.
**Wrong:** Every `<Link className="btn …">` and `<a className="btn …">` (service page "Flat part? See CNC routing →", RFQ-sent "Quote another part", "See what we run") drew the browser's underline through the button label.
**Fix:** `a.btn { text-decoration: none }`. Removed the inline `textDecoration: 'none'` workarounds.

### 8. Hero headline forced an orphan on phones
**Where:** `LandingPage.jsx`.
**Wrong:** `<br />` between the two sentences produced "Machined plastic / parts. / One to a few / thousand." at 390 px.
**Fix:** The break is `className="br-wide"`, hidden under 720 px.

### 9. Facts row wrapped 2-1-1-1 on phones; "How it works" squeezed into two 150 px columns
**Where:** `LandingPage.jsx`, `global.css`.
**Fix:** `.stat-row` is a grid: 5 / 3 / 2 columns by breakpoint, and an odd last stat spans the row. `.grid-4` goes to one column under 480 px so "manufacturability" stops breaking mid-word.

### 10. Process picker cards had misaligned titles
**Where:** `global.css` `.process-option`.
**Wrong:** Buttons vertically centre their content, so the selected card (three-line blurb) had its title 8 px lower than the other two.
**Fix:** `display: flex; flex-direction: column; justify-content: flex-start`.

---

## S2: confusing flow and inconsistent terms

### 11. "Instant Quote" / "Get an instant quote" / "Upload a part" / "Order or RFQ" all meant the same thing
**Fix: one term per concept, used everywhere.**
- The thing: **instant quote** (nav/footer link "Instant quote"; every CTA button "Get an instant quote").
- The other path: **firm quote** ("Request a firm quote" button, "Or request a firm quote" secondary, footer link "Request a firm quote").
- Checkout: **Check out**.
Changes: Landing hero `Upload a part` → `Get an instant quote`. Materials page `Upload a part` → `Get an instant quote`. Landing step 03 and builder step 3 `Order or RFQ` → `Check out, or get a firm quote`. Landing `Price & DFM` → `Price and DFM` (the builder already said "and"). Order rail `Proceed to Checkout →` → `Check out →`. Rail secondary `Prefer a firm quote from a person?` → `Or request a firm quote`. Footer gains `Request a firm quote`.

### 12. The RFQ gate was only explained at the bottom of the right rail
**Where:** `QuoteBuilder.jsx`.
**Wrong:** At qty 150 the centre column just switched its label to "BUDGETARY" with no explanation. On a phone the rail (with the reason and the button) was two screens down.
**Fix:** A gate notice at the top of the centre column with the first reason and a "Request a firm quote →" button:
`**This one needs a person before you can buy.** The number below is budgetary. 150 pieces is over our 100-piece instant-order limit — production runs are quoted by a person within 24 hours.`
Rail gate heading: `This one gets a person before it gets a price you can buy at:` → `Why this one needs a person:` (now matches the RFQ page, which already said that).

### 13. Order rail showed material slugs and a process code
**Where:** `OrderSummary.jsx`, `RfqPage.jsx`.
Before: `×1 · CNC · cnc-delrin`, `×1 · RTR · rt-hdpe`; RFQ page `CNC Machining · cnc-delrin × 150`.
After: `1 × Delrin / Acetal (POM) · CNC`, `1 × HDPE Sheet · Routing`; RFQ page `150 × Delrin / Acetal (POM) · CNC Machining`. The rail gets the material list from the builder; the RFQ page fetches names for the processes on the quote.

### 14. Lead-time options nested parentheses and weren't real radios
Before: `Same Day (Ships today (order by 10am))`, clickable `<label>`s with a painted dot, no input, no keyboard.
After: `Same Day · Ships today (order by 10am)`, a `<fieldset>` with visually hidden `<input type="radio">`s; arrow keys work; focus ring shows.

### 15. Units jumped between systems inside one card
Before: viewer `11.811" × 7.874"`, configurator `Bounding: 300.0 × 200.0 × 12.7mm · Volume: 762.0 cm³ · Area: 1327.0 cm² · Triangles: 12`.
After: viewer `11.81" × 7.87" · 93.0 in² footprint`; configurator `Size: 11.81 × 7.87 × 0.50 in (300 × 200 × 12.7 mm) · Volume: 46.50 in³ (762.0 cm³)`. Inches first (the shop's language), mm in parentheses (the CAD's), triangles gone.

### 16. Material price tier badge said "$$$" for almost everything
**Where:** `PartConfigurator.jsx` `priceTier`.
**Wrong:** Machined stock was scored as `pricePerKg / 50` against cut-offs meant for per-cm³ print material, so Delrin, UHMW, nylon and PEEK all read "$$$". A badge that's always the same says nothing.
**Fix:** Separate cut-offs for per-kg stock ($ < 10, $$ < 25, $$$ above) and per-cm³ print material. Now UHMW/HDPE/PVC/PP/acrylic/6061 are $, Delrin/nylon/PC/G-10/phenolic/brass are $$, PEEK/Ultem/PTFE are $$$. Tooltip and `aria-label` spell it out ("Mid-cost stock").

### 17. Empty-state copy on the builder
Before: `Upload Your Parts` / `Drag in STEP, STL or IGES files for a price right now.` (chips listed 3MF; the sentence didn't; nothing said you could click).
After: `Upload a part` / `Drop a STEP, STL, IGES or 3MF file here, or click to choose one. The price shows in a few seconds.` The dropzone is now keyboard-reachable (`role="button"`, `tabIndex`, Enter/Space).
Loading: `Analyzing your part…` / `This will only take a moment` → `Reading the geometry…` / `A few seconds for most files. Large STEP assemblies take longer.`
Add-more: `Drop more files here or click to add parts` → `Drop another file here, or click to add a part.`

### 18. Login and Register pages described the wrong product
Before: Register subhead `Join to start getting instant quotes` (false: no account is needed to quote). Login subhead `Access your quotes and orders`. No wordmark, no way back, `John Doe` / `Your Company Inc.` placeholders, labels not tied to inputs.
After: Register `Needed to check out and track orders. Pricing a part doesn't need one.`; Login `For your orders and saved quotes. You don't need an account to get a price.`, or, when sent there from checkout, `Sign in to finish checkout. Your quote is saved and will be waiting.` Wordmark links home; "Back to the quote" link; `htmlFor`/`id` on every label; `autocomplete` set; password hint `At least 8 characters.` (matches the server rule); the checkout return path survives Login → Create one → back.
Button/heading case: `Sign In` → `Sign in`, `Create Account` → `Create an account`, `Full Name` → `Name`, `Company (Optional)` → `Company (optional)`, `Register` → `Create one`.

### 19. Two different promises for paperwork turnaround
About said `W-9, certificate of insurance and NDA on request, same day`; Quality said `returned within a business day`. About now says `within a business day`.

### 20. Builder section headings in Title Case while the rest of the site is sentence case
`Part Configuration` → `Part setup`; `Price Breakdown (per unit)` → `Price per piece`; `Unit price` → `Per piece`; `Volume Pricing` → `Quantity breaks`; `Order Summary` → `Order summary`; `Budgetary Summary` → `Budgetary summary`; `Lead Time` → `Lead time`; `Line Items` → `Parts`; `Remove Part` → `Remove part`; `3D Preview` → `3D preview`; `DFM Analysis` → `DFM check`; `Design for Manufacturability` → `Manufacturability check`; `Layer Height` → `Layer height`; `+ Add` → `+ Add part`; `PARTS (1)` is now styled uppercase via CSS rather than typed.

### 21. "/ea" and "per unit" vs "each" and "piece"
The site says "pieces" and "pcs" everywhere; the builder said "units", "/ea", "/part".
`($95.08/ea)` → `$95.08 each`; quantity-break rows `$137.26/ea` → `$137.26 each`; finish option `(+$2.00/part)` → `(+$2.00 each)`; `1 part · 150 total units` → `1 part · 150 pieces`; RFQ page `$95.08/ea` → `$95.08 each`; `Weight: 1.66 kg` → `Ship weight 1.66 kg`.

### 22. Quantity-break subtext explained the obvious and not the useful
Before: `Order more, save per unit — click a quantity to apply it.`
After: `Setup is spread across the run, so the per-piece price drops. Click a quantity to use it.`

### 23. "Score: 100%" read as a pass rate
Warnings count half, so it isn't a percentage of checks. `Score: 100%` → `Score 100/100`.

### 24. Facts row: label after the number
`2017` / `machining in Lake County since` → `Since 2017` / `machining in Lake County`. Also `price & checkout to 100 pcs` → `price and checkout to 100 pcs`, `firm quotes over 100 pcs` → `firm quote over 100 pcs`, `engineering plastics quoted online` → `engineering plastics priced online` (quoted was doing two jobs).

---

## S3: copy that drifted from the voice rules

### 25. Material guidance in the configurator (printing and metals)
These were written before the voice rules and leaned on "great", "excellent", "ideal", "highest".
- PLA: `Stiff and easy to print — great for prototypes, fixtures, and display models. Not for high heat or outdoor use.` → `Stiff and easy to print. Prototypes, fixtures, display models. Softens around 140 °F, so not for hot or outdoor duty.`
- PETG: `Tougher than PLA with better heat and chemical resistance — good for functional parts and enclosures.` → `Tougher than PLA, takes more heat and most chemicals. Working prototypes and enclosures.`
- ABS: `Impact-resistant and heat-tolerant — good for enclosures and automotive-style parts. Best with smoothing/finishing.` → `Takes impact and heat. Enclosures and housings. Smooths well if you want a finished look.`
- TPU: `Rubber-like and flexible — for gaskets, grips, and bumpers. Prints slower.` → `Rubber-like. Gaskets, grips, bumpers. Prints slowly, so it prices higher.`
- PA12: `Strong, durable, and slightly flexible — excellent for living hinges, clips, and end-use functional parts.` → `Strong, tough, a little flexible. Living hinges, clips, end-use parts.`
- Resin: `Highest detail and smoothest surface — ideal for miniatures, dental/jewelry patterns, and fine features. More brittle.` → `Finest detail and smoothest surface. Small housings, snap fits, cosmetic models. More brittle than FDM.`
- Tough resin: `Engineering resin balancing detail with impact resistance — for functional prototypes.` → `Resin with some give. Working prototypes that need detail and a little impact resistance.`
- Aluminum: `Lightweight, corrosion-resistant, easy to machine — for parts that mate with metal.` → `Light, stiff, machines fast. Brackets, plates and fixtures that mate with metal.`
- Stainless: `Strong and corrosion-resistant — for food, marine, and medical-adjacent parts. Harder to machine (higher cost).` → `Strong and corrosion-resistant. Food, marine and medical-adjacent parts. Slow to machine, so it prices higher.`
- Steel: `Strong and economical — for brackets and structural parts. Will rust without a finish.` → `Strong and cheap. Brackets and structural parts. Rusts without a finish.`
- Copper: `Excellent electrical and thermal conductivity — for bus bars and heat sinks.` → `Conducts heat and electricity. Bus bars and heat sinks.`
- Brass: `Easy to machine with a gold finish — for fittings, decorative, and electrical parts.` → `Free-machining, corrosion-resistant, conductive. Fittings, bushings, contacts.`

### 26. Layer-height options
`0.1mm — fine`, `0.2mm`, `0.3mm — fast/draft` → `0.1 mm — fine detail, slower`, `0.2 mm — standard`, `0.3 mm — draft, fastest`.

### 27. Routing card on the landing page
`Where production plastic parts are cheapest to make.` (a fragment) → `The cheapest way to make a flat plastic part in quantity.` (the routing page's own line). The card text no longer goes through `dangerouslySetInnerHTML` for a couple of `&quot;` entities.

### 28. Rail footnote
`Instant price. Final shipping confirmed at checkout.` → `Instant price. Shipping is confirmed at checkout.`

### 29. RFQ form messages
- Validation: `Your name, please.` → `Add your name so we know who to send it to.`; `A working email so the quote has somewhere to go.` → `Add a working email so the quote has somewhere to go.`
- Send failure: `Could not send. Call the shop and we will take it by phone.` → `It didn't send. Call 224-213-6727 and we'll take it by phone.`
- Missing quote: `We couldn't find that online quote, but the form works on its own — describe the part or attach the drawing.` → `We couldn't find that online quote. The form works on its own: describe the part or attach the drawing.`
- New helper line above the fields: `Name and email are required. Everything else helps the number.`

### 30. Builder error messages
- Quote: `We couldn't calculate a price for this configuration. Please adjust and try again.` → `We couldn't price this setup. Change the material or quantity and try again, or call 224-213-6727.`
- Upload fallback: (raw error) → `The file didn't make it to our server. Try again, or email it to quotes@straightedgemfg.com.`
- Login fallback: `Login failed` → `That email and password didn't match. Try again, or call 224-213-6727.`
- Register fallback: `Registration failed` → `We couldn't create the account. Try again, or call 224-213-6727.`
- Materials page: `Loading…` → `Loading the material list…`, plus a real error state: `The material list didn't load. Reload the page, or call 224-213-6727.` (was silent forever).

---

## Missing states (added)

- **Order rail before the first price:** was the static line "Configure parts to see pricing" (nothing to configure yet). Now a spinner with `Pricing your part…`, a spinner next to the heading while re-pricing, and on failure the error plus a `Request a firm quote instead` button so the buyer has a way forward.
- **Materials page load failure:** see 30.
- **Login reached from checkout:** explains that the quote is saved.
- **Upload errors** now look like errors (red border and background, `role="alert"`), not a plain card.

## Accessibility basics (fixed)

- Visible focus ring on buttons, links, process options and dropzones (`:focus-visible`).
- Disabled buttons look disabled.
- Dropzones are reachable and operable by keyboard.
- Part list rows are `<button>`s with `aria-pressed`; quantity-break rows carry `aria-pressed`.
- Compact process switcher and the big picker are `radiogroup`/`radio`; view toggle is a `tablist`; DFM process tabs are a `tablist`.
- Lead time is a `fieldset` with real radios.
- Login/Register labels bound with `htmlFor`; `autocomplete` on every field; error boxes are `role="alert"`; price badge is `aria-live="polite"`.
- Decorative SVGs, swatches and step numbers are `aria-hidden`.
- Mobile menu button: `aria-expanded`, `aria-controls`, state-aware label.
- Builder body text moved from `--text-dim` (#94A3B8, 2.9:1 on white) to `--text-muted` (#64748B, 4.8:1) where it carries meaning.

---

## Left alone, on purpose

- **Lead-time options still show during the RFQ state**, including "Same Day · Ships today (order by 10am) +150%" on a 150-piece production run. That is seeded server config (`server/config`), and the subtotal depends on it. Worth a product decision: hide rush tiers when `gate.requiresRfq`, or drop "Same Day" for a one-person shop.
- **3D-printing material list includes SLS grades (PA12, PA11, glass-filled nylon, SLS TPU) and a dental resin**, but the 3D printing page lists only FDM and SLA machines. Either the shop outsources SLS (say so) or those materials should be deactivated. Server seed; not a client change.
- **CNC DFM check wording** is generic and Title Case ("Undercut Detection", "Material Removal Efficiency", "Geometry appears to have low undercut risk"), and its corner-radius note says ≥ 1 mm while the machining page says 1/16" minimum. The routing DFM is already in voice; the CNC one wants the same pass. It lives in `server/processes/cnc/dfm.js`, next to the logic, so it was out of bounds here beyond the encoding fix.
- **Gate reason sentences** come from `server/services/quoteGate.js`, which was off limits.
- **Checkout, dashboard, order tracking, traveler and admin pages** were outside the route list. They still use Title Case ("Order Summary", "Lead Time") and "/ea".
- **Wordmark** untouched; another agent owns it.
- **"Four FDM machines"** on the landing card vs the printing page (Raise3D + three Creality + "large-format FDM for oversize") may be four or five; could not verify.
- **Gallery captions** reuse photos across pages with different captions (the acetal clamps are "Black acetal clamp blocks" on one page and "The machined version of a printed prototype" on another). Plausible, not verifiable from here.
- The 60-day claim in "Parts off the machines in the last 60 days" will go stale; consider "recent".

---

## Style sheet for future copy

Ten rules, each with one line that is already on the site.

1. **Say the number.** `Firm quotes come back within 24 hours and hold for 30 days.` Not "fast turnaround".
2. **Name the machine, the material and the size.** `Techno HD-II: 59" × 96" bed, 12" under the gantry, 12-position tool changer, 5 hp spindle.`
3. **Inches first, millimetres in parentheses.** `Standard tolerance ±0.005" (±0.13 mm) on plastics.`
4. **One name per thing.** Instant quote (the number on the site), firm quote (the number from a person), check out (buying). Never "RFQ" in buyer-facing copy; it is fine in code and admin screens.
5. **Pieces, not units.** `Up to 100 pieces: check out with a card.` Tables may use "pcs"; prices say "each".
6. **Tell them the catch, then the fix.** `Parts under 1.5" need tabs or an onion skin — expect a small witness mark on one edge. Say which face matters.`
7. **The person is the promise.** `Either way you're talking to the person who runs the machine.` Say "we" and "the person who will run the job"; never "our team".
8. **Claim only what is true today.** `Working toward ISO 9001 registration: documented inspection, traceability and corrective-action procedures now, the audit next.` No certifications the shop doesn't hold; no customer names.
9. **Sentence case everywhere, including buttons and headings.** `Request a firm quote →`, `Part setup`, `Price per piece`. Proper nouns and process names keep their caps (CNC Routing, 3D Printing, Delrin).
10. **Errors say what happened and what to do, with the phone number.** `It didn't send. Call 224-213-6727 and we'll take it by phone.` No exclamation marks, no "Oops".

Banned words, for the record: cutting-edge, seamless, solutions, leverage, elevate, unlock, state-of-the-art, world-class, great, excellent, ideal, premium (as praise), and any closing tagline.
