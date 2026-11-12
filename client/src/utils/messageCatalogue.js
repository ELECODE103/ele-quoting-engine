/**
 * What a buyer reads when the server refuses something.
 *
 * The server answers a refusal with an HTTP status, usually a `code`
 * ("form-expired", "account-locked", …) and a sentence of its own. This file
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
 *           'sign-in' · 'reload' · 'reopen-quote'
 */
export function createCatalogue(brand, { quoteTurnaround = '' } = {}) {
  const PHONE = brand.phone;
  const EMAIL = brand.email;
  const REACH = `call ${PHONE} or email ${EMAIL}`;
  const REACH_CAP = `Call ${PHONE} or email ${EMAIL}`;
  const within = quoteTurnaround ? ` within ${quoteTurnaround}` : '';
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // ─── By code ────────────────────────────────────────────────
  // '*' is the wording wherever the code turns up; a context key overrides it.
  const BY_CODE = {
    // Accounts
    'invalid-credentials': {
      '*': { text: 'That email and password didn\'t match. Check both and try again, or use "Forgot your password?" to choose a new one.', action: 'reset' },
      'two-factor': { text: 'That password didn\'t match. Enter the password you sign in with.' },
    },
    'account-locked': {
      '*': {
        text: ({ minutes }) => `Sign-in for this address is paused for ${minutes ? plural(minutes, 'minute') : 'a few minutes'}, because the wrong password was entered several times in a row. The pause is there to stop anyone guessing their way in, and nobody got in. Choose a new password to sign in now, or wait and try again.`,
        action: 'reset',
      },
    },
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
    busy: { '*': { text: 'We are reading a lot of files right now, so this one is waiting its turn. Nothing is wrong with your file: give it a minute and try again.', action: 'retry' } },
    'storage-full': { '*': { text: `We can't take new files right now. That is a fault on our side. Email them to ${EMAIL} or call ${PHONE} and a person quotes them.` } },
    'store-failed': { '*': { text: `We read this file but couldn't keep it. Try again in a minute, or email it to ${EMAIL}.`, action: 'retry' } },
    'dxf-routing-only': { '*': { text: 'A DXF is a flat outline with no thickness, so we cut it from sheet on the router. Switch to CNC routing to price it, or upload a STEP of the part.', keep: true } },
    'dxf-units-required': { '*': { text: 'Choose whether this drawing is in inches or millimetres, and the price follows.', keep: true } },
    'dxf-thickness-required': { '*': { text: 'Select a stock thickness: a DXF has no thickness of its own.', keep: true } },
    'part-locked': { '*': { text: 'This part is already on an order or a quote request, so its units can no longer be changed. Upload the file again to start a new quote.' } },
    'part-data-unavailable': { '*': { text: 'We can no longer read what we measured from this file. Upload it again and it is priced as before.', keep: true } },

    // Pricing and checkout
    'finish-lead-time': { '*': { text: 'Anodize and powder coat go out to a finisher, so a part with either one ships on the Standard lead time. Choose Standard, or a finish done here.' } },
    'too-many-lines': { '*': { text: `An instant quote holds up to 100 lines. For a larger job, send us the files and a person prices it${within}.`, keep: true, action: 'rfq' } },
    'quote-expired': {
      '*': { text: 'The hold on this price has run out. Reopen the quote for today\'s price; your parts are still there.', action: 'reopen-quote' },
      'firm-quote': { text: `This quote has passed its date. Reply to the quote email or call ${PHONE} and we'll refresh it.`, keep: true },
    },
    'rfq-required': { '*': { text: `This one needs a person to look at it before it can be ordered. Ask for a firm quote and we reply${within}.`, action: 'rfq' } },
    'lead-time-unavailable': { '*': { text: 'The lead time on this quote is no longer offered. Reopen the quote and pick a lead time to see today\'s price.', action: 'reopen-quote' } },
    'quote-inconsistent': { '*': { text: 'The total on this quote no longer adds up, so we won\'t charge it. Reopen the quote for today\'s price.', action: 'reopen-quote' } },
    'parts-unavailable': { '*': { text: 'We no longer hold the part files for this order. Upload them again for a new quote.' } },
    'reorder-failed': { '*': { text: `This order can't be re-quoted as it was. Start a new quote with the same files, or ${REACH}.`, keep: true } },
    'already-accepted': { '*': { text: `This quote has already been accepted, so there is nothing more to do here. Questions about the order: ${PHONE}.` } },
    'not-open': { '*': { text: `This quote is no longer open. ${REACH_CAP} and we'll sort it out.` } },

    // Too many requests. One code covers a dozen different limits, so the wording goes by where it happened.
    'rate-limited': {
      '*': { text: `That is more requests than we take from one connection in a short time. Wait a few minutes and try again, or ${REACH}.` },
      login: { text: `Too many sign-in attempts have come from this connection, so sign-in from it is paused for 15 minutes. On a shared office network that can be someone else's doing. Wait, or call ${PHONE}.` },
      register: { text: `Several accounts have been created from this connection in the last hour, so we have paused new ones. Try again later, or ${REACH} and we'll set you up.` },
      'two-factor': { text: 'Too many tries in a short time. Wait 15 minutes, then enter the code the app shows.' },
      // Two limits share this code (one a minute, five a day); the server's sentence says which.
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
    0: { '*': `We couldn't reach our server. Check your connection and try again; what you typed is still here.` },
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
    413: { '*': `That is larger than we can take here. Send a smaller file, or email it to ${EMAIL}.` },
    415: { '*': `That didn't go through as sent. Reload the page and try again, or ${REACH}.` },
    429: { '*': BY_CODE['rate-limited']['*'].text },
    500: {
      '*': `Something went wrong on our side. Try again in a minute, or ${REACH}.`,
      checkout: `We couldn't start the card payment, and nothing was charged. Try again in a minute, or call ${PHONE} and we'll take the order by phone.`,
      upload: `We couldn't read that upload, and the fault is on our side. Try again, or email the file to ${EMAIL}.`,
    },
    502: { '*': `We couldn't confirm that with the card processor yet. Nothing has gone wrong with your order: refresh in a minute, or call ${PHONE}.` },
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
    if (/^\/rfq\/quote\//.test(p)) return 'firm-quote';
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

  /** Every code and what the buyer reads for it, for the owner's review table. */
  function table() {
    const sample = { data: { retryAfterSeconds: 14 * 60 }, serverMessage: '', minutes: 14, number: () => '' };
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

  return { describe, contextFor, isDeveloperText, table, codes: Object.keys(BY_CODE) };
}
