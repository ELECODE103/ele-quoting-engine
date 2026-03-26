import { useState } from 'react';
import { classNames } from '../utils/format';

export default function DFMPanel({ dfm, dfmAll, process }) {
  const [viewProcess, setViewProcess] = useState(process || 'sheetmetal');
  const activeDfm = dfmAll?.[viewProcess] || dfm;

  if (!activeDfm) return null;

  const { checks, summary } = activeDfm;

  return (
    <div className="card fade-up" style={{ padding: 20 }}>
      <div className="flex-between" style={{ marginBottom: 16 }}>
        <span className="font-display" style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
          Design for Manufacturability
        </span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className={classNames('tag', summary.manufacturable ? 'tag-pass' : 'tag-fail')}>
            {summary.manufacturable ? 'MANUFACTURABLE' : 'ISSUES FOUND'}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Score: {summary.score}%
          </span>
        </div>
      </div>

      {/* Process toggle tabs */}
      {dfmAll && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          {Object.keys(dfmAll).map((p) => (
            <button
              key={p}
              className={`btn btn-ghost ${viewProcess === p ? 'active' : ''}`}
              style={{ fontSize: 10, padding: '4px 10px' }}
              onClick={() => setViewProcess(p)}
            >
              {p === 'sheetmetal' ? 'Sheet Metal' : p === 'cnc' ? 'CNC' : '3D Print'}
            </button>
          ))}
        </div>
      )}

      {/* Summary bar */}
      <div style={{
        display: 'flex', gap: 12, marginBottom: 16, padding: '10px 14px',
        background: 'var(--bg-primary)', borderRadius: 'var(--radius-md)',
      }}>
        <span style={{ fontSize: 11 }}>
          <span style={{ color: 'var(--success-text)' }}>✓ {summary.passCount}</span> pass
        </span>
        {summary.warnCount > 0 && (
          <span style={{ fontSize: 11 }}>
            <span style={{ color: 'var(--warn-text)' }}>⚠ {summary.warnCount}</span> warnings
          </span>
        )}
        {summary.failCount > 0 && (
          <span style={{ fontSize: 11 }}>
            <span style={{ color: 'var(--error-text)' }}>✕ {summary.failCount}</span> failures
          </span>
        )}
      </div>

      {/* Check list */}
      {checks.map((check, i) => (
        <div key={check.id || i} style={{
          display: 'flex', alignItems: 'flex-start', gap: 12,
          padding: '10px 0',
          borderTop: i > 0 ? '1px solid var(--border-subtle)' : 'none',
        }}>
          <span className={classNames('tag', `tag-${check.severity}`)} style={{ flexShrink: 0, marginTop: 2 }}>
            {check.severity === 'pass' ? 'PASS' : check.severity === 'warn' ? 'WARN' : 'FAIL'}
          </span>
          <div>
            <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)' }}>
              {check.label}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2, lineHeight: 1.5 }}>
              {check.detail}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
