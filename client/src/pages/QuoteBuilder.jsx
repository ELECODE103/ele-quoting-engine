import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import { formatCurrency, formatDim } from '../utils/format';
import ThreeViewer from '../components/ThreeViewer';
import DFMPanel from '../components/DFMPanel';
import PartConfigurator from '../components/PartConfigurator';
import OrderSummary from '../components/OrderSummary';
import ProcessPicker from '../components/ProcessPicker';
import brand, { PROCESS_LABELS } from '../brand';

// Closest stock thickness to the model's thinnest dimension (routing materials carry a thickness table).
function pickThickness(mat, geometry) {
  const list = mat?.thicknesses || [];
  if (list.length === 0) return 0;
  const bb = geometry?.boundingBox || {};
  const t = Math.min(bb.width || Infinity, bb.height || Infinity, bb.depth || Infinity);
  if (!Number.isFinite(t)) return list[Math.min(2, list.length - 1)].mm;
  return list.reduce((best, x) => (Math.abs(x.mm - t) < Math.abs(best.mm - t) ? x : best), list[0]).mm;
}

export default function QuoteBuilder() {
  const navigate = useNavigate();
  // Config data from server
  const [processes, setProcesses] = useState([]);
  const [materials, setMaterials] = useState([]);
  const [finishes, setFinishes] = useState([]);
  const [leadTimes, setLeadTimes] = useState([]);

  // Parts state
  const [parts, setParts] = useState([]);          // { partId, fileName, geometry, dfm, meshPreview, materialSlug, grade, thicknessMm, finishSlug, quantity, process, subProcess, layerHeight, infill }
  const [activePart, setActivePart] = useState(null);
  const [selectedLeadTime, setSelectedLeadTime] = useState('standard');
  const [selectedProcess, setSelectedProcess] = useState('cnc');
  // Quote from server
  const [quote, setQuote] = useState(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState(null);

  // UI
  const [uploading, setUploading] = useState(false);
  const [uploadErrors, setUploadErrors] = useState([]);
  const [showDFM, setShowDFM] = useState(false);
  const fileRef = useRef();
  const quoteTimer = useRef(null);

  // Load config on mount
  useEffect(() => {
    Promise.all([api.getProcesses(), api.getMaterials('cnc'), api.getFinishes('cnc'), api.getLeadTimes()])
      .then(([procs, mats, fins, lts]) => {
        setProcesses(procs);
        setMaterials(mats);
        setFinishes(fins);
        setLeadTimes(lts);
      })
      .catch((err) => console.error('Failed to load config:', err));
  }, []);

  // Auto-refresh quote when parts change
  const fetchQuote = useCallback(async () => {
    if (parts.length === 0) return;
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
      const q = await api.getQuote(configs, selectedLeadTime);
      setQuote(q);
      setQuoteError(null);
    } catch (err) {
      console.error('Quote error:', err);
      setQuoteError(err?.message || `We couldn't price this setup. Change the material or quantity and try again, or call ${brand.phone}.`);
    }
    setQuoteLoading(false);
  }, [parts, selectedLeadTime, selectedProcess]);

  useEffect(() => {
    if (parts.length === 0) { setQuote(null); return; }
    clearTimeout(quoteTimer.current);
    quoteTimer.current = setTimeout(() => fetchQuote(), 400);
    return () => clearTimeout(quoteTimer.current);
  }, [fetchQuote]);

  // File upload handler
  const handleFiles = useCallback(async (fileList) => {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    setUploadErrors([]);

    try {
      const result = await api.uploadFiles(Array.from(fileList));
      const defaultMat = materials[0];

      const newParts = result.parts.map((p) => ({
        partId: p.partId,
        fileName: p.fileName,
        geometry: p.geometry,
        dfm: p.dfm,
        meshPreview: p.meshPreview,
        materialSlug: defaultMat?.slug || 'cnc-delrin',
        grade: defaultMat?.grades?.[0]?.name || '',
        thicknessMm: pickThickness(defaultMat, p.geometry),
        finishSlug: finishes[0]?.slug || 'raw',
        quantity: 1,
        process: selectedProcess,
        subProcess: selectedProcess === 'cnc' ? 'milling' : (defaultMat?.subProcess || ''),
        layerHeight: defaultMat?.defaultLayerHeight || 0,
        infill: 0.2,
        dfmAll: p.dfmAll,
      }));

      setParts((prev) => [...prev, ...newParts]);
      setActivePart((prev) => {
        if (newParts.length > 0 && !prev) return newParts[0].partId;
        return prev;
      });
      if (result.errors?.length > 0) setUploadErrors(result.errors);
    } catch (err) {
      setUploadErrors([{ fileName: 'Upload', error: err.message || `The file didn't make it to our server. Try again, or email it to ${brand.email}.` }]);
    }
    setUploading(false);
  }, [materials, finishes, selectedProcess]);

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
    setSelectedProcess(processSlug);
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
  }

  const active = parts.find((p) => p.partId === activePart);
  const activeLineItem = quote?.lineItems?.find((li) => li.partId === activePart);
  const activeDfm = quote?.dfmByPartId?.[activePart] || active?.dfmAll?.[selectedProcess] || active?.dfm;
  const needsRfq = Boolean(quote?.gate?.requiresRfq);
  const cutLabel = selectedProcess === 'routing' ? 'Router cutting' : 'Laser cutting';

  return (
    <div className={parts.length > 0 ? 'qb-grid' : ''} style={{ display: 'grid', gridTemplateColumns: parts.length > 0 ? undefined : '1fr', minHeight: 'calc(100vh - 53px)' }}>

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
          accept=".step,.stp,.stl,.3mf,.iges,.igs"
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
            aria-label="Upload a part file"
            style={{ maxWidth: 640, width: '100%' }}
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
          >
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" style={{ marginBottom: 16, opacity: 0.7 }}>
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <div className="font-display" style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
              Upload a part
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.7, maxWidth: 460, margin: '0 auto' }}>
              Drop a STEP, STL, IGES or 3MF file here, or click to choose one. The price shows in a few seconds.<br />
              Up to {brand.rfqQuantityThreshold} pieces checks out online. More than that, a person quotes it within {brand.quoteTurnaroundHours} hours.
            </div>
            <div style={{ marginTop: 24, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
              {['STEP', 'STL', 'IGES', '3MF'].map((f) => (
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
            <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>A few seconds for most files. Large STEP assemblies take longer.</div>
          </div>
        )}

        {/* Upload errors */}
        {uploadErrors.length > 0 && (
          <div className="card fade-up" role="alert" style={{ padding: 16, marginBottom: 16, borderColor: '#FECACA', background: 'var(--error-bg)', maxWidth: 720, width: '100%' }}>
            {uploadErrors.map((err, i) => (
              <div key={i} style={{ fontSize: 12, color: 'var(--error-text)', marginBottom: 4 }}>
                ⚠ {err.fileName}: {err.error}
              </div>
            ))}
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
            <div className="qb-toolbar" role="tablist" aria-label="Part view">
              <button role="tab" aria-selected={!showDFM} className={`btn ${showDFM ? 'btn-ghost' : 'btn-ghost active'}`} onClick={() => setShowDFM(false)}>
                3D preview
              </button>
              <button role="tab" aria-selected={showDFM} className={`btn ${showDFM ? 'btn-ghost active' : 'btn-ghost'}`} onClick={() => setShowDFM(true)}>
                DFM check
              </button>

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
            </div>

            {/* 3D Preview or DFM */}
            {!showDFM ? (
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
                    <span className="hint">Drag to orbit · Scroll to zoom</span>
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
                        aria-label={`Set quantity to ${b.qty}, ${formatCurrency(b.perUnit)} each`}
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
          </div>
        )}

        {/* Add more parts dropzone */}
        {parts.length > 0 && !uploading && (
          <div
            className="dropzone"
            role="button"
            tabIndex={0}
            style={{ marginTop: 24, padding: '20px 32px', maxWidth: 720, width: '100%', fontSize: 12 }}
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
                { step: '1', title: 'Upload', desc: 'STEP, STL, IGES or 3MF. The geometry is read on our server; the file is encrypted at rest and purged on a schedule.' },
                { step: '2', title: 'Price and DFM', desc: 'Material, finish, quantity. The price updates as you go, with a manufacturability check written for our machines.' },
                { step: '3', title: 'Check out, or get a firm quote', desc: `Up to ${brand.rfqQuantityThreshold} pieces, check out by card. Over that, or if the checker flags something, a firm quote from us within ${brand.quoteTurnaroundHours} hours.` },
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
          partsConfig={parts}
          materials={materials}
          quoteError={quoteError}
          quoteLoading={quoteLoading}
        />
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
