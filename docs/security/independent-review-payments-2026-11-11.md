# Independent review: the money path

Date: 2026-11-11. Branch reviewed: `hardening-2026-11-11` at `e4881d3`. Review branch: `security-review-payments-2026-11-11`.

Scope: everything between an uploaded file and money in the bank: pricing a quote, the quote gate, checkout, the Stripe session and webhook, firm quotes and purchase orders, reorder, the admin price screens, and the documents and emails that state an amount. Sign-in, permissions, injection, uploads and parsing belong to the other two reviewers; what I tripped over there is in section 8.

Method: I read the code and attacked a local server first, and read the three hardening reports and `docs/pricing-models.md` only afterwards. Every finding below has a script that reproduces it against the real `server/index.js` started in production mode on a free local port, with a throwaway database, secrets generated at run time, and the Stripe SDK replaced inside the server process so no request can leave the machine. No application code was changed.

## 1. Verdict

The parts of the money path that were hardened hold up well: a buyer cannot send a price, a webhook cannot be forged, a firm-quote link cannot be forged or reused after it is replaced, and a buyer cannot change an order once it exists.

The weak point is earlier. **Checkout charges whatever total was saved on the quote and never looks again at the part, the rules or the gate.** Three things follow, and they are the launch blockers:

1. A DXF's units can be switched after the price is saved. I paid **$182.85 for a job the engine prices at $4,666.99**, and the paid order carries the full-size part (F-01).
2. The server prices any process name and any material it is sent, including a process the site does not sell. A panel that needs review on every real process was bought, unreviewed, for **$217.20 against a $3,059 routing estimate** (F-02).
3. The quote gate can be stepped around by splitting a job across lines (F-03).

Also blocking: the job traveler leaves out the stock thickness, the grade, and the paperwork and return-the-part flags (F-16), and the server starts without a webhook secret (F-18).

Counts: 1 Critical, 2 High, 8 Medium, 7 Low, 9 Info.

## 2. Findings

"By accident" says how often an honest customer or the owner would hit it without trying.

### Critical

| ID | What | Where | Reproduce | What it costs, in plain words | Fix |
|---|---|---|---|---|---|
| F-01 | A DXF's units can be changed between pricing and checkout. The price stays; the part gets 25.4 times bigger in each direction. | `server/security/index.js:47-57` (the lock starts when an order or request exists, not when a price is saved); `server/routes/api.js:398-444`; `server/routes/orders.js:84` (charges the saved total); `server/routes/pdf.js:38-43` and `orders.js:362` (the shop's views read the part as it is now) | `node tools/security/review-payments/poc-01-dxf-units-swap.js` | A customer draws a 40 × 30 inch panel, tells the site it is millimetres, gets a price for a part the size of a matchbox, flips it back to inches and pays. 20 panels in 3/4" HDPE: paid $182.85, real price $4,666.99. The order shows as paid and the admin screen shows the full-size part, so nothing looks wrong. **By accident:** uncommon but real. The quote builder re-prices after a units change, so it takes an older saved quote or a second tab: price in the wrong units, correct them, then pay from the first quote. | Make a priced part immutable: a units change makes a new part id and leaves the old one as it was. At checkout, re-run `priceQuote` on the saved configuration and refuse if the part's size no longer matches what the line recorded (`meta.geometrySummary`). Print the priced size on the traveler. |

### High

| ID | What | Where | Reproduce | What it costs | Fix |
|---|---|---|---|---|---|
| F-02 | The process, the material-to-process pairing, the stock thickness and the grade are taken from the request unchecked. (a) Any unknown process name, or `sheetmetal`, is priced with the old laser-cutting model and skips the gate. (b) A CNC material under `3d-printing` is priced at a built-in $0.10/cm³ on the FDM rate. (c) Any positive thickness is accepted. (d) Any text is accepted as the grade and stored on the order. | `server/routes/api.js:531-535` (material by slug only), `:544` (process from the body), `:557` (thickness), `:563` (grade); `server/processes/registry.js:54-56` (unknown process falls back to sheet metal); `server/processes/3d-printing/pricing.js:27`; `server/processes/sheetmetal/pricing.js` | `node tools/security/review-payments/poc-02-process-material-not-validated.js` | (a) Ten oversize aluminum panels: CNC $6,665 and routing $3,059, both sent to review. With `process: "anything-at-all"`: **$217.20, no review, paid.** The order line reads "sheetmetal, Aluminum 6061-T6" and the traveler prints "Sheet Metal". (b) Ten aluminum housings: $3,361.91 machined, **$684.01** as a "3D print" in aluminum. (c) A 12 × 8 inch HDPE plate at 0.01 mm: $152.88 against $420.91 at 1 inch. (d) Grade stored as "PEEK natural - upgrade approved by phone" on an HDPE order; the packing slip and the certificate of conformance print it as the material. The shop then holds a paid order and a confirmation email for work it does not do at that price. **By accident:** none; it takes a hand-built request. | In `priceQuote`: refuse a process that is not in `activeProcesses()`; refuse a material whose `process` differs; refuse a finish whose `process` differs; for routing require the thickness to be one the material lists; require the grade to be one the material lists. Remove the sheet-metal fallback from pricing so an unknown process is an error. |
| F-03 | Three ways round the quote gate. (a) The 100-piece limit is per line: 500 pieces as five lines of 100 is not gated. (b) The $5,000 limit is per line; there is no limit on the order. (c) The DFM result is stored per part, so a second line for the same part in a process where it passes replaces the first line's failure. | `server/services/quoteGate.js:57` and `:121` (per line); `server/routes/api.js:577` with `quoteGate.js:65` (keyed by part id, last line wins) | `node tools/security/review-payments/poc-03-gate-bypass.js` | (a) 500 cubes on one line: sent to review. As 5 lines: $10,479.28, checkout allowed. 100 lines × 100 pieces priced at $209,357 with no review. (b) 60 trays as three lines of 20: $11,168.46, no review. (c) A 700 mm bar that does not fit the mill is stopped on its own; add one routing line for the same file and the CNC line checks out for $1,260.87. The buyer pays the listed price (more, in fact, because setup is charged per line), so this is not a discount. It is a production run with a promised ship date, on Standard or Expedited, that nobody looked at. **By accident: likely.** A buyer who wants 300 pieces and sees "over 100 goes to a person" will try three lines. | Sum quantity per part and per order before comparing with the limit. Add an order-total threshold beside the per-line one. Key the DFM result by line, not by part id. |

### Medium

| ID | What | Where | Reproduce | What it costs | Fix |
|---|---|---|---|---|---|
| F-04 | A saved quote is charged as saved for 30 days: not re-priced, not re-gated, materials not re-checked, and usable for any number of orders. | `server/routes/orders.js:84-119` (only expiry, the stored gate flag and the lead time are checked), `:137` (no check that the quote was already ordered) | `node tools/security/review-payments/poc-04-stale-quote.js`; gate part in `poc-03` (d) | After a price rise the same job quoted at $2,162.21, and the earlier quote still charged $706.78, twice, from one quote. A material switched off in admin could still be bought. A quote priced before the gate was tightened still checked out. The 30-day hold is a promise to customers and is reasonable. The cost is that after fixing a rate that was too low, there is no way to stop quotes already out there. **By accident:** every time prices change, for 30 days. | Keep the hold, but at checkout re-run `priceQuote` for availability and the gate, and refuse if the material, finish, process or lead time is no longer offered or the gate now says review. Add an admin action "void open quotes priced before now". Decide whether one quote may become more than one order. |
| F-05 | A finish that is sent out can be bought on Expedited by sending the sheet-metal finish slug. | `server/shopFacts.js:37-42` (the Standard-only rule lists four `cnc-` slugs); `server/routes/api.js:539` (finish by slug only) | `node tools/security/review-payments/poc-05-quantity-rounding-leadtime.js` | `cnc-anodize-clear` with Expedited is refused. `anodize-clear` with Expedited on the same CNC part is accepted: order confirmed, ships in 3 to 5 days, finish "Anodize — Clear". The shop has promised a date the finisher cannot meet. **By accident:** none. | The F-02 fix (finish must belong to the process) closes it. Better: mark sent-out finishes with a field on the finish record so a new finish cannot miss the list. |
| F-08 | Stripe sessions are never expired. Pressing "pay" twice leaves two payable sessions for one order; an order the shop cancels keeps its session. A payment for an order that is no longer waiting is acknowledged and ignored. | `server/services/orderEvents.js:75-90` (new session, old one left open), `:100` (not pending: return silently); `server/routes/stripeWebhook.js:83-85` | `poc-06-stripe-webhook.js` and `poc-10-reorder-and-order-changes.js` | A customer charged twice, or charged for a cancelled order, with no email to anyone and nothing on the order. The first the shop hears is a complaint or a chargeback. **By accident:** occasional (back button, two tabs, a slow page). | When a second session is made, and when an order is cancelled, call `stripe.checkout.sessions.expire` on the old one. When a completed event arrives for an order that is not waiting for payment, email the shop instead of skipping. |
| F-11 | Two accepts of one firm quote sent at the same moment both succeed. | `server/routes/rfq.js:550` (status checked), `:603` (waits for Stripe), `:613` (status changed) | `node tools/security/review-payments/poc-07-firm-quote-link.js` (the stub waits 250 ms where Stripe's network call would) | One quote, two orders: two card orders each with its own payable session, or a card order and a PO order in the production queue. **By accident:** a double click on a slow connection. Not reachable on the PO-only path, which has no wait. | Mark the request "accepted" (or "accepting") before the call to Stripe and undo it if the call fails. |
| F-13 | A material saved with a blank or zero price is stored and then priced at a built-in fallback. | `server/routes/api.js:906-907` (blank becomes `null`); `server/processes/cnc/pricing.js:70` (`|| 1.0`), `routing/pricing.js:37` (`|| 6.0`), `3d-printing/pricing.js:27` (`|| 0.1`) | `node tools/security/review-payments/poc-08-admin-pricing-integrity.js` | PEEK at $130/kg, 25 brackets: $2,888.28. Clear the price field: saved, and the same job is **$1,430.74**, with material at $0.27 a piece instead of $34.56. Nothing warns. A blank machinability does the opposite: $19,529.52. This is the blank-multiplier bug the server report fixed for lead times, still open for materials. **By accident:** plausible whenever a material is edited. | Refuse blank, zero or missing `pricePerKg` / `pricePerCm3` and blank `machinability` / `density` on an active material. Remove the fallbacks from the pricing models so a material without a price is an error, not a guess. |
| F-14 | The multiplier on the Lead Times admin tab is saved and never used. | `server/routes/api.js:496-499` (the rate card's rush table wins whenever it has the slug, and it always does) | `poc-08-admin-pricing-integrity.js` | Expedited set to 2× on the Lead Times tab: saved, shown as 2×, and quotes still charge 1.35×. The owner believes a surcharge changed when it did not. **By accident:** the first time the owner edits it there. | One source. Either remove the field from the Lead Times tab and point to the rate card, or make the lead-time record the only place. |
| F-16 | The job traveler leaves out what was priced. | `server/services/pdfGenerator.js:267-283` (columns), `:408-424` (totals); `client/src/components/OrderDetailDrawer.jsx:239-242`; `server/routes/orders.js:567-573` | `node tools/security/review-payments/poc-09-documents-and-emails.js` | For a DXF order priced at 19.1 mm, grade "HDPE — black", with inspection paperwork: the customer's confirmation and the packing slip show all three. The traveler and the admin order line show none of them. A DXF has no thickness of its own, so the shop cannot tell from its own documents what to cut. Layer height and infill for prints are not shown anywhere. The traveler's money block omits the paperwork line, so its lines add to $514.66 under a total of $574.66. A send-us-the-part order's traveler does not say the original goes back. **By accident: every routed order**, and every order with a colour or grade choice. | Print the same description line the customer documents use (`documents.js` `describe`) on the traveler and the admin line, plus layer height and infill for prints, the paperwork fee line, and the paperwork and return flags. |
| F-18 | The server starts in production without `STRIPE_WEBHOOK_SECRET`. | `server/index.js:10` (not in the required list), `:223` (a warning only) | `poc-06-stripe-webhook.js` (the "no secret" runs) | Without it every webhook is refused, correctly. Orders are then marked paid only if the buyer comes back to the order page after paying. A buyer who closes the tab has paid, the order stays "awaiting payment", and the shop gets no notice. | Add `STRIPE_WEBHOOK_SECRET` to `REQUIRED_ENV_PROD` so a deploy without it fails. |

### Low

| ID | What | Where | Reproduce | What it costs | Fix |
|---|---|---|---|---|---|
| F-06 | A signed webhook is trusted further than it needs to be: (a) the amount check is skipped when the event has no amount or amount 0; (b) currency is not compared; (c) the event's session id is not compared with the session made for the order. | `server/services/orderEvents.js:122-131`; `server/routes/stripeWebhook.js:60-73` | `poc-06-stripe-webhook.js` | Not reachable by a customer: it needs the webhook secret or the Stripe account. It matters if the Stripe account ever takes payments for anything else, or the secret leaks. | Require `session.id === order.stripeSessionId` (or one of the order's sessions), `currency === "usd"`, and a present amount; treat a missing amount as a mismatch. |
| F-07 | Refunds, disputes and expired sessions are not handled. | `server/routes/stripeWebhook.js:60` (one event type) | `poc-06-stripe-webhook.js` | An order refunded in the Stripe dashboard stays "paid" and stays in the production queue. | Handle `charge.refunded` and `charge.dispute.created` by flagging the order and emailing the shop. Until then, cancel the order by hand whenever a refund is made. |
| F-09 | A firm quote's total can be changed without re-sending, and the emailed link then charges the new amount. A total saved as 0 can be accepted on a PO as a $0.00 order. | `server/routes/rfq.js:370-374`, `:398-400` (a new link only when `status: "quoted"` is sent with the change), `:578-585` | `poc-07-firm-quote-link.js` | The admin screen always re-sends, so today this needs a direct API call. A buyer with the page open at $1,500 pressed accept and the Stripe amount was $2,500. | Treat any change to the total, lead time or coverage of a quoted request as a re-send. Have the accept request carry the total the buyer saw and refuse if it differs. Refuse a total of 0 on a quoted request. |
| F-10 | A line break in the PO number prints as a separate line on the traveler. | `server/routes/rfq.js:565`; `server/services/pdfGenerator.js:292` | `poc-07-firm-quote-link.js` | The traveler read "Customer PO: PO-778" and, on its own line, "PAID IN FULL - SHIP TODAY". | Strip line breaks from the PO number (as is already done for the contact name). |
| F-12 | Nothing refuses to sell far under cost. | `server/routes/orders.js:84-87` (only a total of zero or less is refused) | `poc-08-admin-pricing-integrity.js` | Each rule is range-checked and 17 bad values were all refused. But margin 0, floors 0, shipping 0, the lowest mill rate and a 90% quantity break are each legal: 25 brackets fell from $1,590.51 to $26.92 and checked out. The pricing console's preview is the only guard. | A sanity floor at checkout: refuse and alert the shop if a line's price is under its own material cost, or the order is under the minimum order. |
| F-15 | Only the rate card is logged. | `server/routes/api.js:948-954`, `:993-999`, `:1126-1132`; `server/routes/orders.js:421-454` | `poc-08-admin-pricing-integrity.js` | Five material edits, a lead-time edit and anodize set to $0 left no record. Nor does an order's status being set to "paid" by hand. After a pricing mistake there is no way to see what changed or when. | Write material, finish, lead-time and order-status changes to the same audit table, with who, when, before and after. |
| F-17 | Every checkout allows Stripe promotion codes, and a discounted payment is recorded as paid in full. | `server/services/orderEvents.js:86`, `:125`; `server/emails/templates.js:441` | `poc-09-documents-and-emails.js` | Any active promotion code in the Stripe account works on any order, firm quotes included. Paid with a 50% code, the order, the email ("Total paid: $290.51") and the PDFs all state the full amount; $145.25 was collected. I could not test a 100% code against real Stripe: if Stripe reports such a session as `no_payment_required`, the order would stay unpaid. | If codes are not wanted, set `allow_promotion_codes: false`. If they are, store `amount_total` and the discount on the order and print them. |

### Info

| ID | Note |
|---|---|
| I-1 | The webhook answers 400 to a `checkout.session.completed` that has no `orderId` (`stripeWebhook.js:64-67`). If the Stripe account ever sells anything else, Stripe will retry those for days and may disable the endpoint. Answer 200 and ignore. |
| I-2 | Unpaid orders are never removed or expired. Each keeps its quote marked "ordered" and its part locked. |
| I-3 | `tax` is always 0 and Stripe Tax is not enabled; the ship-to country is free text and shipping is the same flat estimate anywhere; the server does not require a ship-to address on the instant path (`orders.js:36-45`). These are business decisions to confirm, not defects. |
| I-4 | The admin phone-order route (`orders.js:247-341`) adds a typed shipping cost on top of a quote total that already includes shipping, checks no expiry, and makes no Stripe session. Admin only. |
| I-5 | A PO acceptance needs only the emailed link, creates a `pending_po` order for the quoted total with the ship-to the acceptor types, and that order is listed in the production queue (labelled "PO to confirm"). The addressee is emailed a confirmation. This is by design; the control is the shop confirming the PO before cutting. |
| I-6 | An order placed under the order minimum stores the difference inside "subtotal" rather than as its own line. A quote re-priced while its checkout request is in flight ends up "ordered" with different contents from its order; the order itself is consistent. |
| I-7 | Notes on the instant path do not affect the price, so a note can ask for anything (a tolerance, a cert) at the instant price. The instant path has no tolerance input at all. |
| I-8 | A new quote takes its id from the request when that id is an unused UUID (`api.js:666`). Harmless, but the server report's "id cannot be set from the body" is not exact. |
| I-9 | With the mailer not configured the shop gets no new-order email and firm quotes cannot be sent. `EMAIL_API_KEY`, `EMAIL_FROM`, `FRONTEND_URL` and the webhook secret belong on the launch checklist. |

## 3. What to do, in order

**Launch blockers**

- F-01, F-02 (which also closes F-05), F-03 a to c. These are one change in one place: `priceQuote` validates what it is given, and checkout re-runs it.
- F-16. The shop cannot build a DXF order correctly from its own documents.
- F-18, with I-9: the webhook secret and the email keys set, and the secret required at startup.

**Fix soon** (first weeks)

- F-04: re-check availability and the gate at checkout; add "void open quotes".
- F-13 and F-14. Until fixed: never leave a material's price blank, and change rush pricing only on the rate card.
- F-08, F-11, F-06, F-07, F-15.
- F-17: decide yes or no on promotion codes.
- F-09, F-10.

**Accept** (with eyes open)

- The 30-day price hold itself, once checkout re-checks the gate and availability.
- F-12, as long as the preview is used before saving rules.
- I-2 to I-8.

## 4. Every route that can create or change an order's amount or payment state

| Route | Who can call it | What it does | Where the amount comes from |
|---|---|---|---|
| `POST /api/quote` | Anyone (bot check when configured) | Creates or re-prices a draft quote; restarts its 30 days | Server: `priceQuote` from the stored part, the current rules, and the request's process, material, finish, grade, thickness, quantity, layer height, infill, lead time and paperwork yes/no. No amount is read from the request (tested). |
| `POST /api/parts/:id/units` | Holder of the part's edit key, until the part is on an order or request | Replaces the stored geometry of a DXF | Changes what saved quotes point at without changing their totals (F-01) |
| `POST /api/orders/checkout-session` | Signed-in buyer (confirmed email when the mailer is on); the quote's owner, or anyone for a quote with no owner; admin for any quote, skipping the gate and lead-time checks | Creates an order "awaiting payment" and a Stripe session; or re-uses the buyer's unpaid order for that quote and updates its address | The total saved on the quote, unchanged (`orders.js:84`). Stripe's line items are built from the order total (`orderEvents.js:59-69`). |
| `POST /api/stripe/webhook` | Stripe, signature required | `checkout.session.completed`: order to "paid", or "paid_amount_mismatch" when the pre-discount amount differs from the order total by more than a cent | Order found by `metadata.orderId`; amount compared with the stored order total |
| `POST /api/orders/:id/confirm-payment` | The order's owner or admin | Asks Stripe about the order's latest session and settles the same way | Same comparison |
| `POST /api/rfq/quote/:token/confirm-payment` | Holder of the firm-quote link | The same for a firm-quote order | Same comparison |
| `PUT /api/rfq/admin/:id` | Admin | Sets the firm total, lead days, paperwork and return flags, status; sends the link | Typed by the owner; any number ≥ 0, must be > 0 to send |
| `POST /api/rfq/quote/:token/accept` | Holder of the link, while the request is "quoted" | Creates an order: "awaiting payment" plus a Stripe session (card), or "pending_po" (PO) | `rfq.quotedTotal` as it is at that moment; nothing from the request |
| `PUT /api/orders/:id/status` | Admin | Sets any status, "paid" included; not logged | Amount unchanged |
| `POST /api/orders` | Admin | Phone order from a quote, no payment | Quote total plus a typed shipping cost |
| `POST /api/orders/:id/reorder` | The order's owner or admin | Makes a new draft quote from the order's lines | Re-priced now by `priceQuote`; gate re-run (tested) |
| `PUT /api/admin/pricing`, `/restore/:id`, `/reset`; `PUT/POST/DELETE /api/admin/materials…`; `PUT/POST /api/admin/finishes…`; `PUT /api/admin/lead-times/:id` | Admin | Change the prices of future quotes | Rate card schema-checked and logged; the others range-checked, not logged |
| `POST /api/rfq` | Anyone | Creates a request; marks the source quote "rfq"; records the budget total | No amount set |

No route lets a buyer change an order after it exists, except re-submitting the address on their own unpaid order (tested: `poc-10`).

## 5. Claimed fixes: verified by attack, or not

| Claim (report) | Result |
|---|---|
| Unsigned webhook refused unless the test switch is set, and never in production (server W1, integration W1) | **Verified.** With a secret: unsigned, wrong secret, 10-minute-old signature, body altered after signing, wrong content type all 400. No secret or an empty one, production, `SE_TEST_HOOKS=1`: 503, order untouched. Outside production with the switch and no secret, unsigned events are processed, as documented. The switch cannot be honoured in production. |
| Webhook idempotent | **Verified.** Three deliveries, one state change, one shop email. |
| Amount compared with the order total | **Verified** for a present, non-zero amount, by webhook and by confirm-payment. Skipped when the amount is absent or 0 (F-06a). |
| A buyer cannot mark an order paid; total and owner cannot be set through the status route (server) | **Verified.** |
| Price, status, owner, gate, expiry cannot be set from the quote body (server) | **Verified.** "id" is not exact (I-8). |
| 100 lines per quote, quantity at most one million (server) | **Verified.** |
| Blank lead-time multiplier refused, 1 to 10 only (server 12) | **Verified**, but the value is never used (F-14), and the same blank problem is open for materials (F-13). The report's "Materials were already validated" does not hold for prices. |
| Finish prices edited in admin now save and price the next quote (integration F1) | **Verified.** |
| DXF units cannot be changed once the part is on an order or request; needs the edit key (server 13, accounts) | **Verified as stated, and incomplete.** See section 6. |
| Firm-quote links: algorithm named, forged and altered links refused, superseded and expired answer 410, not accepted as a login (integration A4, accounts) | **Verified.** Expiry checked by moving the stored date (`poc-11`). |
| "The holder of a live link can accept once, at the owner's price" (accounts) | **Verified in sequence. Not true for two requests at once** (F-11). |
| Stripe return URLs and firm-quote links do not follow the Host header (accounts 8b) | **Verified** with `FRONTEND_URL` unset and a forged host. |
| No email subject carries typed text (accounts 2a) | **Verified** for the order and firm-quote emails, with a line break in the PO number and name. |
| Markup typed into notes is escaped in emails (integration) | **Verified** for the order confirmation and the shop notice. |
| Checkout held for an unconfirmed email when the mailer is on (accounts 3) | **Not tested.** Outside my area, and my servers ran with the mailer off. |
| Real Stripe behaviour: session expiry, 100% promotion codes, delayed payment methods | **Could not test.** The brief rules out the real Stripe API; the stub cannot tell me what Stripe sends. Card is the only method enabled, which removes delayed payments. |

## 6. Open items in the hardening reports that I think are mis-rated

- **Server 13, "DXF units after an order", Medium, Fixed.** The fix locks units once an order exists. The same weakness between pricing and ordering is F-01 and is Critical. The report's concern was the size on the traveler; the larger problem is the size against the price.
- **Server "Materials were already validated".** Not for a blank or zero price (F-13). This should have been the same Medium as the lead-time item it sat beside.
- **Accounts "PO acceptance … accept once".** Correct in sequence only (F-11). Low to Medium.
- **Anonymous quotes readable by id, "arguable, left as is".** I agree for reading. Note that it also means anyone holding a quote id can check it out under their own account. The id is a random UUID, so Low is right.
- **Missing from every open-items list:** no refund or dispute handling (F-07), promotion codes on (F-17), unpaid orders never cleaned up (I-2), and the webhook secret being optional at startup (F-18). None of the three reports looked at these; they are not mis-rated so much as unrated.

Nothing else in the open-items tables touches money.

## 7. Where I found nothing, and how hard I looked

- **A price from the client.** Sent `orderTotal`, `subtotal`, `unitPrice`, `lineTotal`, `leadTimeMultiplier`, `leadTimeSurcharge`, `shippingEstimate`, `paperworkFee`, `gate`, `status`, `userId`, `expiresAt` with quotes, and `total`, `amount`, `paperwork`, `gate` with checkout and with a firm-quote accept. All ignored.
- **Quantities.** 19 values: negative, zero, fractions, strings, hex, exponent, `1e21`, the largest safe integer, booleans, arrays, objects. Each became a whole number of at least 1, capped at one million, or a 400.
- **Cents.** 20 quotes of 1 to 100 lines, both lead times, with and without paperwork: the quote total, the order's parts, the Stripe line items and the Stripe amount agreed to the cent every time. 101 lines refused.
- **Paperwork.** The fee is computed by the server, added after the order minimum, cannot be lowered from the request, and un-ticking before checkout removes both the fee and the flag.
- **Lead times.** Unlisted (`rush`, `same-day`), unknown, empty and non-text slugs refused. Expedited costs more. A lead time switched off in admin blocks checkout of older quotes (read at `orders.js:114`).
- **Webhook.** 13 checks; signature handling, replay, and unpaid, failed and expired events all held.
- **Paying one session and claiming another order.** No path found: the order is named inside the signed event, and confirm-payment reads the session id from the order.
- **Other ways to "paid".** The success URL does nothing by itself; confirm-payment on an unpaid session stays unpaid; another account gets 403; the admin status route refuses a buyer.
- **Firm-quote link.** Six forgeries, supersede, withdraw, expiry, a second accept, a buyer-sent amount: all held.
- **Reorder.** Another account 403, no account 401; re-priced at today's rules; paperwork re-priced at today's fee; gate re-run and enforced.
- **Changing a paid order.** Six attempts; the order was unchanged.
- **Two checkout requests at once.** One order (the second re-uses it). The race in F-11 does not exist on the instant path. Re-pricing a quote while its checkout was in flight left the order and the charge in agreement (I-6).
- **Admin rule values.** 17 bad values (100% margin, negatives, blanks, `1e999`, 100% quantity break, unknown keys, `__proto__`, fractional piece counts) all refused; a save without a note refused.
- **Documents.** The confirmation PDF, traveler, customer email and shop email all stated the amount charged. A notes line reading "Order total: $1.00" prints inside the notes block and does not replace the real total.

Not covered: pricing accuracy (whether $4,666.99 is the right price for that panel is the vetting run's job, not mine); the browser client beyond checking what the admin screens send and show; real Stripe; anything needing more than one server instance.

## 8. Outside my area, noted in passing

- Checkout by an unconfirmed account is not held back while the mailer is unconfigured (documented in the accounts report). With I-9 it makes the email keys a launch item.
- `GET /api/finishes` lists the nine sheet-metal finishes to the public although the process is not offered.
- The firm-quote token is placed in Stripe's `success_url` and `cancel_url` (`rfq.js:536-539`). It is a credential that lasts until the quote is replaced or expires; Stripe sees it.

## 9. How to re-run

```sh
npm install && NODE_ENV=production npm run build
sh tools/security/review-payments/run-all.sh        # all twelve, several minutes
node tools/security/review-payments/poc-01-dxf-units-swap.js   # or one at a time
```

Each script starts its own server (`lib.js`), prints what it did and marks every check `[VULNERABLE]` or `[held]`. `stripe-stub-preload.js` replaces the Stripe SDK inside that server and must never be loaded in a deployed one. `poc-11` uses the in-process test harness because it has to move stored dates.

| Script | Covers |
|---|---|
| `poc-01-dxf-units-swap.js` | F-01 |
| `poc-02-process-material-not-validated.js` | F-02 |
| `poc-03-gate-bypass.js` | F-03, gate part of F-04 |
| `poc-04-stale-quote.js` | F-04; client-sent amounts |
| `poc-05-quantity-rounding-leadtime.js` | F-05; quantities, cents, paperwork, lead times |
| `poc-06-stripe-webhook.js` | F-06, F-07, F-08, F-18; signature, replay, routes to "paid" |
| `poc-07-firm-quote-link.js` | F-09, F-10, F-11; link forgery, revise, withdraw, PO |
| `poc-08-admin-pricing-integrity.js` | F-12 to F-15; rule bounds |
| `poc-09-documents-and-emails.js` | F-16, F-17; totals on documents, typed text |
| `poc-10-reorder-and-order-changes.js` | F-08; reorder, changing a paid order |
| `poc-11-expiry-in-process.js` | 30-day windows |
| `poc-12-claimed-fixes.js` | Section 5 |
