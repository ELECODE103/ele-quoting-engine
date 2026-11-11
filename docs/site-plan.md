# Straightedge Manufacturing — Site Plan

Scope: instant-quote site for machined plastics (CNC mill/turn, CNC routing of sheet/plate plastics, FDM/SLA). Sheet metal is off. Instant price + Stripe to 100 pcs; RFQ above 100 pcs, on DFM fail, oversize, or any line over $5,000.

Basis: branch `straightedge-retool` at `85856ad` (`shared/brand.json`, `ProcessPicker`, routing process, `quoteGate`, `rfq` routes/page/admin queue, Resend mailer, Straightedge public pages), plus competitor flows checked 2026-10-28. Two competitor pages were blocked by the fetch proxy and are not cited: `sendcutsend.com/how-it-works/` and `xometry.com/capabilities/cnc-machining-service/plastic-machining/`.

---

## 1. Competitor teardown

| | SendCutSend | OSH Cut | Xometry | Protolabs | Fictiv |
|---|---|---|---|---|---|
| **Quote start** | "Get Started" → upload page; drag/drop .dxf/.dwg/.eps/.ai/.step/.stp, 1:1 scale, one part per file. Alternative: Parts Builder (60+ templates) or Design Partner directory. | "Instant Pricing" → app.oshcut.com; 17 formats incl. STEP, SLDPRT, IPT, x_t. Bulk upload auto-counts parts. | Dashboard upload; engine "suggests a starting process and material". | Upload, group by project/revision, attach supporting docs; STEP/SLDPRT/CATPART/ZIP. | Upload 3D model; Materials.AI recommends a material; 2D Drawing Generator makes a drawing if you have none. |
| **Account timing** | Not until "Add to Cart" — then log in or create a free account. | Not stated; "Sign In" in header; cart + company accounts with net terms. | Before upload (signup page; dashboard). | Before upload. | Before upload (CTA links to signup). |
| **DFM presentation** | Preflight checklist on the page (holes ≥50% thickness laser, ≥.125" routed, no open contours). In-app presentation not documented. | "Instant manufacturability feedback, including bending and nesting simulations"; auto-resizes tapped holes, detects countersinks, adjusts bend deductions. | "Analyze" tab beside a 3D viewer flags areas to fix. | Part status colors: White (configure), Grey (analyzing), Yellow (review/approve), Red (revise / can't make), Green (ready), Black (expired). | Design tips on upload; engineer DFM review for complex parts; drawing annotation tool for critical callouts. |
| **Material pages** | Per-material page: hero with thicknesses + "2-4 day production time" + "Get instant pricing"; cut-size limits; tolerances (±.005" laser, ±.009" routed); properties badges; use cases; refund-or-remake guarantee; FAQs. Plastics are CNC routed, .118"–.500", 32 materials; routed parts have "small tabs that sand off". | Materials catalog; 278 sheet / 287 tube variations; no plastics. | Hub page lists 12 plastics (HDPE, Acetal/Delrin, PP, UHMW, Nylon 6/6, Acrylic, ABS, PC, PEEK, PTFE, G-10, PVC) with per-material pages; cert badges. | "30+ engineering-grade plastics and metals"; ABS, PC, nylon, PEEK named. | Materials library + AI recommendation. |
| **Pricing transparency** | Unit price updates live with quantity; "bulk discounts up to 80%"; worked examples on service pages (ABS .125" routed 3.5×3.5": $7.42 @1, $2.99 @100). | "No minimum"; fully nested quotes; nesting discounts shown in checkout. | Price + lead time update on every config change. | Price changes with "receive by" calendar; shipment cost shown per part. | Compare up to 5 quantities in one quote; landed cost before commit; quote lock 30 days. |
| **Lead time selection** | Not selectable; "most parts ship within 2-4 business days", routing 1-3 days. | "Our site calculates the fastest options, and we meet whatever deadline you choose"; standard 2–3 days, same-day rush; "guaranteed lead-times". | Economy / Standard / Expedited. | Flexible 6–12 days (discounted) / Standard 3 days / Expedited 1 day. | Lead-time optimizer slider. |
| **Checkout** | Billing + shipping, card. Free US shipping over $39. | Cart; company accounts: net terms, shareable carts, centralized billing; will-call pickup. | "Forward to Purchaser" to hand the quote to buying; net terms/PO after credit form. | One-page checkout with 4 items; own reference number; forward quote to colleagues. | "Full package at checkout" (CAD + drawings + specs); PO/Net30 after vendor setup (Hubs). |
| **Tracking / post-order** | Not documented beyond support. | Part tracking; mill certs. | Order History by order number; repeat-order FAQ. | New IDs for part/quote/order/shipment; cert label on bag. | Virtual inspection photos before ship; inspection reports on the order; Parts Library for one-click reorder. |
| **RFQ / custom path** | "Custom Quote" in Parts tab; one file per request; support returns a cart link or revision advice; must be re-reviewed each reorder. | Phone/email. | Sales-assisted "Request a Quote"; bulk upload for production. | Add notes for feedback; CS questionnaire. | RFQ for complex parts "most returned within 2 business days"; contact form 1–3 days. |
| **Trust signals** | Refund-or-remake guarantee on every material page; US support team. | ISO 9001:2015; "only online fabricator that guarantees both its rapid lead times and the quality of its parts"; phone support. | ISO 9001, 13485, AS9100D, IATF, ITAR, CMMC badges; phone + email. | Certified material labelled on bag. | One accountable partner per order; in-process QC. |

Sources: [SendCutSend ordering](https://sendcutsend.com/blog/how-to-order-parts-from-sendcutsend), [SendCutSend custom quote FAQ](https://sendcutsend.com/faq/how-to-get-a-custom-quote/), [SendCutSend Delrin page](https://sendcutsend.com/materials/delrin/), [SendCutSend CNC routing](https://sendcutsend.com/services/cnc-routing/), [OSH Cut home](https://www.oshcut.com), [OSH Cut comparison](https://www.oshcut.com/comparison), [OSH Cut DFM ordering](https://oshcut.com/services/online-dfm-ordering), [OSH Cut getting started](https://www.oshcut.com/learn/getting-started/learn-more/), [Xometry how it works](https://www.xometry.com/how-xometry-works/), [Xometry plastics](https://www.xometry.com/materials/material-cnc-machining-plastic/), [Protolabs CNC platform](https://www.protolabs.com/en-gb/resources/blog/protolabs-new-quoting-platform-by-service-line-cnc-machining/), [Protolabs lead times](https://www.protolabs.com/en-gb/resources/blog/cnc-flexible-lead-time-option-save-costs-with-longer-lead-times/), [Protolabs Network ordering](https://www.hubs.com/how-ordering-works/), [Fictiv how it works](https://www.fictiv.com/why-choose-fictiv/how-it-works/).

**What to copy.** SendCutSend: price before account, material pages that are the SEO landing pages, a stated guarantee, worked price examples. OSH Cut: deadline-driven lead time with a guarantee, will-call. Protolabs: a part status that tells the buyer exactly what is blocking. Fictiv: a quoted RFQ the customer can accept and pay from, reorder from a saved configuration, a stated RFQ turnaround. Xometry: "forward to purchaser".

**What not to copy.** Account before upload (Xometry/Protolabs/Fictiv). A one-person shop wins by being the easiest place to get a number. The current build already gets this right: `/api/upload` and `/api/quote` are public, and `OrderSummary.handleCheckout` is the first place a login is asked for.

---

## 2. Customer journeys

### Persona A — engineer, STEP file, 5 prototypes

1. **Entry.** Google "delrin cnc machining quote" or "cnc plastic parts Chicago"; or a LinkedIn post with a shop photo. Lands on `/machining` or `/`. The hero already says "Upload a part" and names the materials; the stat row says "Instant price & checkout to 100 pcs". Good. What is still missing is a price example ("a 3×2×1 Delrin block, qty 5, is about $X") so they know it is a shop and not a lead form.
2. **`/quote`.** Picks CNC (default), drops the STEP. Viewer, bounding box, and price appear. `ProcessPicker` lets them flip to routing or printing and the price re-runs. Keep them with the price breakdown (already there: material / setup / machine time) and the quantity-break table.
3. **Configure.** Material, grade/color, milling vs turning, qty 5, finish. Drop-off risk: no place to say "the Ø.500 bore is the one that matters" and no drawing upload on the instant path — `PartConfigurator` has no tolerance, drawing, or notes field. They either guess or bail to `/rfq`, which is slower.
4. **DFM.** `DFMPanel` lists PASS/WARN/FAIL with the Tormach envelope and plastics wall rules. A hard fail flips the rail to "Request a firm quote →" with the reasons listed. Good.
5. **Lead time.** Standard / Expedited / Rush / Same Day with "+35%" style surcharges. They want a date, not a percentage.
6. **Checkout.** "Proceed to Checkout →" → `/login` with `state.from`. If they have no account, they click Register and land on `/` — the quote is still in the DB but they have lost the link to it. This is the single worst drop-off in the flow and is a one-line fix (Gap 1).
7. **Post-order.** Stripe redirects to `/orders/:id?paid=true`. The page ignores `paid`, shows "Lead Time: Standard" hard-coded, no line items, no tracking number. No email arrives except Stripe's receipt. Reorder means re-uploading.

### Persona B — OEM purchasing manager, 500/yr of a Delrin wear part, has a drawing

1. **Entry.** Referral from a plant engineer, or Google "delrin wear parts machining Illinois". Lands on `/machining`, reads tolerance (±0.005" standard, ±0.002" called out), envelope, "FAI with every production order", then `/quality` for certs, W-9, COI, NDA. This is the right content; it needs an "Approved supplier? Here is the packet" link that goes to a real form or PDF.
2. **`/quote`.** Uploads STEP, sets qty 500. The gate fires on `quantity` (threshold from `brand.rfqQuantityThreshold`); the rail becomes "Budgetary Summary" with the reason and the 24-hour promise. Good — they see a number and a next step.
3. **`/rfq/:quoteId`.** Parts and budgetary unit prices are pre-filled; the form takes quantities, critical tolerances, need-by date, finish/marking/packaging, drawing (PDF/DXF/DWG), notes. No account needed. Both emails fire (`rfq.js`). Good.
4. **The response.** This is where the branch stops. Admin opens `/admin` → RFQ queue → "Mark quoted" with a dollar figure. Nothing reaches the customer: no email, no quote PDF, no page to accept, no pay link, no PO path. The owner has to write the quote by hand in his own mail client. Fictiv and SendCutSend both close this loop with a link that drops the quoted parts into a cart.
5. **Post-order.** Same thin order page; no customer-visible RFQ history in `/dashboard`; reorder is "send another RFQ".

### Persona C — maintenance tech, broken part, no CAD

1. **Entry.** Google "machine shop near me plastic part" or "UHMW guide custom cut". Lands on `/`. Needs one line: "No CAD? Send photos and dimensions, or bring the part." The current landing does not say this; `/rfq` does accept PNG/JPG but nothing routes a no-CAD visitor there.
2. **`/rfq`** (no quoteId). The form works stand-alone, the drawing field takes a photo, phone number is shown. What is missing: a second photo, rough dimensions field, "what it does / what it mates to" prompt (the notes placeholder covers it), and a "bring it to Wauconda" option.
3. **Response.** Same gap as Persona B: the owner replies by hand; there is no pay link.
4. **Post-order.** The CAD the shop draws is not attached to anything the customer can reorder from.

### RFQ path (all personas)
`quoteGate.evaluate` runs on every `/api/quote` call; reasons: `quantity` (>100), `dfm-fail`, `envelope` (CNC travel or router bed), `complex-geometry` (volume ratio <12% on CNC), `big-ticket` (line >$5,000). The gate is stored on the quote and `POST /api/orders/checkout-session` returns 409 `rfq-required` if someone tries anyway. `/rfq/:quoteId` → `POST /api/rfq` (multipart) → admin + buyer emails → `/admin` queue (`RfqQueue.jsx`) → `PUT /api/rfq/admin/:id` status/quotedTotal. **Open end:** quoted → customer.

### Post-order path
`checkout.session.completed` → order `paid` (`stripeWebhook.js`) → **no email** → `/orders/:id` timeline → admin `PUT /orders/:id/status` with tracking number → **no email, tracking not rendered** → no reorder.

---

## 3. Gap analysis (ranked by conversion impact)

| # | Gap | Who does it well | Change in this codebase | Effort |
|---|---|---|---|---|
| 1 | **New customers lose their quote at checkout.** `OrderSummary.handleCheckout` sends guests to `/login` with `state.from`; `LoginPage` honors it, but `RegisterPage.jsx:27` does `navigate('/')` and the "Register" link in `LoginPage` does not pass `state`. First-time buyers — most of them — land on the marketing page with no way back to `/checkout/:quoteId`. | SendCutSend (account at Add to Cart, straight back to cart) | `RegisterPage`: `const returnTo = location.state?.from \|\| '/quote'; navigate(returnTo)`. `LoginPage`: `<Link to="/register" state={location.state}>`. Then show "Create account to pay — your quote is saved" on both pages. | S |
| 2 | **Quoted RFQs never reach the customer.** `PUT /api/rfq/admin/:id` with `status: 'quoted'` stores `quotedTotal` and `quotedAt`; no email, no PDF, no page, no pay link. Every production job (the whole Persona B segment) finishes off-platform, by hand. | Fictiv (RFQ returned as an orderable quote), SendCutSend (support sends a cart link) | `rfq.js`: on `quoted`, email the buyer a link to `/rfq/:id` (public, UUID) showing quoted total, line items, validity 30 days, and two buttons: "Pay by card" (create a quote row from the RFQ with `gate.requiresRfq=false` and `orderTotal=quotedTotal`, then the existing checkout) and "Send PO" (creates order `pending_po`, emails owner). `RfqQueue.jsx`: add per-line quoted prices and a notes-to-customer field. Reuse `pdfGenerator` for a quote PDF. | M |
| 3 | **No order emails.** `mailer.js` exists and works for RFQs, but `stripeWebhook.js` (paid) and `orders.js:350` (status change, still `TODO`) send nothing. Buyer gets only Stripe's receipt; shipping notice never goes out. | Fictiv, SendCutSend | Call `mailer.send` in the webhook (`paid`: order number, lines, lead time, link) and in `PUT /orders/:id/status` for `in_production`, `shipped` (carrier + tracking link), `delivered`. Also notify the owner on `paid`. | S |
| 4 | **Order page is thin.** `OrderTrackingPage` ignores `?paid=true`, shows "Lead Time: Standard" literally, renders no `order.items`, no `trackingNumber`/`carrier` (stored by admin but never shown), "Back to Orders" navigates to `/quote`, no reorder. `CustomerDashboard` lists orders only — no quotes, no RFQs. | Fictiv (Parts Library, inspection on the order) | Render items with `config`, lead time from the linked quote, a "Payment received" banner on `paid`, tracking link, fix back link to `/dashboard`. "Reorder": post the saved item configs to `/quote` state. Dashboard tabs: Orders / Saved quotes / RFQs (`GET /api/rfq` filtered by `userId` needs adding). | M |
| 5 | **Lead time is a multiplier, not a date.** `OrderSummary` shows "+35%" and "7-10 business days" (`DEFAULT_LEAD_TIMES`). Same-day at 2.5× is on the list; for a one-person shop it is a promise that will be broken. | Protolabs (receive-by date), OSH Cut (deadline, guaranteed) | Compute `shipBy` server-side from `days` + business-day calendar and return it in the quote; show "Ships by Tue Nov 11" in `OrderSummary`, `CheckoutPage`, and `/orders/:id`. Set `same-day.active=false` unless the owner wants it. | S |
| 6 | **Instant path has no drawing, tolerance, or notes.** `PartConfigurator` has material / grade / operation / thickness / qty / finish. The RFQ form has all three, so buyers with a print are pushed to the slow path. | Fictiv (drawing + annotation), Xometry (notes to engineers) | Add `tolerance` select (standard ±0.005" / tight — tight may add a gate reason), PDF drawing upload (`POST /api/parts/:id/drawing`, reuse the multer config from `rfq.js`), and `notes` textarea; persist on `partsDB`, carry into `orderItemsDB.config` and the job traveler PDF. | M |
| 7 | **Every price refresh creates a new quote row.** `POST /api/quote` inserts a draft on each 400 ms debounce; no stable ID, no "email me this quote", no PDF, no expiry. `quotesDB` fills with orphans; the admin "open quotes" stat is meaningless. | Fictiv (30-day lock), Protolabs (quote IDs) | Client generates a `quoteId` once per session; server upserts. Add `expiresAt` (30 days), `GET /api/quote/:id/pdf`, and an "Email me this quote" button in `OrderSummary` (uses `mailer`). | M |
| 8 | **Checkout is card-only, ship-only, tax-free.** `CheckoutPage` → Stripe; `shippingCost: 0`, `tax: 0`; no pickup option though the About page says "Come see the shop"; no PO reference field; no "send to purchasing". | OSH Cut (net terms, will-call), Xometry (forward to purchaser) | Add shipping method radio (Ship / Pick up in Wauconda = $0), PO/reference field stored on the order, Stripe Tax or an IL rate, and "Send this quote to purchasing" (emails the quote link). PO payment itself rides on Gap 2's `pending_po` path. | M |
| 9 | **No-CAD visitors have no door.** `/rfq` accepts photos, but nothing on `/` or the nav says so. | SendCutSend (Parts Builder, Design Partners) | One line + link in the landing hero and footer ("No CAD? Send photos or bring the part"); on `/rfq` without a quoteId, show a "No CAD yet" mode with two photo inputs and a dimensions field. | S |
| 10 | **No material detail pages.** `/materials` is one table built from `GET /api/materials`; no `/materials/:slug`, so the SEO landing page that SendCutSend wins with does not exist. | SendCutSend (per-material page) | `MaterialPage.jsx` at `/materials/:slug`: stocked forms/thicknesses from the material row, tolerance, use cases (reuse `PartConfigurator`'s `MATERIAL_GUIDANCE`), an engine-generated price example at qty 1/10/100, guarantee, "Quote in this material" → `/quote?process=&material=` (QuoteBuilder needs to read those params). | M |
| 11 | **Two headers.** Public pages use `PublicLayout`; `/quote`, `/checkout`, `/dashboard`, `/orders` use the older `Header.jsx` (Materials / Quote Builder / Sign In only). Different nav, no phone, no footer. | — | Wrap the protected routes in `PublicLayout` (or give `Header` the same links and footer). | S |
| 12 | **DFM checks say what, not what to do.** Severity + detail only; no per-check fix text; `DFMPanel` has no button to send a failing part to RFQ from the panel itself. | Protolabs (status colors), OSH Cut (auto-fix) | Add a `fix` string to each check in `cnc/dfm.js` and `routing/dfm.js`; render it in `DFMPanel`; add "Send this part for review" that calls `handleRfq`. | S |
| 13 | **No analytics.** Nothing fires anywhere. | — | See §5. | S |
| 14 | **Quantity input allows 100000.** `PartConfigurator` `max="100000"`; the gate handles it, but the UI should say "over 100 → firm quote" at the field. | — | Inline helper under the quantity field when `qty > brand.rfqQuantityThreshold`. | S |

Done on this branch and not gaps any more: process picker + routing process, plastics-first material list (13 plastics + 6061/brass; metals beyond that `active: false`), quote gate enforced at checkout (409), RFQ form + emails + admin queue, Straightedge brand everywhere including Stripe product name, real shop photos, public pages (`/machining`, `/routing`, `/3d-printing`, `/materials`, `/quality`, `/about`), phone/email in nav and footer, Tormach envelope and router bed in DFM.

---

## 4. Site map and page specs

Routes that exist are marked ✓; proposed changes are in the blocks.

| Route | Purpose | Key blocks | Primary CTA | Secondary CTA | API data |
|---|---|---|---|---|---|
| `/` ✓ | Convert search/referral to an upload | Hero (keep); stat row (keep); **add** a price example card and a "No CAD?" line; process cards; recent work gallery; how it works; quality teaser; dark CTA | Upload a part → `/quote` | Request a firm quote → `/rfq` | — |
| `/machining`, `/routing`, `/3d-printing` ✓ | Process landing (SEO + buyer qualification) | Hero; capability blocks (machines, envelope, tolerance, finishes); materials quoted online; **add** "Approved supplier packet" link on `/machining` | Get an instant quote | Full material guide | `GET /api/materials?process=` |
| `/materials` ✓ → **add** `/materials/:slug` | Material reference and SEO landing | Table (keep); per-material page: stocked forms, tolerance, guidance text, price example @1/10/100, guarantee, FAQ | Quote in this material → `/quote?process=&material=` | Request a firm quote | `GET /api/materials`, `POST /api/quote` for the example |
| `/quality` ✓, `/about` ✓ | Trust | FAI, CoC, certs, ISO path, inspection equipment; shop photos, address, phone, hours, "come see the shop"; **add** W-9 / COI / supplier form download links | Upload a part | Call | — |
| `/quote` ✓ | Instant quote builder | ProcessPicker; parts rail; viewer / DFM; PartConfigurator (**add** tolerance, drawing, notes); price breakdown; quantity breaks; OrderSummary (**add** ship-by date, "Email me this quote"); gate box when RFQ | Proceed to Checkout (gated → Request a firm quote) | Prefer a firm quote from a person? | `POST /api/upload`, `POST /api/quote` (returns `gate`, `dfmByPartId`, **add** `shipBy`), `GET /api/materials?process=`, `GET /api/finishes?process=`, `GET /api/lead-times` |
| `/rfq`, `/rfq/:quoteId` ✓ | Firm-quote request | Parts + budgetary prices + gate reasons (keep); form (keep); **add** no-CAD mode (photos ×2, dimensions, "bring it in") | Send for a firm quote | Phone / email | `GET /api/quote/:id`, `POST /api/rfq` |
| **new** `/rfq/:rfqId/quote` (or `/quotes/:id`) | Customer-facing quoted RFQ | Quoted lines and total, validity, notes from the shop, drawing on file | Pay by card (→ `/checkout/:quoteId` from a derived quote) | Send a PO (→ order `pending_po`) | `GET /api/rfq/:id` (**add** quoted lines), **add** `POST /api/rfq/:id/accept` |
| `/login`, `/register` ✓ | Account at order time only | Email/password; **fix** `register` to honor `state.from`; one line "your quote is saved" | Continue to checkout | — | `POST /api/auth/*` |
| `/checkout/:quoteId` ✓ | Ship-to and pay | Address (keep); **add** Ship / Pick up in Wauconda, PO/reference field, tax line, ship-by date; order summary | Pay & Place Order (Stripe) | Send this quote to purchasing | `GET /api/quote/:id`, `POST /api/orders/checkout-session` |
| `/orders/:id` ✓ | Confirmation + tracking | **add** paid banner, line items with config, ship-by, tracking link, files/drawings; timeline (keep); **fix** back link | Reorder → `/quote` with saved configs | Contact about this order (mailto with order number) | `GET /api/orders/:id` |
| `/dashboard` ✓ | Customer home | **add** tabs: Orders / Saved quotes / RFQs with status and quoted totals | New quote | Reorder | `GET /api/orders`, **add** `GET /api/quotes/mine`, `GET /api/rfq/mine` |
| `/admin` ✓ | Owner ops | RFQ queue (keep); **add** per-line quoted prices + customer note + "Send quote" button; order queue; status update with tracking | — | — | `GET /api/rfq/admin/list`, `PUT /api/rfq/admin/:id`, `PUT /api/orders/:id/status` |

Nav (make it the same on every page via `PublicLayout`): Machining · Routing · 3D printing · Materials · Quality · About · [Instant quote]. Footer: address, phone, email, hours, guarantee line, file formats.

---

## 5. Instrumentation

One `track(event, props)` helper in `client/src/utils/analytics.js` (Plausible or PostHog; both work with a static SPA). Every event carries `sessionId`, `process`, and `quoteId` when present. Server-side events go to the same project from `server/services/analytics.js`.

| # | Event | Fires in | Props |
|---|---|---|---|
| 1 | `landing_cta_click` | `LandingPage.jsx` and `ServicePage.jsx` button handlers | `page`, `cta` (hero / process-card / dark-cta) |
| 2 | `upload_started` | `QuoteBuilder.handleFiles` before `api.uploadFiles` | `fileCount`, `extensions`, `process` |
| 3 | `upload_result` | `QuoteBuilder.handleFiles` after the response | `parsed`, `failed`, `parseMs` |
| 4 | `quote_shown` | `QuoteBuilder.fetchQuote` on success, first time per part set | `orderTotal`, `partCount`, `gate.requiresRfq`, `gate.reasons[].code` |
| 5 | `process_switched` | `QuoteBuilder.handleProcessChange` (wired to `ProcessPicker`) | `from`, `to`, `partCount` |
| 6 | `config_changed` | `PartConfigurator` `onChange` (throttled) | `field`, `value` |
| 7 | `dfm_viewed` / `dfm_fail_seen` | `QuoteBuilder` `setShowDFM(true)`; `DFMPanel` mount when `summary.failCount > 0` | `failCount`, `checkIds` |
| 8 | `lead_time_selected` | `OrderSummary` `onLeadTimeChange` | `slug`, `surchargePct` |
| 9 | `gate_shown` | `OrderSummary` render when `needsRfq` flips true | `reasons[].code`, `orderTotal` |
| 10 | `rfq_started` / `rfq_submitted` | `RfqPage` mount; `RfqPage.submit` success | `hasQuote`, `hasDrawing`, `reasons[].code` |
| 11 | `checkout_started` / `auth_wall_hit` | `OrderSummary.handleCheckout` (both branches) | `authenticated`, `orderTotal` |
| 12 | `auth_completed` | `LoginPage` / `RegisterPage` success | `returnTo`, `isNew` |
| 13 | `payment_redirect` | `CheckoutPage.handleSubmit` before `window.location = sessionUrl` | `orderId` |
| 14 | `order_paid` (server) | `stripeWebhook.js` on `checkout.session.completed` | `orderId`, `total`, `leadTime`, `process` |
| 15 | `rfq_quoted` / `rfq_won` (server) | `PUT /api/rfq/admin/:id` on status change | `rfqId`, `hoursToQuote`, `quotedTotal`, `budgetTotal` |
| 16 | `reorder_clicked` | `OrderTrackingPage` / `CustomerDashboard` (once built) | `orderId` |

Funnels to watch weekly: upload_started → quote_shown → checkout_started → auth_completed → order_paid, split by `process`; and quote_shown(gated) → rfq_submitted → rfq_quoted → rfq_won, with `hoursToQuote` against the 24-hour promise in `brand.json`.

---

## 6. Open questions for the owner

1. **Stocked vs ordered.** 13 plastics are quoted online. Which are actually on the shelf (and in what forms/thicknesses) and which get ordered per job? Lead time and the material pages should say.
2. **Tight tolerance.** `/machining` promises ±0.002" on called-out features. On the instant path, should a "tight" selection add a surcharge, trigger the gate, or both?
3. **Lead times you can hold alone.** Standard 7–10 / Expedited 3–5 / Rush 1–2 / Same Day 2.5×. Which of these are real for one person, and will you guarantee the ship-by date?
4. **Quoted RFQ → payment.** When you mark an RFQ quoted, should the customer get a card pay link, a PO path, or both? Net-30 for approved OEMs at launch, or card only until volume justifies it?
5. **Guarantee wording.** `/quality` describes inspection but there is no remake-or-refund promise anywhere. Do you want one, and with what exclusions (e.g. accepted DFM warnings)?
6. **Pickup.** `/about` says "Come see the shop". Will-call hours, and should checkout offer pickup at $0 shipping?
7. **Sales tax.** Collect Illinois tax via Stripe Tax, or resale certificates only?
8. **The 24-hour promise.** `brand.quoteTurnaroundHours` is 24 and it is printed on the landing page, the quote builder, the RFQ page, and the acknowledgement email. Can you hold it during production weeks, or should it be one business day?
9. **No-CAD jobs.** Worth taking? Minimum charge for drawing the part? Should the drawn CAD be attached to the customer's account for reorder?
10. **Certs and paperwork.** "FAI with every production order" is on the landing page — at what quantity does "production" start, and is FAI free? Material certs / CoC: free on request or a line item?
11. **Price example.** Can we publish a worked example on `/` and the material pages (a specific Delrin block at qty 1/10/100)? Competitors do; it is the strongest single trust signal for an engineer.
12. **Account policy.** Account at checkout (current) vs guest checkout with email only?
13. **Printing's place.** FDM/SLA pricing is unchanged from the Nord MFG build. Keep it as a side door, or re-price it around prototypes-for-machined-parts?
