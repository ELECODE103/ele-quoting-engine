export default function PartConfigurator({ part, materials, finishes, onChange, onRemove }) {
  const currentMat = materials.find((m) => m.slug === part.materialSlug) || materials[0];

  function handleMaterialChange(slug) {
    const mat = materials.find((m) => m.slug === slug);
    onChange({
      materialSlug: slug,
      grade: mat.grades[0].name,
      thicknessMm: mat.thicknesses[Math.min(2, mat.thicknesses.length - 1)].mm,
    });
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
        {/* Material */}
        <label>
          <span className="field-label">Material</span>
          <select
            className="input"
            value={part.materialSlug}
            onChange={(e) => handleMaterialChange(e.target.value)}
          >
            {materials.map((m) => (
              <option key={m.slug} value={m.slug}>{m.name}</option>
            ))}
          </select>
        </label>

        {/* Grade */}
        <label>
          <span className="field-label">Grade</span>
          <select
            className="input"
            value={part.grade}
            onChange={(e) => onChange({ grade: e.target.value })}
          >
            {currentMat.grades.map((g) => (
              <option key={g.name} value={g.name}>{g.name}</option>
            ))}
          </select>
        </label>

        {/* Thickness */}
        <label>
          <span className="field-label">Thickness</span>
          <select
            className="input"
            value={part.thicknessMm}
            onChange={(e) => onChange({ thicknessMm: parseFloat(e.target.value) })}
          >
            {currentMat.thicknesses.map((t) => (
              <option key={t.mm} value={t.mm}>{t.label}</option>
            ))}
          </select>
        </label>

        {/* Quantity */}
        <label>
          <span className="field-label">Quantity</span>
          <input
            className="input"
            type="number"
            min="1"
            max="100000"
            value={part.quantity}
            onChange={(e) => onChange({ quantity: Math.max(1, parseInt(e.target.value) || 1) })}
          />
        </label>

        {/* Finish */}
        <label style={{ gridColumn: '1 / -1' }}>
          <span className="field-label">Finish</span>
          <select
            className="input"
            value={part.finishSlug}
            onChange={(e) => onChange({ finishSlug: e.target.value })}
          >
            {finishes.map((f) => (
              <option key={f.slug} value={f.slug}>
                {f.name}{f.pricePerPart > 0 ? ` (+$${f.pricePerPart.toFixed(2)}/part)` : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Geometry summary */}
      {part.geometry && (
        <div style={{
          marginTop: 16, padding: '10px 14px',
          background: 'var(--bg-primary)', borderRadius: 'var(--radius-md)',
          display: 'flex', flexWrap: 'wrap', gap: '12px 20px',
          fontSize: 11, color: 'var(--text-dim)',
        }}>
          <span>Bounding: {(part.geometry.flatWidth || 0).toFixed(1)} × {(part.geometry.flatHeight || 0).toFixed(1)}mm</span>
          <span>Area: {((part.geometry.flatArea || 0) / 645.16).toFixed(1)} in²</span>
          <span>Perimeter: {(part.geometry.estimatedPerimeter || 0).toFixed(0)}mm</span>
          <span>Holes: {part.geometry.estimatedHoles || 0}</span>
          <span>Bends: {part.geometry.estimatedBends || 0}</span>
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
