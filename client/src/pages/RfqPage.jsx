import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import PublicLayout from '../components/PublicLayout';
import { api } from '../utils/api';
import { useAuth } from '../utils/authContext';
import { formatCurrency } from '../utils/format';
import brand, { PROCESS_LABELS } from '../brand';
import { when } from '../facts';

const within = when('quote-turnaround', (v) => ` within ${v}`);
const UPLOAD_EXT = ['.pdf', '.dxf', '.dwg', '.png', '.jpg', '.jpeg']; // what POST /api/rfq accepts
const MAX_MB = 25;

/**
 * Firm-quote request. Three ways in:
 *   /rfq/:quoteId   from the quote builder, parts pre-filled
 *   /rfq            a drawing and a quantity
 *   /rfq?nocad=1    a worn part and a phone photo, no drawing ("photo" mode)
 * Both modes post to the same endpoint. The photo-mode fields (machine,
 * material, how soon, what it does) are folded into the notes so the server
 * needs no change.
 */
export default function RfqPage() {
  const { quoteId } = useParams();
  const location = useLocation();
  const { user } = useAuth();
  const [quote, setQuote] = useState(null);
  const [quoteMissing, setQuoteMissing] = useState(false);
  const [materialNames, setMaterialNames] = useState({});
  // Always starts in drawing mode so the prerendered page and the first client
  // render match; the effect below switches to photo mode for ?nocad=1.
  const [mode, setMode] = useState('drawing');
  const [form, setForm] = useState({
    contactName: '', email: '', company: '', phone: '',
    quantities: '', tolerance: '', finishNotes: '', dueDate: '', notes: '', lives: '',
    machine: '', material: '', soon: '', size: '',
  });
  const [drawing, setDrawing] = useState(null);
  const [fileError, setFileError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(null);

  useEffect(() => {
    if (quoteId || !/[?&]nocad=1/.test(location.search)) return undefined;
    setMode('photo');
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
  const photo = mode === 'photo';

  function pickFile(e) {
    const f = e.target.files?.[0] || null;
    setFileError('');
    if (f) {
      const ext = (f.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
      if (!UPLOAD_EXT.includes(ext)) { setFileError(`That file type (${ext || 'unknown'}) will not upload. Use a JPG, PNG or PDF, or email it to ${brand.email}.`); e.target.value = ''; return setDrawing(null); }
      if (f.size > MAX_MB * 1024 * 1024) { setFileError(`That file is over ${MAX_MB} MB. Send a smaller photo, or email it to ${brand.email}.`); e.target.value = ''; return setDrawing(null); }
    }
    setDrawing(f);
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!form.contactName.trim()) return setError('Add your name so we know who to send it to.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return setError('Add a working email so the quote has somewhere to go.');
    if (photo && !drawing && !form.notes.trim() && !form.size.trim()) return setError('Attach a photo, or describe the part and its size, so there is something to quote.');
    setBusy(true);
    try {
      // Extra fields ride in the notes: the endpoint stores and emails `notes` as written.
      const extra = photo
        ? [
          'NO DRAWING. Photo request.',
          form.machine && `Machine it is from: ${form.machine}`,
          form.material && `Material, if known: ${form.material}`,
          form.size && `Rough size: ${form.size}`,
          form.soon && `How soon: ${form.soon}`,
          form.lives && `Where the part lives: ${form.lives}`,
          form.notes && `What it does: ${form.notes}`,
        ]
        : [form.lives && `Where the part lives: ${form.lives}`, form.notes];
      const { machine, material, soon, size, lives, ...fields } = form;
      const res = await api.submitRfq({
        ...fields,
        notes: extra.filter(Boolean).join('\n').slice(0, 2000),
        quoteId: quote?.quoteId || quote?.id || quoteId || '',
      }, drawing);
      setSent(res);
      window.scrollTo(0, 0);
    } catch (err) {
      setError(err.message || `It didn't send. Call ${brand.phone} and we'll take it by phone.`);
    }
    setBusy(false);
  }

  if (sent) {
    return (
      <PublicLayout>
        <section className="section">
          <div className="pub-wrap" style={{ maxWidth: 680 }}>
            <div className="eyebrow" style={{ marginBottom: 14 }}>Request received</div>
            <h1 className="display" style={{ marginBottom: 16 }}>It's in the queue.</h1>
            <p className="lede" style={{ marginBottom: 20 }}>
              The person who will cut the part reads it and replies to <b>{form.email}</b>{within}. If the {photo ? 'photo' : 'print'} needs
              a conversation first, that is the reply you will get.
            </p>
            <p className="body-copy" style={{ marginBottom: 20 }}>
              A confirmation email is on its way. {photo ? 'More photos? Reply to it and attach them.' : 'More files? Reply to it and attach them.'}{' '}
              In a hurry, call <a href={brand.phoneHref}>{brand.phone}</a> and give the reference below.
            </p>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 28 }}>Reference: {String(sent.rfqId || '').slice(0, 8).toUpperCase()}</p>
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
              <div className="eyebrow" style={{ marginBottom: 14 }}>Firm quote</div>
              <h1 className="display" style={{ fontSize: 36, marginBottom: 14 }}>Tell us what matters. We'll price the rest.</h1>
              <p className="lede" style={{ marginBottom: 20 }}>
                A firm quote comes from the person who will cut the part{within}{when('quote-valid', (v) => ` and holds for ${v}`)}.
                The more you give us, the sharper the number: a drawing, the quantities you would actually buy, the two
                dimensions that have to be right.
              </p>

              {!quote && (
                <div className="plain-box" style={{ marginBottom: 20 }}>
                  <h2 className="display h3-like" style={{ marginBottom: 6 }}>No drawing?</h2>
                  <p className="body-copy">
                    Attach a photo of the part with a tape measure in it and say what the part does. That is enough to start.{' '}
                    {photo
                      ? 'The form is set up for that now.'
                      : <button type="button" className="linklike-inline" onClick={() => setMode('photo')}>Switch the form to a photo request</button>}
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
              <ul className="checklist" style={{ marginBottom: 20 }}>
                <li>You get a confirmation email with a reference number.</li>
                <li>The person who will cut the part reads the request and replies{within}, with a price or with a question.</li>
                <li>Nothing is ordered and nothing is charged until you say so.</li>
              </ul>

              <p className="body-copy">
                Prefer the phone? <a href={brand.phoneHref}>{brand.phone}</a> rings the shop. Prints and photos by email to{' '}
                <a href={`mailto:${brand.email}`}>{brand.email}</a>.
              </p>
            </div>

            <form id="request" className="card" style={{ padding: 24 }} onSubmit={submit} noValidate aria-label={photo ? 'Photo quote request' : 'Firm quote request'}>
              {!quote && (
                <div className="mode-toggle" role="group" aria-label="What you have">
                  <button type="button" aria-pressed={!photo} onClick={() => setMode('drawing')}>I have a drawing or a quantity</button>
                  <button type="button" aria-pressed={photo} onClick={() => setMode('photo')}>I have a worn part, no drawing</button>
                </div>
              )}
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>Name and email are required. Everything else helps the number.</p>
              <div className="rfq-grid">
                <label><span className="field-label">Name <span aria-hidden="true" style={{ color: 'var(--error)' }}>*</span></span><input className="input" value={form.contactName} onChange={set('contactName')} autoComplete="name" required aria-required="true" /></label>
                <label><span className="field-label">Email <span aria-hidden="true" style={{ color: 'var(--error)' }}>*</span></span><input className="input" type="email" value={form.email} onChange={set('email')} autoComplete="email" required aria-required="true" /></label>
                <label><span className="field-label">Company</span><input className="input" value={form.company} onChange={set('company')} autoComplete="organization" /></label>
                <label><span className="field-label">Phone</span><input className="input" value={form.phone} onChange={set('phone')} autoComplete="tel" /></label>

                {photo ? (
                  <>
                    <label className="full">
                      <span className="field-label">Photo or sketch (JPG, PNG or PDF)</span>
                      <input className="input" type="file" accept=".jpg,.jpeg,.png,.pdf" onChange={pickFile} />
                      <span className="field-hint">Lay a tape measure or a ruler next to the part. One file here, up to {MAX_MB} MB; reply to the confirmation email with more.</span>
                    </label>
                    <label className="full"><span className="field-label">What machine is it from?</span><input className="input" placeholder="Make and model if you have it, or what the machine does" value={form.machine} onChange={set('machine')} /></label>
                    <label><span className="field-label">Material, if known</span><input className="input" placeholder="e.g. white, waxy, floats in water" value={form.material} onChange={set('material')} /></label>
                    <label><span className="field-label">Rough size</span><input className="input" placeholder={'e.g. 14" long × 2" × 3/4"'} value={form.size} onChange={set('size')} /></label>
                    <label><span className="field-label">How many</span><input className="input" placeholder="e.g. 2 now, 6 a year" value={form.quantities} onChange={set('quantities')} /></label>
                    <label><span className="field-label">How soon</span><input className="input" placeholder="e.g. line is down / next shutdown" value={form.soon} onChange={set('soon')} /></label>
                    <label className="full"><span className="field-label">What it does and what it runs against</span><textarea className="input" rows={3} placeholder="e.g. guides cartons into the sealer; rides on a stainless rail. Worn on the leading edge." value={form.notes} onChange={set('notes')} /></label>
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
                      <span className="field-hint">One file, up to {MAX_MB} MB. Reply to the confirmation email with anything else.</span>
                    </label>
                    <label className="full"><span className="field-label">Anything else</span><textarea className="input" rows={4} placeholder="What the part does, what it mates with, what went wrong with the last supplier." value={form.notes} onChange={set('notes')} /></label>
                  </>
                )}
              </div>
              {fileError && <div role="alert" style={{ color: 'var(--error-text)', fontSize: 13, marginTop: 12 }}>{fileError}</div>}
              {error && <div role="alert" style={{ color: 'var(--error-text)', fontSize: 13, marginTop: 12 }}>{error}</div>}
              <button className="btn btn-primary btn-lg" type="submit" disabled={busy} style={{ width: '100%', justifyContent: 'center', marginTop: 18 }}>
                {busy ? 'Sending…' : photo ? 'Send the photo for a quote' : 'Send for a firm quote'}
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
