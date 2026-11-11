import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import PublicLayout from '../components/PublicLayout';
import { api } from '../utils/api';
import { useAuth } from '../utils/authContext';
import { formatCurrency } from '../utils/format';
import brand, { PROCESS_LABELS } from '../brand';
import { fact, when, PAPERWORK_HELP } from '../facts';
import useFormGuard from '../utils/useFormGuard';
import VerifyEmailNotice from '../components/security/VerifyEmailNotice';

const within = when('quote-turnaround', (v) => ` within ${v}`);
const UPLOAD_EXT = ['.pdf', '.dxf', '.dwg', '.png', '.jpg', '.jpeg']; // what POST /api/rfq accepts
const MAX_MB = 25;
// Said only once the owner has answered (shared/shop-facts.json).
// part-return (owner, 2026-11-11): the customer pays to ship the part in; the original goes back
// with the finished parts and the quoted price covers that return shipping.
// (fact() gives the confirmed sentence or null; when() with no second argument gives nothing.)
const PART_RETURN = fact('part-return');
const PART_QUOTE_TIME = fact('part-quote-time');

/**
 * Firm-quote request. Three ways in:
 *   /rfq/:quoteId   from the quote builder, parts pre-filled
 *   /rfq            a drawing and a quantity
 *   /rfq?nocad=1    a worn part and no drawing ("part" mode): the buyer sends
 *                   the physical part, so this mode has no file upload
 * Both modes post to the same endpoint. The part-mode fields (machine,
 * material, how soon, what it does) are folded into the notes; requestType=part
 * tells the server to answer with a reference and the address to ship the part
 * to. That address is shown only on the confirmation screen, from the response.
 *
 * The form is bot-checked (utils/useFormGuard): a hidden honeypot field, a
 * form token that proves the form was open for a few seconds, and Cloudflare
 * Turnstile when the server has keys. The server answers with what it did:
 * `confirmationEmail` (was the buyer emailed?), `noEmailReason` when not, and,
 * in part mode, `shipTo` or `shipToPending` (the address is only given to a
 * sender who passed the check). The confirmation screens below say exactly
 * that, no more — and the text before the form promises neither an email nor
 * an address on the screen, because whether either happens is decided per
 * request (owner decision, 2026-11-11: with no Turnstile keys there is no
 * automatic confirmation and no address on screen).
 *
 * Two checkboxes ride as their own fields, because the owner prices both into
 * the firm quote: `paperwork` (a first-article inspection report and a
 * certificate of conformance; off unless ticked, or already chosen on the
 * online quote) and, in part mode, `returnPart` (send the original back with
 * the order; on to start with).
 */
export default function RfqPage() {
  const { quoteId } = useParams();
  const location = useLocation();
  const { user } = useAuth();
  const guard = useFormGuard('rfq');
  const [quote, setQuote] = useState(null);
  const [quoteMissing, setQuoteMissing] = useState(false);
  const [materialNames, setMaterialNames] = useState({});
  // Always starts in drawing mode so the prerendered page and the first client
  // render match; the effect below switches to part mode for ?nocad=1.
  const [mode, setMode] = useState('drawing');
  const [form, setForm] = useState({
    contactName: '', email: '', company: '', phone: '',
    quantities: '', tolerance: '', finishNotes: '', dueDate: '', notes: '', lives: '',
    machine: '', material: '', soon: '',
  });
  const [paperwork, setPaperwork] = useState(false);
  const [returnPart, setReturnPart] = useState(true);
  const [drawing, setDrawing] = useState(null);
  const [fileError, setFileError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(null);

  useEffect(() => {
    if (quoteId || !/[?&]nocad=1/.test(location.search)) return undefined;
    setMode('part');
    // On a phone the form sits below the intro; bring it into view.
    const t = setTimeout(() => { if (window.innerWidth < 769) document.getElementById('request')?.scrollIntoView(); }, 120);
    return () => clearTimeout(t);
  }, [location.search, quoteId]);

  useEffect(() => {
    if (user) setForm((f) => ({ ...f, contactName: f.contactName || user.name || '', email: f.email || user.email || '', company: f.company || user.company || '' }));
  }, [user]);

  useEffect(() => {
    if (!quoteId) return;
    api.getQuoteById(quoteId).then((q) => {
      setQuote(q);
      if (q.paperwork) setPaperwork(true); // already asked for on the online quote
      const qtys = (q.lineItems || []).map((li) => li.quantity);
      if (qtys.length) setForm((f) => ({ ...f, quantities: f.quantities || qtys.join(' / ') }));
      // Show material names, not slugs ("Delrin / Acetal (POM)", not "cnc-delrin").
      const procs = [...new Set((q.lineItems || []).map((li) => li.meta?.process).filter(Boolean))];
      Promise.all(procs.map((pr) => api.getMaterials(pr).catch(() => []))).then((lists) => {
        const map = {};
        lists.flat().forEach((m) => { map[m.slug] = m.name; });
        setMaterialNames(map);
      });
    }).catch(() => setQuoteMissing(true));
  }, [quoteId]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const part = mode === 'part';

  function pickFile(e) {
    const f = e.target.files?.[0] || null;
    setFileError('');
    if (f) {
      const ext = (f.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
      if (!UPLOAD_EXT.includes(ext)) { setFileError(`That file type (${ext || 'unknown'}) will not upload. Use a PDF, DXF, DWG, JPG or PNG, or email it to ${brand.email}.`); e.target.value = ''; return setDrawing(null); }
      if (f.size > MAX_MB * 1024 * 1024) { setFileError(`That file is over ${MAX_MB} MB. Send a smaller file, or email it to ${brand.email}.`); e.target.value = ''; return setDrawing(null); }
    }
    setDrawing(f);
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!form.contactName.trim()) return setError('Add your name so we know who to send it to.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return setError('Add a working email so the quote has somewhere to go.');
    if (part && !form.notes.trim()) return setError('Say what the part is and what it does, so we know what is coming.');
    setBusy(true);
    try {
      // Extra fields ride in the notes: the endpoint stores and emails `notes` as written.
      const extra = part
        ? [
          'NO DRAWING. The customer is sending the part.',
          form.notes && `What it is and does: ${form.notes}`,
          form.machine && `Machine it is from: ${form.machine}`,
          form.material && `Material, if known: ${form.material}`,
          form.soon && `How soon: ${form.soon}`,
        ]
        : [form.lives && `Where the part lives: ${form.lives}`, form.notes];
      const { machine, material, soon, lives, ...fields } = form;
      const res = await guard.submit((headers, trap) => api.submitRfq({
        ...fields,
        ...(part ? { requestType: 'part', returnPart, tolerance: '', finishNotes: '', dueDate: '' } : {}),
        paperwork,
        notes: extra.filter(Boolean).join('\n').slice(0, 2000),
        quoteId: quote?.quoteId || quote?.id || quoteId || '',
        ...trap,
      }, part ? null : drawing, headers));
      setSent(res);
      window.scrollTo(0, 0);
    } catch (err) {
      setError(err.message || `It didn't send. Call ${brand.phone} and we'll take it by phone.`);
    }
    setBusy(false);
  }

  if (sent) {
    const reference = sent.reference || String(sent.rfqId || '').slice(0, 8).toUpperCase();
    // What the server did, from its answer and nothing else. A confirmation email is only
    // mentioned when the server says it sent one; the ship-to address only when it is in the answer.
    const emailed = sent.confirmationEmail === true;
    const whyNoEmail = emailed || sent.needsEmailVerification || sent.noEmailReason === 'account-unconfirmed'
      ? null // sent, or the confirm-your-email notice below says why not
      : sent.noEmailReason === 'daily-limit'
        ? 'We did not send another confirmation email: we limit how many go to one address in a day. Your request is in.'
        : 'No automatic confirmation email goes out for this request. We read it and reply to you at that address.';
    // Part mode: the next step is the buyer's. The address comes from the server response only.
    if (part) {
      return (
        <PublicLayout>
          <section className="section">
            <div className="pub-wrap" style={{ maxWidth: 680 }}>
              <div className="eyebrow" style={{ marginBottom: 14 }}>Request received</div>
              <h1 className="display" style={{ marginBottom: 16 }}>{sent.shipTo ? 'Now send us the part.' : 'We have your request.'}</h1>
              {sent.shipTo ? (
                <p className="lede" style={{ marginBottom: 20 }}>
                  Write the reference on the box and ship the part to the address below, at your cost. We measure it and send a price
                  to <b>{form.email}</b>.{PART_QUOTE_TIME ? ` ${PART_QUOTE_TIME}` : ''}
                </p>
              ) : (
                <p className="lede" style={{ marginBottom: 20 }}>
                  Keep the reference below. We read the request first, then reply to <b>{form.email}</b> with the
                  address to ship the part to. Do not send anything yet.
                </p>
              )}
              <VerifyEmailNotice reason="to get our emails about this request" />
              <div className="plain-box" style={{ marginBottom: 20 }}>
                <dl className="ship-part">
                  <div>
                    <dt className="field-label">Reference to write on the box</dt>
                    <dd style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 700, letterSpacing: 1, color: 'var(--text-primary)', margin: '2px 0 14px' }}>{reference}</dd>
                  </div>
                  <div>
                    <dt className="field-label">Ship the part to</dt>
                    {sent.shipTo
                      ? (
                        <dd style={{ margin: '2px 0 0', fontSize: 16, lineHeight: 1.5, color: 'var(--text-primary)' }}>
                          {sent.shipTo.name}{(sent.shipTo.lines || []).map((l) => <span key={l}><br />{l}</span>)}
                        </dd>
                      )
                      : <dd style={{ margin: '2px 0 0' }} data-testid="ship-to-pending">It comes in our reply to {form.email}, once we have read the request. In a hurry? Call <a href={brand.phoneHref}>{brand.phone}</a> with the reference.</dd>}
                  </div>
                </dl>
              </div>
              <p className="body-copy" style={{ marginBottom: 20 }}>
                {sent.shipTo && emailed ? 'The same reference and address are in the confirmation email. ' : ''}
                {!emailed && whyNoEmail ? `${whyNoEmail} ` : ''}
                {(sent.returnPart ?? returnPart)
                  ? 'You asked for the original back: we send it back with your finished parts, and the price we quote includes that return shipping.'
                  : `You did not ask for the original back, so we keep it with the job. Changed your mind? ${emailed ? 'Reply to the confirmation email' : `Call ${brand.phone} or email ${brand.email} with the reference`} before you order.`}{' '}
                {paperwork ? 'You asked for a first-article inspection report and a certificate of conformance: the price we quote will include them. ' : ''}
                Nothing is ordered and nothing is charged until you say so. Questions: <a href={brand.phoneHref}>{brand.phone}</a>.
              </p>
              <div className="cta-row">
                <Link to="/replacement-parts" className="btn btn-primary">How replacement parts work</Link>
                <Link to="/" className="btn btn-ghost">Back to the site</Link>
              </div>
            </div>
          </section>
        </PublicLayout>
      );
    }
    return (
      <PublicLayout>
        <section className="section">
          <div className="pub-wrap" style={{ maxWidth: 680 }}>
            <div className="eyebrow" style={{ marginBottom: 14 }}>Request received</div>
            <h1 className="display" style={{ marginBottom: 16 }}>It's in the queue.</h1>
            <p className="lede" style={{ marginBottom: 20 }}>
              The engineer who will run the job reads it and replies to <b>{form.email}</b>{within}. If the print needs
              a conversation first, that is the reply you will get.
            </p>
            <VerifyEmailNotice reason="to get our emails about this request" />
            <p className="body-copy" style={{ marginBottom: 20 }}>
              {paperwork ? 'You asked for a first-article inspection report and a certificate of conformance: the price we quote will include them, and the quote will say so. ' : ''}
              {emailed
                ? 'A confirmation email is on its way. More files? Reply to it and attach them. '
                : `${whyNoEmail ? `${whyNoEmail} ` : ''}More files? Email them to ${brand.email} with the reference below. `}
              In a hurry, call <a href={brand.phoneHref}>{brand.phone}</a> and give the reference below.
            </p>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 28 }}>Reference: {reference}</p>
            <div className="cta-row">
              <Link to="/quote" className="btn btn-primary">Quote another part</Link>
              <Link to="/" className="btn btn-ghost">Back to the site</Link>
            </div>
          </div>
        </section>
      </PublicLayout>
    );
  }

  const reasons = quote?.gate?.reasons || [];

  return (
    <PublicLayout>
      <section className="section" style={{ paddingTop: 48 }}>
        <div className="pub-wrap">
          <div className="hero-grid" style={{ alignItems: 'start', gap: 48 }}>
            <div>
              <div className="eyebrow" style={{ marginBottom: 14 }}>{part ? 'Replacement part, no drawing' : 'Firm quote'}</div>
              <h1 className="display" style={{ fontSize: 36, marginBottom: 14 }}>{part ? 'Tell us about the part. Then send it to us.' : 'Tell us what matters. We\'ll price the rest.'}</h1>
              {part ? (
                <p className="lede" style={{ marginBottom: 20 }}>
                  No drawing needed, and no photo. Tell us about the part, then send it to us. We measure it and send you a price.
                </p>
              ) : (
                <p className="lede" style={{ marginBottom: 20 }}>
                  A firm quote comes back{within}, from the engineer who will run the job{when('quote-valid', (v) => `, and holds for ${v}`)}.
                  The more you give us, the sharper the number: a drawing, the quantities you would actually buy, the two
                  dimensions that have to be right.
                </p>
              )}

              {!quote && (
                <div className="plain-box" style={{ marginBottom: 20 }}>
                  <h2 className="display h3-like" style={{ marginBottom: 6 }}>No drawing?</h2>
                  <p className="body-copy">
                    Send us the part. Tell us what it is and what it does; when the request goes in you get a reference,
                    and we send you the address to ship it to.{' '}
                    {part
                      ? 'The form is set up for that now.'
                      : <button type="button" className="linklike-inline" onClick={() => setMode('part')}>Switch the form to a send-the-part request</button>}
                  </p>
                </div>
              )}

              {quote && (
                <div className="card" style={{ padding: 18, marginBottom: 20 }}>
                  <div className="field-label">Parts from your online quote</div>
                  {(quote.lineItems || []).map((li) => (
                    <div key={li.partId} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border-subtle)', fontSize: 13 }}>
                      <div>
                        <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{li.fileName}</div>
                        <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                          {li.quantity} × {materialNames[li.meta?.materialSlug] || li.meta?.materialSlug} · {PROCESS_LABELS[li.meta?.process] || li.meta?.process}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <div className="price-label">budgetary</div>
                        <div style={{ fontWeight: 600 }}>{formatCurrency(li.perUnit?.final || 0)} each</div>
                      </div>
                    </div>
                  ))}
                  {reasons.length > 0 && (
                    <div className="gate-box" style={{ marginTop: 14 }}>
                      Why this one needs a person:
                      <ul>{reasons.map((r, i) => <li key={i}>{r.message}</li>)}</ul>
                    </div>
                  )}
                </div>
              )}
              {quoteMissing && (
                <div className="gate-box" role="status" style={{ marginBottom: 20 }}>We couldn't find that online quote. The form works on its own: describe the part or attach the drawing.</div>
              )}

              <h2 className="display h3-like" style={{ marginBottom: 8 }}>What happens next</h2>
              {part ? (
                <ul className="checklist" style={{ marginBottom: 20 }}>
                  <li>You get a reference on the next screen, and we send you the address to ship the part to. Do not ship anything until you have both.</li>
                  <li>Write the reference on the box and send the part. {PART_RETURN ? `${PART_RETURN} Untick the box on the form if you do not need it back.` : 'Tell us in the request if you need the original back.'}</li>
                  <li>We measure it and send you a price.{PART_QUOTE_TIME ? ` ${PART_QUOTE_TIME}` : ''} Nothing is ordered and nothing is charged until you say so.</li>
                </ul>
              ) : (
                <ul className="checklist" style={{ marginBottom: 20 }}>
                  <li>You get a reference number on the next screen. Keep it: it is how we find your request.</li>
                  <li>The engineer who will run the job reads the request and replies{within}, with a price or with a question.</li>
                  <li>Nothing is ordered and nothing is charged until you say so.</li>
                </ul>
              )}

              <p className="body-copy">
                Prefer the phone? <a href={brand.phoneHref}>{brand.phone}</a> rings the shop. Prints by email to{' '}
                <a href={`mailto:${brand.email}`}>{brand.email}</a>.
              </p>
            </div>

            <form id="request" className="card" style={{ padding: 24, position: 'relative' }} onSubmit={submit} noValidate aria-label={part ? 'Send-the-part request' : 'Firm quote request'}>
              {guard.honeypot}
              {!quote && (
                <div className="mode-toggle" role="group" aria-label="What you have">
                  <button type="button" aria-pressed={!part} onClick={() => setMode('drawing')}>I have a drawing or a quantity</button>
                  <button type="button" aria-pressed={part} onClick={() => setMode('part')}>I have a worn part, no drawing</button>
                </div>
              )}
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
                {part ? 'Name, email and what the part is are required. No file to attach: the part itself is what we work from.' : 'Name and email are required. Everything else helps the number.'}
              </p>
              <div className="rfq-grid">
                <label><span className="field-label">Name <span aria-hidden="true" style={{ color: 'var(--error)' }}>*</span></span><input className="input" value={form.contactName} onChange={set('contactName')} autoComplete="name" required aria-required="true" /></label>
                <label><span className="field-label">Email <span aria-hidden="true" style={{ color: 'var(--error)' }}>*</span></span><input className="input" type="email" value={form.email} onChange={set('email')} autoComplete="email" required aria-required="true" /></label>
                <label><span className="field-label">Company</span><input className="input" value={form.company} onChange={set('company')} autoComplete="organization" /></label>
                <label><span className="field-label">Phone</span><input className="input" value={form.phone} onChange={set('phone')} autoComplete="tel" /></label>

                {part ? (
                  <>
                    <label className="full">
                      <span className="field-label">What the part is and what it does <span aria-hidden="true" style={{ color: 'var(--error)' }}>*</span></span>
                      <textarea className="input" rows={3} placeholder="e.g. carton guide on the sealer infeed; rides on a stainless rail. Worn on the leading edge." value={form.notes} onChange={set('notes')} required aria-required="true" />
                    </label>
                    <label className="full"><span className="field-label">What machine is it from?</span><input className="input" placeholder="Make and model if you have it, or what the machine does" value={form.machine} onChange={set('machine')} /></label>
                    <label className="full"><span className="field-label">Material, if known</span><input className="input" placeholder="e.g. white, waxy, floats in water" value={form.material} onChange={set('material')} /></label>
                    <label><span className="field-label">How many</span><input className="input" placeholder="e.g. 2 now, 6 a year" value={form.quantities} onChange={set('quantities')} /></label>
                    <label><span className="field-label">How soon</span><input className="input" placeholder="e.g. line is down / next shutdown" value={form.soon} onChange={set('soon')} /></label>
                    <label className="full check-row">
                      <input type="checkbox" name="returnPart" checked={returnPart} onChange={(e) => setReturnPart(e.target.checked)} />
                      <span>
                        <span className="check-label">Send my original part back with the order.</span>
                        <span className="field-hint">{PART_RETURN || 'Untick this if you do not need the original back.'}</span>
                      </span>
                    </label>
                  </>
                ) : (
                  <>
                    <label className="full"><span className="field-label">Quantities to quote</span><input className="input" placeholder="e.g. 250 / 500 / 1,000, or an annual usage with monthly releases" value={form.quantities} onChange={set('quantities')} /></label>
                    <label><span className="field-label">Critical tolerances</span><input className="input" placeholder="e.g. Ø0.500 +0.000/−0.002" value={form.tolerance} onChange={set('tolerance')} /></label>
                    <label><span className="field-label">Need by</span><input className="input" type="date" value={form.dueDate} onChange={set('dueDate')} /></label>
                    <label className="full"><span className="field-label">Where the part lives</span><input className="input" placeholder="e.g. washdown, 140 °F, touches food, outdoors" value={form.lives} onChange={set('lives')} /><span className="field-hint">Heat and moisture change the material and the tolerance plastic will hold.</span></label>
                    <label className="full"><span className="field-label">Finish, marking, packaging</span><input className="input" placeholder="e.g. deburr all edges, engrave PN, bag 10 per" value={form.finishNotes} onChange={set('finishNotes')} /></label>
                    <label className="full">
                      <span className="field-label">Drawing (PDF, DXF, DWG, JPG or PNG)</span>
                      <input className="input" type="file" accept=".pdf,.dxf,.dwg,.png,.jpg,.jpeg" onChange={pickFile} />
                      <span className="field-hint">One file, up to {MAX_MB} MB. Email anything else to {brand.email} with your reference.</span>
                    </label>
                    <label className="full"><span className="field-label">Anything else</span><textarea className="input" rows={4} placeholder="What the part does, what it mates with, what went wrong with the last supplier." value={form.notes} onChange={set('notes')} /></label>
                  </>
                )}
                <label className="full check-row">
                  <input type="checkbox" name="paperwork" checked={paperwork} onChange={(e) => setPaperwork(e.target.checked)} />
                  <span>
                    <span className="check-label">I need a first-article inspection report and a certificate of conformance.</span>
                    <span className="field-hint">{PAPERWORK_HELP} It adds to the price, and the quote says that it is included.</span>
                  </span>
                </label>
              </div>
              {guard.widget}
              {fileError && <div role="alert" style={{ color: 'var(--error-text)', fontSize: 13, marginTop: 12 }}>{fileError}</div>}
              {error && <div role="alert" style={{ color: 'var(--error-text)', fontSize: 13, marginTop: 12 }}>{error}</div>}
              <button className="btn btn-primary btn-lg" type="submit" disabled={busy} style={{ width: '100%', justifyContent: 'center', marginTop: 18 }}>
                {busy ? 'Sending…' : part ? 'Send the request' : 'Send for a firm quote'}
              </button>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10, textAlign: 'center' }}>
                Customer names and part numbers are never published.{when('paperwork-packet', ' NDA on request.')}
              </div>
            </form>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
