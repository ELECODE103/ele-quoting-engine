import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../utils/api';
import HumanGate from '../components/security/HumanGate';
import { formatCurrency, formatDim, formatShipDate } from '../utils/format';
import ThreeViewer from '../components/ThreeViewer';
import DxfPreview from '../components/DxfPreview';
import DFMPanel from '../components/DFMPanel';
import PartConfigurator from '../components/PartConfigurator';
import OrderSummary from '../components/OrderSummary';
import ProcessPicker from '../components/ProcessPicker';
import { when, SENT_OUT_FINISHES } from '../facts';
import brand, { PROCESS_LABELS } from '../brand';
import { sessionQuoteId, storedQuoteId, storeQuoteId, authPath } from '../utils/returnTo';
import { describeRefusal } from '../utils/messages';
import { useAuth } from '../utils/authContext';

// Closest stock thickness to the model's thinnest dimension (routing materials carry a thickness table).
function pickThickness(mat, geometry) {
  const list = mat?.thicknesses || [];
  if (list.length === 0) return 0;
  if (geometry?.is2D) return 0; // a DXF has no thickness: the customer picks it before a price shows
  const bb = geometry?.boundingBox || {};
  const t = Math.min(bb.width || Infinity, bb.height || Infinity, bb.depth || Infinity);
  if (!Number.isFinite(t)) return list[Math.min(2, list.length - 1)].mm;
  return list.reduce((best, x) => (Math.abs(x.mm - t) < Math.abs(best.mm - t) ? x : best), list[0]).mm;
}

// Deep link from the material and service pages: /quote?process=cnc&material=cnc-delrin
// opens the builder on that process with that material preselected for uploaded parts.
const LINKABLE_PROCESSES = ['cnc', 'routing', '3d-printing'];
// DXF parts are priced only once the customer has settled what the file cannot say:
// the drawing units (when the file is unitless) and the stock thickness.
const isDxfName = (name) => /\.dxf$/i.test(name || '');
// What the upload accepts. Checked before a file leaves the browser, so a drawing or a photo
// dropped here is answered at once and does not count against the day's upload allowance.
const CAD_TYPES = ['.step', '.stp', '.stl', '.3mf', '.iges', '.igs', '.dxf'];
const extOf = (name) => (String(name || '').match(/\.[^.]+$/) || [''])[0].toLowerCase();
const DRAWING_TYPES = ['.pdf', '.dwg', '.png', '.jpg', '.jpeg'];
function dxfTodo(p) {
  if (!p.geometry?.is2D) return null;
  if (p.geometry.profile2d?.units?.needsConfirmation) return `Choose inches or millimetres for ${p.fileName} to see a price.`;
  if (!(p.thicknessMm > 0)) return `Select a stock thickness for ${p.fileName} to see a price.`;
  return null;
}

export default function QuoteBuilder() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const linkedProcess = LINKABLE_PROCESSES.includes(searchParams.get('process')) ? searchParams.get('process') : 'cnc';
  const linkedMaterial = searchParams.get('material') || '';
  // Config data from server
  const [processes, setProcesses] = useState([]);
  const [materials, setMaterials] = useState([]);
  const [finishes, setFinishes] = useState([]);
  const [leadTimes, setLeadTimes] = useState([]);

  // Parts state
  const [parts, setParts] = useState([]);          // { partId, fileName, geometry, dfm, meshPreview, materialSlug, grade, thicknessMm, finishSlug, quantity, process, subProcess, layerHeight, infill }
  const [activePart, setActivePart] = useState(null);
  const [selectedLeadTime, setSelectedLeadTime] = useState('standard');
  const [paperwork, setPaperwork] = useState(false); // first-article report + certificate of conformance: off unless the buyer ticks it
  const [selectedProcess, setSelectedProcess] = useState(linkedProcess);
  // Material slug to preselect on upload; cleared when the buyer switches process.
  const [preferredMaterial, setPreferredMaterial] = useState(linkedMaterial);
  // Quote from server
  const [quote, setQuote] = useState(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState(null);

  // UI
  const [uploading, setUploading] = useState(false);
  const [uploadErrors, setUploadErrors] = useState([]);
  const [showDFM, setShowDFM] = useState(false);
  const [dxfOffer, setDxfOffer] = useState(null);   // DXF files waiting on "switch to routing?"
  const [unitsBusy, setUnitsBusy] = useState(false);
  const fileRef = useRef();
  const quoteTimer = useRef(null);
  const { isAuthenticated } = useAuth();
  // The files of the last upload that was refused whole (server busy, the check not passed): "Try again" sends them again.
  const [retryFiles, setRetryFiles] = useState(null);
  const errorBox = useRef(null);
  useEffect(() => { if (uploadErrors.length > 0 && errorBox.current) errorBox.current.focus(); }, [uploadErrors]);

  // Notes + optional drawing for the shop. Stored with the quote; never priced.
  const [notes, setNotes] = useState('');
  const [drawingName, setDrawingName] = useState('');
  const [drawingBusy, setDrawingBusy] = useState(false);
  const [drawingError, setDrawingError] = useState('');
  const drawingRef = useRef();

  // Load config on mount, then reopen the quote this tab was working on (or the
  // one named by ?quote=, e.g. from Reorder). This is what brings a buyer's
  // parts and settings back after the sign-in / register detour or a reload.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [procs, lts] = await Promise.all([api.getProcesses(), api.getLeadTimes()]);
        if (cancelled) return;
        setProcesses(procs);
        setLeadTimes(lts);

        const fromLink = searchParams.get('quote');
        const savedId = fromLink || storedQuoteId();
        let saved = null;
        if (savedId) {
          saved = await api.getQuoteSession(savedId).catch(() => null);
          if (!saved || saved.parts.length === 0) { saved = null; if (!fromLink) storeQuoteId(null); }
        }
        const process = saved?.process || linkedProcess;
        const [mats, fins] = await Promise.all([api.getMaterials(process), api.getFinishes(process)]);
        if (cancelled) return;
        setMaterials(mats);
        setFinishes(fins);
        if (saved) {
          storeQuoteId(saved.quoteId);
          setSelectedProcess(process);
          if (lts.some((lt) => lt.slug === saved.leadTimeSlug)) setSelectedLeadTime(saved.leadTimeSlug);
          setPaperwork(Boolean(saved.paperwork));
          setNotes(saved.notes || '');
          setDrawingName(saved.drawingFileName || '');
          setParts(saved.parts.map((p) => ({ quantity: 1, infill: 0.2, ...p, process: p.process || process })));
          setActivePart(saved.parts[0].partId);
        }
        if (fromLink) setSearchParams({}, { replace: true });
      } catch (err) {
        console.error('Failed to load config:', err);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-refresh quote when parts change
  // Anodize and powder coat are sent out to a finisher, so a quote with either
  // one ships on Standard: picking one while a faster lead time is selected
  // moves the quote back to Standard (the picker explains why).
  useEffect(() => {
    if (selectedLeadTime !== 'standard' && parts.some((p) => SENT_OUT_FINISHES.has(p.finishSlug))) setSelectedLeadTime('standard');
  }, [parts, selectedLeadTime]);

  const fetchQuote = useCallback(async () => {
    if (parts.length === 0) return;
    const todo = parts.map(dxfTodo).find(Boolean);
    if (todo) { setQuote(null); setQuoteError(todo); return; }
    setQuoteLoading(true);
    try {
      const configs = parts.map((p) => ({
        partId: p.partId,
        materialSlug: p.materialSlug,
        grade: p.grade,
        thicknessMm: p.thicknessMm,
        finishSlug: p.finishSlug,
        quantity: p.quantity,
        process: p.process || selectedProcess,
        subProcess: p.subProcess || '',
        layerHeight: p.layerHeight || 0,
        infill: p.infill || 0.2,
      }));
      // One quote per session: the same id is sent with every refresh so the
      // server updates that quote instead of saving a new draft each time. If
      // that quote has since been ordered, the server answers with a new id.
      const q = await api.getQuote(configs, selectedLeadTime, { quoteId: sessionQuoteId(), process: selectedProcess, notes, paperwork });
      storeQuoteId(q.quoteId);
      setQuote(q);
      setDrawingName(q.drawingFileName || '');
      setQuoteError(null);
    } catch (err) {
      setQuoteError(err?.message || `We couldn't price this setup. Change the material or quantity and try again, or call ${brand.phone}.`);
    }
    setQuoteLoading(false);
  }, [parts, selectedLeadTime, selectedProcess, notes, paperwork]);

  async function attachDrawing(file) {
    if (!file || !quote?.quoteId) return;
    setDrawingBusy(true);
    setDrawingError('');
    try {
      const r = await api.uploadQuoteDrawing(quote.quoteId, file);
      setDrawingName(r.drawingFileName);
    } catch (err) {
      setDrawingError(err.message);
    }
    setDrawingBusy(false);
    if (drawingRef.current) drawingRef.current.value = '';
  }

  async function removeDrawing() {
    if (!quote?.quoteId) return;
    setDrawingBusy(true);
    try { await api.removeQuoteDrawing(quote.quoteId); setDrawingName(''); } catch (err) { setDrawingError(err.message); }
    setDrawingBusy(false);
  }

  useEffect(() => {
    if (parts.length === 0) { setQuote(null); return; }
    clearTimeout(quoteTimer.current);
    quoteTimer.current = setTimeout(() => fetchQuote(), 400);
    return () => clearTimeout(quoteTimer.current);
  }, [fetchQuote]);

  // File upload handler
  // `ctx` carries the process/materials/finishes to use when the caller has just switched process.
  const handleFiles = useCallback(async (fileList, ctx) => {
    if (!fileList || fileList.length === 0) return;
    const all = Array.from(fileList);
    // Anything that is not a model is answered here, in words, before it is sent.
    const wrong = all.filter((f) => !CAD_TYPES.includes(extOf(f.name)));
    const files = all.filter((f) => CAD_TYPES.includes(extOf(f.name)));
    const wrongErrors = wrong.map((f) => ({
      fileName: f.name,
      error: DRAWING_TYPES.includes(extOf(f.name))
        ? `The instant quote reads 3D models, not drawings or photos. Upload a STEP, STL, IGES or 3MF of the part (or a DXF for a flat routed part), or send this file with a firm-quote request and a person prices it.`
        : `We can't read ${extOf(f.name) || 'that kind of'} files here. Upload a STEP, STL, IGES or 3MF model, or a DXF for a flat routed part.`,
      action: DRAWING_TYPES.includes(extOf(f.name)) ? 'rfq' : null,
    }));
    setRetryFiles(null);
    if (files.length === 0) { setUploadErrors(wrongErrors); if (fileRef.current) fileRef.current.value = ''; return; }
    const proc = ctx?.process || selectedProcess;
    // A DXF is a 2D profile: routing only. Offer the switch instead of failing the upload.
    if (proc !== 'routing' && files.some((f) => isDxfName(f.name))) { setDxfOffer(files); return; }
    const mats = ctx?.materials || materials;
    const fins = ctx?.finishes || finishes;
    setUploading(true);
    setUploadErrors([]);

    try {
      const result = await api.uploadFiles(files, proc);
      const defaultMat = mats.find((m) => m.slug === preferredMaterial) || mats[0];

      const newParts = result.parts.map((p) => ({
        partId: p.partId,
        editKey: p.editKey, // lets this browser, and only this one, set a DXF's units
        fileName: p.fileName,
        geometry: p.geometry,
        dfm: p.dfm,
        meshPreview: p.meshPreview,
        materialSlug: defaultMat?.slug || 'cnc-delrin',
        grade: defaultMat?.grades?.[0]?.name || '',
        thicknessMm: pickThickness(defaultMat, p.geometry),
        finishSlug: fins[0]?.slug || 'raw',
        quantity: 1,
        process: proc,
        subProcess: proc === 'cnc' ? 'milling' : (defaultMat?.subProcess || ''),
        layerHeight: defaultMat?.defaultLayerHeight || 0,
        infill: 0.2,
        dfmAll: p.dfmAll,
      }));

      setParts((prev) => [...prev, ...newParts]);
      setActivePart((prev) => {
        if (newParts.length > 0 && !prev) return newParts[0].partId;
        return prev;
      });
      // Each refused file comes back with the server's reason and a code; the words on screen are the catalogue's.
      const refused = (result.errors || []).map((e) => {
        const said = describeRefusal({ status: 200, code: e.code, serverMessage: e.error, data: e, context: 'upload' });
        return { fileName: e.fileName, error: said.message, code: e.code, action: e.offerRfq ? 'rfq' : said.action };
      });
      if (refused.some((e) => e.code === 'busy')) setRetryFiles(files.filter((f) => refused.some((e) => e.code === 'busy' && e.fileName === f.name)));
      setUploadErrors([...wrongErrors, ...refused]);
    } catch (err) {
      // The whole upload was refused (or never arrived). `err.message` is already the buyer's wording.
      if (err.action === 'retry' || err.status === 0) setRetryFiles(files);
      setUploadErrors([...wrongErrors, { fileName: files.length === 1 ? files[0].name : `${files.length} files`, error: err.message, code: err.code, action: err.data?.offerRfq ? 'rfq' : err.action }]);
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = ''; // so the same file can be chosen again
  }, [materials, finishes, selectedProcess, preferredMaterial]);

  const handleDrop = useCallback((e) => { e.preventDefault(); handleFiles(e.dataTransfer.files); }, [handleFiles]);

  const updatePart = (partId, updates) => {
    setParts((prev) => prev.map((p) => p.partId === partId ? { ...p, ...updates } : p));
  };

  const removePart = (partId) => {
    setParts((prev) => prev.filter((p) => p.partId !== partId));
    if (activePart === partId) {
      const remaining = parts.filter((p) => p.partId !== partId);
      setActivePart(remaining[0]?.partId || null);
    }
  };

  async function handleProcessChange(processSlug) {
    if (processSlug === selectedProcess) return;
    const dxfPart = processSlug !== 'routing' && parts.find((p) => p.geometry?.is2D);
    if (dxfPart) {
      setUploadErrors([{ fileName: dxfPart.fileName, error: `A DXF is a 2D profile, so it can only be quoted for CNC routing. Remove it, or upload a STEP of the part, to quote ${PROCESS_LABELS[processSlug] || processSlug}.` }]);
      return;
    }
    setSelectedProcess(processSlug);
    setPreferredMaterial('');
    // Re-fetch materials and finishes for this process
    const [mats, fins] = await Promise.all([
      api.getMaterials(processSlug),
      api.getFinishes(processSlug),
    ]);
    setMaterials(mats);
    setFinishes(fins);
    // Update all existing parts to use this process and reset material
    if (mats.length > 0) {
      setParts((prev) => prev.map((p) => ({
        ...p,
        process: processSlug,
        subProcess: processSlug === 'cnc' ? 'milling' : (mats[0].subProcess || ''),
        materialSlug: mats[0].slug,
        grade: mats[0].grades?.[0]?.name || '',
        thicknessMm: pickThickness(mats[0], p.geometry),
        finishSlug: fins[0]?.slug || 'raw',
        layerHeight: mats[0].defaultLayerHeight || 0,
        infill: 0.2,
      })));
    }
    return { mats, fins };
  }

  // "Switch to CNC routing" from the DXF offer: change process, then upload the held files with it.
  async function acceptDxfOffer() {
    const files = dxfOffer;
    setDxfOffer(null);
    const r = await handleProcessChange('routing');
    await handleFiles(files, { process: 'routing', materials: r?.mats, finishes: r?.fins });
  }

  // DXF units: the server re-reads the drawing at the chosen scale and returns the part again.
  async function handleUnitsChange(partId, units) {
    setUnitsBusy(true);
    try {
      const p = await api.setPartUnits(partId, units, parts.find((x) => x.partId === partId)?.editKey);
      updatePart(partId, { geometry: p.geometry, dfm: p.dfm, dfmAll: p.dfmAll });
      setUploadErrors([]);
    } catch (err) {
      setUploadErrors([{ fileName: parts.find((x) => x.partId === partId)?.fileName || 'Units', error: err.message }]);
    }
    setUnitsBusy(false);
  }

  const active = parts.find((p) => p.partId === activePart);
  const activeLineItem = quote?.lineItems?.find((li) => li.partId === activePart);
  const activeDfm = quote?.dfmByPartId?.[activePart] || active?.dfmAll?.[selectedProcess] || active?.dfm;
  const needsRfq = Boolean(quote?.gate?.requiresRfq);
  const cutLabel = selectedProcess === 'routing' ? 'Router cutting' : 'Laser cutting';

  return (
    <div className={parts.length > 0 ? 'qb-grid' : ''} style={{ display: 'grid', gridTemplateColumns: parts.length > 0 ? undefined : '1fr', minHeight: 'calc(100vh - 53px)' }}>
      {/* The one-time bot check before the first upload (renders nothing until it is needed). */}
      <HumanGate />

      {/* ═══ LEFT SIDEBAR: Parts List ═══ */}
      {parts.length > 0 && (
        <aside style={{ borderRight: '1px solid var(--border-primary)', padding: 16, overflowY: 'auto', background: 'var(--bg-secondary)' }}>
          <div className="flex-between" style={{ marginBottom: 16 }}>
            <span className="font-display" style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Parts ({parts.length})
            </span>
            <button className="btn btn-primary" style={{ fontSize: 11, padding: '6px 12px' }} onClick={() => fileRef.current?.click()}>
              + Add part
            </button>
          </div>

          {parts.map((pt, i) => {
            const lineItem = quote?.lineItems?.find((li) => li.partId === pt.partId);
            return (
              <button
                type="button"
                key={pt.partId}
                className="fade-up"
                aria-pressed={activePart === pt.partId}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left',
                  padding: '10px 12px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
                  transition: 'all 0.15s', marginBottom: 4,
                  border: `1px solid ${activePart === pt.partId ? 'var(--border-primary)' : 'transparent'}`,
                  background: activePart === pt.partId ? 'var(--bg-hover)' : 'transparent',
                  animationDelay: `${i * 50}ms`,
                }}
                onClick={() => setActivePart(pt.partId)}
              >
                <div style={{
                  width: 40, height: 40, flexShrink: 0, background: 'var(--bg-primary)',
                  borderRadius: 6, border: '1px solid var(--border-primary)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 16, color: 'var(--accent)',
                }}>
                  ▲
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="truncate" style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)' }}>
                    {pt.fileName}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2, whiteSpace: 'nowrap' }}>
                    {formatDim(pt.geometry?.flatWidth || 0)} × {formatDim(pt.geometry?.flatHeight || 0)} · qty {pt.quantity}
                  </div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)', whiteSpace: 'nowrap' }}>
                  {lineItem ? formatCurrency(lineItem.lineTotal) : '…'}
                </div>
              </button>
            );
          })}
        </aside>
      )}

      {/* ═══ CENTER: Upload / Preview / Config ═══ */}
      <main style={{
        padding: parts.length > 0 ? 24 : 48,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: parts.length === 0 ? 'center' : 'flex-start',
        overflowY: 'auto',
      }}>
        <input
          ref={fileRef} type="file" multiple
          accept=".step,.stp,.stl,.3mf,.iges,.igs,.dxf"
          style={{ display: 'none' }}
          onChange={(e) => handleFiles(e.target.files)}
        />

        {/* Empty state: process picker + dropzone */}
        {parts.length === 0 && !uploading && (
          <div style={{ maxWidth: 640, width: '100%', marginBottom: 16 }}>
            <div className="field-label" style={{ marginBottom: 10 }}>How should we make it?</div>
            <ProcessPicker processes={processes} value={selectedProcess} onChange={handleProcessChange} />
          </div>
        )}
        {parts.length === 0 && !uploading && (
          <div
            className="dropzone"
            role="button"
            tabIndex={0}
            aria-labelledby="dropzone-title"
            aria-describedby="dropzone-help"
            style={{ maxWidth: 640, width: '100%' }}
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
          >
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" style={{ marginBottom: 16, opacity: 0.7 }}>
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <div id="dropzone-title" className="font-display" style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
              Upload a part
            </div>
            <div id="dropzone-help" style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.7, maxWidth: 460, margin: '0 auto' }}>
              Drop a STEP, STL, IGES or 3MF file here, or click to choose one. Flat part? Drop a DXF and pick the thickness. The price shows in a few seconds.<br />
              Up to {brand.rfqQuantityThreshold} pieces checks out online. More than that, a person quotes it{when('quote-turnaround', (v) => ` within ${v}`)}.
            </div>
            {preferredMaterial && materials.some((m) => m.slug === preferredMaterial) && (
              <div data-testid="preselected-material" style={{ marginTop: 14, fontSize: 12.5, color: 'var(--accent)', fontWeight: 600 }}>
                Material preselected: {materials.find((m) => m.slug === preferredMaterial).name}. You can change it after upload.
              </div>
            )}
            <div style={{ marginTop: 24, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
              {['STEP', 'STL', 'IGES', '3MF', 'DXF'].map((f) => (
                <span key={f} style={{ fontSize: 10, padding: '4px 10px', borderRadius: 4, background: 'var(--bg-card)', border: '1px solid var(--border-primary)', color: 'var(--text-muted)', fontWeight: 500 }}>
                  {f}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Upload progress */}
        {uploading && (
          <div className="flex-col fade-in" style={{ alignItems: 'center', gap: 20, paddingTop: 48 }}>
            <div className="spinner" style={{ width: 40, height: 40, borderWidth: 3 }} />
            <div className="font-display" style={{ fontSize: 14, color: 'var(--text-muted)' }} role="status">Reading the geometry…</div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', textAlign: 'center', maxWidth: 360 }}>A few seconds for most files. A large or very detailed model can take up to a minute; the price appears here when it is read, so there is no need to upload it twice.</div>
          </div>
        )}

        {/* DXF with another process selected: offer routing rather than refusing the file */}
        {dxfOffer && !uploading && (
          <div className="gate-box fade-up" role="alert" aria-label="DXF files are quoted for CNC routing" style={{ marginBottom: 16, maxWidth: 720, width: '100%', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
            <span style={{ flex: '1 1 320px' }}>
              <b>{dxfOffer.filter((f) => isDxfName(f.name)).map((f) => f.name).join(', ')} is a 2D drawing.</b>{' '}
              A DXF has an outline but no thickness, so we cut it from sheet on the router — it cannot be quoted for {PROCESS_LABELS[selectedProcess] || selectedProcess}.
              {parts.length > 0 ? ' Switching re-prices every part in this quote as routed.' : ''}
            </span>
            <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-primary" onClick={acceptDxfOffer}>Switch to CNC routing and upload</button>
              <button type="button" className="btn btn-ghost" onClick={() => setDxfOffer(null)}>Cancel</button>
            </span>
          </div>
        )}

        {/* Upload errors: what happened to each file, and what to do next */}
        {uploadErrors.length > 0 && (
          <div className="card fade-up upload-problems" role="alert" tabIndex={-1} ref={errorBox}>
            <div className="upload-problems-head">
              {uploadErrors.length === 1 ? 'This file was not priced' : `${uploadErrors.length} files were not priced`}
              {parts.length > 0 ? '. The parts already in your quote are untouched.' : ''}
            </div>
            <ul>
              {uploadErrors.map((err, i) => (
                <li key={i}><b>{err.fileName}</b> {err.error}</li>
              ))}
            </ul>
            <div className="notice-actions">
              {retryFiles && <button type="button" className="btn btn-primary" onClick={() => handleFiles(retryFiles)}>Try again</button>}
              {uploadErrors.some((e) => e.action === 'rfq') && (
                <button type="button" className="btn btn-outline" onClick={() => navigate(quote?.quoteId ? `/rfq/${quote.quoteId}` : '/rfq')}>Request a firm quote</button>
              )}
              <button type="button" className="btn btn-ghost" onClick={() => { setUploadErrors([]); setRetryFiles(null); }}>Dismiss</button>
              <span className="upload-problems-reach">Or call <a href={brand.phoneHref}>{brand.phone}</a>.</span>
            </div>
          </div>
        )}

        {/* Active part view */}
        {parts.length > 0 && !uploading && active && (
          <div className="fade-up" style={{ width: '100%', maxWidth: 720 }}>
            {/* Process switch */}
            <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <ProcessPicker compact processes={processes} value={selectedProcess} onChange={handleProcessChange} />
              <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Switching re-prices every part in this quote.</span>
            </div>

            {/* Gate notice: shown up top so it isn't buried in the rail (or below the fold on a phone) */}
            {needsRfq && (
              <div className="gate-box" role="status" style={{ marginBottom: 16, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
                <span style={{ flex: '1 1 320px' }}>
                  <b>This one needs a person before you can buy.</b> The number below is budgetary.{' '}
                  {quote?.gate?.reasons?.[0]?.message ? `${quote.gate.reasons[0].message}.` : ''}
                </span>
                <button type="button" className="btn btn-primary" onClick={() => navigate(quote?.quoteId ? `/rfq/${quote.quoteId}` : '/rfq')}>
                  Request a firm quote →
                </button>
              </div>
            )}

            {/* View toggle */}
            <div className="qb-toolbar">
              <div role="tablist" aria-label="Part view" style={{ display: 'flex', gap: 8 }}>
                <button type="button" role="tab" aria-selected={!showDFM} className={`btn ${showDFM ? 'btn-ghost' : 'btn-ghost active'}`} onClick={() => setShowDFM(false)}>
                  {active.geometry?.is2D ? '2D preview' : '3D preview'}
                </button>
                <button type="button" role="tab" aria-selected={showDFM} className={`btn ${showDFM ? 'btn-ghost active' : 'btn-ghost'}`} onClick={() => setShowDFM(true)}>
                  DFM check
                </button>
              </div>

              {/* Price badge */}
              {activeLineItem && (
                <div className="qb-price" aria-live="polite">
                  {quoteLoading && <div className="spinner" aria-label="Updating price" />}
                  <span className="price-label">{needsRfq ? 'Budgetary' : 'Instant price'}</span>
                  <span className="font-display" style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)' }}>
                    {formatCurrency(activeLineItem.lineTotal)}
                  </span>
                  {active.quantity > 1 && (
                    <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                      {formatCurrency(activeLineItem.perUnit.final)} each
                    </span>
                  )}
                </div>
              )}
              {/* DXF: say what is still needed instead of showing a price built on a guess */}
              {!activeLineItem && dxfTodo(active) && (
                <div className="qb-price" role="status" style={{ whiteSpace: 'normal', maxWidth: 300, textAlign: 'right' }}>
                  <span style={{ fontSize: 11.5, color: 'var(--warn-text)', fontWeight: 600 }}>
                    {active.geometry.profile2d?.units?.needsConfirmation ? 'Choose inches or millimetres to see the price' : 'Select a stock thickness to see the price'}
                  </span>
                </div>
              )}
            </div>

            {/* 3D Preview or DFM */}
            {!showDFM && active.geometry?.is2D ? (
              <div className="card" style={{ marginBottom: 20, overflow: 'hidden' }}>
                <DxfPreview
                  profile={active.geometry.profile2d}
                  dfm={activeDfm}
                  materialColor={materials.find((m) => m.slug === active.materialSlug)?.color || '#F4F4F5'}
                  onUnitsChange={(u) => handleUnitsChange(active.partId, u)}
                  unitsBusy={unitsBusy}
                />
              </div>
            ) : !showDFM ? (
              <div className="card" style={{ marginBottom: 20, overflow: 'hidden' }}>
                <div style={{ height: 360, position: 'relative' }}>
                  <ThreeViewer
                    positions={active.meshPreview?.positions}
                    color={materials.find((m) => m.slug === active.materialSlug)?.color || '#4F8CFF'}
                  />
                  {/* Overlay info */}
                  <div className="viewer-meta">
                    <span>{formatDim(active.geometry?.flatWidth || 0)} × {formatDim(active.geometry?.flatHeight || 0)}</span>
                    <span>{((active.geometry?.flatArea || 0) / 645.16).toFixed(1)} in² footprint</span>
                    <span className="hint">Drag to turn · Ctrl + scroll or +/− to zoom</span>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ marginBottom: 20 }}>
                <DFMPanel dfm={activeDfm} dfmAll={active.dfmAll} process={selectedProcess} />
              </div>
            )}

            {/* Part Configurator */}
            <PartConfigurator
              part={active}
              materials={materials}
              finishes={finishes}
              onChange={(updates) => updatePart(active.partId, updates)}
              onRemove={() => removePart(active.partId)}
              selectedProcess={selectedProcess}
            />

            {/* Price breakdown */}
            {activeLineItem && (
              <div className="card fade-up" style={{ padding: 20, marginTop: 16 }}>
                <span className="font-display" style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', display: 'block', marginBottom: 12 }}>
                  Price per piece
                </span>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px 16px', fontSize: 11 }}>
                  <PriceRow label="Material" value={activeLineItem.perUnit.material} />
                  {activeLineItem.perUnit.cutting > 0 && <PriceRow label={cutLabel} value={activeLineItem.perUnit.cutting} />}
                  {activeLineItem.perUnit.bending > 0 && <PriceRow label="Bending" value={activeLineItem.perUnit.bending} />}
                  {activeLineItem.perUnit.holes > 0 && <PriceRow label="Holes & features" value={activeLineItem.perUnit.holes} />}
                  {activeLineItem.perUnit.machining > 0 && <PriceRow label="Machining" value={activeLineItem.perUnit.machining} />}
                  {activeLineItem.perUnit.tooling > 0 && <PriceRow label="Tooling" value={activeLineItem.perUnit.tooling} />}
                  {activeLineItem.perUnit.setup > 0 && <PriceRow label="Setup" value={activeLineItem.perUnit.setup} />}
                  {activeLineItem.perUnit.machineTime > 0 && <PriceRow label="Machine time" value={activeLineItem.perUnit.machineTime} />}
                  {activeLineItem.perUnit.support > 0 && <PriceRow label="Support material" value={activeLineItem.perUnit.support} />}
                  {activeLineItem.perUnit.finish > 0 && <PriceRow label="Finish" value={activeLineItem.perUnit.finish} />}
                  <div style={{ gridColumn: '1 / -1', borderTop: '1px solid var(--border-subtle)', margin: '4px 0' }} />
                  {activeLineItem.perUnit.discount > 0 && (
                    <PriceRow label={`Volume discount (${(activeLineItem.perUnit.discount * 100).toFixed(0)}%)`} value={-activeLineItem.perUnit.discountAmount} color="var(--success-text)" />
                  )}
                  <PriceRow label="Per piece" value={activeLineItem.perUnit.final} bold />
                </div>
              </div>
            )}

            {/* Volume pricing (quantity breaks) — click a tier to apply it */}
            {activeLineItem?.quantityBreaks?.length > 1 && (
              <div className="card fade-up" style={{ padding: 20, marginTop: 16 }}>
                <span className="font-display" style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', display: 'block', marginBottom: 4 }}>
                  Quantity breaks
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-dim)', display: 'block', marginBottom: 12 }}>
                  Setup is spread across the run, so the per-piece price drops. Click a quantity to use it.
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {activeLineItem.quantityBreaks.map((b) => {
                    const isActive = b.qty === active.quantity;
                    return (
                      <button
                        key={b.qty}
                        onClick={() => updatePart(active.partId, { quantity: b.qty })}
                        aria-label={`${b.qty} pc${b.qty > 1 ? 's' : ''}, ${formatCurrency(b.perUnit)} each, ${formatCurrency(b.lineTotal)}: use this quantity`}
                        aria-pressed={isActive}
                        style={{
                          display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 16, alignItems: 'center',
                          padding: '7px 10px', borderRadius: 6, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
                          border: `1px solid ${isActive ? 'var(--accent)' : 'transparent'}`,
                          background: isActive ? 'var(--accent-bg)' : 'transparent',
                          fontSize: 11,
                        }}
                      >
                        <span style={{ fontWeight: isActive ? 700 : 500, color: isActive ? 'var(--accent)' : 'var(--text-secondary)' }}>
                          {b.qty} pc{b.qty > 1 ? 's' : ''}
                        </span>
                        <span style={{ color: 'var(--text-muted)' }}>{formatCurrency(b.perUnit)} each</span>
                        <span style={{ fontWeight: 500, color: 'var(--text-secondary)' }}>{formatCurrency(b.lineTotal)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Notes + drawing for the shop (whole order). Stored with the order; never changes the price. */}
            {quote && (
              <div className="card fade-up" style={{ padding: 20, marginTop: 16 }}>
                <label htmlFor="qb-notes" className="font-display" style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', display: 'block', marginBottom: 4 }}>
                  Notes for the shop <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}>(optional)</span>
                </label>
                <span style={{ fontSize: 11, color: 'var(--text-dim)', display: 'block', marginBottom: 10 }}>
                  Which dimension matters, what it mates with, how to mark or bag it. Notes and drawings don't change the instant price.
                </span>
                <textarea
                  id="qb-notes"
                  className="input"
                  rows={3}
                  maxLength={2000}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="e.g. The Ø0.500 bore is the one that matters. Deburr all edges."
                />
                <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12 }}>
                  <input ref={drawingRef} id="qb-drawing" type="file" accept=".pdf,application/pdf" className="sr-only" onChange={(e) => attachDrawing(e.target.files?.[0])} />
                  {drawingName ? (
                    <>
                      <span style={{ color: 'var(--text-secondary)' }}>Drawing: <b>{drawingName}</b></span>
                      <label htmlFor="qb-drawing" className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 10px', cursor: 'pointer' }}>Replace</label>
                      <button type="button" className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} disabled={drawingBusy} onClick={removeDrawing}>Remove</button>
                    </>
                  ) : (
                    <label htmlFor="qb-drawing" className="btn btn-ghost" style={{ fontSize: 12, cursor: 'pointer' }}>
                      {drawingBusy ? 'Attaching…' : 'Attach a drawing (PDF)'}
                    </label>
                  )}
                </div>
                {drawingName && (
                  <div className="gate-box" role="status" style={{ marginTop: 10 }}>
                    We review drawings before cutting; we'll contact you before work starts if anything changes the price.
                  </div>
                )}
                {drawingError && <div role="alert" style={{ color: 'var(--error-text)', fontSize: 12, marginTop: 8 }}>{drawingError}</div>}
              </div>
            )}
          </div>
        )}

        {/* Add more parts dropzone */}
        {parts.length > 0 && !uploading && (
          <div
            className="dropzone"
            role="button"
            tabIndex={0}
            style={{ marginTop: 24, padding: '20px 32px', maxWidth: 720, width: '100%', fontSize: 13 }}
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
          >
            <span style={{ color: 'var(--text-muted)' }}>Drop another file here, or click to add a part.</span>
          </div>
        )}

        {/* Features callout (empty state) */}
        {parts.length === 0 && !uploading && (
          <div style={{ maxWidth: 900, margin: '40px auto 0', padding: '0 32px' }}>
            <div style={{ textAlign: 'center', marginBottom: 16 }}>
                <span className="eyebrow">How it works</span>
              </div>
              <div className="grid-3">
              {[
                { step: '1', title: 'Upload', desc: 'STEP, STL, IGES or 3MF — or a DXF for flat routed parts. The geometry is read on our server; the file is ' + when('file-encryption', 'encrypted at rest and ') + 'purged on a schedule.' },
                { step: '2', title: 'Price and DFM', desc: 'Material, finish, quantity. The price updates as you go, with a manufacturability check written for our machines.' },
                { step: '3', title: 'Check out, or get a firm quote', desc: `Up to ${brand.rfqQuantityThreshold} pieces, check out by card. Over that, or if the checker flags something, a firm quote from a person${when('quote-turnaround', (v) => ` within ${v}`)}.` },
              ].map((f, i) => (
                <div key={i} className="card fade-up" style={{ padding: 24, textAlign: 'center', animationDelay: `${200 + i * 120}ms` }}>
                  <div aria-hidden="true" style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 700, margin: '0 auto 12px' }}>{f.step}</div>
                  <div className="font-display" style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
                    {f.title}
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.6 }}>{f.desc}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* ═══ RIGHT SIDEBAR: Order Summary ═══ */}
      {parts.length > 0 && (
        <OrderSummary
          quote={quote}
          leadTimes={leadTimes}
          selectedLeadTime={selectedLeadTime}
          onLeadTimeChange={setSelectedLeadTime}
          paperwork={paperwork}
          onPaperworkChange={setPaperwork}
          partsConfig={parts}
          materials={materials}
          quoteError={quoteError}
          quoteLoading={quoteLoading}
        />
      )}
      {/* Phone and tablet: the total and the one button that matters, always within reach of the thumb.
          The summary itself (lead time, paperwork, line items) is one tap away. Same numbers, same
          destinations as the summary's own button (components/OrderSummary.jsx). */}
      {parts.length > 0 && quote && (
        <div className="qb-bar" role="region" aria-label={needsRfq ? 'Budgetary total' : 'Total and checkout'}>
          <a href="#order-summary" className="qb-bar-total">
            <span className="price-label">{needsRfq ? 'Budgetary' : 'Total'}{quoteLoading ? ' · updating' : ''}</span>
            <b>{formatCurrency(quote.orderTotal)}</b>
            <span className="qb-bar-sub">{quote.shipBy ? `Ships by ${formatShipDate(quote.shipBy)} · ` : ''}details</span>
          </a>
          {needsRfq ? (
            <button type="button" className="btn btn-primary btn-lg" onClick={() => navigate(quote.quoteId ? `/rfq/${quote.quoteId}` : '/rfq')}>Request a firm quote</button>
          ) : (
            <button type="button" className="btn btn-primary btn-lg" onClick={() => { const to = `/checkout/${quote.quoteId}`; navigate(isAuthenticated ? to : authPath('/login', to)); }}>Check out</button>
          )}
        </div>
      )}
    </div>
  );
}

function PriceRow({ label, value, bold, color }) {
  return (
    <>
      <span style={{ color: color || 'var(--text-muted)', fontWeight: bold ? 600 : 400 }}>{label}</span>
      <span style={{
        textAlign: 'right',
        color: color || (bold ? 'var(--accent)' : 'var(--text-secondary)'),
        fontWeight: bold ? 600 : 400,
      }}>
        {formatCurrency(value)}
      </span>
    </>
  );
}
