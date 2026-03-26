export default function PartConfigurator({ part, materials, finishes, onChange, onRemove, selectedProcess }) {
  const currentMat = materials.find((m) => m.slug === part.materialSlug) || materials[0];

  function handleMaterialChange(slug) {
    const mat = materials.find((m) => m.slug === slug);
    if (!mat) return;
    const updates = { materialSlug: slug };

    if (selectedProcess === 'sheetmetal') {
      const thicknessIdx = Math.min(2, Math.max(0, (mat.thicknesses?.length || 1) - 1));
      updates.grade = mat.grades?.[0]?.name || '';
      updates.thicknessMm = mat.thicknesses?.[thicknessIdx]?.mm || 1.5;
    } else if (selectedProcess === 'cnc') {
      updates.grade = mat.grades?.[0]?.name || '';
      updates.subProcess = mat.subProcess || 'milling';
    } else if (selectedProcess === '3d-printing') {
      updates.subProcess = mat.subProcess || 'fdm';
      updates.layerHeight = mat.defaultLayerHeight || 0.2;
    }
    onChange(updates);
  }

  return (
    <div className="card" style={{ padding: 20 }}>
      <div className="flex-between" style={{ marginBottom: 16 }}>
        <span className="font-display" style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
          Part Configuration
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{part.fileName}</span>
      </div>

      <div className="grid-2">
        {/* Material - always shown */}
        <label>
          <span className="field-label">Material</span>
          <select className="input" value={part.materialSlug} onChange={(e) => handleMaterialChange(e.target.value)}>
            {materials.map((m) => (
              <option key={m.slug} value={m.slug}>{m.name}</option>
            ))}
          </select>
        </label>

        {/* Grade - sheet metal and CNC */}
        {(selectedProcess === 'sheetmetal' || selectedProcess === 'cnc') && currentMat?.grades?.length > 0 && (
          <label>
            <span className="field-label">Grade</span>
            <select className="input" value={part.grade} onChange={(e) => onChange({ grade: e.target.value })}>
              {currentMat.grades.map((g) => (
                <option key={g.name} value={g.name}>{g.name}</option>
              ))}
            </select>
          </label>
        )}

        {/* Thickness - sheet metal only */}
        {selectedProcess === 'sheetmetal' && currentMat?.thicknesses?.length > 0 && (
          <label>
            <span className="field-label">Thickness</span>
            <select className="input" value={part.thicknessMm} onChange={(e) => onChange({ thicknessMm: parseFloat(e.target.value) })}>
              {currentMat.thicknesses.map((t) => (
                <option key={t.mm} value={t.mm}>{t.label}</option>
              ))}
            </select>
          </label>
        )}

        {/* Sub-process - CNC (milling/turning) */}
        {selectedProcess === 'cnc' && (
          <label>
            <span className="field-label">Process</span>
            <select className="input" value={part.subProcess || 'milling'} onChange={(e) => onChange({ subProcess: e.target.value })}>
              <option value="milling">CNC Milling</option>
              <option value="turning">CNC Turning</option>
            </select>
          </label>
        )}

        {/* Layer Height - 3D printing */}
        {selectedProcess === '3d-printing' && currentMat?.layerHeights && (
          <label>
            <span className="field-label">Layer Height</span>
            <select className="input" value={part.layerHeight || currentMat.defaultLayerHeight} onChange={(e) => onChange({ layerHeight: parseFloat(e.target.value) })}>
              {currentMat.layerHeights.map((lh) => (
                <option key={lh} value={lh}>{lh}mm</option>
              ))}
            </select>
          </label>
        )}

        {/* Infill - FDM only */}
        {selectedProcess === '3d-printing' && currentMat?.subProcess === 'fdm' && (
          <label>
            <span className="field-label">Infill ({Math.round((part.infill || 0.2) * 100)}%)</span>
            <input
              className="input"
              type="range"
              min="0.1" max="1.0" step="0.05"
              value={part.infill || 0.2}
              onChange={(e) => onChange({ infill: parseFloat(e.target.value) })}
              style={{ padding: '8px 0' }}
            />
          </label>
        )}

        {/* Quantity - always shown */}
        <label>
          <span className="field-label">Quantity</span>
          <input className="input" type="number" min="1" max="100000" value={part.quantity}
            onChange={(e) => onChange({ quantity: Math.max(1, parseInt(e.target.value) || 1) })} />
        </label>

        {/* Finish - always shown, full width */}
        <label style={{ gridColumn: '1 / -1' }}>
          <span className="field-label">Finish</span>
          <select className="input" value={part.finishSlug} onChange={(e) => onChange({ finishSlug: e.target.value })}>
            {finishes.map((f) => (
              <option key={f.slug} value={f.slug}>
                {f.name}{f.pricePerPart > 0 ? ` (+$${f.pricePerPart.toFixed(2)}/part)` : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Geometry summary - always shown */}
      {part.geometry && (
        <div style={{
          marginTop: 16, padding: '10px 14px',
          background: 'var(--bg-primary)', borderRadius: 'var(--radius-md)',
          display: 'flex', flexWrap: 'wrap', gap: '12px 20px',
          fontSize: 11, color: 'var(--text-dim)',
        }}>
          <span>Bounding: {(part.geometry.boundingBox?.width || part.geometry.flatWidth || 0).toFixed(1)} × {(part.geometry.boundingBox?.height || part.geometry.flatHeight || 0).toFixed(1)} × {(part.geometry.boundingBox?.depth || part.geometry.estimatedThickness || 0).toFixed(1)}mm</span>
          <span>Volume: {((part.geometry.volume || 0) / 1000).toFixed(1)} cm³</span>
          <span>Area: {((part.geometry.surfaceArea || part.geometry.flatArea || 0) / 100).toFixed(1)} cm²</span>
          <span>Triangles: {(part.geometry.triangleCount || 0).toLocaleString()}</span>
        </div>
      )}

      {/* Actions */}
      <div className="flex-between" style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border-subtle)' }}>
        <button className="btn btn-danger" style={{ fontSize: 11 }} onClick={onRemove}>
          Remove Part
        </button>
      </div>
    </div>
  );
}
