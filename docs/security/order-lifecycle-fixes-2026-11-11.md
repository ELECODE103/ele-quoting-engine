# Order lifecycle fixes: what happens after a Stripe session exists

Date: 2026-11-11. Branch: `order-lifecycle-fixes` (from `hardening-2026-11-11` at `e4881d3`, with `security-review-payments-2026-11-11` merged in for its report and scripts).

This answers the independent payment-path review (`docs/security/independent-review-payments-2026-11-11.md`) for everything after the creation of a Stripe session: the webhook, the confirm-payment routes, order states, the firm-quote accept path, purchase orders, session expiry, refunds, disputes, promotion codes and the startup requirements for Stripe. Pricing, the quote gate, re-pricing at checkout, tax and shipping, page wording and the runbook belong to other branches and are not changed here.

Nothing in this work called the real Stripe API. Stripe is replaced at the boundary in every test and script. Section 9 lists what that leaves unproven.

## 1. Summary

| Finding | Severity | Status | Permanent test |
|---|---|---|---|
| F-18 server starts without the webhook secret | Medium, launch blocker | Fixed | `server/security/stripeStartup.test.js` |
| F-08 sessions never expired; late and duplicate payments dropped | Medium | Fixed | `server/routes/orderLifecycle.test.js` (F-08 cases, expiry and sweep cases) |
| F-11 two accepts of one firm quote both succeed | Medium | Fixed | same file (F-11 cases, instant checkout, confirm-payment, reorder) |
| F-06 amount check skipped; currency and session not compared | Low | Fixed | same file (F-06 cases) |
| F-07 refunds and disputes not handled | Low | Fixed | same file (F-07 cases) |
| F-17 promotion codes on everywhere; discount recorded as paid in full | Low | Fixed; switch is off pending the owner's decision | same file (F-17 cases) |
| F-09 total changed without re-sending keeps the old link live | Low | Fixed | same file (F-09 cases) |
| F-10 line break in the PO number prints on the traveler | Low | Fixed | same file (F-10 cases) |
| Quote link sent to Stripe in return URLs (review section 8) | Low | Fixed | same file ("Stripe is never given the quote link") |
| `PUT /api/orders/:id/status` sets any status with no record (F-15, order part) | Low | Fixed | same file (manual moves, audit) |
| I-1 webhook answers 400 to a checkout that is not ours | Info | Fixed | same file ("events that are not ours") |
| I-2 unpaid orders never expire | Info | Fixed | same file (expiry, sweep) |
| I-6 quote re-priced during its checkout ends up "ordered" with other contents | Info | Fixed | same file ("a re-price that arrives while…") |
| I-9 mailer off: shop gets no order email | Info | Startup now says so plainly | `stripeStartup.test.js` |
| I-3, I-4, I-5, I-7, I-8 | Info | Accepted or another branch's; see section 7 | |
| F-16 traveler leaves out what was priced | Medium | Open: not this branch (traveler layout) | |

Verification counts are in section 10.

## 2. The order payment state machine

The code is `server/services/orderState.js` (what is allowed) and `server/services/orderLifecycle.js` (carrying it out). The tables below restate the lists in `orderState.js`; a test (`orderLifecycle.test.js`, manual moves) holds the server to them.

### States

| `order.status` | Meaning | In the production queue |
|---|---|---|
| `pending_payment` | The order exists and has a Stripe session; nothing collected | no |
| `pending_po` | Accepted on a purchase order; nothing charged; the shop confirms the PO | yes |
| `paid` | Card payment verified, or marked paid by the owner with a reason | yes |
| `received`, `in_production`, `quality_check`, `packing` | The shop's own steps | yes |
| `shipped`, `delivered` | Done | no |
| `expired` | Never paid; its session lapsed. Shown as "Not paid, closed". The quote can be used again | no |
| `cancelled` | Called off by the shop | no |
| `refunded` | The whole payment was refunded in Stripe | no |
| `paid_amount_mismatch` | Written by earlier versions only. Nothing produces it now; it still displays and can be resolved by hand | no |

### Flags (an order keeps its state while flagged)

| Field | Values | Set by | Cleared by |
|---|---|---|---|
| `attention` | `duplicate-payment`, `late-payment`, `payment-mismatch`, `zero-payment`, `dispute`, `refund-problem` | a payment or Stripe event the site would not settle on its own | the owner (`POST /api/orders/:id/resolve-attention`, note required); a full refund of the extra payment; a dispute won |
| `refundedAmount` | dollars refunded so far | `charge.refunded`, `refund.updated` | |
| `disputeStatus` | `open`, `won`, `lost`, `closed` | `charge.dispute.created`, `charge.dispute.closed` | |
| `discountAmount`, `amountPaid` | what Stripe reported | a verified payment | |
| `paidVia`, `manualPaidReason`, `manualPaidBy` | `card` or `manual` | a verified payment, or the owner | |

### Automatic moves

| From | To | Caused by | Condition |
|---|---|---|---|
| (none) | `pending_payment` | `POST /api/orders/checkout-session`; `POST /api/rfq/quote/:token/accept` with card | written in one synchronous step with its claim on the quote |
| (none) | `pending_po` | `POST /api/rfq/quote/:token/accept` with a PO | same |
| `pending_payment` | `paid` | `checkout.session.completed`; `POST /api/orders/:id/confirm-payment`; `POST /api/rfq/quote/:token/confirm-payment`; `POST /api/rfq/return/confirm`; the sweep | every payment check passes (section 3, F-06) |
| `pending_payment` | `expired` | `checkout.session.expired` for the order's only session; the sweep once the session's expiry plus ten minutes has passed and Stripe confirms it was not paid | the order is not flagged |
| `paid` … `delivered` | `refunded` | `charge.refunded` or `refund.updated` when the amount refunded reaches the amount paid | |

Nothing automatic moves an order out of `cancelled`, `expired` or `refunded`. A payment that arrives for one of those, or a second payment for a paid order, changes no state: it is recorded, the order is flagged and the shop is emailed.

### Manual moves (`PUT /api/orders/:id/status`, admin)

| From | May be moved to |
|---|---|
| `pending_payment` | `paid` (reason required), `cancelled` |
| `pending_po` | `received`, `in_production`, `paid` (reason required), `cancelled` |
| `paid` | `received`, `in_production`, `quality_check`, `packing`, `shipped`, `delivered`, `cancelled`, `refunded` (reason required) |
| `received`, `in_production`, `quality_check`, `packing` | any other step from `paid` to `delivered`, `cancelled`, `refunded` (reason required) |
| `shipped`, `delivered` | any other step from `paid` to `delivered`, `refunded` (reason required) |
| `expired` | `paid` (reason required), `cancelled` |
| `cancelled` | `paid` (reason required) |
| `refunded` | nothing |
| `paid_amount_mismatch` | `paid` (reason required), `cancelled`, `refunded` (reason required) |

Refused, always: any move to `pending_payment`, `pending_po`, `expired` or `paid_amount_mismatch`; an unpaid order straight into production; anything out of `refunded`. Sending the order's current status changes only the tracking fields and the note. "Reason required" for `paid` applies when no payment is on record (`paidAt` is empty). Marking paid or cancelling closes the order's open Stripe session. Every move writes a row to `admin_audit`.

### Diagram

```
                    checkout-session / accept (card)                 accept (PO)
                               |                                         |
                               v                                         v
   +-------------------- pending_payment --------------------+       pending_po
   |                     |           |                       |           |
   | session lapsed      | verified  | owner: paid           | owner:    | owner: PO confirmed
   | (event or sweep)    | payment   | (reason)              | cancel    | (received / in_production)
   v                     v           v                       v           | or paid (reason), cancel
 expired --owner:paid--> paid <------+                    cancelled      |
   |   (reason)          |  \                                ^  |        |
   +--owner: cancel ---->|   \--- owner: cancel -------------+  |        |
                         v                                      |        |
        received -> in_production -> quality_check -> packing --+        |
              ^            (the shop's steps, any order)  <--------------+
              |                         |
              |                         v
              |                  shipped -> delivered
              |
   full refund in Stripe (any step from paid to delivered) ---> refunded   (final)
   owner: paid, with a reason (from cancelled) -----------------> paid

   Flags, on any state: needs attention (duplicate / late / not matching / nothing collected /
   dispute / refund problem), part refunded, disputed. A flag never changes the state.
```

### Sessions

An order has at most one open Checkout session. `orderEvents.createCheckoutSession` (now `orderLifecycle.checkoutSession`) hands out the order's existing session while it is still good (open at Stripe, same amount, same return pages, same promotion-code setting, more than five minutes from expiry). Otherwise it expires the old one through the Stripe API and only then makes a new one. If the old one cannot be confirmed closed the request is refused (`payment-session-busy`) rather than leaving two payable pages. If Stripe says the old one was paid, the order is settled and the buyer is sent to the success page. Two calls at the same moment share one session. Every session is a row in `payment_sessions`; every session is created with `expires_at` two hours out (`CHECKOUT_SESSION_MINUTES`, 30 to 1440).

## 3. Findings

### F-18. Production refuses to start without the webhook secret

- **Root cause.** `STRIPE_WEBHOOK_SECRET` was not in `REQUIRED_ENV_PROD` (`server/index.js`); its absence was a warning.
- **Fix.** It is in the required list. A missing, empty or blank value stops the server with exit code 1, the usual `FATAL: Missing required environment variables: STRIPE_WEBHOOK_SECRET` line and a second line saying what breaks and where to get the secret. Values are never printed. A secret that does not start with `whsec_` starts the server and logs a warning by name.
- **Tests.** `server/security/stripeStartup.test.js` (4 cases, real server, production mode).
- **PoC now.** `poc-06`: "the server does not start (exit 1): FATAL: Missing required environment variables: STRIPE_WEBHOOK_SECRET", for both no secret and an empty one.
- **Side effect to know about.** `server/testSupport/liveServer.js` now gives the server a throwaway signing secret by default (`s.webhookSecret`). A test that wants none passes `STRIPE_WEBHOOK_SECRET: ""`.

### F-08. Sessions expire; a payment is never dropped

- **Root cause.** A new session was made on every "pay" and the old one left open; cancelling did nothing at Stripe; `markPaid` returned silently for an order that was not pending.
- **Fix.** Sessions as described above. On cancel (and on marking paid by hand) the open session is expired. `checkout.session.expired` is handled. A completed payment for an order that is already paid, refunded, cancelled or expired is written to `payment_events`, the order is flagged `duplicate-payment` or `late-payment`, and the shop gets one email ("Order ABCD1234 needs attention: duplicate payment — $235.59"). A sweep at startup and every ten minutes closes unpaid orders whose session expiry has passed: it asks Stripe about each session first, settles one that was paid, skips the order when Stripe does not answer, and leaves flagged orders and phone orders (no session) alone. An expired instant order gives its quote back (`ordered` to `draft`); an expired firm-quote order puts the request back to `quoted` so it can be accepted again.
- **Tests.** Eight F-08 and expiry cases in `orderLifecycle.test.js`.
- **PoC now.** `poc-06`: pressing pay twice leaves one open session; a second payment for a paid order answers `{"received":true,"outcome":"duplicate-payment"}`, order flagged, one email. `poc-10`: cancelling leaves the session "expired" at Stripe; a payment that arrives anyway answers `outcome: "late-payment"`, order flagged, one email.

### F-11. One quote, one order

- **Root cause.** The accept handler checked `status === "quoted"`, waited on Stripe, then wrote `accepted`. Two requests both passed the check.
- **Fix.** The check, the order, its lines and the move to `accepted` are written in one synchronous block before the call to Stripe. If the session cannot be made the claim is released (only while the quote is still held by that order and it is unpaid). A repeated accept answers from the existing order: the same card session (200, `repeat: true`), or for the same PO number the same order. A different PO number, or switching method, is `already-accepted`.
- **The same reasoning applied elsewhere.**
  - **Instant checkout.** The reviewer saw one order from two simultaneous requests. That is because the lookup for an unpaid order and the insert of a new one are in one synchronous step, so the second request finds the first one's order. It then made a second session for it; now both requests share one session. Two related holes are closed: the quote is marked `ordered` in the same step (a re-price during the Stripe call used to change the quote under its order, I-6), and a failed first request no longer deletes an order another request is using.
  - **Confirm-payment.** `markPaid` checked the status on an order object read before the call to Stripe. A webhook landing during that call meant a second move to paid, a second pair of emails and a rewritten payment date. Every decision is now made on the order as read at that moment (`transitionToPaid`, `applySession`).
  - **PO acceptance.** Had no wait and was safe; it goes through the same claim.
  - **Reorder.** Synchronous, creates draft quotes only. Two at once make two drafts and nothing else. Pinned by a test, left as is.
- **Tests.** Seven cases (F-11, instant checkout, confirm-payment, reorder).
- **PoC now.** `poc-07`: two card accepts at once answer 201 and 200 with one order; card and PO at once answer 201 and 409 with one order.

### F-06. What a payment must show before an order is marked paid

- **Root cause.** The amount check ran only for a non-zero amount; currency and session id were never compared.
- **Fix.** `orderLifecycle.checkSession`, used by the webhook and all confirm routes:
  1. the session is one recorded for this order (`payment_sessions`; for orders made before today, the id on the order row);
  2. `payment_status` is `paid`;
  3. `amount_total` is present and an integer;
  4. `amount_total` plus `total_details.amount_discount` equals `expectedCharge(order)` in cents, exactly;
  5. a discount is accepted only on a session that was created with promotion codes allowed;
  6. `currency` equals the order's currency (`usd`). A missing currency is a mismatch.
  Any failure: the order stays `pending_payment`, is flagged `payment-mismatch` with the reason in plain words, and the shop is emailed once. The customer is told only that the payment is being checked.
- **Tests.** Three F-06 cases covering seven malformed payment reports, both confirm routes, and the clean path.
- **PoC now.** `poc-06`: no amount, amount 0, JPY, and a session made elsewhere all leave the order `pending_payment`.
- **Changed behaviour.** `paid_amount_mismatch` is no longer written. A mismatch used to put the order in that paid-like state; it now stays unpaid and flagged.

### F-07. Refunds and disputes

- **Root cause.** One event type was handled.
- **Fix.** `charge.refunded` and `refund.updated` (the charge is read from Stripe for the running total). A full refund moves the order to `refunded`, out of the production queue. A partial refund keeps it active and stores the amount. A refund total that goes down (a refund failed) flags `refund-problem`. `charge.dispute.created` flags the order `dispute` and emails the shop at once; nothing is cancelled. `charge.dispute.closed` records won, lost or closed. Charges are matched to orders by the payment intent stored when the order was paid; for an order paid before today, by asking Stripe which session the payment intent came from; last, by the order id the session now puts on the payment intent's metadata. A refund of an extra (duplicate or late) payment does not refund the order: it clears the flag.
- **Tests.** Five F-07 cases; one more in the migration suite for an order paid by the old code.
- **PoC now.** `poc-06`: after `charge.refunded` the order is `refunded`, out of the queue, one email.

### F-17. Promotion codes

- **Root cause.** `allow_promotion_codes: true` on every session; the check compared the pre-discount amount and recorded the full total as paid.
- **Fix.** Off by default. `STRIPE_PROMOTION_CODES=on` turns them on; the admin orders tab shows the setting, and so does the startup log. When on: the order stores `discountAmount` and `amountPaid`; the confirmation email says "Total paid" for what was collected with the order total and the discount beside it; the order confirmation PDF prints "Promotion code" and "Amount paid" lines; the admin and customer pages show both. A session completed with nothing to pay (a 100% code; `no_payment_required`, or an amount of 0) is not marked paid: the order is flagged `zero-payment` and the owner is emailed, and decides by hand.
- **Tests.** Three F-17 cases.
- **PoC now.** `poc-09`: "every checkout session is created with allow_promotion_codes: false"; a session reported with a 50% discount leaves the order `pending_payment`, flagged.

### F-09. The emailed link is for the terms that were sent

- **Root cause.** The link named only the request and the send time; the amount was read when the link was used.
- **Fix.** When a quote is sent, a fingerprint of its terms (total, lines and quantities, lead time, validity date, paperwork, return of the part, note) is stored (`rfqs.sent_terms`), and the link carries the amount it was issued for. If the stored terms no longer match what was sent, the link answers 409 `quote-changed` on view, accept and confirm, the admin view has no link to copy and shows "Changed since it was sent", and the save answers `linkInvalidated: true`. Pressing send then really sends (it used to skip when nothing differed from the already-edited row). The accept request carries the total on the page (`seenTotal`); a different one is refused. A quote with no positive total cannot be accepted. The terms of an accepted quote cannot be edited (`quote-accepted`). A quote sent before today is fingerprinted the first time it is opened or edited.
- **Tests.** Three F-09 cases; one in the migration suite with a link in the old format.
- **PoC now.** `poc-07`: accept after an unsent change answers 409 `quote-changed`, no Stripe session; a total of 0 answers 409.

### F-10. Single-line fields

- **Root cause.** `sanitizeString` keeps line breaks; the traveler printed the PO number as given.
- **Fix.** `server/middleware/singleLine.js`. A value with a line break, tab, control character, Unicode line separator or hidden formatting character is refused with 400, a `code` and the `field`; nothing is rewritten. Applied to: PO number (also limited to letters, digits, spaces and `. , - _ # / & ( ) + :`, 60 characters); ship-to name, street, city, state, ZIP, country on firm-quote accept, instant checkout and phone orders; name, company, phone on the request form, registration and profile; carrier, tracking number, ship date and the reason on the admin status route. The traveler and the document facts print a stored PO number on one line whatever it holds, for rows written before today.
- **Tests.** Two F-10 cases; `botCheck.test.js` updated (a line break in a name is refused where it used to be turned into a space).
- **PoC now.** `poc-07`: PO number with a line break answers 400 `po-number-invalid`.
- **Not changed.** Length limits where a field was previously cut to length silently (names, company, phone) are still cut, not refused, to avoid turning away a buyer over a long phone extension. Notes are multi-line by nature and print inside their own block.

### Return URLs (review section 8)

- **Root cause.** `success_url` and `cancel_url` for a firm quote were `/firm-quote/<accept token>`.
- **Fix.** They are `/firm-quote/return?o=<order id>&r=<return token>&paid=true` and `…&cancelled=true`. The return token (`server/services/returnToken.js`) is signed with its own derived key and audience, lasts as long as the session plus an hour, and is good for one thing: `POST /api/rfq/return/confirm`, which settles the order if Stripe says it was paid and answers with reference, status, total, ship-by and whether the payment is being checked. No name, address, email or quote. The firm-quote page remembers its own link in the tab's session storage before redirecting, so the return page sends the buyer back to their quote page; in a browser that never saw the link it shows the order's status and points to the email.
- **Instant path.** Its return URLs carry the order id and quote id only, behind sign-in. Unchanged.

### Manual status changes and the audit trail

- **Fix.** Section 2. `server/services/audit.js` exports `record({ actor, action, entity, entityId, before, after, note })` and `list()`. It appends to `admin_audit` and never throws. Actions written: `order.mark-paid`, `order.cancel`, `order.status`, `order.attention-resolved`.
- **For the merge.** The table is `admin_audit(id, user_id, user_email, action, entity, entity_id, note, before_json, after_json, created_at)`, created in `server/models/orderLifecycleMigration.js`. If the other branch's table differs, keep theirs and point `audit.record` at it; the four call sites pass only the fields above.

## 4. Stripe: events to enable, settings to check

### Events to enable on the webhook endpoint

Endpoint: `https://<site>/api/stripe/webhook`. Enable exactly these six:

```
checkout.session.completed
checkout.session.expired
charge.refunded
refund.updated
charge.dispute.created
charge.dispute.closed
```

The handler also understands `checkout.session.async_payment_succeeded`, `refund.failed` and `charge.refund.updated` if they are sent; they are not needed with card-only checkout. Any other type is acknowledged and ignored. The list is exported as `HANDLED_EVENTS` from `server/routes/stripeWebhook.js`.

Answers: 200 handled, already handled (`duplicate: true`) or not ours (`ignored`); 400 bad signature; 500 the site failed and Stripe should send it again.

### Dashboard settings for the owner to check

| Setting | What to check |
|---|---|
| Webhook signing secret | Copy the endpoint's secret (starts `whsec_`) into `STRIPE_WEBHOOK_SECRET`. The server will not start without it. Test mode and live mode have different secrets. |
| Session expiry | Set by the site, two hours per session. There is nothing to set in the dashboard. To change it: `CHECKOUT_SESSION_MINUTES` (30 to 1440). |
| Promotion codes | Off at the site. Before setting `STRIPE_PROMOTION_CODES=on`, look at Product catalog > Coupons: every active promotion code would work on every order, firm quotes included. A 100% code never releases an order by itself. |
| Customer emails from Stripe | The site sends its own order confirmation. It sends the customer nothing on a refund. Turn on Stripe's refund receipts if customers should be told by email. |
| Dispute notifications | Keep Stripe's own dispute emails on. The site emails the shop too, but the deadline and the evidence form are in Stripe. |
| Payment methods | Checkout asks for card only. Do not enable delayed methods (bank debits) for this integration without a code change. |
| Other uses of the account | A payment link or another product on the same account is ignored by the site (answered 200). |

Radar is out of scope.

### Environment

| Variable | Meaning | Default |
|---|---|---|
| `STRIPE_WEBHOOK_SECRET` | required in production | none: the server refuses to start |
| `STRIPE_PROMOTION_CODES` | `on` allows promotion codes at checkout | off |
| `CHECKOUT_SESSION_MINUTES` | how long a payment page stays open | 120 |

## 5. Refusal codes (stable, machine-readable)

New in this branch unless marked existing.

| `code` | Status | Where | Meaning |
|---|---|---|---|
| `payment-session-busy` | 502 | checkout-session, firm-quote accept | The earlier payment page could not be confirmed closed; try again in a minute |
| `order-not-payable` | 409 | checkout-session | The order was paid, cancelled or closed meanwhile |
| `payments-unavailable` | 503 | internal, session creation | Stripe not configured |
| `card-unavailable` | 502, 503 | firm-quote accept | Card payment could not be started |
| `method-required` | 400 | firm-quote accept | Neither card nor PO chosen |
| `address-required` | 400 | firm-quote accept | Ship-to incomplete |
| `quote-changed` | 409 | firm-quote view, accept, confirm | The quote was changed after the link was sent, or the page's total is not the quote's |
| `quote-not-payable` | 409 | firm-quote accept | The quote has no positive total |
| `already-accepted` | 409 | firm-quote accept | existing; now also for a different PO number or method |
| `not-open` | 409 | firm-quote accept | existing |
| `quote-accepted` | 409 | `PUT /api/rfq/admin/:id` | Terms of an accepted quote cannot be edited |
| `po-number-required` | 400 | firm-quote accept | |
| `po-number-invalid` | 400 | firm-quote accept | Not one printable line of allowed characters, or over 60 |
| `field-single-line` | 400 | accept, checkout-session, phone order, request form, register, profile, order status | With `field`: the value has a line break or hidden character |
| `field-too-long`, `field-invalid`, `field-required` | 400 | same routes | With `field` |
| `return-link-invalid` | 404 | `POST /api/rfq/return/confirm` | Return token missing, forged, expired or for another order |
| `confirm-failed` | 502 | same | |
| `status-unknown` | 400 | `PUT /api/orders/:id/status` | |
| `transition-not-allowed` | 409 | same | The move is not in the state machine |
| `reason-required` | 400 | same; `resolve-attention` | A typed reason of at least three characters is needed |
| `order-not-found` | 404 | same | |

Response fields the pages read: `paymentUnderReview` (order and firm-quote views, confirm routes), `repeat` and `order` (accept), `linkInvalidated` and `needsResend` (admin RFQ), `linkAmount` (firm-quote view), `payment` and `paymentEvents` (admin order views), `alreadyPaid` is internal (the route answers with the success page as `sessionUrl`).

Webhook outcomes (`outcome` or `ignored` in the 200 body): `paid`, `replay`, `unpaid`, `payment-mismatch`, `zero-payment`, `duplicate-payment`, `late-payment`, `order-expired`, `session-closed`, `refunded`, `partially-refunded`, `extra-refund`, `refund-problem`, `dispute-opened`, `dispute-won`, `dispute-lost`, `dispute-closed`, `unmatched`, `no-order-id`, `order-not-found`, `event-type`.

## 6. Shop notifications for money events

All go through `mailer.send` to `mailer.shopNotifyAddress()` (the existing path), which is a logged no-op without `EMAIL_API_KEY` and `EMAIL_FROM`. Subjects hold our own words, the order reference and an amount, never customer text. Each event also leaves a row in `payment_events` (`kind`, `order_id`, `amount_cents`, `notified`, `created_at`) for a digest or alert to count.

| Event | Email to the shop (template, subject) | `payment_events.kind` |
|---|---|---|
| New paid order | `newOrderShop`: "New order ID — $N" | `order-paid` |
| New PO order | `rfqAcceptedShop`: "Quote ID accepted on a purchase order — $N" | `po-order` |
| Payment needing attention | `paymentAttentionShop`: "Order ID needs attention: duplicate payment / late payment / payment does not match the order / nothing was collected / refund problem — $N" | `duplicate-payment`, `late-payment`, `payment-mismatch`, `zero-payment`, `refund-problem` |
| Refund | `refundShop`: "Order ID: refunded in full / partly refunded / extra payment refunded — $N" | `refund` |
| Dispute | `disputeShop`: "Order ID: payment disputed — $N", then "dispute won / lost / closed" | `dispute-opened`, `dispute-closed` |

Rows written without an email (`notified` 0): `order-expired`, `order-cancelled`, `manual-paid`, `attention-resolved`, `unmatched`, and `event` (one per Stripe event id that changed nothing, for de-duplication).

With the mailer not configured the startup log says: "WARNING: THE SHOP WILL RECEIVE NO ORDER EMAILS. New paid orders, purchase-order orders, payments that need attention, refunds and disputes will appear only in admin until EMAIL_API_KEY and EMAIL_FROM are set." The admin orders tab shows "Order emails to the shop are off" in the same case.

Not sent, by decision left open: an email to the customer when an order expires unpaid, is cancelled, or is refunded; a confirmation when the owner marks an order paid by hand.

## 7. The reviewer's Info items

| Item | Disposition |
|---|---|
| I-1 webhook 400 for a checkout with no order id | Fixed: 200 and ignored; also 200 for an order id we do not have (it was 404). |
| I-2 unpaid orders never expire | Fixed (sweep, `expired`). Still open: an expired order's part stays locked against a units change and its files are kept. See section 8. |
| I-3 tax 0, shipping flat, country free text | The tax-and-shipping branch. Not changed. |
| I-4 admin phone-order route adds typed shipping, makes no session | Accepted here; the price side is the review-fixes branch. A phone order has no session, so the sweep never expires it; the owner marks it paid with a reason or cancels it. Its ship-to fields are now line-checked. |
| I-5 PO acceptance needs only the link | Accepted, by design. The control is the shop confirming the PO. The order shows "PO to confirm" and moving it into work is audited. |
| I-6 order minimum inside subtotal; quote re-priced during checkout | Second half fixed (the quote is claimed with the order). First half is presentation, another branch. |
| I-7 notes do not affect the instant price | Accepted: a business rule, not payment state. |
| I-8 a new quote takes its id from the request | Not this branch (quote creation). Harmless. |
| I-9 mailer off | Startup log and admin screen now say so plainly. The keys belong on the launch checklist. |

## 8. Found in the lifecycle code that the reviewer did not report

| # | What | Severity | Status |
|---|---|---|---|
| 1 | Confirm-payment and the webhook racing: both moved the order to paid, two confirmation emails, payment date rewritten | Low | Fixed |
| 2 | Instant checkout: when the first of two simultaneous requests failed at Stripe it deleted the order the second was using, and the second answered with a payment page for an order that no longer existed | Low | Fixed |
| 3 | The webhook answered 404 for an unknown order id, which Stripe retries for days | Info | Fixed |
| 4 | "Paid revenue" on the admin screen summed list totals: it ignored promotion-code discounts and partial refunds | Low | Fixed (`server/routes/api.js`, admin stats) |
| 5 | There was no way to cancel an order in the admin screen at all (only through the API) | Info | Added: "Cancel order" in the drawer |
| 6 | Pressing send on a quote whose terms had been saved earlier did not send, because nothing differed from the saved row | Low | Fixed |
| 7 | Orders written by origin/master store totals unrounded (for example 259.2436…); the charge was the rounded figure | Info | Handled: every comparison is in whole cents |
| 8 | The browser-run Stripe stub reported paid sessions with no currency; with the stricter checks the two existing browser suites would have failed | Info | Stub updated (`scripts/e2e/stub-network.cjs`) |
| 9 | `server/routes/botCheck.test.js` reads `data/rfq-drawings` in the repository and fails in a fresh checkout where that folder does not exist yet | Info | Not fixed (not this branch). `mkdir -p data/rfq-drawings` before `npm test` in a new worktree. |
| 10 | The in-flight session sharing and the synchronous claims assume one server process. A second instance would need a real lock. | Info | Accepted: the database is a single file and cannot be shared between instances anyway |

## 9. What remains open, and what could not be verified

**Open**

- F-16 (traveler content): another branch. `poc-09` still reports it.
- A paid order's quote can still be checked out again as a second order (`poc-10` notes it). One quote, one order on the instant path is the review-fixes branch.
- Expired orders: the part stays locked against a units change, and the order's files are kept by retention like any order's. Low.
- No customer email on expiry, cancellation or refund (section 6).
- The first start after deploy: unpaid orders older than a day that were made by the old code are closed as expired by the sweep, after Stripe is asked whether each was paid. The owner should expect those to change from "awaiting payment" to "not paid, closed".

**Not verified against real Stripe** (the brief rules it out; each is an assumption about Stripe's behaviour, stated in the code where it is used)

- That a session completed with a 100% promotion code reports `payment_status: "no_payment_required"`. Both that and `paid` with an amount of 0 are handled the same way.
- That `payment_intent_data.metadata` on the session is copied to the charge, so that `charge.refunded` carries `metadata.orderId`. It is only the third way of matching; the first two do not depend on it.
- The exact shape of `refund.updated` and that its `charge` can be read with `charges.retrieve`.
- That `checkout.sessions.expire` fails with a distinguishable error for a session that is already complete or expired. The code does not rely on the error text: it reads the session back.
- That `expires_at` two hours out is accepted (Stripe documents 30 minutes to 24 hours).
- Stripe's own retry timing and event ordering. Handlers do not depend on order.

**Merge notes for whoever integrates the branches**

- `server/services/expectedCharge.js` is a byte-for-byte copy of the file in the review-fixes working tree when this was written. It returns `{ cents, dollars, components }`, not a number as the brief described. `orderLifecycle.expectedCents` accepts either shape.
- Session creation moved from `orderEvents.createCheckoutSession` into `orderLifecycle.openSession`. The tax-and-shipping branch's additions to session creation (`automatic_tax`, a Stripe Customer, per-line tax codes) have to be ported there. Its tax handling at settlement belongs in `checkSession` (subtract `total_details.amount_tax` when the order is taxed by Stripe) and in the `updates` passed to `orderEvents.transitionToPaid`.
- The review-fixes branch's `checkoutSessionFor` / `checkoutGuard.sessionFor` does what `createCheckoutSession` now does by itself; it can call through.
- `settleFromSession` and `confirmPayment` now take the order or its id and re-read it; `markPaid` no longer takes `warning`.
- Currency is required on a payment report. Tests elsewhere that build a session object by hand need `currency: "usd"`. The harness, the review stub and the browser-run stub all supply it.
- Tests elsewhere that move an unpaid order straight into production through the status route will now get 409 `transition-not-allowed`.
- New route inventory entries: `POST /api/orders/:id/resolve-attention` (admin), `GET /api/orders/admin/payment-settings` (admin), `POST /api/rfq/return/confirm` (open, return token).
- New stores live in `server/models/lifecycleStore.js`, not `models/index.js`.

## 10. Verification

| Check | Result |
|---|---|
| `npm test` | 44/44 suites (the 41 that existed plus `orderLifecycle.test.js`, `stripeStartup.test.js`, `orderLifecycleMigration.test.js`) |
| New cases | `orderLifecycle.test.js` 41; `stripeStartup.test.js` 4; `orderLifecycleMigration.test.js` 9 |
| Fails on the old behaviour | `orderLifecycle.test.js` run against commit `11c1d64` (the data layer only, old behaviour): 39 of 41 fail. The two that pass are the setup and the reorder control. |
| Migration | `orderLifecycleMigration.test.js` opens `server/models/fixtures/origin-master-orders.db`, written by origin/master's own code (`scripts/dev/make-origin-master-fixture.js`): every old row and column unchanged, second run adds nothing, the paid order displays, replays cleanly, moves on and can be refunded; the unpaid order can still be paid; the unpaid card accept can be paid again or lapses and reopens its quote; the quoted firm quote opens from a link in the old format and is accepted; the PO order displays and can be started. |
| `NODE_ENV=production npm run build` | 22/22 routes |
| `node scripts/claims-check.js` | exit 0 |
| `scripts/e2e/hardening-accounts.mjs` | 96/96 |
| `tools/security/csp-browser-check.js` | 66 steps, 66 clean, 0 violations |
| `scripts/e2e/order-lifecycle.mjs` (new) | 63/63, with a double click on every pay and accept button; 30 screenshots at 1360 px in `docs/screenshots/order-lifecycle-2026-11-11/` |
| Reviewer scripts in this lane | `poc-06` 0 of 15, `poc-07` 0 of 15, `poc-10` 0 of 5 checks show a weakness; `poc-09` 2 of 5, both F-16 (not this branch). Also run: `poc-11` 0 of 2; `poc-12` 1 of 9, which is F-01 (not this branch). `poc-01` to `05` and `08` belong to other branches and were not re-run here. |

The reviewer's scripts were changed where their checks assumed the old behaviour (a second session always exists; a late payment is "dropped" if the order stays cancelled; the server starts without a secret). Each change is marked in the script with a dated comment, and the review stub gained `sessions.expire`.

### How to re-run

```sh
mkdir -p data/rfq-drawings          # only in a fresh checkout (section 8, item 9)
npm install && npm test
NODE_ENV=production npm run build && node scripts/claims-check.js
node server/routes/orderLifecycle.test.js
node tools/security/review-payments/poc-06-stripe-webhook.js      # and poc-07, poc-09, poc-10
NODE_PATH=<dir holding playwright> env -u HTTPS_PROXY -u HTTP_PROXY -u http_proxy -u https_proxy NO_PROXY=localhost \
  node scripts/e2e/order-lifecycle.mjs --scratch <dir>
```

## 11. Decisions for the owner

1. **Promotion codes.** Off now. Yes or no. If yes, set `STRIPE_PROMOTION_CODES=on` and review the active codes in Stripe first.
2. **How long a payment page stays open.** Two hours now. After that the order closes as "not paid" and the quote can be ordered again.
3. **Emails to the customer** when an order closes unpaid, is cancelled, or is refunded. None are sent now.
4. **A confirmation email when you mark an order paid by hand.** Not sent now.
5. **Duplicate and late payments.** The site flags them and emails you; the refund is made by you in Stripe. Confirm that is how you want it, rather than an automatic refund.
