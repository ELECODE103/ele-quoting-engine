import { useState, useRef, useCallback, useEffect } from 'react';
import { api } from '../utils/api';
import { formatCurrency, formatDim } from '../utils/format';
import ThreeViewer from '../components/ThreeViewer';
import DFMPanel from '../components/DFMPanel';
import PartConfigurator from '../components/PartConfigurator';
import OrderSummary from '../components/OrderSummary';

export default function QuoteBuilder() {
  // Config data from server
  const [materials, setMaterials] = useState([]);
  const [finishes, setFinishes] = useState([]);
  const [leadTimes, setLeadTimes] = useState([]);

  // Parts state
  const [parts, setParts] = useState([]);          // { partId, fileName, geometry, dfm, meshPreview, materialSlug, grade, thicknessMm, finishSlug, quantity }
  const [activePart, setActivePart] = useState(null);
  const [selectedLeadTime, setSelectedLeadTime] = useState('standard');

  // Quote from server
  const [quote, setQuote] = useState(null);
  const [quoteLoading, setQuoteLoading] = useState(false);

  // UI
  const [uploading, setUploading] = useState(false);
  const [uploadErrors, setUploadErrors] = useState([]);
  const [showDFM, setShowDFM] = useState(false);
  const fileRef = useRef();
  const quoteTimer = useRef(null);

  // Load config on mount
  useEffect(() => {
    Promise.all([api.getMaterials(), api.getFinishes(), api.getLeadTimes()])
      .then(([mats, fins, lts]) => {
        setMaterials(mats);
        setFinishes(fins);
        setLeadTimes(lts);
      })
      .catch((err) => console.error('Failed to load config:', err));
  }, []);

  // Auto-refresh quote when parts change
  useEffect(() => {
    if (parts.length === 0) { setQuote(null); return; }
    clearTimeout(quoteTimer.current);
    quoteTimer.current = setTimeout(() => fetchQuote(), 400);
    return () => clearTimeout(quoteTimer.current);
  }, [parts, selectedLeadTime]);

  async function fetchQuote() {
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
      }));
      const q = await api.getQuote(configs, selectedLeadTime);
      setQuote(q);
    } catch (err) {
      console.error('Quote error:', err);
    }
    setQuoteLoading(false);
  }

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
        materialSlug: defaultMat?.slug || 'mild-steel',
        grade: defaultMat?.grades[0]?.name || 'A36 / 1008',
        thicknessMm: defaultMat?.thicknesses[2]?.mm || defaultMat?.thicknesses[0]?.mm || 1.5,
        finishSlug: 'raw',
        quantity: 1,
      }));

      setParts((prev) => [...prev, ...newParts]);
      if (newParts.length > 0 && !activePart) setActivePart(newParts[0].partId);
      if (result.errors?.length > 0) setUploadErrors(result.errors);
    } catch (err) {
      setUploadErrors([{ fileName: 'Upload', error: err.message }]);
    }
    setUploading(false);
  }, [materials, activePart]);

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

  const active = parts.find((p) => p.partId === activePart);
  const activeLineItem = quote?.lineItems?.find((li) => li.partId === activePart);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: parts.length > 0 ? '300px 1fr 340px' : '1fr', minHeight: 'calc(100vh - 53px)' }}>

      {/* ═══ LEFT SIDEBAR: Parts List ═══ */}
      {parts.length > 0 && (
        <aside style={{ borderRight: '1px solid var(--border-primary)', padding: 16, overflowY: 'auto', background: 'var(--bg-secondary)' }}>
          <div className="flex-between" style={{ marginBottom: 16 }}>
            <span className="font-display" style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-muted)' }}>
              PARTS ({parts.length})
            </span>
            <button className="btn btn-primary" style={{ fontSize: 11, padding: '6px 12px' }} onClick={() => fileRef.current?.click()}>
              + Add
            </button>
          </div>

          {parts.map((pt, i) => {
            const lineItem = quote?.lineItems?.find((li) => li.partId === pt.partId);
            return (
              <div
                key={pt.partId}
                className="fade-up"
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
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
                  ⬡
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="truncate" style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)' }}>
                    {pt.fileName}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
                    {formatDim(pt.geometry?.flatWidth || 0)} × {formatDim(pt.geometry?.flatHeight || 0)} · qty {pt.quantity}
                  </div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)', whiteSpace: 'nowrap' }}>
                  {lineItem ? formatCurrency(lineItem.lineTotal) : '...'}
                </div>
              </div>
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
          accept=".step,.stp,.stl,.3mf,.iges,.igs,.dxf,.svg"
          style={{ display: 'none' }}
          onChange={(e) => handleFiles(e.target.files)}
        />

        {/* Empty state: dropzone */}
        {parts.length === 0 && !uploading && (
          <div
            className="dropzone"
            style={{ maxWidth: 640, width: '100%' }}
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => fileRef.current?.click()}
          >
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" style={{ marginBottom: 16, opacity: 0.7 }}>
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <div className="font-display" style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
              Upload Your Parts
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.7, maxWidth: 440 }}>
              Drag & drop STEP, STL, or IGES files.<br />
              Real geometry extraction with instant DFM analysis and pricing.
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
            <div className="font-display" style={{ fontSize: 14, color: 'var(--text-muted)' }}>Analyzing geometry…</div>
            <div style={{ fontSize: 11, color: 'var(--accent)' }}>Parsing mesh · Extracting features · Running DFM checks</div>
          </div>
        )}

        {/* Upload errors */}
        {uploadErrors.length > 0 && (
          <div className="card fade-up" style={{ padding: 16, marginBottom: 16, borderColor: 'var(--error-bg)', maxWidth: 720, width: '100%' }}>
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
            {/* View toggle */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <button className={`btn ${showDFM ? 'btn-ghost' : 'btn-ghost active'}`} onClick={() => setShowDFM(false)}>
                3D Preview
              </button>
              <button className={`btn ${showDFM ? 'btn-ghost active' : 'btn-ghost'}`} onClick={() => setShowDFM(true)}>
                DFM Analysis
              </button>

              {/* Price badge */}
              {activeLineItem && (
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
                  {quoteLoading && <div className="spinner" />}
                  <span className="font-display" style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)' }}>
                    {formatCurrency(activeLineItem.lineTotal)}
                  </span>
                  {active.quantity > 1 && (
                    <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                      ({formatCurrency(activeLineItem.perUnit.final)}/ea)
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
                  <div style={{
                    position: 'absolute', bottom: 0, left: 0, right: 0,
                    padding: '10px 16px', background: 'linear-gradient(transparent, rgba(8,12,20,0.9))',
                    display: 'flex', gap: 16, fontSize: 10, color: 'var(--text-dim)',
                  }}>
                    <span>{formatDim(active.geometry?.flatWidth || 0)} × {formatDim(active.geometry?.flatHeight || 0)}</span>
                    <span>Area: {((active.geometry?.flatArea || 0) / 645.16).toFixed(1)} in²</span>
                    <span>{(active.geometry?.triangleCount || 0).toLocaleString()} triangles</span>
                    <span style={{ marginLeft: 'auto' }}>Drag to orbit · Scroll to zoom</span>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ marginBottom: 20 }}>
                <DFMPanel dfm={active.dfm} />
              </div>
            )}

            {/* Part Configurator */}
            <PartConfigurator
              part={active}
              materials={materials}
              finishes={finishes}
              onChange={(updates) => updatePart(active.partId, updates)}
              onRemove={() => removePart(active.partId)}
            />

            {/* Price breakdown */}
            {activeLineItem && (
              <div className="card fade-up" style={{ padding: 20, marginTop: 16 }}>
                <span className="font-display" style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', display: 'block', marginBottom: 12 }}>
                  Price Breakdown (per unit)
                </span>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px 16px', fontSize: 11 }}>
                  <PriceRow label="Material" value={activeLineItem.perUnit.material} />
                  <PriceRow label="Laser cutting" value={activeLineItem.perUnit.cutting} />
                  {activeLineItem.perUnit.bending > 0 && <PriceRow label="Bending" value={activeLineItem.perUnit.bending} />}
                  {activeLineItem.perUnit.holes > 0 && <PriceRow label="Holes & features" value={activeLineItem.perUnit.holes} />}
                  {activeLineItem.perUnit.finish > 0 && <PriceRow label="Finish" value={activeLineItem.perUnit.finish} />}
                  <div style={{ gridColumn: '1 / -1', borderTop: '1px solid var(--border-subtle)', margin: '4px 0' }} />
                  {activeLineItem.perUnit.discount > 0 && (
                    <PriceRow label={`Volume discount (${(activeLineItem.perUnit.discount * 100).toFixed(0)}%)`} value={-activeLineItem.perUnit.discountAmount} color="var(--success-text)" />
                  )}
                  <PriceRow label="Unit price" value={activeLineItem.perUnit.final} bold />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Add more parts dropzone */}
        {parts.length > 0 && !uploading && (
          <div
            className="dropzone"
            style={{ marginTop: 24, padding: '20px 32px', maxWidth: 720, width: '100%', fontSize: 12 }}
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => fileRef.current?.click()}
          >
            <span style={{ color: 'var(--text-dim)' }}>Drop more files here or click to add parts</span>
          </div>
        )}

        {/* Features callout (empty state) */}
        {parts.length === 0 && !uploading && (
          <div style={{ maxWidth: 900, margin: '40px auto 0', padding: '0 32px' }}>
            <div className="grid-3">
              {[
                { icon: '⚡', title: 'Real Geometry Parsing', desc: 'STEP and STL files are parsed with OpenCascade WASM. Surface area, volume, holes, bends — all extracted automatically.' },
                { icon: '🔍', title: 'DFM Analysis', desc: 'Automatic design-for-manufacturability checks flag issues: min feature size, bend feasibility, hole spacing, and more.' },
                { icon: '💰', title: 'Production Pricing', desc: 'Material weight, cut perimeter, bend count, finish cost, and volume discounts — all calculated from your actual geometry.' },
              ].map((f, i) => (
                <div key={i} className="card fade-up" style={{ padding: 24, animationDelay: `${200 + i * 120}ms` }}>
                  <div style={{ fontSize: 28, marginBottom: 12 }}>{f.icon}</div>
                  <div className="font-display" style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
                    {f.title}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>{f.desc}</div>
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
