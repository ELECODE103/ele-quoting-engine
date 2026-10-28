import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import PublicLayout from '../components/PublicLayout';
import { api } from '../utils/api';
import { useAuth } from '../utils/authContext';
import { formatCurrency } from '../utils/format';
import brand, { PROCESS_LABELS } from '../brand';

/**
 * Firm-quote request. Reached from the quote builder (with a quoteId) or
 * directly (/rfq) for a buyer who has a print but no CAD yet.
 */
export default function RfqPage() {
  const { quoteId } = useParams();
  const { user } = useAuth();
  const [quote, setQuote] = useState(null);
  const [quoteMissing, setQuoteMissing] = useState(false);
  const [materialNames, setMaterialNames] = useState({});
  const [form, setForm] = useState({
    contactName: user?.name || '', email: user?.email || '', company: user?.company || '', phone: '',
    quantities: '', tolerance: '', finishNotes: '', dueDate: '', notes: '',
  });
  const [drawing, setDrawing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(null);

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

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!form.contactName.trim()) return setError('Add your name so we know who to send it to.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return setError('Add a working email so the quote has somewhere to go.');
    setBusy(true);
    try {
      const res = await api.submitRfq({ ...form, quoteId: quote?.quoteId || quote?.id || quoteId || '' }, drawing);
      setSent(res);
      window.scrollTo(0, 0);
    } catch (err) {
      setError(err.message || `It didn't send. Call ${brand.phone} and we'll take it by phone.`);
    }
    setBusy(false);
  }

  if (sent) {
    return (
      <PublicLayout title="Request received">
        <section className="section">
          <div className="pub-wrap" style={{ maxWidth: 680 }}>
            <div className="eyebrow" style={{ marginBottom: 14 }}>Request received</div>
            <h1 className="display" style={{ marginBottom: 16 }}>It's in the queue.</h1>
            <p className="lede" style={{ marginBottom: 20 }}>
              A firm quote comes back to <b>{form.email}</b> within {sent.turnaroundHours || brand.quoteTurnaroundHours} hours,
              from the person who will run the job. If the print needs a conversation first, you'll hear from us sooner.
            </p>
            <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 28 }}>Reference: {sent.rfqId}</p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
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
    <PublicLayout title="Request a firm quote" description={`Request a firm quote from ${brand.name} for production quantities of machined plastic parts. Quotes within ${brand.quoteTurnaroundHours} hours.`}>
      <section className="section" style={{ paddingTop: 48 }}>
        <div className="pub-wrap">
          <div className="hero-grid" style={{ alignItems: 'start', gap: 48 }}>
            <div>
              <div className="eyebrow" style={{ marginBottom: 14 }}>Firm quote</div>
              <h1 className="display" style={{ fontSize: 36, marginBottom: 14 }}>Tell us what matters. We'll price the rest.</h1>
              <p className="lede" style={{ marginBottom: 24 }}>
                Firm quotes come back within {brand.quoteTurnaroundHours} hours and hold for 30 days. The more you give us —
                a drawing, the quantities you'd actually buy, the two dimensions that have to be right — the sharper the number.
              </p>

              {quote && (
                <div className="card" style={{ padding: 18, marginBottom: 20 }}>
                  <div className="field-label">Parts from your online quote</div>
                  {(quote.lineItems || []).map((li) => (
                    <div key={li.partId} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border-subtle)', fontSize: 13 }}>
                      <div>
                        <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{li.fileName}</div>
                        <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>
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

              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                Prefer the phone? <a href={brand.phoneHref} style={{ color: 'var(--accent)' }}>{brand.phone}</a>. Prints by email to{' '}
                <a href={`mailto:${brand.email}`} style={{ color: 'var(--accent)' }}>{brand.email}</a>.
              </p>
            </div>

            <form className="card" style={{ padding: 24 }} onSubmit={submit} noValidate aria-label="Firm quote request">
              <p style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 14 }}>Name and email are required. Everything else helps the number.</p>
              <div className="rfq-grid">
                <label><span className="field-label">Name <span aria-hidden="true" style={{ color: 'var(--error)' }}>*</span></span><input className="input" value={form.contactName} onChange={set('contactName')} autoComplete="name" required aria-required="true" /></label>
                <label><span className="field-label">Email <span aria-hidden="true" style={{ color: 'var(--error)' }}>*</span></span><input className="input" type="email" value={form.email} onChange={set('email')} autoComplete="email" required aria-required="true" /></label>
                <label><span className="field-label">Company</span><input className="input" value={form.company} onChange={set('company')} autoComplete="organization" /></label>
                <label><span className="field-label">Phone</span><input className="input" value={form.phone} onChange={set('phone')} autoComplete="tel" /></label>
                <label className="full"><span className="field-label">Quantities to quote</span><input className="input" placeholder="e.g. 250 / 500 / 1,000 — or an annual usage with monthly releases" value={form.quantities} onChange={set('quantities')} /></label>
                <label><span className="field-label">Critical tolerances</span><input className="input" placeholder="e.g. Ø0.500 +0.000/−0.002" value={form.tolerance} onChange={set('tolerance')} /></label>
                <label><span className="field-label">Need by</span><input className="input" type="date" value={form.dueDate} onChange={set('dueDate')} /></label>
                <label className="full"><span className="field-label">Finish, marking, packaging</span><input className="input" placeholder="e.g. deburr all edges, laser-mark PN, bag 10 per" value={form.finishNotes} onChange={set('finishNotes')} /></label>
                <label className="full">
                  <span className="field-label">Drawing (PDF, DXF, DWG)</span>
                  <input className="input" type="file" accept=".pdf,.dxf,.dwg,.png,.jpg,.jpeg" onChange={(e) => setDrawing(e.target.files?.[0] || null)} />
                </label>
                <label className="full"><span className="field-label">Anything else</span><textarea className="input" rows={4} placeholder="What the part does, what it mates with, what went wrong with the last supplier." value={form.notes} onChange={set('notes')} /></label>
              </div>
              {error && <div role="alert" style={{ color: 'var(--error-text)', fontSize: 13, marginTop: 12 }}>{error}</div>}
              <button className="btn btn-primary btn-lg" type="submit" disabled={busy} style={{ width: '100%', justifyContent: 'center', marginTop: 18 }}>
                {busy ? 'Sending…' : 'Send for a firm quote'}
              </button>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 10, textAlign: 'center' }}>
                Files and drawings stay private. NDA on request.
              </div>
            </form>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
