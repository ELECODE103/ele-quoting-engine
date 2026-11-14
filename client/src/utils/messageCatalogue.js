/**
 * What a buyer reads when the server refuses something.
 *
 * The server answers a refusal with an HTTP status, usually a `code`
 * ("form-expired", "quote-changed", …) and a sentence of its own. This file
 * is the one place that decides the words on the screen for each code, so the
 * whole site says the same thing the same way:
 *
 *   what happened · why, in half a sentence, when that helps trust ·
 *   what to do next · and a person to reach when the automated path is closed.
 *
 * Nothing here changes what the server does. It only chooses wording, per code
 * and per place (`context`: the kind of request that was refused). A code that
 * is not listed keeps the server's sentence, unless that sentence is written
 * for a developer ("Authentication required", "Invalid or expired token"), in
 * which case the buyer gets the plain fallback for that status.
 *
 * No imports: `createCatalogue(brand, facts)` is given the brand facts, so the
 * same file runs in the browser, in `node` for its test, and in the script
 * that prints the catalogue for the owner (scripts/qa/message-catalogue.mjs).
 * The instance the app uses is utils/messages.js.
 *
 * Each entry: { text, keep?, action? }
 *   text    string, or (info) => string. `info` = { data, serverMessage, minutes, number(n) }.
 *   keep    true: the server's sentence is specific (it names a count, a date
 *           or a size) and already reads well; show it, and use `text` only if
 *           the server sent none.
 *   action  what the page may offer next to the message:
 *           'rfq' (firm-quote form) · 'retry' · 'reset' (password reset) ·
 *           'sign-in' · 'reload' · 'reopen-quote' · 'open-order' (the order
 *           this quote already became)
 */
export function createCatalogue(brand, { quoteTurnaround = '' } = {}) {
  const PHONE = brand.phone;
  const EMAIL = brand.email;
  const REACH = `call ${PHONE} or email ${EMAIL}`;
  const REACH_CAP = `Call ${PHONE} or email ${EMAIL}`;
  const within = quoteTurnaround ? ` within ${quoteTurnaround}` : '';
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const dollars = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  // The name a buyer knows a field by, for refusals that say which field (`data.field`).
  const FIELD_NAMES = {
    name: 'Your name', contactName: 'Your name', customerName: 'Your name', company: 'The company name', phone: 'The phone number', email: 'The email address',
    shippingName: 'The ship-to name', shippingCompany: 'The ship-to company', shippingAddress: 'The street address', shippingCity: 'The city', shippingState: 'The state', shippingZip: 'The ZIP code', shippingCountry: 'The country',
    poNumber: 'The purchase order number', notes: 'The notes', customerNotes: 'The notes', quantities: 'The quantities', tolerance: 'The tolerance', finishNotes: 'The finish notes', dueDate: 'The date', quoteNote: 'The note on the quote', reason: 'The reason', note: 'The note',
  };
  const fieldName = (data) => FIELD_NAMES[data && data.field] || 'One of the fields';

  // ─── By code ────────────────────────────────────────────────
  // '*' is the wording wherever the code turns up; a context key overrides it.
  const BY_CODE = {
    // Accounts
    'invalid-credentials': {
      '*': { text: 'That email and password didn\'t match. Check both and try again, or use "Forgot your password?" to choose a new one.', action: 'reset' },
      'two-factor': { text: 'That password didn\'t match. Enter the password you sign in with.' },
    },
    // Sign-in brakes (the sign-in throttle of 2026-11-11; the old per-address lock, `account-locked`, is gone:
    // nothing an outsider does to an address locks its owner out any more).
    'try-later': {
      '*': {
        text: ({ minutes }) => `Sign-in from this connection is paused for ${minutes ? plural(minutes, 'minute') : 'a few minutes'}, because the wrong password was entered several times in a row. The pause is there to stop anyone guessing their way in, and nobody got in. Choose a new password to sign in now, or wait and try again.`,
        action: 'reset',
      },
    },
    'account-busy': {
      '*': {
        text: `There have been a lot of wrong passwords for this address, so for now we only sign it in from a browser it has used before. Nobody got in. Sign in from a browser you have used before, or choose a new password to sign in from this one. Stuck? Call ${PHONE}.`,
        action: 'reset',
      },
    },
    'two-factor-paused': {
      '*': { text: ({ minutes }) => `Too many wrong codes were entered, so codes are paused for ${minutes ? plural(minutes, 'minute') : 'a few minutes'}. Nobody got in. Wait, then enter the code your authenticator app shows at that moment.` },
    },
    // The one-time admin setup answers every refusal that is not about the new password with the same sentence, on purpose.
    'setup-refused': { '*': { text: 'That didn\'t work. Check the setup code and try again. If the admin account has already been set up, sign in instead.', action: 'sign-in' } },
    'two-factor-required': { '*': { text: 'Enter the 6-digit code from your authenticator app.' } },
    'two-factor-invalid': {
      '*': { text: 'That code didn\'t match. Codes change every 30 seconds: enter the one the app shows now.' },
      'recovery-code': { text: 'That recovery code didn\'t match, or it has been used already. Each one works once: try the next on your list.' },
    },
    'weak-password': { '*': { text: 'That password is too easy to guess. Use at least 10 characters with an upper-case letter, a lower-case letter and a number.', keep: true } },
    'account-exists': { '*': { text: 'There is already an account for that address. Sign in, or choose a new password if you have forgotten it.', action: 'sign-in' } },
    'link-invalid': {
      '*': { text: 'This link has been used, has been replaced by a newer one, or has run out. Ask for a new one.' },
      'firm-quote': { text: `This quote link doesn't open a quote. Use the link in the latest email from us, or ${REACH}.` },
    },
    'link-expired': { '*': { text: 'This link has run out. Ask for a new one.' } },
    'link-superseded': { '*': { text: 'We have sent you a newer quote since this one. Use the link in the latest email from us.' } },
    'email-unverified': { '*': { text: 'Confirm your email address before you pay. We sent the link when you created the account; you can send it again from this page.' } },
    'auth-required': { '*': { text: 'Sign in to carry on. Your quote is saved.', action: 'sign-in' } },
    'session-ended': { '*': { text: 'You have been signed out. Sessions end on their own after a while, and at once when the password changes. Sign in again and you come straight back here; your quote is saved.', action: 'sign-in' } },
    csrf: { '*': { text: 'This page is out of date, most likely because you signed in or out in another tab. Nothing was sent. Reload the page and try again.', action: 'reload' } },
    'two-factor-enrolment-required': { '*': { text: 'Set up two-step sign-in first. The admin pages stay closed until it is on.' } },
    'already-enabled': { '*': { text: 'Two-step sign-in is already on for this account.' } },
    'not-enabled': { '*': { text: 'Two-step sign-in is not on for this account.' } },
    'setup-missing': { '*': { text: 'That setup has run out. Start it again and scan the new code.', action: 'retry' } },

    // The spam check (Cloudflare Turnstile)
    'human-check-required': {
      '*': { text: `The spam check didn't pass, so nothing was sent. It runs again just above the button; when it says "Check passed", send it again. If it keeps failing, ${REACH} and we'll take it from there.`, action: 'retry' },
      login: { text: 'The spam check didn\'t pass, so we didn\'t try the password. It runs again below; when it says "Check passed", press Sign in again.', action: 'retry' },
      upload: { text: `The spam check didn't pass, so the file wasn't read. Try the upload again, or email the file to ${EMAIL} and we'll price it.`, action: 'retry' },
    },
    'human-check-unavailable': {
      '*': { text: `The spam check isn't answering right now. That is a fault on our side, not something you did. Try again in a minute, or ${REACH} and we'll take it from there.`, action: 'retry' },
    },

    // Forms (request forms, registration, password reset)
    'form-expired': { '*': { text: 'This page was open for a long time and the form timed out. Nothing was lost: press the button again.', action: 'retry' } },
    'form-reused': { '*': { text: 'That was sent twice. If you don\'t see a reference on the next screen, press the button once more.', action: 'retry' } },
    'form-token-missing': { '*': { text: `The form didn't finish loading, so nothing was sent. Reload the page and send it again, or ${REACH}.`, action: 'reload' } },
    'too-fast': { '*': { text: 'That went out before the form was ready. Wait a few seconds and press the button again; what you typed is still here.', action: 'retry' } },
    'content-mismatch': {
      '*': { text: 'That file is not the type its name says it is. Export it again from your CAD program and upload it.', keep: true },
      rfq: { text: `That attachment is not the type its name says it is. Attach a PDF, DXF, DWG, JPG or PNG, or send the request without it and email the file to ${EMAIL}.` },
    },

    // Uploads (quote tool)
    'file-too-large': { '*': { text: ({ number }) => `That file is over ${number('MB') || 50} MB, the most the instant quote reads. Export it at a coarser resolution, or send it to us and a person prices it${within}.`, action: 'rfq' } },
    'too-many-files': { '*': { text: ({ number }) => `That is more files than one upload takes. Add up to ${number('part files') || 10} at a time; the rest can follow.` } },
    'request-too-large': { '*': { text: ({ number }) => `That upload is too large to take in one go${number('MB') ? ` (the limit is ${number('MB')} MB)` : ''}. Add the files a few at a time.` } },
    'daily-upload-limit': { '*': { text: ({ number }) => `You have reached today's upload limit from this network${number('MB') ? ` (${number('MB')} MB in 24 hours)` : ''}. The limit keeps one sender from filling our disk. Email your files to ${EMAIL} or call ${PHONE} and a person quotes them.`, action: 'rfq' } },
    'model-too-large': { '*': { text: `This model is more detailed than the instant quote reads. Export it at a coarser resolution and upload it again, or send it to us and a person prices it${within}.`, keep: true, action: 'rfq' } },
    'parse-timeout': { '*': { text: `This model took longer to read than the instant quote allows. Simplify it or export it at a coarser resolution, or send it to us and a person prices it${within}.`, keep: true, action: 'rfq' } },
    'file-damaged': { '*': { text: 'This file is damaged or incomplete. Export it again from your CAD program and upload it.', keep: true } },
    busy: { '*': { text: 'We are reading a lot of files right now and could not take this one yet. Nothing is wrong with your file: give it a minute and try again.', action: 'retry' } },
    'storage-full': { '*': { text: `We can't take new files right now. That is a fault on our side. Email them to ${EMAIL} or call ${PHONE} and a person quotes them.` } },
    'store-failed': { '*': { text: `We read this file but couldn't keep it. Try again in a minute, or email it to ${EMAIL}.`, action: 'retry' } },
    'dxf-routing-only': { '*': { text: 'A DXF is a flat outline with no thickness, so we cut it from sheet on the router. Switch to CNC routing to price it, or upload a STEP of the part.', keep: true } },
    'dxf-units-required': { '*': { text: 'Choose whether this drawing is in inches or millimetres, and the price follows.', keep: true } },
    'dxf-thickness-required': { '*': { text: 'Select a stock thickness: a DXF has no thickness of its own.', keep: true } },
    'part-locked': { '*': { text: 'This part is already on an order or a quote request, so its units can no longer be changed. Upload the file again to start a new quote.' } },
    'units-rate-limited': { '*': { text: 'That is a lot of unit changes in a short time. Wait a few minutes, then set the units again. The drawing and its quote are as you left them.' } },
    'part-data-unavailable': { '*': { text: 'We can no longer read what we measured from this file. Upload it again and it is priced as before.', keep: true } },

    // Pricing and checkout
    'finish-lead-time': { '*': { text: 'Anodize and powder coat go out to a finisher, so a part with either one ships on the Standard lead time. Choose Standard, or a finish done here.' } },
    'quote-expired': {
      '*': { text: 'The hold on this price has run out. Reopen the quote for today\'s price; your parts are still there.', action: 'reopen-quote' },
      'firm-quote': { text: `This quote has passed its date. Reply to the quote email or call ${PHONE} and we'll refresh it.`, keep: true },
    },
    'rfq-required': { '*': { text: `This one needs a person to look at it before it can be ordered. Ask for a firm quote and we reply${within}.`, action: 'rfq' } },
    'lead-time-unavailable': { '*': { text: 'The lead time on this quote is no longer offered. Reopen the quote and pick a lead time to see today\'s price.', action: 'reopen-quote' } },
    'quote-inconsistent': { '*': { text: 'The total on this quote no longer adds up, so we won\'t charge it. Reopen the quote for today\'s price.', action: 'reopen-quote' } },
    'parts-unavailable': { '*': { text: 'We no longer hold the part files for this order. Upload them again for a new quote.' } },
    // Reorder is for an order that was paid for (or accepted on a PO and started). The order page does not
    // offer the button otherwise; this is for a page left open while the order lapsed, and for other clients.
    'reorder-not-available': {
      '*': {
        text: ({ data }) => (data && data.status === 'pending_payment'
          ? `This order hasn't been paid for yet, so there is nothing to reorder and nothing was changed. Go back to checkout to pay for it. Questions: ${PHONE}.`
          : `This order was never paid for, so there is nothing to reorder and nothing was changed. Start a new quote with the same files, or ${REACH}.`),
      },
    },
    'reorder-failed': { '*': { text: `This order can't be re-quoted as it was. Start a new quote with the same files, or ${REACH}.`, keep: true } },
    'already-accepted': { '*': { text: `This quote has already been accepted, so there is nothing more to do here. Questions about the order: ${PHONE}.` } },
    'not-open': { '*': { text: `This quote is no longer open. ${REACH_CAP} and we'll sort it out.` } },

    // A setting the server will not price as chosen (codes from the price-integrity fixes, 2026-11-11). Each names
    // the selector to change (`data.field`); the quote tool puts that selector back once and says so, and shows
    // these words if the same refusal comes back. Where the server's sentence names the part, the finish or the
    // range, that sentence is the one shown.
    'process-not-offered': { '*': { text: 'That way of making the part isn\'t one we sell online, so it wasn\'t priced. Choose one of the processes on this page, or ask for a firm quote and a person prices it.', action: 'rfq' } },
    'material-not-offered': { '*': { text: 'That material isn\'t on our list any more, so it wasn\'t priced. Pick another material and the price updates, or ask for a firm quote if it has to be that one.', action: 'rfq' } },
    'material-process-mismatch': { '*': { text: 'That material doesn\'t go with the process chosen for this part, so it wasn\'t priced. Pick a material from the list for this process, or change the process.', keep: true } },
    'grade-not-offered': { '*': { text: 'That grade isn\'t one we offer in this material. Pick a grade from the list and the price updates.' } },
    'sub-process-not-offered': { '*': { text: 'That option doesn\'t go with the material chosen, so it wasn\'t priced. Pick the material again and choose from the options shown, or ask for a firm quote and a person prices it.', action: 'rfq' } },
    'thickness-required': { '*': { text: 'Choose a stock thickness for this part. We cut it from sheet, and the price depends on which sheet.', keep: true } },
    'thickness-not-offered': { '*': { text: 'We don\'t stock that thickness in this material. Pick one from the list, or ask for a firm quote if you need a thickness that isn\'t there.', action: 'rfq' } },
    'finish-not-offered': { '*': { text: 'That finish isn\'t offered for this process. Pick a finish from the list and the price updates.' } },
    'finish-not-for-material': { '*': { text: 'That finish isn\'t done on this material. Pick one of the finishes listed for it and the price updates.', keep: true } },
    'layer-height-not-offered': { '*': { text: 'We don\'t print this material at that layer height. Pick one from the list and the price updates.' } },
    'infill-out-of-range': { '*': { text: 'Infill has to be between 5 and 100 percent. Change it and the price updates.' } },
    'quantity-invalid': { '*': { text: 'The quantity has to be a whole number of pieces, 1 or more. Correct it and the price updates.', keep: true } },
    'lead-time-not-offered': { '*': { text: 'That lead time isn\'t offered right now. Choose one of the lead times shown, and the price and the ship date update.' } },
    'part-not-found': { '*': { text: `We couldn't find that part on this quote. It may have been uploaded in another browser, or under another account. Upload the file again and it is priced as before, or ${REACH}.` } },
    'material-unavailable': { '*': { text: `We can't price that material online right now. That is a fault on our side. Pick another material, or ask for a firm quote and a person prices this one. Questions: ${PHONE}.`, action: 'rfq' } },
    'pricing-unavailable': { '*': { text: `We can't price this online right now. That is a fault on our side, and nothing was charged. Try again in a few minutes, or ask for a firm quote and a person prices it. Questions: ${PHONE}.`, keep: true, action: 'rfq' } },
    'price-check-failed': {
      '*': { text: `We couldn't confirm this price automatically, so we haven't shown it. Nothing is wrong with your file. Ask for a firm quote and a person prices it, or call ${PHONE}.`, action: 'rfq' },
      checkout: { text: `We couldn't confirm the price of this order automatically, so we have not charged you. Ask for a firm quote and a person prices it, or call ${PHONE}.`, action: 'rfq' },
    },
    // Checkout: the quote is not what was priced, or has been used.
    'quote-needs-update': { '*': { text: 'Something on this quote is no longer offered the way it was priced, so we have not charged you. Reopen the quote to see today\'s options and price; your parts are still there.', action: 'reopen-quote' } },
    'quote-part-changed': { '*': { text: 'A drawing on this quote was changed after its price was worked out, so nothing was sent. Reopen the quote so it is priced again, then send your request.', action: 'reopen-quote' } },
    'quote-already-ordered': { '*': { text: `This quote has already been ordered, so it can't be paid for a second time. Nothing was charged. Open that order to see where it stands; to order the same parts again, use Reorder on the order page. Questions: ${PHONE}.`, action: 'open-order' } },
    'checkout-rate-limited': { '*': { text: `That is a lot of tries at checkout in a few minutes, so checkout on this account is paused for a short while. Nothing was charged. Wait a few minutes and try again, or call ${PHONE} and we'll take the order by phone.`, action: 'retry' } },
    // Admin saves (the owner's screens): the server's sentence says which case it is.
    'price-required': { '*': { text: 'A material needs a price above zero before it can be saved or switched on. Enter the price and save again.', keep: true } },
    'quoted-total-invalid': { '*': { text: 'The quoted total has to be an amount of money. A quote that is out with the customer can\'t be saved at nothing: enter the amount it should be, or withdraw the quote.', keep: true } },

    // Paying for an order, and the firm-quote link (codes from the order-lifecycle fixes, 2026-11-11)
    'payment-session-busy': {
      '*': { text: `The card page that was opened for this order earlier is still closing, so we couldn't open a new one yet. Nothing was charged. Give it a minute and press the button again, or call ${PHONE}.`, action: 'retry' },
      // Cancelling an unpaid order from "Your orders": the page could not be confirmed closed, so the order was left alone.
      order: { text: `We couldn't confirm that the card page for this order is closed, so the order was left as it is. Nothing was charged. Give it a minute and try again, or call ${PHONE}.`, action: 'retry' },
    },
    // Cancelling an unpaid order, and checking out a changed quote while its earlier order was being paid (review of 2026-11-13, N-01).
    'cancel-not-available': { '*': { text: `This order can't be cancelled from this page: it has been paid or closed already, or it came from a firm quote. Reload the page to see where it stands, or call ${PHONE}.`, keep: true } },
    'cancel-order-paid': { '*': { text: `This order has just been paid, so it was not cancelled. Reload the page to see it. If that is not what you meant, call ${PHONE}.` } },
    'earlier-order-paid': { '*': { text: `Your earlier order for these parts has just been paid, so we did not start a second payment. Open that order to see it. If you want this changed quote as well, come back and check out again. Questions: ${PHONE}.`, action: 'open-order' } },
    // One sender may hold only so many unpaid orders (server/security/orderCaps.js). The server's sentence names the count and how long a payment page stays open.
    'unpaid-orders-limit': { '*': { text: `You already have orders waiting for payment, which is the most we keep open at once. Pay for one of them from Your orders, or cancel one there, then check out again. To place this order by phone, call ${PHONE}.`, keep: true } },
    'unpaid-orders-daily-limit': { '*': { text: `That is more checkouts started and not paid for than we take in one day. Nothing was charged. Pay for an order that is waiting in Your orders, try again tomorrow, or call ${PHONE} and we'll take the order by phone.` } },
    // An order that closed unpaid and whose lines were later cleared to keep the database inside its ceiling (server/services/storagePressure.js). Owner-only.
    'order-lines-cleared': { '*': { text: 'This order closed without payment and its lines have since been cleared, so it cannot be marked paid or moved on. Take the order again: have the customer check out their quote, or enter it as a phone order.', keep: true } },
    'order-not-payable': { '*': { text: `This order can no longer be paid for from this page: it has been paid, cancelled or closed since the page was opened. Reload the page to see where it stands, or call ${PHONE}.`, action: 'reload' } },
    'payments-unavailable': { '*': { text: `Card payment isn't available right now. That is a fault on our side, and nothing was charged. Try again in a few minutes, or call ${PHONE} and we'll take the order by phone.`, action: 'retry' } },
    'card-unavailable': { '*': { text: `We couldn't open the card page. That is a fault on our side, and nothing was charged. Try again in a few minutes, or call ${PHONE} and we'll take the order by phone.`, action: 'retry' } },
    'method-required': { '*': { text: 'Choose how you want to pay, by card or on a purchase order, then accept.' } },
    'address-required': { '*': { text: 'Add the full ship-to address: name, street, city, state and ZIP.' } },
    'quote-changed': {
      '*': {
        // Firm-quote page. Two answers carry this code (server/routes/rfq.js) and in both the page stops showing the quote:
        //   linkReplaced  the owner changed the quote after this link was sent and has not sent it again: the link
        //                 opens nothing until the new email arrives, so the way on is that email or a person
        //   otherwise     the total on the page is no longer the quote's: reloading shows it as it is now
        text: ({ data }) => {
          if (data && data.linkReplaced) return `This quote was changed after this link was sent, so this link no longer opens it. Nothing was accepted and nothing was charged. Use the link in our newest email about this quote, or ${REACH}.`;
          const now = [data && data.quotedTotal, data && data.total, data && data.orderTotal].map(Number).find((n) => Number.isFinite(n) && n > 0);
          return `This quote has changed since this page was opened, so nothing was accepted and nothing was charged.${now ? ` The price is now ${dollars(now)}.` : ''} Reload this page to see the quote as it is now, and accept again if it is right. Questions: ${PHONE}.`;
        },
        action: 'reload',
      },
      // Instant checkout (price-integrity fixes): the quote was priced again before charging and the total moved.
      // When the quote can be re-priced in place the page shows the new total and the same button accepts it;
      // when it can't (`reopen`), the way on is back through the quote.
      checkout: {
        text: ({ data }) => {
          const was = Number(data && data.previousTotal);
          const now = Number(data && data.newTotal);
          const moved = Number.isFinite(was) && was > 0 && Number.isFinite(now) && now > 0 ? ` It was ${dollars(was)} and is now ${dollars(now)}.` : Number.isFinite(now) && now > 0 ? ` It is now ${dollars(now)}.` : '';
          return `The price of this quote has changed since it was last priced, so we have not charged you.${moved} Reopen the quote to check it and carry on at today's price; your parts are still there. Questions: ${PHONE}.`;
        },
        action: 'reopen-quote',
      },
    },
    'quote-not-payable': { '*': { text: `This quote has no price on it yet, so it can't be accepted. ${REACH_CAP} and we'll put it right.` } },
    'quote-accepted': { '*': { text: 'This quote has been accepted, so its price and terms can no longer be changed. Send a new quote instead.' } },
    'po-number-required': { '*': { text: 'Enter your purchase order number, so we can match the order to it.' } },
    'po-number-invalid': { '*': { text: 'That purchase order number can\'t be used as typed. Use one line of letters, numbers and ordinary punctuation, 60 characters at most.' } },
    'return-link-invalid': { '*': { text: `This page opens from the card page when a payment finishes, and the link that brought you here is incomplete or has run out. Your payment is not affected. Open the link in your quote email to see where the order stands, or call ${PHONE}.` } },
    'confirm-failed': { '*': { text: `We couldn't confirm the payment with the card processor just now. That says nothing about the payment itself. Refresh in a minute; if it still isn't confirmed, call ${PHONE}.`, action: 'retry' } },
    'order-not-found': { '*': { text: `We couldn't find that order on this account. If the link came from an email, sign in with the address the email went to, or call ${PHONE}.` } },
    'transition-not-allowed': { '*': { text: 'An order can\'t make that change from where it is now.', keep: true } },
    'reason-required': { '*': { text: 'Type a short reason (three characters or more): it goes in the order\'s history.', keep: true } },
    'status-unknown': { '*': { text: 'That is not one of the states an order can be in.', keep: true } },

    // A field refused by name (`data.field`): one line only, too long, not usable, or missing.
    'field-single-line': { '*': { text: ({ data }) => `${fieldName(data)} has to be one line. Take out the line break (pasting from a document often brings one along) and send it again.` } },
    'field-too-long': { '*': { text: ({ data }) => `${fieldName(data)} is longer than we can take${data && Number(data.max) > 0 ? ` (${Number(data.max)} characters at most)` : ''}. Shorten it and send it again.` } },
    'field-invalid': { '*': { text: ({ data }) => `${fieldName(data)} can't be used as typed. Check it and send it again.` } },
    'field-required': { '*': { text: ({ data }) => `${fieldName(data)} is needed. Fill it in and send it again.` } },

    // A request the server could not read as a quote at all (price-integrity fixes): nothing for the buyer to fix.
    'config-invalid': { '*': { text: `We couldn't price this as it was sent. That is most likely a page that is out of date: reload the page and try again. If it keeps happening, ask for a firm quote and a person prices it, or call ${PHONE}.`, action: 'rfq' } },

    // The database file could not be written (a full disk): whatever was asked for has not gone through
    // (server/middleware/saveGuard.js; review of 2026-11-13, N-08). One sentence wherever it happens.
    'save-failed': { '*': { text: `We could not save that just now, so it has not gone through. That is a fault on our side. Try again in a few minutes, or ${REACH}.`, action: 'retry' } },

    // ─── Limits per sender, a busy moment, and models a person has to price (availability work, 2026-11-12) ───
    // Every one of these says what happened, that nothing is wrong with the buyer's work where that is true, and
    // the way on: wait (with the time, when the server gives one), keep working on what is open, sign in, or ask
    // for a firm quote. `data.retryAfterSeconds` → `minutes`; `data.scope` says whose allowance it was.

    // Pricing (POST /api/quote, reorder, and the price check at checkout)
    'pricing-budget': {
      '*': { text: ({ minutes }) => `We have priced as much from this network or account in the last hour as the instant quote allows, so this change was not priced. It prices again in about ${minutes ? plural(minutes, 'minute') : 'an hour'}. For a price sooner, ask for a firm quote and a person prices it${within}, or call ${PHONE}.`, action: 'rfq' },
      checkout: { text: ({ minutes }) => `We check the price once more before we charge, and this network or account has used the pricing the instant quote allows for the hour, so we have not charged you. Your quote is saved: try again in about ${minutes ? plural(minutes, 'minute') : 'an hour'}, or call ${PHONE} and we'll take the order by phone.`, action: 'retry' },
      order: { text: ({ minutes }) => `We have priced as much from this network or account in the last hour as the instant quote allows, so the order was not re-quoted and nothing was changed. Try Reorder again in about ${minutes ? plural(minutes, 'minute') : 'an hour'}, or ${REACH}.`, action: 'retry' },
    },
    'pricing-busy': {
      '*': { text: `We are pricing a lot of quotes right now, so this one is waiting its turn. Nothing is wrong with your parts. The price updates by itself in a few seconds; if it doesn't, change anything on the quote or call ${PHONE}.`, action: 'retry' },
      order: { text: `We are pricing a lot of quotes right now, so the order was not re-quoted yet and nothing was changed. Press Reorder again in a few seconds, or call ${PHONE}.`, action: 'retry' },
      checkout: { text: `We check the price once more before we charge, and we are pricing a lot of quotes right now, so we have not charged you. Your quote is saved: press the pay button again in a few seconds, or call ${PHONE} and we'll take the order by phone.`, action: 'retry' },
    },
    'pricing-in-progress': {
      '*': { text: 'We are still pricing your last change. The price updates by itself in a few seconds.', action: 'retry' },
      order: { text: 'We are still working on the last reorder from this connection. Give it a few seconds and press Reorder again.', action: 'retry' },
    },
    'quote-too-slow': {
      '*': { text: `This quote is taking longer to price than the instant quote allows, so it was not priced. Ask for a firm quote and a person prices it${within}, or split it into smaller quotes. Questions: ${PHONE}.`, action: 'rfq' },
      order: { text: `This order has more in it than the instant quote can re-price in one go, so it was not re-quoted and nothing was changed. Start a new quote with fewer lines, or ${REACH} and a person prices it.` },
      checkout: { text: `We check the price once more before we charge, and this quote took longer to price than the instant quote allows, so we have not charged you. Ask for a firm quote and a person prices it${within}, or call ${PHONE} and we'll take the order by phone.`, action: 'rfq' },
    },
    'reprice-limit': { '*': { text: ({ minutes }) => `This quote has been changed a great many times in the last hour, so this change was not priced. It prices again in ${minutes ? `about ${plural(minutes, 'minute')}` : 'a few minutes'}, or ask for a firm quote and a person prices it${within}.`, action: 'rfq' } },
    'quote-limit': {
      '*': { text: ({ minutes }) => `A lot of new quotes have been started from here in a short time, so this one was not started. Keep working on a quote you already have open, or try again in ${minutes ? `about ${plural(minutes, 'minute')}` : 'a while'}. For a big job, ask for a firm quote and a person prices it${within}.`, action: 'rfq' },
      order: { text: ({ minutes }) => `A lot of new quotes have been started from here in a short time, so the order was not re-quoted and nothing was changed. Open a quote you already have, or try Reorder again in ${minutes ? `about ${plural(minutes, 'minute')}` : 'a while'}. Questions: ${PHONE}.` },
    },
    'drafts-full': {
      '*': {
        text: ({ data }) => (data && data.scope === 'account'
          ? `Your account holds as many saved quotes as we keep for one account, so this one was not saved. Open a quote you already have and change it, or email ${EMAIL} and we'll clear out the old ones for you.`
          : `There are a lot of quotes open from this network, so this one was not saved. Keep working on a quote you already have open, or sign in to save more. For a big job, ask for a firm quote and a person prices it${within}.`),
        action: 'rfq',
      },
      order: { text: `Your account holds as many saved quotes as we keep for one account, so the order was not re-quoted and nothing was changed. Open a quote you already have and change it, or email ${EMAIL} and we'll clear out the old ones for you.` },
    },
    'quotes-paused': { '*': { text: `We can't save new quotes for visitors without an account right now. That is a limit on our side, and your files are fine. Sign in, or create an account and confirm your email, and it works. Or email your files to ${EMAIL} and a person quotes them.`, action: 'sign-in' } },
    'too-many-lines': { '*': { text: `An instant quote holds up to 100 lines. For a larger job, send us the files and a person prices it${within}.`, keep: true, action: 'rfq' } },

    // Uploads
    'uploads-paused': { '*': { text: `We can't take new files from visitors without an account right now. That is a limit on our side, and nothing is wrong with your file. Sign in, or create an account and confirm your email, and upload again. Or email the files to ${EMAIL} and a person quotes them.`, action: 'sign-in' } },
    'stored-limit': {
      '*': {
        text: ({ data, number }) => {
          const size = number('MB') ? ` (${number('MB')} MB of files)` : '';
          return data && data.scope === 'account'
            ? `Your account has reached what we keep for one account at a time${size}, so this file was not taken. Files that are not on an order are cleared after a few days. Email your files to ${EMAIL} or call ${PHONE} and a person quotes them.`
            : `You have reached what we keep from one network at a time${size}, so this file was not taken. Files that are not on an order or a saved quote are cleared after a few days. Email your files to ${EMAIL} or call ${PHONE} and a person quotes them.`;
        },
        action: 'rfq',
      },
    },
    'parse-budget': { '*': { text: `We have spent as long reading files from this network in the last hour as the instant quote allows, so this one was not read. Try again later, or send us the files and a person quotes them${within}.`, action: 'rfq' } },
    'parse-memory': { '*': { text: `This model needs more memory to read than the instant quote allows. Simplify it or export it at a coarser resolution, or send it to us and a person prices it${within}.`, action: 'rfq' } },
    'parse-failed': { '*': { text: `We couldn't read this file. Export it again from your CAD program and upload it, or send it to us and a person prices it${within}.`, keep: true, action: 'rfq' } },
    'not-read': { '*': { text: 'We stopped reading this upload because another file in it could not be read in time. Nothing is wrong with this file: upload it by itself and it is read.', action: 'retry' } },
    'file-padded': { '*': { text: `This file is much larger than the model inside it needs, which usually means the export went wrong. Export it again from your CAD program and upload it, or send it to us and a person prices it${within}.`, action: 'rfq' } },

    // A model the instant quote will not put a price on: a person prices it
    'nested-shells': { '*': { text: `This model has one closed shape inside another: a sealed hollow, or a part inside a part. The instant quote can't tell which, and the price depends on it, so a person prices these. Ask for a firm quote and we reply${within}.`, action: 'rfq' } },
    'too-thin-to-print': { '*': { text: `This part is too thin or too small for our printers to make reliably, so it was not priced for printing. Thicken it, or ask for a firm quote and a person looks at how it could be made.`, action: 'rfq' } },
    'geometry-not-measurable': { '*': { text: `We couldn't measure this model: some of its coordinates are not real numbers, it has no solid volume, or its shapes overlap so the volume can't be counted. Export it again from your CAD program as one solid and upload it, or send it to us and a person prices it${within}.`, action: 'rfq' } },
    'geometry-out-of-range': { '*': { text: `This model's size doesn't come out as a real part: it is far larger than anything we make, or it sits very far from the origin. Check the export units and upload it again, or send it to us and a person prices it${within}.`, action: 'rfq' } },
    'geometry-too-small': { '*': { text: `This model comes out smaller than anything we can hold or measure. Check the export units (millimetres or inches) and upload it again, or send it to us and a person prices it${within}.`, action: 'rfq' } },

    // Delivery choice, carrier account and sales tax at checkout and on the firm-quote page (shipping and tax, 2026-11-12).
    // The server's sentence says which case it is (which choice is not offered, what is wrong with the account number,
    // why this order has no parcel price), so it is kept; these words stand in when it sends none.
    'shipping-option': { '*': { text: 'Choose how you want the order delivered, then continue.', keep: true } },
    'carrier-account': { '*': { text: 'Check the carrier and the account number: the number is 5 to 20 letters and digits. Then continue.', keep: true } },
    'pickup-name': { '*': { text: 'Tell us who is picking the order up, then continue.' } },
    'ship-country': { '*': { text: 'Choose the country from the list, then try again. Nothing was charged.' } },
    // The state and the ZIP code of a United States address are held against each other (review of 2026-11-13, N-03;
    // server/services/usAddress.js). The server's sentence for a mismatch names the ZIP code and both states, so it is kept.
    'ship-state': { '*': { text: 'Choose the state from the list, then try again. Nothing was charged or sent.' } },
    'ship-zip': { '*': { text: 'That ZIP code is not one we recognise. A ZIP code is five digits (or five and four). Check it and try again. Nothing was charged or sent.' } },
    'address-mismatch': { '*': { text: `The state and the ZIP code of the ship-to address don't match. Check the address and try again. Nothing was charged or sent. If the address is right as typed, call ${PHONE} and we'll take it from there.`, keep: true } },
    'shipping-manual': { '*': { text: `We can't give this order a shipping price online, so nothing was charged. Choose another delivery option if one is offered, or ask for a firm quote and we price the freight${within}.`, keep: true, action: 'rfq' } },
    'tax-address': { '*': { text: `We couldn't work out sales tax for that address, so nothing was charged. Check the street, city, state and ZIP code and try again, or call ${PHONE}.` } },
    'exemption-reason': { '*': { text: 'Choose the reason this order is tax-exempt, then continue.' } },
    'certificate-required': { '*': { text: 'Attach your exemption certificate, or untick the tax-exempt box. Then continue.' } },
    'certificate-missing': { '*': { text: 'No file came through. Choose your certificate again: a PDF, or a JPG or PNG scan.' } },
    'certificate-type': { '*': { text: 'Send the certificate as a PDF, or a JPG or PNG scan.' } },
    'certificate-too-large': { '*': { text: 'That file is too large for a certificate. Send a smaller PDF or scan.', keep: true } },
    'certificate-unreadable': { '*': { text: 'That upload didn\'t come through whole. Choose the file and try again.', action: 'retry' } },
    'certificate-failed': { '*': { text: `We couldn't keep the certificate. That is a fault on our side. Try again in a minute, or email it to ${EMAIL} and say which order it is for.`, action: 'retry' } },
    'quote-locked': { '*': { text: 'This quote has already been ordered or sent to us, so it can\'t be changed from this page. Open the order, or start a new quote.' } },
    // The owner's screens: the order view and the shipping preview in the pricing console.
    'no-certificate': { '*': { text: 'There is no exemption certificate on this order.', keep: true } },
    'invalid-settings': { '*': { text: 'One of the settings on screen is not valid, so the example could not be worked out. The message beside the setting says which.', keep: true } },

    // The part file behind a quote is gone (checkout checks before it charges)
    'part-file-missing': { '*': { text: `We no longer hold one of the files on this quote, so we have not charged you. Reopen the quote and upload the file again: it picks up where it left off. Questions: ${PHONE}.`, action: 'reopen-quote' } },

    // 3D previews: the quote and its price never depend on them
    'preview-limit': { '*': { text: 'A lot of part previews have been loaded from this network in the last hour, so previews are paused for a while. Pricing and ordering are not affected.' } },
    'preview-rate-limited': { '*': { text: 'A lot of part previews have been loaded in a short time, so previews are paused for a few minutes. Pricing and ordering are not affected.' } },
    'preview-unavailable': { '*': { text: 'We can\'t show the 3D preview of this part right now. The quote and its price are not affected.' } },
    'no-preview': { '*': { text: 'This part has no 3D preview. The quote and its price are not affected.' } },
    'preview-too-large': { '*': { text: 'The 3D preview of this part is too large to show here. The quote and its price are not affected.' } },

    // The request form, and an answer too large to send
    'requests-paused': { '*': { text: `We are getting more requests than we can read right now, so the form is paused for a little while and this one was not sent. ${REACH_CAP} and we'll take it from there.` } },
    'answer-too-large': { '*': { text: `That is more than we can show on one page. Reload the page; if it happens again, ${REACH} and we'll sort it out.`, action: 'reload' } },

    // Too many requests. One code covers a dozen different limits, so the wording goes by where it happened.
    'rate-limited': {
      '*': { text: `That is more requests than we take from one connection in a short time. Wait a few minutes and try again, or ${REACH}.` },
      login: { text: `Too many sign-in attempts have come from this connection, so sign-in from it is paused for 15 minutes. On a shared office network that can be someone else's doing. Wait, or call ${PHONE}.` },
      register: { text: `Several accounts have been created from this connection in the last hour, so we have paused new ones. Try again later, or ${REACH} and we'll set you up.` },
      'two-factor': { text: 'Too many tries in a short time. Wait 15 minutes, then enter the code the app shows.' },
      // Three limits share this code (one a minute, five a day per account, five an hour per network); the server's sentence says which.
      resend: { text: `We sent a link a moment ago, and we send a handful a day at most. Check the spam folder first; if nothing has arrived, call ${PHONE}.`, keep: true },
      reset: { text: `Several reset links have been asked for from this connection in the last hour, so we have paused them. Try again in an hour, or call ${PHONE}.` },
      form: { text: `We have had several requests from you in a short time, so this one was not sent. ${REACH_CAP} and we'll take it from there.` },
      upload: { text: `That is a lot of uploads in a few minutes, so uploads from this connection are paused for a quarter of an hour. Email the files to ${EMAIL} if it can't wait.` },
      quote: { text: 'The quote is changing faster than we can price it. Wait a few seconds and it updates.', keep: true },
      drawing: { text: `That is a lot of drawings in an hour. Email this one to ${EMAIL} with your quote and we'll attach it.` },
      documents: { text: 'That is a lot of documents in a few minutes. Wait a little and open it again.' },
    },
  };

  // ─── No code: by status and place ───────────────────────────
  const BY_STATUS = {
    0: {
      '*': `We couldn't reach our server. Check your connection and try again; what you typed is still here.`,
      // A list on the owner's pages or on "Your orders": nothing was typed.
      admin: `We couldn't reach our server. Check your connection and try again.`,
      order: `We couldn't reach our server. Check your connection and try again.`,
    },
    400: { '*': `That didn't go through as sent. Check what you entered and try again, or ${REACH}.` },
    401: { '*': BY_CODE['session-ended']['*'].text },
    403: { '*': 'This account can\'t open that. If it is yours, sign in with the account that made it.' },
    404: {
      '*': 'We couldn\'t find that. It may have been removed, or the link is incomplete.',
      checkout: 'We couldn\'t find that quote. It may already be an order, or it belongs to another account. Open your quote again to carry on.',
      quote: 'We couldn\'t find that quote. Upload the part again to price it.',
      order: 'We couldn\'t find that order on this account.',
    },
    409: { '*': 'That has changed since this page was opened. Reload the page to see where it stands.' },
    410: { '*': 'That is no longer available. Upload the file again to start a new quote.' },
    408: { '*': 'That took too long and we stopped waiting. Nothing was lost: try it again.' },
    413: { '*': `That is larger than we can take here. Send a smaller file, or email it to ${EMAIL}.` },
    422: { '*': `We couldn't use that as it was sent. Check it and try again, or ${REACH}.` },
    415: { '*': `That didn't go through as sent. Reload the page and try again, or ${REACH}.` },
    429: { '*': BY_CODE['rate-limited']['*'].text },
    500: {
      '*': `Something went wrong on our side. Try again in a minute, or ${REACH}.`,
      checkout: `We couldn't start the card payment, and nothing was charged. Try again in a minute, or call ${PHONE} and we'll take the order by phone.`,
      upload: `We couldn't read that upload, and the fault is on our side. Try again, or email the file to ${EMAIL}.`,
    },
    502: { '*': `We couldn't confirm that with the card processor yet. Nothing has gone wrong with your order: refresh in a minute, or call ${PHONE}.` },
    504: { '*': `That took too long and we stopped waiting. Try again in a minute, or ${REACH}.` },
    503: {
      '*': `That part of the site isn't answering right now. Try again in a minute, or ${REACH}.`,
      checkout: `Card payment isn't available right now. That is a fault on our side. Call ${PHONE} and we'll take the order by phone.`,
    },
  };

  // Sentences the server writes for a developer. A buyer who would have read one gets the status fallback instead.
  const DEVELOPER_TEXT = [
    /^authentication required$/i, /invalid or expired token/i, /^access denied$/i, /^admin access required$/i, /^not allowed$/i,
    /^not found$/i, /^(quote|order|part|user|rfq) not found$/i, /^no (files uploaded|parts configured|drawing attached|drawing|file)$/i,
    /^(registration|login|upload|backup|preview) failed/i, /^failed to /i, /^could not (create|rebuild|build|confirm) /i,
    /internal server error/i, /could not be processed/i, /isn't valid json/i, /send this request as json/i, /^the request is too large/i,
    /quote id is required/i, /invalid order total/i, /payment processing is not configured/i, /^too many requests, please try again later/i,
    /^upload limit reached/i, /^too many registration attempts/i, /must be (a number|text|one of)/i, /\b(csrf|token|payload|rate.?limit)\b/i, /request failed: \d+/i,
  ];
  const isDeveloperText = (s) => !s || DEVELOPER_TEXT.some((re) => re.test(String(s).trim()));

  /** Which family of request a path belongs to (the `context` for wording). */
  function contextFor(path = '', method = 'GET') {
    const p = String(path).split('?')[0];
    if (/^\/auth\/login/.test(p)) return 'login';
    if (/^\/auth\/register/.test(p)) return 'register';
    if (/^\/auth\/verify-email\/resend/.test(p)) return 'resend';
    if (/^\/auth\/verify-email/.test(p)) return 'verify';
    if (/^\/auth\/password-reset/.test(p)) return 'reset';
    if (/^\/auth\/2fa/.test(p)) return 'two-factor';
    if (/^\/human\/verify/.test(p)) return 'upload';
    if (/^\/upload/.test(p) || /^\/parts\/[^/]+\/units/.test(p)) return 'upload';
    if (/^\/quote\/[^/]+\/drawing/.test(p)) return 'drawing';
    if (/^\/rfq\/(quote|return)\//.test(p)) return 'firm-quote';
    if (/^\/rfq/.test(p) && method !== 'GET') return 'rfq';
    if (/^\/orders\/checkout-session/.test(p)) return 'checkout';
    if (/^\/orders/.test(p)) return 'order';
    if (/^\/quote/.test(p)) return method === 'GET' ? 'checkout' : 'quote';
    if (/^\/pdf\//.test(p)) return 'documents';
    if (/^\/admin\//.test(p)) return 'admin';
    if (/^\/public\/form-token/.test(p)) return 'form';
    return '*';
  }
  // Contexts that share wording.
  const FALLBACK_CONTEXT = { rfq: 'form', 'firm-quote': '*', verify: '*', order: '*' };

  function entryFor(code, context) {
    const set = BY_CODE[code];
    if (!set) return null;
    return set[context] || set[FALLBACK_CONTEXT[context]] || set['*'] || null;
  }

  /**
   * The words for one refusal.
   * @param {{status?: number, code?: string, serverMessage?: string, data?: object, context?: string}} r
   * @returns {{message: string, action: string|null, source: 'catalogue'|'server'|'status'}}
   */
  function describe({ status = 0, code = '', serverMessage = '', data = {}, context = '*' } = {}) {
    const info = {
      data,
      serverMessage,
      minutes: data && data.retryAfterSeconds ? Math.max(1, Math.ceil(data.retryAfterSeconds / 60)) : 0,
      /** A number the server's sentence gives next to a unit ("over 50 MB" → 50). */
      number: (unit) => {
        const m = new RegExp(`([\\d,]+)\\s*${unit}`).exec(serverMessage || '');
        return m ? m[1] : '';
      },
    };
    // Admin screens are the owner's: the server's own sentence is the useful one there.
    if (context === 'admin' && serverMessage && !entryFor(code, context)) return { message: serverMessage, action: null, source: 'server' };
    const entry = entryFor(code, context);
    if (entry) {
      const own = typeof entry.text === 'function' ? entry.text(info) : entry.text;
      const useServer = entry.keep && serverMessage && !isDeveloperText(serverMessage);
      return { message: useServer ? serverMessage : own, action: entry.action || null, source: useServer ? 'server' : 'catalogue' };
    }
    if (serverMessage && !isDeveloperText(serverMessage)) return { message: serverMessage, action: null, source: 'server' };
    const bucket = BY_STATUS[status] || BY_STATUS[status >= 500 ? 500 : 400];
    return { message: bucket[context] || bucket[FALLBACK_CONTEXT[context]] || bucket['*'], action: status === 401 ? 'sign-in' : null, source: 'status' };
  }

  // ─── Order states the buyer's order page shows ──────────────
  // Not refusals: the standing of an order after money has moved, or not moved. Worded here so
  // the order page, the firm-quote page and anything else that shows an order say the same thing.
  // `info`: { amount (dollars refunded), email (where we write to the buyer) }.
  // (The states and flags are the order state machine's, server/services/orderState.js: `expired`, `cancelled`
  // and `refunded` are order.status; under review, partly refunded and disputed are flags on an order that keeps
  // its status; `awaiting-po` is order.status "pending_po".) None of these says when: no reply time and no bank
  // timing is promised here unless the owner confirms one in shared/shop-facts.json.
  const ORDER_STATES = {
    'payment-under-review': ({ email } = {}) => `We received a payment for this order and are checking it by hand before we confirm the order. You don't need to do anything. We'll write to ${email || 'you'} when it is settled. Questions: ${PHONE}.`,
    expired: ({ firmQuote } = {}) => (firmQuote
      ? `This order was never paid for, so it has closed. Nothing was charged. Open the link in your quote email to order, or call ${PHONE}.`
      : `This order was never paid for, so it has closed. Nothing was charged. Your quote is still there: go back to it to order, or call ${PHONE}.`),
    'awaiting-po': ({ poNumber } = {}) => `We have your purchase order${poNumber ? ` ${poNumber}` : ''}. Nothing has been charged. We confirm the purchase order with you before work starts. Questions: ${PHONE}.`,
    refunded: ({ amount } = {}) => `We refunded this order${Number(amount) > 0 ? `: ${dollars(amount)} went back to the card it was paid with` : ' to the card it was paid with'}. A bank can take several days to show a refund. Questions: ${PHONE}.`,
    'partially-refunded': ({ amount } = {}) => `We refunded ${Number(amount) > 0 ? dollars(amount) : 'part'} of this order to the card it was paid with. The rest of the order stands. A bank can take several days to show a refund.`,
    disputed: () => `The bank behind the card has raised a question about this payment (a dispute). We answer the bank directly, and the order waits until it is settled. If you did not ask your bank about this charge, call ${PHONE}.`,
    cancelled: () => `This order was cancelled and will not be made. If that is not what you expected, call ${PHONE}.`,
  };
  // ─── Notices: not refusals ───────────────────────────────────
  // Something the server did that the buyer should know about, on an answer that is otherwise a success.
  //   verification-queued  the site is over its hourly line for email to addresses nobody has confirmed, so the
  //                        confirmation email is held and sent when the hour turns (`queued` / `verificationQueued`)
  const NOTICES = {
    'verification-queued': 'We are sending a lot of confirmation emails right now, so yours is waiting its turn. It will arrive within the hour, and you don\'t need to ask again. Check the spam folder when it does.',
  };
  const notice = (key) => NOTICES[key] || '';
  const noticeTable = () => Object.entries(NOTICES).map(([key, text]) => ({ key, text }));

  // ─── Why a quote goes to a person (gate reasons) ─────────────
  // Not refusals: the reasons listed beside "Request a firm quote" (`gate.reasons[].code`, and the `reasons` of
  // an `rfq-required` answer). The server's sentence names the numbers (pieces, the limit, the thickness), so it
  // is the one shown; the words here are for a reason that arrives without one. The three added by the
  // price-integrity fixes are worded here; the older reasons keep the server's sentence.
  const GATE_REASONS = {
    'order-quantity': 'The pieces on this order add up to more than the instant order takes in one go. A run this size is priced by a person: ask for a firm quote.',
    'big-ticket-order': 'The total of this order is over the amount we take online without a person confirming the price first. Ask for a firm quote and we confirm it before you pay.',
    'stock-thinner-than-model': 'The stock thickness chosen is thinner than the model, so the part can\'t be cut from it as drawn. Pick a thicker stock, or ask for a firm quote and a person confirms the stock with you.',
  };
  const GATE_FALLBACK = 'This one needs a person to look at it before it can be ordered.';
  /** The sentence for one gate reason ({ code, message }). */
  function gateReason(reason) {
    const said = reason && typeof reason.message === 'string' ? reason.message.trim() : '';
    if (said && !isDeveloperText(said)) return said;
    return GATE_REASONS[reason && reason.code] || GATE_FALLBACK;
  }
  const gateReasonTable = () => Object.entries(GATE_REASONS).map(([code, text]) => ({ code, text }));

  /** The sentence for an order state, or '' for one that needs no explaining (paid, in production, shipped…). */
  function orderState(key, info) {
    const say = ORDER_STATES[key];
    return say ? say(info) : '';
  }

  /** Every code and what the buyer reads for it, for the owner's review table. */
  function table() {
    const sample = { data: { retryAfterSeconds: 14 * 60, field: 'shippingName' }, serverMessage: '', minutes: 14, number: () => '' };
    const rows = [];
    for (const [code, set] of Object.entries(BY_CODE)) {
      for (const [context, entry] of Object.entries(set)) {
        rows.push({ code, where: context === '*' ? 'everywhere' : context, text: typeof entry.text === 'function' ? entry.text(sample) : entry.text, keepsServerSentence: Boolean(entry.keep), offers: entry.action || '' });
      }
    }
    for (const [status, set] of Object.entries(BY_STATUS)) {
      for (const [context, text] of Object.entries(set)) rows.push({ code: `(no code) HTTP ${status === '0' ? 'no answer' : status}`, where: context === '*' ? 'everywhere' : context, text, keepsServerSentence: false, offers: '' });
    }
    return rows;
  }
  /** The order states and their sentences, for the same table. */
  const orderStateTable = () => Object.keys(ORDER_STATES).map((key) => ({ state: key, text: orderState(key, { amount: 120, email: 'the address on the order' }) }));

  return { describe, contextFor, isDeveloperText, table, orderState, orderStateTable, gateReason, gateReasonTable, notice, noticeTable, codes: Object.keys(BY_CODE), gateReasonCodes: Object.keys(GATE_REASONS), noticeKeys: Object.keys(NOTICES) };
}
