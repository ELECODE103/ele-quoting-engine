# Buyer-journey quality pass — 2026-11-11

Branch `journey-qa`, cut from `hardening-2026-11-11` (e4881d3). The coordinator pushed it once, at the work-in-progress commit `bbf2461`; the commits after that are local and not pushed. No security behaviour, limit, token, validation rule, route, price or pricing rule was changed: every change is wording, layout, focus, a client-side convenience, the HTML and text of the emails, or the layout of the shop's documents.

What was walked: every screen and state the hardening pass added, plus the journey around them, in Chromium against a production-mode server at 390, 768 and 1360 px and by keyboard alone. The walk is a script, `scripts/e2e/journey-qa.mjs`, so it can be run again after any change. It was run twice: on the hardening build as it stood ("before") and on this branch ("after"). It records, for each screen, a screenshot, the messages a buyer reads, whether the page scrolls sideways, touch targets under 24 px, and the axe-core result.

Screenshots: `docs/screenshots/journey-qa-2026-11-11/` (after, 390 and 1360 px) and `…/before/` (the same screens before). Emails: `…/emails/`. The shop's street address is masked wherever it would show.

## 1. Result

| Check | Before | After |
|---|---|---|
| Screens with a serious or critical axe violation | 54 of 101 | 1 of 101 (the home page, which this pass did not touch) |
| Screens that scroll sideways | 7 at 390 px and 9 at 768 px (all admin) | 0 |
| Refusal messages in developer or accusing language that could reach a buyer | 16 (section 5) | 0 |
| Kinds of upload refusal with no way to a person on the screen | 5 of 10 | 0 |
| A buyer confirms their email from the link: is checkout one press away? | No (the new tab had lost the quote) | Yes |
| Session ends at checkout | Red box: "Authentication required". Page stays; nothing to press | Sign-in page says why; after signing in the buyer is back at checkout with the address they typed |
| Back from the card page | Ship-to form empty | Ship-to form as typed |
| Focus after a refused form | Stays on the button | On the message |
| `npm test` | 41 suites | 43/43 suites pass (two added) |
| `NODE_ENV=production npm run build` | 22/22 | 22/22 |
| `node scripts/claims-check.js` | exit 0 | exit 0 |

## 2. Findings, ranked by how many buyers meet them and how badly

"Before" and "after" link to the phone screenshots; the desktop ones have the same names ending `-1360`.

| # | Who meets it | What was wrong | What it is now | Before / after |
|---|---|---|---|---|
| 1 | Every first-time buyer | After pressing "Confirm my email" in the email, the page offered "Back to your quote". The email opens in a new tab, the quote id lived in the first tab's session storage, so that button opened an empty quote tool. A buyer who had just built a quote was looking at nothing. | The browser remembers the checkout page it was heading for (path only, for a week, cleared when the order is placed or on sign-out). The confirmed page's main button is "Go to checkout". | [before](../screenshots/journey-qa-2026-11-11/before/a12-verify-confirmed-same-browser-390.jpg) / [after](../screenshots/journey-qa-2026-11-11/a12-verify-confirmed-same-browser-390.jpg) |
| 2 | Every buyer on a phone | The total and "Check out" were at the bottom of a page about 3,300 px tall. Nothing on the first screen said what the order would cost or how to buy it. | A bar at the bottom of the screen carries the total, the ship date and the one button (Check out, or Request a firm quote when the quote is gated). The full summary is one tap away. | [before](../screenshots/journey-qa-2026-11-11/before/a04b-quote-priced-first-screen-390.jpg) / [after](../screenshots/journey-qa-2026-11-11/a04b-quote-priced-first-screen-390.jpg) |
| 3 | Every buyer creating an account | The password rules were one line of 11 px grey text. A password that broke one was refused after the form's three-second wait, in a box the page did not move to. No way to see what had been typed. | The four rules are listed under the field and tick off as the buyer types; a short password is caught before anything is sent; "Show password" on every password field; the message takes the focus and the field is marked. | [before](../screenshots/journey-qa-2026-11-11/before/a09-register-password-refused-390.jpg) / [after](../screenshots/journey-qa-2026-11-11/a09-register-password-refused-390.jpg) |
| 4 | Every buyer at checkout | The form had sample data as placeholders ("John Smith", "123 Main St", "New York") that read as already filled in, Title Case labels, no autofill hints (a phone could not offer the saved address), an emoji padlock, and "Pay & Place Order". The confirm-your-email box did not say that what was typed would be kept. | Plain labels, `autocomplete` on every field, no placeholders, "Pay and place order", a line under the button saying what happens next. The confirm box says why, that any device will do, and that nothing typed is lost. | [before](../screenshots/journey-qa-2026-11-11/before/a10-checkout-confirm-email-390.jpg) / [after](../screenshots/journey-qa-2026-11-11/a10-checkout-confirm-email-390.jpg) |
| 5 | Any buyer whose session ends while they are at checkout (a day-old tab, a password change on another device) | Pressing pay showed "Authentication required" in a red box. The page stayed, the button stayed, and nothing said what to do. Signing in from the header lost the address. | The app goes to the sign-in page, which says the session ended and that the quote and the details are saved; after signing in the buyer is back on checkout with the address as typed. | [before](../screenshots/journey-qa-2026-11-11/before/a19-checkout-session-ended-390.jpg) / [after](../screenshots/journey-qa-2026-11-11/a19-checkout-session-ended-390.jpg) |
| 6 | Any buyer who uses the back button on the card page | The ship-to form came back empty, under a notice in colours used nowhere else on the site. | The form comes back as typed. The notice says nothing was charged, in the site's own heads-up box. | [before](../screenshots/journey-qa-2026-11-11/before/a20-checkout-back-from-card-390.jpg) / [after](../screenshots/journey-qa-2026-11-11/a20-checkout-back-from-card-390.jpg) |
| 7 | Any buyer whose upload is refused | Ten kinds of refusal, each a line starting "⚠ Upload:" or "⚠ file name:". Five gave no way to reach a person. "Server busy" said to upload again and offered nothing to press. A PDF or a photo was uploaded, refused by the server, and counted against the day's allowance. | Each refusal names the file, says what happened and what to do, and carries the action as a button (Try again, Request a firm quote) plus the phone number. A drawing or photo is answered in the browser, before it is sent, and pointed at the firm-quote form. | [before](../screenshots/journey-qa-2026-11-11/before/u10-upload-server-busy-390.jpg) / [after](../screenshots/journey-qa-2026-11-11/u10-upload-server-busy-390.jpg) |
| 8 | Any buyer whose spam check fails, or who leaves a form open | "We couldn't confirm you're not a robot." "The check that keeps robots out isn't answering." "That was sent faster than a person fills in a form." | One catalogue of messages (section 5). None says robot, none blames the buyer, each says what to do and who to call. | [before](../screenshots/journey-qa-2026-11-11/before/g06-rfq-check-failed-390.jpg) / [after](../screenshots/journey-qa-2026-11-11/g06-rfq-check-failed-390.jpg) |
| 9 | Any buyer who mistypes a password five times | "Sign-in is paused for 15 minutes. Wait, or reset your password to sign in now." No time, no button; the reset link was a small link above. | Says why the pause exists and that nobody got in, shows the time it ends, and has a "Choose a new password" button in the message. | [before](../screenshots/journey-qa-2026-11-11/before/f05-login-paused-390.jpg) / [after](../screenshots/journey-qa-2026-11-11/f05-login-paused-390.jpg) |
| 10 | Any buyer who picks anodize or powder coat with a faster lead time selected | The lead time moved back to Standard, and the ship date with it, without a word. | A notice says the lead time moved, why, and how to get it back. | [after](../screenshots/journey-qa-2026-11-11/a06-quote-sent-out-finish-390.jpg) |
| 11 | Every buyer with a mouse; every buyer on a phone; every keyboard user | The 3D preview took the scroll wheel: with the pointer over it the page would not scroll. On a phone it could not be turned at all. It could not be reached by keyboard. | The wheel scrolls the page (Ctrl + wheel, a pinch, or the + and − buttons zoom). A sideways drag turns the part on a phone and an up-and-down swipe scrolls. Arrow keys turn it. | [after](../screenshots/journey-qa-2026-11-11/a04-quote-priced-390.jpg) |
| 12 | Any buyer sending a request with something missing | The error was a line of red text above the button; focus stayed on the button; the field was not marked. | The message takes the focus, the field is marked and tied to the message, and the result screen's heading takes the focus when the request goes in. | [before](../screenshots/journey-qa-2026-11-11/before/c03-rfq-missing-name-390.jpg) / [after](../screenshots/journey-qa-2026-11-11/c03-rfq-missing-name-390.jpg) |
| 13 | A buyer who confirms on a different device from the one with the quote | "Your account can check out now" and a Sign in button that led to an empty quote tool on that device. | Says the first device's checkout has already unlocked and is the place to go back to; "Sign in on this device" is the alternative. | [before](../screenshots/journey-qa-2026-11-11/before/a18-verify-other-device-done-390.jpg) / [after](../screenshots/journey-qa-2026-11-11/a18-verify-other-device-done-390.jpg) |
| 14 | A buyer who presses "Send the link again" straight after an earlier send | The press was refused: "We just sent one." | After a send the button counts down the minute the server makes everyone wait. | [after](../screenshots/journey-qa-2026-11-11/a11-checkout-resend-too-soon-390.jpg) |
| 15 | Every buyer, less sharply | Small grey text on the Bone tint was 4.2:1; success green 3.8:1; error red on its tint 4.4:1; amber on Bone 4.4:1 (all under the 4.5:1 that small text needs). | Four colour tokens darkened (numbers in section 7). | section 7 |
| 16 | Keyboard and screen-reader users | Eleven links before the content of every page and no way past them; the price sat inside a tab list; the upload target and the quantity buttons were announced by names that did not match their text; a status menu with no name. | Skip link; the roles corrected; names match the text. | section 7 |
| 17 | The owner, once | Two-step enrolment on a phone ran off the side of the screen (the QR code and the steps sat side by side); the admin tabs ran off the side at 390 and 768 px (the walk could not reach "Lead Times" on a phone); the banner was error red though nothing was wrong. | Enrolment is three numbered steps and stacks on a phone; the setup key is grouped in fours with a copy button; the tabs wrap; tables scroll inside their card; the banner is the site's "something to do" amber. | [before](../screenshots/journey-qa-2026-11-11/before/h04-admin-enrolment-qr-390.jpg) / [after](../screenshots/journey-qa-2026-11-11/h04-admin-enrolment-qr-390.jpg) |
| 18 | The owner, once, with consequences if skipped | The recovery codes screen had Copy and Download and two sentences. Nothing said what happens if the phone and the codes are both lost. | Says what the codes are for and what losing them means; Copy, Download, Print, each confirmed in words; prints as a clean sheet. | [before](../screenshots/journey-qa-2026-11-11/before/h06-admin-recovery-codes-390.jpg) / [after](../screenshots/journey-qa-2026-11-11/h06-admin-recovery-codes-390.jpg) |
| 19 | The shop, on every routed order (payments review F-16, rated a launch blocker) | The job traveler listed file, process, material and finish. A DXF has no thickness of its own, so the sheet to cut was not on the traveler; nor were the grade, the inspection paperwork, or the customer's original part to return. | Section 8. | `client/public/brand/documents/sample-job-traveler.pdf` |
| 20 | Every recipient of an email in dark mode; every recipient of an account email | No dark-mode handling; the preview line ran on into the greeting; the text part put the link in the middle of a sentence; the account emails did not say why they were sent. | Section 9. | `…/emails/` |

Smaller things fixed on the way: the request form's phone field brings up the phone keypad; the sign-in email field is marked as the username for password managers; the two-step code step shows who is signing in and lets them start over; an "account exists" refusal offers Sign in and Choose a new password as buttons; the forgot-password result says why it reads the same for an unknown address and offers "Try a different address"; motion stops for anyone who has asked their device to reduce it; a field taking the focus is never left under the sticky header or the phone total bar; the on-screen job traveler had a "Save Notes" button that saved nothing, and is gone.

## 3. Does the quote survive?

| Detour | Before | After |
|---|---|---|
| Creating an account from checkout | Yes | Yes |
| Confirming the email in the tab the email opens | The quote was still on the server, but the new tab did not know which one: "Back to your quote" opened an empty tool | "Go to checkout" |
| Confirming on another device | The first device's checkout unlocked by itself within 15 seconds; the second device said nothing about it | Same, and the second device says so |
| Password reset | Sign-in afterwards went to an empty quote tool in a new tab | After a reset, "Sign in with the new password" carries the checkout it was heading for |
| Session ends at checkout | Dead end ("Authentication required") | Sign in, back at checkout, address kept |
| Back button from the card page | Parts kept, address lost | Both kept |
| Reload of the quote tool | Kept | Kept |
| A second visit from the home page hero or a material page | The earlier quote reopens (a material deep link is ignored when the tab already holds a quote: known, left) | Same |

How it is kept, for the security reviewers: `straightedge.checkout` in localStorage holds `{ path: "/checkout/<quote id>", at }`, accepted back only if it matches that exact shape, forgotten after seven days, on sign-out and when the order is placed. `straightedge.checkoutDraft` in sessionStorage holds the six ship-to fields for one quote id, for that tab, cleared when the order is placed and on sign-out. Neither holds anything about the session. Both are in `client/src/utils/returnTo.js` with tests.

## 4. What was deliberately left, and why

| Left | Why |
|---|---|
| Home page: the large step numerals are 2.2:1 (axe: serious) | `LandingPage.jsx` belongs to the copy branch. They are decoration next to a numbered list, hidden from screen readers. One line to fix (`opacity: 0.35` on Ink) when that file is next open. It is the only serious axe finding left, and it is on a screen this pass did not touch. |
| Order summary internals (10 and 11 px text, the pulsing button) | The tax and shipping work is in `OrderSummary.jsx` and the totals now. This pass added an `id`, a class and a larger checkbox there, and nothing else. The phone bar in `QuoteBuilder.jsx` reads `quote.orderTotal` and `quote.shipBy`: whoever changes what "Total" means should change the bar's label with it. |
| Admin tables | Wide tables now scroll inside their card instead of moving the page. They were not redesigned for a phone. |
| Admin save failures use the browser's own alert box | Owner-only screens; out of this pass. |
| The traveler's quality checklist | Its lines carry fixed numbers ("+/- 0.005 in") and there is none for routing. That is shop practice for the owner to state, not layout. See section 10. |
| A truncated STL is told "the file's contents do not match its extension" | The server answers it with the same code as a renamed file. Section 6, item 7. |
| Finish list is not filtered by material (anodize is offered on acetal) | Catalogue and pricing, not wording. See section 10. |
| Cloudflare's real widget | The sandbox cannot reach it; a stand-in was used, as in the hardening run. The widget's own look on a phone is unverified. |
| 768 px screenshots | Walked and checked by the script (no sideways scroll, no serious axe finding); not stored, to keep the repository small. |

## 5. Message catalogue: refusal code → what the buyer now reads

One file decides the words: `client/src/utils/messageCatalogue.js`. `client/src/utils/api.js` passes every refusal through it, so a page shows `err.message` and gets the same sentence the rest of the site would. The rules it follows: what happened; why, in half a sentence, when that helps trust; what to do next; a person to reach when the automated path is closed. Its test (`messageCatalogue.test.js`) fails if any entry says bot, robot, token, CSRF, rate limit, payload or invalid, blames the buyer, or closes a path without giving the phone number or the email address.

Three things to know when reading the table:

- The same code is worded for the place it happened ("Where").
- Where the server's own sentence names a count, a size or a date (a model's triangle count, a password rule, an expiry date), that sentence is shown, and the entry in the table is the fallback.
- A refusal with no code keeps the server's sentence if it was written for a buyer ("Add the full ship-to address"). If it was written for a developer ("Authentication required", "Invalid or expired token", "Access denied", "Quote not found", "Failed to create checkout session", "Payment processing is not configured", "Too many requests, please try again later.", "Upload limit reached.", "Registration failed", "Login failed", "Internal server error", "Send this request as JSON.", "The request body isn't valid JSON."), the buyer gets the plain sentence for that status at the foot of the table. Thirteen such sentences could reach a buyer before; with "We couldn't confirm you're not a robot", "The check that keeps robots out…" and "sent faster than a person fills in a form", that is sixteen messages replaced.

**Codes that are on their way.** The order-lifecycle fixes add refusal codes this branch's server does not send yet. They are in the catalogue already, worded from that branch's report, so the words are ready when the branches meet: `payment-session-busy`, `order-not-payable`, `payments-unavailable`, `card-unavailable`, `method-required`, `address-required`, `quote-changed`, `quote-not-payable`, `quote-accepted`, `po-number-required`, `po-number-invalid`, `return-link-invalid`, `confirm-failed`, `order-not-found`, and the four that name a field (`field-single-line`, `field-too-long`, `field-invalid`, `field-required`: the sentence starts with the buyer's name for the field, "The purchase order number has to be one line…", and with "One of the fields" for a field name the client does not know). `quote-changed` says nothing was accepted or charged and gives the new price when the server sends it. Three more are guesses at names from the other two fix branches (`quote-too-large`, `part-reupload-required`, `config-invalid`).

**A code the client has never heard of** shows the server's sentence when it is a buyer's sentence, and otherwise the plain sentence for its status at the foot of the table. There is one for every status the API uses (400, 401, 403, 404, 408, 409, 410, 413, 415, 422, 429, 500, 502, 503, 504, and no answer at all), and a test holds each to the same rules as the catalogue.

**Order states.** The last table is what the order page says for an order that is under review, refunded, partly refunded, disputed, expired or cancelled (`describeOrderState` in `client/src/utils/messages.js`). The order-lifecycle branch words the same states inline in `OrderTrackingPage.jsx`; whoever merges should pick one. Two differences are for the owner (section 10, item 15).

Regenerate these tables at any time: `node scripts/qa/message-catalogue.mjs`.

| Code | Where | What the buyer reads | Offered with it |
|---|---|---|---|
| `invalid-credentials` | everywhere | That email and password didn't match. Check both and try again, or use "Forgot your password?" to choose a new one. | button: Choose a new password |
| `invalid-credentials` | two-step setup (admin) | That password didn't match. Enter the password you sign in with. |  |
| `account-locked` | everywhere | Sign-in for this address is paused for 14 minutes, because the wrong password was entered several times in a row. The pause is there to stop anyone guessing their way in, and nobody got in. Choose a new password to sign in now, or wait and try again. | button: Choose a new password |
| `two-factor-required` | everywhere | Enter the 6-digit code from your authenticator app. |  |
| `two-factor-invalid` | everywhere | That code didn't match. Codes change every 30 seconds: enter the one the app shows now. |  |
| `two-factor-invalid` | sign-in with a recovery code | That recovery code didn't match, or it has been used already. Each one works once: try the next on your list. |  |
| `weak-password` | everywhere | *(the server's own sentence when it names a number, size or date; otherwise:)* That password is too easy to guess. Use at least 10 characters with an upper-case letter, a lower-case letter and a number. |  |
| `account-exists` | everywhere | There is already an account for that address. Sign in, or choose a new password if you have forgotten it. | link: Sign in |
| `link-invalid` | everywhere | This link has been used, has been replaced by a newer one, or has run out. Ask for a new one. |  |
| `link-invalid` | firm-quote link | This quote link doesn't open a quote. Use the link in the latest email from us, or call 224-213-6727 or email quotes@straightedgemfg.com. |  |
| `link-expired` | everywhere | This link has run out. Ask for a new one. |  |
| `link-superseded` | everywhere | We have sent you a newer quote since this one. Use the link in the latest email from us. |  |
| `email-unverified` | everywhere | Confirm your email address before you pay. We sent the link when you created the account; you can send it again from this page. |  |
| `auth-required` | everywhere | Sign in to carry on. Your quote is saved. | link: Sign in |
| `session-ended` | everywhere | You have been signed out. Sessions end on their own after a while, and at once when the password changes. Sign in again and you come straight back here; your quote is saved. | link: Sign in |
| `csrf` | everywhere | This page is out of date, most likely because you signed in or out in another tab. Nothing was sent. Reload the page and try again. |  |
| `two-factor-enrolment-required` | everywhere | Set up two-step sign-in first. The admin pages stay closed until it is on. |  |
| `already-enabled` | everywhere | Two-step sign-in is already on for this account. |  |
| `not-enabled` | everywhere | Two-step sign-in is not on for this account. |  |
| `setup-missing` | everywhere | That setup has run out. Start it again and scan the new code. | button: try again |
| `human-check-required` | everywhere | The spam check didn't pass, so nothing was sent. It runs again just above the button; when it says "Check passed", send it again. If it keeps failing, call 224-213-6727 or email quotes@straightedgemfg.com and we'll take it from there. | button: try again |
| `human-check-required` | sign-in | The spam check didn't pass, so we didn't try the password. It runs again below; when it says "Check passed", press Sign in again. | button: try again |
| `human-check-required` | quote tool: upload | The spam check didn't pass, so the file wasn't read. Try the upload again, or email the file to quotes@straightedgemfg.com and we'll price it. | button: try again |
| `human-check-unavailable` | everywhere | The spam check isn't answering right now. That is a fault on our side, not something you did. Try again in a minute, or call 224-213-6727 or email quotes@straightedgemfg.com and we'll take it from there. | button: try again |
| `form-expired` | everywhere | This page was open for a long time and the form timed out. Nothing was lost: press the button again. | button: try again |
| `form-reused` | everywhere | That was sent twice. If you don't see a reference on the next screen, press the button once more. | button: try again |
| `form-token-missing` | everywhere | The form didn't finish loading, so nothing was sent. Reload the page and send it again, or call 224-213-6727 or email quotes@straightedgemfg.com. |  |
| `too-fast` | everywhere | That went out before the form was ready. Wait a few seconds and press the button again; what you typed is still here. | button: try again |
| `content-mismatch` | everywhere | *(the server's own sentence when it names a number, size or date; otherwise:)* That file is not the type its name says it is. Export it again from your CAD program and upload it. |  |
| `content-mismatch` | request forms | That attachment is not the type its name says it is. Attach a PDF, DXF, DWG, JPG or PNG, or send the request without it and email the file to quotes@straightedgemfg.com. |  |
| `file-too-large` | everywhere | That file is over 50 MB, the most the instant quote reads. Export it at a coarser resolution, or send it to us and a person prices it within 24 hours. | button: Request a firm quote |
| `too-many-files` | everywhere | That is more files than one upload takes. Add up to 10 at a time; the rest can follow. |  |
| `request-too-large` | everywhere | That upload is too large to take in one go. Add the files a few at a time. |  |
| `daily-upload-limit` | everywhere | You have reached today's upload limit from this network. The limit keeps one sender from filling our disk. Email your files to quotes@straightedgemfg.com or call 224-213-6727 and a person quotes them. | button: Request a firm quote |
| `model-too-large` | everywhere | *(the server's own sentence when it names a number, size or date; otherwise:)* This model is more detailed than the instant quote reads. Export it at a coarser resolution and upload it again, or send it to us and a person prices it within 24 hours. | button: Request a firm quote |
| `parse-timeout` | everywhere | *(the server's own sentence when it names a number, size or date; otherwise:)* This model took longer to read than the instant quote allows. Simplify it or export it at a coarser resolution, or send it to us and a person prices it within 24 hours. | button: Request a firm quote |
| `file-damaged` | everywhere | *(the server's own sentence when it names a number, size or date; otherwise:)* This file is damaged or incomplete. Export it again from your CAD program and upload it. |  |
| `busy` | everywhere | We are reading a lot of files right now and could not take this one yet. Nothing is wrong with your file: give it a minute and try again. | button: try again |
| `storage-full` | everywhere | We can't take new files right now. That is a fault on our side. Email them to quotes@straightedgemfg.com or call 224-213-6727 and a person quotes them. |  |
| `store-failed` | everywhere | We read this file but couldn't keep it. Try again in a minute, or email it to quotes@straightedgemfg.com. | button: try again |
| `dxf-routing-only` | everywhere | *(the server's own sentence when it names a number, size or date; otherwise:)* A DXF is a flat outline with no thickness, so we cut it from sheet on the router. Switch to CNC routing to price it, or upload a STEP of the part. |  |
| `dxf-units-required` | everywhere | *(the server's own sentence when it names a number, size or date; otherwise:)* Choose whether this drawing is in inches or millimetres, and the price follows. |  |
| `dxf-thickness-required` | everywhere | *(the server's own sentence when it names a number, size or date; otherwise:)* Select a stock thickness: a DXF has no thickness of its own. |  |
| `part-locked` | everywhere | This part is already on an order or a quote request, so its units can no longer be changed. Upload the file again to start a new quote. |  |
| `part-data-unavailable` | everywhere | *(the server's own sentence when it names a number, size or date; otherwise:)* We can no longer read what we measured from this file. Upload it again and it is priced as before. |  |
| `finish-lead-time` | everywhere | Anodize and powder coat go out to a finisher, so a part with either one ships on the Standard lead time. Choose Standard, or a finish done here. |  |
| `too-many-lines` | everywhere | *(the server's own sentence when it names a number, size or date; otherwise:)* An instant quote holds up to 100 lines. For a larger job, send us the files and a person prices it within 24 hours. | button: Request a firm quote |
| `quote-expired` | everywhere | The hold on this price has run out. Reopen the quote for today's price; your parts are still there. | button: Reopen the quote |
| `quote-expired` | firm-quote link | *(the server's own sentence when it names a number, size or date; otherwise:)* This quote has passed its date. Reply to the quote email or call 224-213-6727 and we'll refresh it. |  |
| `rfq-required` | everywhere | This one needs a person to look at it before it can be ordered. Ask for a firm quote and we reply within 24 hours. | button: Request a firm quote |
| `lead-time-unavailable` | everywhere | The lead time on this quote is no longer offered. Reopen the quote and pick a lead time to see today's price. | button: Reopen the quote |
| `quote-inconsistent` | everywhere | The total on this quote no longer adds up, so we won't charge it. Reopen the quote for today's price. | button: Reopen the quote |
| `parts-unavailable` | everywhere | We no longer hold the part files for this order. Upload them again for a new quote. |  |
| `reorder-failed` | everywhere | *(the server's own sentence when it names a number, size or date; otherwise:)* This order can't be re-quoted as it was. Start a new quote with the same files, or call 224-213-6727 or email quotes@straightedgemfg.com. |  |
| `already-accepted` | everywhere | This quote has already been accepted, so there is nothing more to do here. Questions about the order: 224-213-6727. |  |
| `not-open` | everywhere | This quote is no longer open. Call 224-213-6727 or email quotes@straightedgemfg.com and we'll sort it out. |  |
| `payment-session-busy` | everywhere | The card page that was opened for this order earlier is still closing, so we couldn't open a new one yet. Nothing was charged. Give it a minute and press the button again, or call 224-213-6727. | button: try again |
| `order-not-payable` | everywhere | This order can no longer be paid for from this page: it has been paid, cancelled or closed since the page was opened. Reload the page to see where it stands, or call 224-213-6727. |  |
| `payments-unavailable` | everywhere | Card payment isn't available right now. That is a fault on our side, and nothing was charged. Try again in a few minutes, or call 224-213-6727 and we'll take the order by phone. | button: try again |
| `card-unavailable` | everywhere | We couldn't open the card page. That is a fault on our side, and nothing was charged. Try again in a few minutes, or call 224-213-6727 and we'll take the order by phone. | button: try again |
| `method-required` | everywhere | Choose how you want to pay, by card or on a purchase order, then accept. |  |
| `address-required` | everywhere | Add the full ship-to address: name, street, city, state and ZIP. |  |
| `quote-changed` | everywhere | This quote has changed since this page was opened, so nothing was accepted and nothing was charged. Check the price and the details below, and accept again if they are right. Questions: 224-213-6727. |  |
| `quote-not-payable` | everywhere | This quote has no price on it yet, so it can't be accepted. Call 224-213-6727 or email quotes@straightedgemfg.com and we'll put it right. |  |
| `quote-accepted` | everywhere | This quote has been accepted, so its price and terms can no longer be changed. Send a new quote instead. |  |
| `po-number-required` | everywhere | Enter your purchase order number, so we can match the order to it. |  |
| `po-number-invalid` | everywhere | That purchase order number can't be used as typed. Use one line of letters, numbers and ordinary punctuation, 60 characters at most. |  |
| `return-link-invalid` | everywhere | This page opens from the card page when a payment finishes, and the link that brought you here is incomplete or has run out. Your payment is not affected. Open the link in your quote email to see where the order stands, or call 224-213-6727. |  |
| `confirm-failed` | everywhere | We couldn't confirm the payment with the card processor just now. That says nothing about the payment itself. Refresh in a minute; if it still isn't confirmed, call 224-213-6727. | button: try again |
| `order-not-found` | everywhere | We couldn't find that order on this account. If the link came from an email, sign in with the address the email went to, or call 224-213-6727. |  |
| `transition-not-allowed` | everywhere | *(the server's own sentence when it names a number, size or date; otherwise:)* An order can't make that change from where it is now. |  |
| `reason-required` | everywhere | *(the server's own sentence when it names a number, size or date; otherwise:)* Type a short reason (three characters or more): it goes in the order's history. |  |
| `status-unknown` | everywhere | *(the server's own sentence when it names a number, size or date; otherwise:)* That is not one of the states an order can be in. |  |
| `field-single-line` | everywhere | The ship-to name has to be one line. Take out the line break (pasting from a document often brings one along) and send it again. |  |
| `field-too-long` | everywhere | The ship-to name is longer than we can take. Shorten it and send it again. |  |
| `field-invalid` | everywhere | The ship-to name can't be used as typed. Check it and send it again. |  |
| `field-required` | everywhere | The ship-to name is needed. Fill it in and send it again. |  |
| `quote-too-large` | everywhere | *(the server's own sentence when it names a number, size or date; otherwise:)* This quote is larger than the instant quote handles. Send us the files and a person prices it within 24 hours. | button: Request a firm quote |
| `part-reupload-required` | everywhere | *(the server's own sentence when it names a number, size or date; otherwise:)* We no longer hold what we measured from this file, so it can't be priced as it stands. Upload the file again and it is priced as before. |  |
| `config-invalid` | everywhere | *(the server's own sentence when it names a number, size or date; otherwise:)* That combination of options can't be priced as chosen. Change the material, finish or quantity, or ask for a firm quote and a person prices it. | button: Request a firm quote |
| `rate-limited` | everywhere | That is more requests than we take from one connection in a short time. Wait a few minutes and try again, or call 224-213-6727 or email quotes@straightedgemfg.com. |  |
| `rate-limited` | sign-in | Too many sign-in attempts have come from this connection, so sign-in from it is paused for 15 minutes. On a shared office network that can be someone else's doing. Wait, or call 224-213-6727. |  |
| `rate-limited` | create account | Several accounts have been created from this connection in the last hour, so we have paused new ones. Try again later, or call 224-213-6727 or email quotes@straightedgemfg.com and we'll set you up. |  |
| `rate-limited` | two-step setup (admin) | Too many tries in a short time. Wait 15 minutes, then enter the code the app shows. |  |
| `rate-limited` | send the confirmation link again | *(the server's own sentence when it names a number, size or date; otherwise:)* We sent a link a moment ago, and we send a handful a day at most. Check the spam folder first; if nothing has arrived, call 224-213-6727. |  |
| `rate-limited` | password reset | Several reset links have been asked for from this connection in the last hour, so we have paused them. Try again in an hour, or call 224-213-6727. |  |
| `rate-limited` | request forms | We have had several requests from you in a short time, so this one was not sent. Call 224-213-6727 or email quotes@straightedgemfg.com and we'll take it from there. |  |
| `rate-limited` | quote tool: upload | That is a lot of uploads in a few minutes, so uploads from this connection are paused for a quarter of an hour. Email the files to quotes@straightedgemfg.com if it can't wait. |  |
| `rate-limited` | quote tool: pricing | *(the server's own sentence when it names a number, size or date; otherwise:)* The quote is changing faster than we can price it. Wait a few seconds and it updates. |  |
| `rate-limited` | quote tool: attach a drawing | That is a lot of drawings in an hour. Email this one to quotes@straightedgemfg.com with your quote and we'll attach it. |  |
| `rate-limited` | admin documents | That is a lot of documents in a few minutes. Wait a little and open it again. |  |
| `(no code) HTTP no answer` | everywhere | We couldn't reach our server. Check your connection and try again; what you typed is still here. |  |
| `(no code) HTTP 400` | everywhere | That didn't go through as sent. Check what you entered and try again, or call 224-213-6727 or email quotes@straightedgemfg.com. |  |
| `(no code) HTTP 401` | everywhere | You have been signed out. Sessions end on their own after a while, and at once when the password changes. Sign in again and you come straight back here; your quote is saved. |  |
| `(no code) HTTP 403` | everywhere | This account can't open that. If it is yours, sign in with the account that made it. |  |
| `(no code) HTTP 404` | everywhere | We couldn't find that. It may have been removed, or the link is incomplete. |  |
| `(no code) HTTP 404` | checkout | We couldn't find that quote. It may already be an order, or it belongs to another account. Open your quote again to carry on. |  |
| `(no code) HTTP 404` | quote tool: pricing | We couldn't find that quote. Upload the part again to price it. |  |
| `(no code) HTTP 404` | order page | We couldn't find that order on this account. |  |
| `(no code) HTTP 408` | everywhere | That took too long and we stopped waiting. Nothing was lost: try it again. |  |
| `(no code) HTTP 409` | everywhere | That has changed since this page was opened. Reload the page to see where it stands. |  |
| `(no code) HTTP 410` | everywhere | That is no longer available. Upload the file again to start a new quote. |  |
| `(no code) HTTP 413` | everywhere | That is larger than we can take here. Send a smaller file, or email it to quotes@straightedgemfg.com. |  |
| `(no code) HTTP 415` | everywhere | That didn't go through as sent. Reload the page and try again, or call 224-213-6727 or email quotes@straightedgemfg.com. |  |
| `(no code) HTTP 422` | everywhere | We couldn't use that as it was sent. Check it and try again, or call 224-213-6727 or email quotes@straightedgemfg.com. |  |
| `(no code) HTTP 429` | everywhere | That is more requests than we take from one connection in a short time. Wait a few minutes and try again, or call 224-213-6727 or email quotes@straightedgemfg.com. |  |
| `(no code) HTTP 500` | everywhere | Something went wrong on our side. Try again in a minute, or call 224-213-6727 or email quotes@straightedgemfg.com. |  |
| `(no code) HTTP 500` | checkout | We couldn't start the card payment, and nothing was charged. Try again in a minute, or call 224-213-6727 and we'll take the order by phone. |  |
| `(no code) HTTP 500` | quote tool: upload | We couldn't read that upload, and the fault is on our side. Try again, or email the file to quotes@straightedgemfg.com. |  |
| `(no code) HTTP 502` | everywhere | We couldn't confirm that with the card processor yet. Nothing has gone wrong with your order: refresh in a minute, or call 224-213-6727. |  |
| `(no code) HTTP 503` | everywhere | That part of the site isn't answering right now. Try again in a minute, or call 224-213-6727 or email quotes@straightedgemfg.com. |  |
| `(no code) HTTP 503` | checkout | Card payment isn't available right now. That is a fault on our side. Call 224-213-6727 and we'll take the order by phone. |  |
| `(no code) HTTP 504` | everywhere | That took too long and we stopped waiting. Try again in a minute, or call 224-213-6727 or email quotes@straightedgemfg.com. |  |

| Order state | What the buyer reads on the order page |
|---|---|
| payment under review | We received a payment for this order and are checking it by hand before we confirm the order. You don't need to do anything. We'll write to the address on the order when it is settled. Questions: 224-213-6727. |
| expired | This order was never paid for, so it has closed. Nothing was charged. Your quote is still there: go back to it to order, or call 224-213-6727. |
| refunded | We refunded this order: $120.00 went back to the card it was paid with. A bank can take several days to show a refund. Questions: 224-213-6727. |
| partially refunded | We refunded $120.00 of this order to the card it was paid with. The rest of the order stands. A bank can take several days to show a refund. |
| disputed | The bank behind the card has raised a question about this payment (a dispute). We answer the bank directly, and the order waits until it is settled. If you did not ask your bank about this charge, call 224-213-6727. |
| cancelled | This order was cancelled and will not be made. If that is not what you expected, call 224-213-6727. |

Messages for states the server never sees (worded in `client/src/utils/security.js`, `useFormGuard.jsx` and the pages):

| State | What the buyer reads |
|---|---|
| The spam check's script did not load (content blocker, office firewall) | The spam check didn't load, and we need it before we take anything in: it keeps junk out of the shop's inbox. A content blocker or an office firewall is the usual cause. Allow challenges.cloudflare.com and reload the page, or call 224-213-6727 or email quotes@straightedgemfg.com and we'll take it from there. |
| A form is sent while that check is not loaded | Nothing was sent: the spam check above didn't load, and this form needs it. What you typed is still here. Call 224-213-6727 or email quotes@straightedgemfg.com instead. |
| A form is sent before the check has finished | The spam check just above the button hasn't finished. Give it a moment (or tick its box if it shows one), then press the button again. |
| The check itself reports a problem | The spam check didn't finish. Run it again or, if it keeps stopping, call 224-213-6727 and we'll take it from there. |
| The quote tool's check is closed before it finishes | The upload was stopped because the spam check was closed before it finished. Nothing was read. Add the file again when you are ready. |
| Sign-in asks for the check for the first time | One quick check first, after the earlier wrong passwords. It appears below; when it says "Check passed", press Sign in again. |
| A password that does not meet the four rules (caught before sending) | The password still needs: an upper-case letter. *(lists whichever are missing)* |
| The two password boxes differ (reset) | The two boxes don't hold the same password. Press "Show password" to compare them, then correct one. |
| A drawing or photo dropped on the quote tool | The instant quote reads 3D models, not drawings or photos. Upload a STEP, STL, IGES or 3MF of the part (or a DXF for a flat routed part), or send this file with a firm-quote request and a person prices it. |
| Any other file type dropped on the quote tool | We can't read .xyz files here. Upload a STEP, STL, IGES or 3MF model, or a DXF for a flat routed part. |
| Request form: wrong attachment type / too large | We can't take .docx files on this form, so it was not attached. Attach a PDF, DXF, DWG, JPG or PNG, or send the request without it and email the file to quotes@straightedgemfg.com. / That file is over 25 MB, the most this form takes, so it was not attached. … |
| Request form: no name / no or half an email / no description (part request) | Add your name so we know who to send it to. / Add your email so the quote has somewhere to go. / That email address doesn't look complete. Check it, so the quote has somewhere to go. / Say what the part is and what it does, so we know what is coming. |
| A sent-out finish moves the lead time | Lead time moved from Expedited to Standard, and the ship date with it. Anodize and powder coat go out to a finisher, so a quote with either one ships on Standard. Pick a finish done here to get Expedited back. |
| Signed out (session ended, cookie gone) and sent to sign in | You were signed out. Sessions end on their own after a while, and at once when the password changes. Sign in and you go straight back to where you were; your quote and what you typed are saved. |
| Back from the card page unpaid | You came back from the card page before paying, so nothing was charged. Your parts and ship-to details are as you left them. Pay when you are ready. Something not right on the card page? Call 224-213-6727. |

## 6. For the security engineers: states where the server gives the client no usable code

Nothing here was changed on the server. Where the client could word around it, it did; each item says what it had to assume. A code and a couple of fields per item would let the client stop guessing.

1. **`rate-limited` is one code for at least fourteen different limits**: sign-in per connection, the registration limiter, the two-step limiter, resend per minute and per day, reset per connection, request forms per connection (hour and day) and per address (hour and day), form-token issuing, the quote-tool check, pricing (burst and 15-minute), quote reopening, DXF units, drawings, PDFs, backups. The client words it by endpoint. Inside one endpoint it cannot tell them apart: resend "one a minute" from "five a day" (it shows the server's sentence there), a form refused for the connection from one refused for the address, a pricing burst from the 15-minute cap. None carries `retryAfterSeconds` in the body, so only `account-locked` can say when to try again.
2. **Three limiters answer with no code at all** (`server/index.js`): the general `/api` limit ("Too many requests, please try again later."), the upload limit ("Upload limit reached. Please try again later.") and the request-form limit. The client shows its own sentence for HTTP 429 by endpoint.
3. **Validation refusals carry neither a code nor the field**: "Email and password are required", "Please enter a valid email address" (auth); "Your name is required", "A valid email is required" (request form); "Add the full ship-to address", "Enter your purchase order number", "Choose card or purchase order" (firm quote). The page validates the same things first, so a buyer rarely sees them; when one does arrive the page cannot mark the field.
4. **`weak-password` is one code for six reasons** (missing classes or length, over 72 bytes, one repeated character, on the common list, built from the email address, built from our name). The page checks the first two and the email rule itself and shows the server's sentence for the rest. A `reason` would let the page mark the rule that failed.
5. **The reset-link check answers `{ valid: false }` with no reason.** Used, replaced by a newer link and expired read the same, so the page lists all three. (`/verify-email` does separate `link-expired` from `link-invalid`.)
6. **Uploads.** A file type the tool does not read: 400, no code (now caught in the browser first). A malformed multipart body: 400 "That upload couldn't be read. Try again.", no code. "No files uploaded": 400, no code. An unexpected failure: 500 "Upload failed. Please try again.", no code. A multer error that reaches the app-level handler: 413 "File too large. Maximum size is N MB.", no code.
7. **A truncated binary STL is answered as `content-mismatch`** ("The file's contents do not match its extension"), the same as a PNG renamed `.stl`. The buyer's file is an STL; it was cut short in transit or on export. `file-damaged` exists and is the truthful answer.
8. **Numbers live only inside sentences**: the size limit (`file-too-large`), the file count (`too-many-files`), the daily allowance (`daily-upload-limit`), the request ceiling (`request-too-large`), triangle counts (`model-too-large`), the parse time (`parse-timeout`). The client reads the digits out of the server's sentence to build its own. Fields (`limitMb`, `maxFiles`, `count`, `max`, `seconds`) would be sturdier.
9. **`busy` inside a 200 answer** (one file of several) has no `retryAfterSeconds`; the 503 form of it does.
10. **Checkout**: 503 "Payment processing is not configured", 500 "Failed to create checkout session", 404 "Quote not found", 403 "Access denied", 400 "Invalid order total" and "Quote ID is required" have no code. The client words them by status. `auth-required` and `session-ended` have codes but developer sentences ("Authentication required", "Invalid or expired token"); the client never shows those.
11. **Quote drawing**: "That file isn't a PDF", "The drawing is over N MB", "This quote can no longer be changed" (409), no codes.
12. **Request form**: attachment over 25 MB (413), unreadable attachment (400), unknown quote id (404 "Quote not found") and 500, no codes. On success `noEmailReason` has two known values (`account-unconfirmed`, `daily-limit`); the page treats any other as "no automatic email for this request".
13. **Firm-quote link**: accept and pay refusals at 400, 502 and 503 have sentences written for the buyer but no codes.
14. **DXF units**: 410 "The uploaded file is no longer on our server. Upload it again." and the 400s have no code.
15. **Pricing**: 400 "No parts configured", 404 "Quote not found", 500 "Quote calculation failed. Please try again.", no codes.
16. **Order page**: confirm-payment 502 "Could not confirm the payment yet" and reorder 500 "Could not rebuild the quote", no codes.
17. **Registration's honeypot answer** is a 400 with no code ("We couldn't create the account…"). By design; listed so nobody adds one by accident.

Also for review, client-side and new in this pass: the two storage keys in section 3; and `auth-required` on a request the page sent while it believed it was signed in is now treated like `session-ended` (the page drops its signed-in state and goes to the sign-in form, which says why). No request is retried, and nothing is sent that was not sent before.

## 7. Accessibility (WCAG 2.2 AA)

**Automated.** axe-core 4.14.0, rules tagged WCAG 2 A/AA, 2.1 A/AA and 2.2 AA, run by the walk on every captured screen at all three widths.

| | Before | After |
|---|---|---|
| Captures (screen × width) | 293 | 303 |
| Distinct screens | 101 | 101 |
| Screens with a serious or critical violation | 54 | 1 (the home page, not touched: see section 4) |
| `color-contrast` (serious) | 53 screens | 1 screen (home page step numerals) |
| `label-content-name-mismatch` (serious) | 22 screens | 0 |
| `aria-required-children` (critical) | 9 screens | 0 |
| `select-name` (critical) | 1 screen | 0 |
| `scrollable-region-focusable` (serious) | 1 screen | 0 |
| Moderate or minor violations | 0 | 0 |
| Screens that scroll sideways | 7 at 390 px, 9 at 768 px (all admin) | 0 |

The first after-run left five admin tabs with findings the phone could not reach before (the tabs ran off the screen): blue and amber status text at 3.2:1 and 2.0:1, ghost-grey slugs at 1.5:1, a view switch with the wrong role, a table card that scrolled without being reachable by keyboard. Those were fixed and the admin and upload journeys run again: 99 captures, none with a serious or critical violation.

**Contrast, with numbers.**

| Pair | Ratio | Verdict |
|---|---|---|
| Ink `#101C33` on white / on Bone `#F4F1EA` | 16.99 / 15.06 | Text and focus outline |
| Bone on Ink | 15.06 | Text on dark panels and buttons |
| Brass `#A8834E` on white | 3.49 | Passes 3:1 for a graphic (the mark, a hairline). Fails 4.5:1: never text |
| Brass on Bone | 3.09 | Passes 3:1 by a hair. Never text, never the only sign of anything |
| Brass on Ink | 4.87 | The mark on dark panels |
| Secondary text, was `#64748B`: on white 4.76, on Bone **4.21**, on the selected-row tint **4.20** | | Failed on the two tints |
| Secondary text, now `#5B6779`: on white 5.74, on Bone 5.09, on the tint 5.07 | | Passes |
| Success text, was `#059669` on white **3.77**; now `#047857`: 5.48 on white, 5.21 on its tint | | Passes |
| Error text, was `#DC2626` on its tint **4.41**; now `#B91C1C`: 5.91 on its tint, 6.47 on white | | Passes |
| Amber text, was `#B45309` on Bone **4.45**; now `#9A4A07`: 5.55 on Bone | | Passes |
| Unselected radio ring, was `#94A3B8` on white **2.56**; now `#64748B`: 4.76 | | Passes 3:1 for a control |

**Focus.** One rule for everything that takes the focus: a 2 px Ink outline (16.99:1 on white) with a Brass halo around it. Brass is the accent, Ink is the indicator. On dark panels the outline is Bone. A message that takes the focus (an error summary, a result) shows the same outline. Nothing focused sits under the sticky header or the phone total bar (`scroll-padding`), which is 2.4.11.

**By keyboard alone** (recorded by the walk):

| Screen | Tab stops before → after | First stop after | Stops with no visible focus |
|---|---|---|---|
| Sign in | 7 → 9 (the two added are "Show password" and the phone link) | wordmark, then Email | none |
| Create an account | 8 → 10 | wordmark, then Name | none |
| Forgot password | 4 → 4 | wordmark, then Email | none |
| Firm-quote form | 40 → 40 | "Skip to the content" (was the phone number, with eleven header links before the form) | one: the browser's own calendar button inside the "Need by" date field, before and after. The field's outline shows on its three stops before it |
| Quote tool, empty | 15 → 16 | "Skip to the content" | none |
| Quote tool, priced | 37 → 41 (the preview, its two zoom buttons, and the skip link) | "Skip to the content" | none |

Signing in and uploading a part (Enter on the drop zone opens the file picker) both work by keyboard alone, before and after. The honeypot field is never reached by Tab.

**Checked by hand, with the evidence in the code or the screenshots.**

| Requirement | Where | State |
|---|---|---|
| Every field has a visible label tied to it | all account, checkout and request screens | Yes |
| Errors are tied to their field (`aria-invalid`, `aria-describedby`) | register, reset, request form | Yes. Server-side validation refusals cannot name a field (section 6, item 3) |
| Focus moves to the error summary | sign-in, register, forgot, reset, request form, checkout, two-step setup, upload refusals | Yes (`components/form/Notice.jsx`, `FormError`) |
| Results of something that took time are announced | confirm email, resend, reset sent, request received, upload read or refused, price updating, copy/download/print of recovery codes | `role="status"` or `role="alert"`; the result heading takes the focus where the page changes |
| Password fields: show control with a name; rules before sending | `components/form/PasswordField.jsx` | "Show password" / "Hide password", `aria-pressed`; rules list is the field's description |
| One-time code | sign-in, two-step setup | `inputmode="numeric"`, `autocomplete="one-time-code"`, takes the focus; a recovery code gets the text keyboard with capitals |
| Autofill | sign-in (`username`, `current-password`), register (`name`, `email`, `organization`, `new-password`), reset (`new-password`), checkout (`shipping name`, `address-line1`, `address-level2`, `address-level1`, `postal-code`, `country`), request form (`name`, `email`, `organization`, `tel`) | Yes |
| Every submit has a busy state and cannot be sent twice | all forms | Button disabled and renamed while busy; the handler also returns if a send is in flight; `aria-busy` on the form |
| The spam-check container | `components/security/HumanCheck.jsx` | A labelled group ("Spam check"), a status line in words, and an alert with the next step when it cannot run. In the quote tool it is a dialog that takes the focus, keeps Tab inside, closes on Escape and gives the focus back |
| Target size (2.5.8, 24 px) | phone | Buttons 40 px and up, primary buttons 48, fields 44. The links the walk flagged under 24 px before (wordmark, "Forgot your password?", "Back to sign in", footer phone) are padded to 24. Text links inside a sentence are exempt |
| Reduced motion | site-wide | With "reduce motion" on, nothing animates but the spinner, slowly |
| No sideways scroll at 390, 768, 1360 | every screen | None, at any of the three widths (it was 7 admin screens at 390 px and 9 at 768 px) |
| 16 px fields on a phone | all forms | Yes: iOS no longer zooms the page when a field takes the focus |
| Bypass blocks | every page with the site header | "Skip to the content" is the first Tab stop |

Not checked: a real screen reader (VoiceOver, NVDA, TalkBack) and Cloudflare's own widget. Both need a person and, for the widget, the live keys.

## 8. Documents

**Job traveler** (`server/services/pdfGenerator.js`, payments review finding F-16). The shop cuts from this sheet.

- Two heavy boxes above everything else when they apply: **INSPECTION PAPERWORK ORDERED: FIRST-ARTICLE REPORT + CERTIFICATE OF CONFORMANCE** (with the fee, or "in the quoted price") and **RETURN THE CUSTOMER'S ORIGINAL PART WITH THIS ORDER**. When neither applies the sheet says "not ordered" and "none to return", so a missing box is never read as "not known". Both are also on the checklist and in the order details.
- Every line prints the full description the order was priced on: process · material · grade · stock thickness (mm and inches) · size (mm and inches) and, for a DXF, the drawing units and whether the customer chose them · finish · tolerance · layer height and infill for prints · quantity, with the quantity again in large type.
- A value the order line does not carry prints as **NOT RECORDED — confirm with customer** (for size, "measure from the file") and is counted in a third box, "CHECK BEFORE CUTTING: N VALUES NOT RECORDED ON THIS ORDER". It is never left blank. A routed line with no thickness stops the job on paper.
- It reads what is stored on the order line today: `config.thicknessMm`, `config.grade`, `config.geometrySummary`, `config.input.*`, `config.layerHeightMm`, plus the part's measured geometry when the part row still exists. The engineer on `review-fixes` is making the order snapshot carry thickness, grade, units and dimensions per line; `documents.specOf` is the one function to point at those fields when they land. Until then, a line whose part has been purged prints "size: NOT RECORDED — measure from the file".
- A typed PO number or note prints as one line of text inside its own labelled field ("Customer PO (as typed): …"). A typed line break cannot start a line that reads like one of the document's own. The same one-line rule is applied to the PO and the buyer's notes on the customer documents and to the note on the packing list.
- The payment line says so when an order is on a purchase order and not charged, or when a card payment has not arrived.
- Test: `server/services/pdfGenerator.test.js` renders a routed DXF order with paperwork and the original part to return and asserts each string in the PDF text; a second case renders a line with nothing recorded and asserts the four NOT RECORDED strings and the count.

**Admin order line and on-screen traveler.** The order drawer's line (`OrderDetailDrawer.jsx`) and the on-screen traveler (`JobTravelerPage.jsx`) show the same description by the same rules (`client/src/utils/orderLineCore.js`, tested), with NOT RECORDED in red. The on-screen traveler now carries the two boxes and a "Print the traveler (PDF)" button.

**Where the buyer sees totals.** The quote PDF and the order confirmation PDF already carried "Inspection paperwork" as its own line in the totals, with the paragraph that says what it is; that is confirmed by the regenerated samples and unchanged.

**Samples.** `client/public/brand/documents/sample-*.pdf` and their previews are regenerated from the current generators (`node scripts/preview-documents.js`, run by the brand kit). The sample order now has inspection paperwork on it so the fee line shows, and there is a seventh sample, `sample-job-traveler.pdf`, with both boxes.

**Brand art.** `node scripts/brand/kit.js` reads the services line from `shared/brand.json` ("Machined plastics · CNC milling & routing · 3D printing"). Regenerating changed exactly the art that carried the old line: `social/linkedin-banner-1128x191` and `social/linkedin-personal-banner-1584x396` (SVG and PNG) and the kit sheet. OCR over every rendered PNG in `client/public/brand` finds no "turning". Nothing needed fixing by hand in the repository. By hand, outside it: **if either LinkedIn banner has already been uploaded, upload the new file.**

**Stale screenshots.** `docs/screenshots/revisions-2026-11-11/compare-about.jpg`, `compare-home.jpg` and `compare-quality.jpg` showed copy the owner has since ruled out ("One person", "Send a photo") and are removed. Nothing referred to them.

## 9. Emails

All 13 templates (25 sample renderings) go through one layout (`server/emails/templates.js`). What is sent and when is untouched; subjects are unchanged.

| | Before | After |
|---|---|---|
| Dark mode | `color-scheme: light` only. A dark-mode client inverts what it can and leaves the rest | A dark style block (Ink card, Bone text, Bone button with Ink text); clients that drop `<style>` get the light layout |
| Preview line | The preheader, then whatever followed it: "…ready to check out. Hello, Someone, we hope you," | The preheader, padded so nothing trails after it |
| Text part | Heading, paragraphs, "Confirm my email: https://…" in one line | Heading set off, the action's label on one line and the link alone on the next (a long link survives a text client's wrapping), the reason for the email at the foot |
| One action | Yes | Yes. "Password changed" and the two-step notices have no link, and say that is on purpose |
| Account emails (confirm, reset, changed, paused, two-step) | Said what to do | Also say why the email was sent, that it can be ignored if it was not expected and what happens then, and "We never ask for your password, by email or any other way" |
| Shop notices | The inbox preview line carried the customer's typed name or PO number | Reference, amount, lead time and flags only (typed text stays in the body, as in subjects) |
| Phone | Fixed 32 px side padding; the button its text's width | 20 px padding and a full-width button under 480 px |
| `<style>` | None | One, a constant (`templates.LAYOUT_STYLE`): the phone rules and the dark rules. Everything else stays inline, because many clients drop `<style>` |

Rendered: `docs/screenshots/journey-qa-2026-11-11/emails/<template>-light.jpg`, `-dark-phone.jpg` and `.txt` (subject, preheader, text part). Re-render: `node scripts/qa/render-emails.mjs`.

## 10. For the owner to decide

Wording and tone:

1. **"Spam check."** That is what the site calls the Cloudflare step everywhere. It was already the name on the screen; the alternatives were "security check" (vaguer) and "one quick check" (used as the dialog's title). Say if you want a different word and it changes in one place.
2. **"Pay and place order"** replaces "Pay & Place Order".
3. **Who to call.** Every closed path ends with the phone number, the email address, or both. No message says when the phone is answered or how fast an email is. If you want hours or a reply time on these, say what is true and it goes in the catalogue.
4. **"within 24 hours"** appears in refusals that send the buyer to a firm quote ("a person prices it within 24 hours"). It comes from the confirmed fact `quote-turnaround` and disappears if that fact is unconfirmed.
5. **"A large or very detailed model can take up to a minute"** on the upload progress line. It matches the server's 60-second limit for reading a file. If that limit changes, this line should.
6. **"We never ask for your password, by email or any other way."** New, at the foot of the five account emails. It is a promise about conduct: confirm you are happy to make it.
7. **"call … now and we'll lock the account"** in the password-changed email was already there. There is no lock button in the admin yet; today that means resetting the password yourself.
8. **The traveler's wording**: "NOT RECORDED — confirm with customer", "tolerance: no option ordered (standard for the material unless the drawing or notes say otherwise)", and the text of the two boxes. It is your shop's sheet; change any of it.
9. **The traveler's quality checklist** prints fixed lines per process ("Dimensions within tolerance (+/- 0.005 in)", "Thread gauging passed") that are not tied to the material's tolerance, and has no list for routing. Left as found. Tell us what the checklist should say.
10. **The admin banner** for two-step setup is amber ("something to do") instead of red ("something is wrong"). The security report calls it "the red banner".

Behaviour:

11. **The browser remembers where checkout was** for a week (section 3). It is what makes "Go to checkout" work from the email. The security reviewers should say yes to it.
12. **"Send the link again" waits a minute** after a send. A buyer who sent it to a slow mailbox waits; nobody gets refused.
13. **Anodize and powder coat are offered on plastics** in the quote tool (the finish list is per process, not per material). Seen during the walk, not changed. It is a catalogue decision.
14. **If either LinkedIn banner is already live, replace it** (section 8).
15. **Two time promises in the order-lifecycle branch's order page**: "We'll email you today" when a payment is under review, and "Banks usually show a refund within 5 to 10 business days". The catalogue's versions promise neither ("We'll write to you when it is settled"; "A bank can take several days to show a refund"). Choose which you will stand behind.

## 11. Verification

| Check | Result |
|---|---|
| `npm test` | 43/43 suites, 657 cases, exit 0, on the final source (run again after the last change). An earlier full run on this branch was 42/43: the email injection test refused the layout's new `<style>` element. That is the change described below |
| `NODE_ENV=production npm run build` | 22/22 routes prerendered |
| `node scripts/claims-check.js` | exit 0 |
| `scripts/e2e/hardening-accounts.mjs` (the accounts browser suite, real policy, no bypass) | 96/96, on the final build. Run it with `--shots <a scratch folder>`: without it the suite writes its screenshots over `docs/screenshots/hardening-2026-11-11/` (it did here; they were restored from git, and that folder is unchanged on this branch) |
| `tools/security/csp-browser-check.js` | 66 steps, 66 clean, 0 violations, 0 page errors, policy proof passed, on the final build |
| `scripts/e2e/journey-qa.mjs` with axe-core 4.14.0 | 303 captures over 101 screens at 390, 768 and 1360 px; 0 problems noted; 1 screen with a serious violation (home page, untouched); 0 sideways scroll |
| Street address | Masked in the two part-request screenshots and in every email rendering. Not in `client/dist` |

**Assertions changed in the two existing browser suites, each because the wording or behaviour it pinned was changed on purpose:**

- `hardening-accounts.mjs` and `csp-browser-check.js`: the pay button is found as "Pay and place order" (was "Pay & Place Order").
- `hardening-accounts.mjs`: "a second resend inside a minute is refused politely" pressed the button twice and waited for "We just sent one". The button now counts down, so the check asserts the button is disabled and counting, and asks the server directly for the refusal (429, "We just sent one").

Nothing else in either suite was touched; every other label, button name and message they look for still matches.

**One security test changed, for the security engineers to confirm.** `server/security/crossBranch.test.js` ("…it cannot inject into an email") holds every tag in an email's HTML to a list of the layout's own. The layout now has one `<style>` element, for dark mode and phone widths. The test allows it only as the constant `templates.LAYOUT_STYLE`: exactly one, in the head, byte for byte the same in every message, so nothing typed can be in it. Every other assertion in that test is unchanged and passes. If a `<style>` element in mail is not wanted at all, deleting the constant restores the old layout and costs dark mode and the full-width phone button, nothing else.

**Tests added:** `client/src/utils/messageCatalogue.test.js` (11 cases) and `client/src/utils/orderLineCore.test.js` (4), which take the suite count from 41 to 43; two cases in `returnTo.test.js`; and `server/services/pdfGenerator.test.js` rewritten from one case to five.

**A note on the baseline.** The first full `npm test` on the untouched branch came back 39/41 on this machine while other work was running on it: `botCheck.test.js` (a folder listing raced) and `uploads.test.js` ("slowest health check while parsing: 311 ms"). Both passed when run alone straight afterwards, with no change. They are sensitive to a loaded machine, not to this branch.

**About the screenshots.** A full-page capture draws the site's sticky header wherever the page happened to be scrolled to, so in some of the committed captures (mostly refusal screens, where focus had moved down to the message) the header appears as a band across the content. That is the capture, not the page: in a browser the header stays at the top. The walk script now takes full-page captures from the top; only the two admin enrolment screens (`h04`, `h05`) were captured again with it, because their setup-key layout changed late. The rest were left as they were rather than regenerated.

**Not verified:**

- Cloudflare's real widget (the sandbox cannot reach it), so its look inside the forms on a phone and its own keyboard behaviour.
- Stripe's hosted page and the real return from it; the walk uses the hardening run's stand-in, which returns paid at once. The "back from the card page" state was reached by opening its URL.
- A real screen reader, a real phone, and a real password manager. The attributes they rely on are in place and were checked in the markup.
- Email rendering in real clients (Gmail, Outlook, Apple Mail). The renderings are Chromium with light and dark colour schemes; Outlook on Windows ignores the dark block and shows the light layout.
- The "before" capture named `u02-upload-file-too-large` shows the daily-limit message: on that run the test server's daily allowance was smaller than the file. The wording a buyer got for an oversize file before was the server's, shown as "⚠ Upload: That file is over 50 MB, the most the instant quote reads. Send it to us for a firm quote, or export it at a coarser resolution." The after capture is the real state.
- The order-lifecycle codes and order states in the catalogue (section 5) are worded from that branch's report; they have not been seen on a screen here because the server on this branch does not send them yet.

## 12. Open items

| Item | For | Notes |
|---|---|---|
| Home page step numerals fail contrast | whoever next edits `LandingPage.jsx` | One line. The only serious axe finding left |
| Server states with no usable code | security engineers | Section 6. The catalogue words around each; codes and fields would remove the guessing |
| `<style>` in email, and the two storage keys | security engineers | Sections 11 and 3 |
| Order-lifecycle wording: catalogue or inline | whoever merges that branch | Section 5; owner item 15 |
| Order snapshot fields for the traveler | the engineer on `review-fixes` | `documents.specOf` and `orderLineCore.specFor` are the two functions to point at the new fields |
| The phone total bar reads `quote.orderTotal` | the tax and shipping work | If "Total" comes to mean something else before tax, the bar's label should follow |
| Owner decisions | owner | Section 10, fifteen items |
| Real widget, real card page, real mail clients, a screen reader, a phone | before launch, by a person | Section 11, "Not verified" |
| The sample documents under `client/public/brand/documents` carry the shop's street address | owner | They are documents, and that folder answers 404 in production; they are in the repository, as they were before this pass |

## 13. How to run it again

```sh
npm install && npm test
NODE_ENV=production npm run build && node scripts/claims-check.js
# the walk: starts its own production-mode servers, about 20 minutes a width
NODE_PATH=<dir holding playwright> env -u HTTPS_PROXY -u HTTP_PROXY NO_PROXY=localhost \
  node scripts/e2e/journey-qa.mjs --scratch <dir> --shots docs/screenshots/journey-qa-2026-11-11 \
  [--widths 390,768,1360] [--only a,c,u] [--axe <path to axe.min.js>] [--label after]
node scripts/qa/message-catalogue.mjs            # the table in section 5
node scripts/qa/render-emails.mjs                # the email renderings
(cd scripts/brand && npm install && node kit.js) # brand art and sample documents
```

The walk's letters: `a` first order end to end and what survives the detours, `b` from a material page and the home hero, `c` gated part to a firm-quote request, `d` replacement part with and without the bot check, `e` forgot password, `f` wrong password to pause to unlock, `g` form refusals, `h` admin, `u` upload refusals, `k` keyboard. Its report (`<scratch>/<label>-report.json`) holds every message seen on every screen.

## Appendix A. What the buyer read on each screen, before and after

Screens whose messages changed. Taken from the walk at 390 px; "⏎" separates messages on one screen.

| Screen | Before | After |
|---|---|---|
| a03-quote-first-upload-check | One quick check that you are a person. It usually finishes by itself. ⏎ Reading the geometry… | Checking that a person is sending this. It usually finishes by itself. ⏎ Reading the geometry… |
| a06-quote-sent-out-finish |  | Lead time moved from Expedited to Standard, and the ship date with it. Anodize and powder coat go out to a finisher, so a quote with either one ships on Standard. Pick a finish done here to get Expedited back. OK |
| a08-register | One quick check that you are a person. It usually finishes by itself. | Checking that a person is sending this. It usually finishes by itself. |
| a09-register-password-refused | Check passed. ⏎ Password must contain: one upper-case letter. | Check passed. ⏎ The password still needs: an upper-case letter. |
| a10-checkout-confirm-email | Confirm your email before you pay. We sent a link to dana-390@buyer.test when you created the account. Open it, and this page carries on by itself. Your order confirmation and shipping notice go to that address, so we check it reaches you first. Send the link again I've confirmed it Wrong address, or no email? Call 224-213-6727. | One step before you pay: confirm your email. We sent a link to dana-390@buyer.test when you created the account. Open it on any device and this page carries on by itself; nothing you have entered here is lost. Your order confirmation and shipping notice go to that address, so we make sure it reaches you before any money moves. Send the link again I've confirmed it Wrong address, or no email after a few minutes? Call 224-213-6727 and we'll put it right. |
| a10b-checkout-confirm-email-first-screen | Confirm your email before you pay. We sent a link to dana-390@buyer.test when you created the account. Open it, and this page carries on by itself. Your order confirmation and shipping notice go to that address, so we check it reaches you first. Send the link again I've confirmed it Wrong address, or no email? Call 224-213-6727. | One step before you pay: confirm your email. We sent a link to dana-390@buyer.test when you created the account. Open it on any device and this page carries on by itself; nothing you have entered here is lost. Your order confirmation and shipping notice go to that address, so we make sure it reaches you before any money moves. Send the link again I've confirmed it Wrong address, or no email after a few minutes? Call 224-213-6727 and we'll put it right. |
| a11-checkout-resend-too-soon | Confirm your email before you pay. We sent a link to dana-390@buyer.test when you created the account. Open it, and this page carries on by itself. Your order confirmation and shipping notice go to that address, so we check it reaches you first. Send the link again I've confirmed it Wrong address, or no email? Call 224-213-6727. Sent again to dana-390@buyer.test. Use the newest email; check the spam folder too. | One step before you pay: confirm your email. We sent a link to dana-390@buyer.test when you created the account. Open it on any device and this page carries on by itself; nothing you have entered here is lost. Your order confirmation and shipping notice go to that address, so we make sure it reaches you before any money moves. Send again in 59 s I've confirmed it Wrong address, or no email after a few minutes? Call 224-213-6727 and we'll put it right. Sent again to dana-390@buyer.test. Use the newest email (older links stop working), and check the spam folder too. |
| a19-checkout-session-ended |  | You were signed out. Sessions end on their own after a while, and at once when the password changes. Sign in and you go straight back to where you were; your quote and what you typed are saved. |
| a20-checkout-back-from-card |  | You came back from the card page before paying, so nothing was charged. Your parts and ship-to details are as you left them. Pay when you are ready. Something not right on the card page? Call 224-213-6727. |
| d07-rfq-received-unconfirmed-account | Confirm your email to get our emails about this request. We sent a link to sam-390@buyer.test when you created the account. Open it, and this page carries on by itself. Your order confirmation and shipping notice go to that address, so we check it reaches you first. Send the link again I've confirmed it Wrong address, or no email? Call 224-213-6727. | One step to get our emails about this request: confirm your email. We sent a link to sam-390@buyer.test when you created the account. Open it on any device and this page carries on by itself; nothing you have entered here is lost. Your request is in either way. We only send automatic emails to an address its owner has confirmed. Send the link again I've confirmed it Wrong address, or no email after a few minutes? Call 224-213-6727 and we'll put it right. |
| e03-forgot-password-sent | If reset-390@buyer.test has an account, a link to choose a new password is on its way. It works once and for one hour. Nothing in a few minutes? Check the spam folder, and check the address for a typo. We send at most three links an hour to one address. Still stuck: call 224-213-6727. | If reset-390@buyer.test has an account, a link to choose a new password is on its way. It works once and for one hour. |
| e05-reset-password-mismatch | The two passwords are not the same. Type the new password again. | The two boxes don't hold the same password. Press "Show password" to compare them, then correct one. |
| e08-reset-link-used | This reset link has been used, has been replaced by a newer one, or is more than an hour old. | This reset link has been used, has been replaced by a newer one, or is more than an hour old. Links work once, so nobody who finds an old email can use it. |
| f01-login-wrong-password | That email and password didn't match. | That email and password didn't match. Check both and try again, or use "Forgot your password?" to choose a new one. Choose a new password |
| f02-login-check-appears | Check passed. ⏎ That email and password didn't match. | Check passed. ⏎ That email and password didn't match. Check both and try again, or use "Forgot your password?" to choose a new one. Choose a new password |
| f03-login-wrong-with-check | Check passed. ⏎ That email and password didn't match. | Check passed. ⏎ That email and password didn't match. Check both and try again, or use "Forgot your password?" to choose a new one. Choose a new password |
| f04-login-fifth-wrong | Check passed. ⏎ That email and password didn't match. | Check passed. ⏎ That email and password didn't match. Check both and try again, or use "Forgot your password?" to choose a new one. Choose a new password |
| f05-login-paused | Check passed. ⏎ Too many wrong passwords for this address. Sign-in is paused for 15 minutes. Wait, or reset your password to sign in now. | Check passed. ⏎ Sign-in for this address is paused for 15 minutes, because the wrong password was entered several times in a row. The pause is there to stop anyone guessing their way in, and nobody got in. Choose a new password to sign in now, or wait and try again. The pause ends at about 7:27 PM. Choose a new password |
| f06-login-paused-right-password | Check passed. ⏎ Too many wrong passwords for this address. Sign-in is paused for 15 minutes. Wait, or reset your password to sign in now. | Check passed. ⏎ Sign-in for this address is paused for 15 minutes, because the wrong password was entered several times in a row. The pause is there to stop anyone guessing their way in, and nobody got in. Choose a new password to sign in now, or wait and try again. The pause ends at about 7:27 PM. Choose a new password |
| f07-login-after-unlock-needs-check | Check passed. ⏎ One quick check first, after the earlier wrong passwords. It appears below; when it has passed, press Sign in again. | Check passed. ⏎ One quick check first, after the earlier wrong passwords. It appears below; when it says "Check passed", press Sign in again. |
| g01-rfq-check-blocked | The spam check didn't load. A content blocker or a firewall may be stopping challenges.cloudflare.com. Allow it and reload the page, or call 224-213-6727 or email quotes@straightedgemfg.com and we'll take it from there. Try it again | The spam check didn't load, and we need it before we take anything in: it keeps junk out of the shop's inbox. A content blocker or an office firewall is the usual cause. Allow challenges.cloudflare.com and reload the page, or call 224-213-6727 or email quotes@straightedgemfg.com and we'll take it from there. Try it again |
| g02-rfq-check-blocked-send | The spam check didn't load. A content blocker or a firewall may be stopping challenges.cloudflare.com. Allow it and reload the page, or call 224-213-6727 or email quotes@straightedgemfg.com and we'll take it from there. Try it again ⏎ Nothing was sent: the spam check above didn't load, and this form needs it. Call 224-213-6727 or email quotes@straightedgemfg.com instead. | The spam check didn't load, and we need it before we take anything in: it keeps junk out of the shop's inbox. A content blocker or an office firewall is the usual cause. Allow challenges.cloudflare.com and reload the page, or call 224-213-6727 or email quotes@straightedgemfg.com and we'll take it from there. Try it again ⏎ Nothing was sent: the spam check above didn't load, and this form needs it. What you typed is still here. Call 224-213-6727 or email quotes@straightedgemfg.com instead. |
| g03-register-check-blocked | The spam check didn't load. A content blocker or a firewall may be stopping challenges.cloudflare.com. Allow it and reload the page, or call 224-213-6727 or email quotes@straightedgemfg.com and we'll take it from there. Try it again | The spam check didn't load, and we need it before we take anything in: it keeps junk out of the shop's inbox. A content blocker or an office firewall is the usual cause. Allow challenges.cloudflare.com and reload the page, or call 224-213-6727 or email quotes@straightedgemfg.com and we'll take it from there. Try it again |
| g04-quote-check-blocked | The spam check didn't load. A content blocker or a firewall may be stopping challenges.cloudflare.com. Allow it and reload the page, or call 224-213-6727 or email quotes@straightedgemfg.com and we'll take it from there. Try it again ⏎ Reading the geometry… | The spam check didn't load, and we need it before we take anything in: it keeps junk out of the shop's inbox. A content blocker or an office firewall is the usual cause. Allow challenges.cloudflare.com and reload the page, or call 224-213-6727 or email quotes@straightedgemfg.com and we'll take it from there. Try it again ⏎ Reading the geometry… |
| g05-quote-check-blocked-after-cancel | ⚠ Upload: The spam check didn't load. A content blocker or a firewall may be stopping challenges.cloudflare.com. Allow it and reload the page, or call 224-213-6727 or email quotes@straightedgemfg.com and we'll take it from there. | This file was not priced cube_20mm.stl The spam check didn't load, and we need it before we take anything in: it keeps junk out of the shop's inbox. A content blocker or an office firewall is the usual cause. Allow challenges.cloudflare.com and reload the page, or call 224-213-6727 or email quotes@straightedgemfg.com and we'll take it from there. Dismiss Or call 224-213-6727. |
| g06-rfq-check-failed | One quick check that you are a person. It usually finishes by itself. ⏎ We couldn't confirm you're not a robot. Complete the check and try again. | Check passed. ⏎ The spam check didn't pass, so nothing was sent. It runs again just above the button; when it says "Check passed", send it again. If it keeps failing, call 224-213-6727 or email quotes@straightedgemfg.com and we'll take it from there. |
| g07b-register-check-not-answering | Check passed. ⏎ The check that keeps robots out isn't answering right now. Try again in a minute. Call 224-213-6727 or email quotes@straightedgemfg.com and we'll take it from there. | Checking that a person is sending this. It usually finishes by itself. ⏎ The spam check isn't answering right now. That is a fault on our side, not something you did. Try again in a minute, or call 224-213-6727 or email quotes@straightedgemfg.com and we'll take it from there. |
| g08-quote-check-failed | Check passed. ⏎ We couldn't confirm you're not a robot. Complete the check and try again. ⏎ Reading the geometry… | Check passed. ⏎ The spam check didn't pass, so the file wasn't read. Try the upload again, or email the file to quotes@straightedgemfg.com and we'll price it. Run the check again ⏎ Reading the geometry… |
| g09-rfq-form-expired | One quick check that you are a person. It usually finishes by itself. ⏎ This form was open for a long time. Send it again. | Checking that a person is sending this. It usually finishes by itself. ⏎ This page was open for a long time and the form timed out. Nothing was lost: press the button again. |
| g10-rfq-form-not-loaded | One quick check that you are a person. It usually finishes by itself. ⏎ The form didn't load completely. Reload the page and try again. | Checking that a person is sending this. It usually finishes by itself. ⏎ The form didn't finish loading, so nothing was sent. Reload the page and send it again, or call 224-213-6727 or email quotes@straightedgemfg.com. |
| g11-rfq-sent-too-fast | One quick check that you are a person. It usually finishes by itself. ⏎ That was sent faster than a person fills in a form. Wait a few seconds and send it again. | Check passed. ⏎ That went out before the form was ready. Wait a few seconds and press the button again; what you typed is still here. |
| g12-rfq-too-many | One quick check that you are a person. It usually finishes by itself. ⏎ That email address has sent several requests in a short time. Call 224-213-6727 or email quotes@straightedgemfg.com and we'll take it from there. | Checking that a person is sending this. It usually finishes by itself. ⏎ We have had several requests from you in a short time, so this one was not sent. Call 224-213-6727 or email quotes@straightedgemfg.com and we'll take it from there. |
| g13-rfq-attachment-wrong-type | Check passed. ⏎ That file type (.docx) will not upload. Use a PDF, DXF, DWG, JPG or PNG, or email it to quotes@straightedgemfg.com. | Check passed. ⏎ We can't take .docx files on this form, so it was not attached. Attach a PDF, DXF, DWG, JPG or PNG, or send the request without it and email the file to quotes@straightedgemfg.com. |
| g14-rfq-attachment-not-what-it-says | One quick check that you are a person. It usually finishes by itself. ⏎ That file isn't what its name says it is (PDF). Send a PDF, DXF, DWG, or a photo (JPG, PNG, HEIC). Or send the request without it and email the file to quotes@straightedgemfg.com. | Checking that a person is sending this. It usually finishes by itself. ⏎ That attachment is not the type its name says it is. Attach a PDF, DXF, DWG, JPG or PNG, or send the request without it and email the file to quotes@straightedgemfg.com. |
| g15-register-account-exists | Check passed. ⏎ An account with this email already exists. Sign in, or reset the password if you've forgotten it. | Check passed. ⏎ There is already an account for that address. Sign in, or choose a new password if you have forgotten it. Sign in Choose a new password |
| h01-verify-confirmed-owner | owner@straightedge.test is confirmed. Your account can check out now. | owner@straightedge.test is confirmed. The account is ready. |
| h02-admin-enrolment-required | Set up two-step sign-in to open the admin pages. The admin account can change prices, see every customer's files and download the database, so it takes a password and a code from your phone. Nothing else in the admin area opens until this is done. It takes two minutes. Sign out | Set up two-step sign-in to open the admin pages. The admin account can change prices, see every customer's files and download the database, so signing in to it takes a password and a code from your phone. Nothing else in the admin area opens until this is done. It takes about two minutes, once. Sign out |
| h03-admin-enrolment-wrong-password | Set up two-step sign-in to open the admin pages. The admin account can change prices, see every customer's files and download the database, so it takes a password and a code from your phone. Nothing else in the admin area opens until this is done. It takes two minutes. Sign out ⏎ Enter your current password to set this up. | Set up two-step sign-in to open the admin pages. The admin account can change prices, see every customer's files and download the database, so signing in to it takes a password and a code from your phone. Nothing else in the admin area opens until this is done. It takes about two minutes, once. Sign out ⏎ That password didn't match. Enter the password you sign in with. |
| h04-admin-enrolment-qr | Set up two-step sign-in to open the admin pages. The admin account can change prices, see every customer's files and download the database, so it takes a password and a code from your phone. Nothing else in the admin area opens until this is done. It takes two minutes. Sign out | Set up two-step sign-in to open the admin pages. The admin account can change prices, see every customer's files and download the database, so signing in to it takes a password and a code from your phone. Nothing else in the admin area opens until this is done. It takes about two minutes, once. Sign out ⏎ Shown once. The spaces are only there to make it easier to read. |
| h05-admin-enrolment-wrong-code | Set up two-step sign-in to open the admin pages. The admin account can change prices, see every customer's files and download the database, so it takes a password and a code from your phone. Nothing else in the admin area opens until this is done. It takes two minutes. Sign out ⏎ That code didn't match. Enter the 6-digit code the app shows now. | Set up two-step sign-in to open the admin pages. The admin account can change prices, see every customer's files and download the database, so signing in to it takes a password and a code from your phone. Nothing else in the admin area opens until this is done. It takes about two minutes, once. Sign out ⏎ Shown once. The spaces are only there to make it easier to read. ⏎ That code didn't match. Codes change every 30 seconds: enter the one the app shows now. |
| h09-login-code-wrong | That code didn't match. Codes change every 30 seconds; enter the current one. | That code didn't match. Codes change every 30 seconds: enter the one the app shows now. |
| u01-upload-too-many-files | ⚠ Upload: Upload up to 2 part files at a time. | 3 files were not priced 3 files That is more files than one upload takes. Add up to 2 at a time; the rest can follow. Dismiss Or call 224-213-6727. |
| u02-upload-file-too-large | ⚠ Upload: You've reached today's upload limit from this network (1 MB in 24 hours). Email your files to quotes@straightedgemfg.com or call 224-213-6727 and we'll quote them by hand. | This file was not priced big-scan.stl That file is over 1 MB, the most the instant quote reads. Export it at a coarser resolution, or send it to us and a person prices it within 24 hours. Request a firm quote Dismiss Or call 224-213-6727. |
| u03-upload-model-too-dense | ⚠ dense-scan.stl: This model has 4,000 triangles, more than the instant quote reads (1,000). Export it at a coarser resolution and upload again, or send it to us for a firm quote. | This file was not priced dense-scan.stl This model has 4,000 triangles, more than the instant quote reads (1,000). Export it at a coarser resolution and upload again, or send it to us for a firm quote. Request a firm quote Dismiss Or call 224-213-6727. |
| u03b-upload-dense-again | ⚠ dense-a.stl: This model has 12,000 triangles, more than the instant quote reads (1,000). Export it at a coarser resolution and upload again, or send it to us for a firm quote. | This file was not priced dense-a.stl This model has 18,000 triangles, more than the instant quote reads (1,000). Export it at a coarser resolution and upload again, or send it to us for a firm quote. Request a firm quote Dismiss Or call 224-213-6727. |
| u04-upload-daily-limit | ⚠ Upload: You've reached today's upload limit from this network (1 MB in 24 hours). Email your files to quotes@straightedgemfg.com or call 224-213-6727 and we'll quote them by hand. | This file was not priced dense-d.stl You have reached today's upload limit from this network (3 MB in 24 hours). The limit keeps one sender from filling our disk. Email your files to quotes@straightedgemfg.com or call 224-213-6727 and a person quotes them. Request a firm quote Dismiss Or call 224-213-6727. |
| u05-upload-wrong-type | ⚠ Upload: We can't read pdf files here. Upload a STEP, STL, IGES or 3MF model, or a DXF for a flat routed part. | This file was not priced part.pdf The instant quote reads 3D models, not drawings or photos. Upload a STEP, STL, IGES or 3MF of the part (or a DXF for a flat routed part), or send this file with a firm-quote request and a person prices it. Request a firm quote Dismiss Or call 224-213-6727. |
| u06-upload-content-mismatch | ⚠ photo.stl: The file's contents do not match its extension. Re-export it from your CAD program and upload again. | This file was not priced photo.stl The file's contents do not match its extension. Re-export it from your CAD program and upload again. Dismiss Or call 224-213-6727. |
| u07-upload-damaged | ⚠ cut-short.stl: The file's contents do not match its extension. Re-export it from your CAD program and upload again. | This file was not priced cut-short.stl The file's contents do not match its extension. Re-export it from your CAD program and upload again. Dismiss Or call 224-213-6727. |
| u08-upload-one-good-one-bad | ⚠ cut-short.stl: The file's contents do not match its extension. Re-export it from your CAD program and upload again. | This file was not priced. The parts already in your quote are untouched. cut-short.stl The file's contents do not match its extension. Re-export it from your CAD program and upload again. Dismiss Or call 224-213-6727. |
| u10-upload-server-busy | ⚠ Upload: We're reading a lot of files right now. Give it a minute and upload this one again. | This file was not priced cube_20mm.stl We are reading a lot of files right now and could not take this one yet. Nothing is wrong with your file: give it a minute and try again. Try again Dismiss Or call 224-213-6727. |
| u11-upload-parse-timed-out | ⚠ plate_400_holes.step: This model took more than 4 seconds to read, which is longer than the instant quote allows. Simplify it or export it at a coarser resolution, or send it to us for a firm quote. | This file was not priced plate_400_holes.step This model took more than 4 seconds to read, which is longer than the instant quote allows. Simplify it or export it at a coarser resolution, or send it to us for a firm quote. Request a firm quote Dismiss Or call 224-213-6727. |
| u12-upload-storage-full | ⚠ Upload: We can't take new files right now. Email them to quotes@straightedgemfg.com or call 224-213-6727 and we'll quote them by hand. | This file was not priced huge.stl We can't take new files right now. That is a fault on our side. Email them to quotes@straightedgemfg.com or call 224-213-6727 and a person quotes them. Dismiss Or call 224-213-6727. |

## Appendix B. What the walk checked on the way

| What was checked | Before | After |
|---|---|---|
| material page → quote: material preselected | true | true |
| home hero → quote: the earlier quote is reopened | true | true |
| rfq: where focus is after a refused send | "button" | "div#rfq-error" |
| pause email carries a reset link | false | — |
| u01-upload-too-many-files: a way to a person is on the screen | false | true |
| u02-upload-file-too-large: a way to a person is on the screen | true | true |
| u03-upload-model-too-dense: a way to a person is on the screen | true | true |
| u03b-upload-dense-again: a way to a person is on the screen | true | true |
| u05-upload-wrong-type: a way to a person is on the screen | false | true |
| u06-upload-content-mismatch: a way to a person is on the screen | false | true |
| u07-upload-damaged: a way to a person is on the screen | false | true |
| u08-upload-one-good-one-bad: a way to a person is on the screen | false | true |
| u12-upload-storage-full: a way to a person is on the screen | true | true |
| keyboard only: sign in | true | true |
| keyboard only: Enter on the drop zone opens the file picker | true | true |
| register: typed name/email kept after a refusal | true | true |
| quote survives registration | true | true |
| after confirming: a way back to the quote/checkout is offered | false | true |
| checkout: address typed before confirming is still there | true | true |
| order confirmation email sent | true | true |
| confirming on another device releases the first device's checkout | true | true |
| session ended at checkout: where the buyer is | "/checkout/:id" | "/login?next=%2Fcheckout%2F:id" |
| session ended at checkout: quote id still in this tab | true | true |
| back from the card page: address still filled in | false | true |
| quote survives a reload of /quote | true | true |
| reset: signing in with the new password lands on | "/quote" | "/quote" |
| paused: email typed is kept | true | true |
| pause email: where its button leads | "/forgot-password" | "/forgot-password" |
| unlock by reset: signed in | true | true |
| recovery codes screen: actions offered | ["Copy","Download as a text file","I have saved them"] | ["Copy","Download as a text file","Print","I have saved them"] |
| one-time code field | {"inputmode":"numeric","autocomplete":"one-time-code","focused":true} | {"inputmode":"numeric","autocomplete":"one-time-code","focused":true} |
| wrong code: password field still filled | true | true |
| sign in with a code | true | true |
| sign in with a recovery code | true | true |
| check blocked: what was typed is kept | true | true |
| check fail: what was typed is kept | true | true |
| check not answering: what was typed is kept | true | true |
| the same request sent twice | {"a":201,"b":201,"same":true,"replayed":true} | {"a":201,"b":201,"same":true,"replayed":true} |
| requests from one address in an hour | [201,201,201,201,201,429] | [201,201,201,201,201,429] |
| session ended at checkout: after signing in again | — | "/checkout/:id" |
