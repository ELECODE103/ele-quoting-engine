import { PROCESS_LABELS, PROCESS_BLURBS } from '../brand';

const ICONS = {
  cnc: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="12" width="18" height="8" rx="1.5" /><path d="M12 12V4M9 4h6M8 8h8" />
    </svg>
  ),
  routing: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="1.5" /><circle cx="9" cy="12" r="2.5" /><rect x="14" y="9" width="4" height="6" rx="1" />
    </svg>
  ),
  '3d-printing': (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" /><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
    </svg>
  ),
};

/**
 * The three ways we make a part. `compact` renders a one-line segmented control
 * for the top of the builder once parts are loaded.
 */
export default function ProcessPicker({ processes, value, onChange, compact = false }) {
  const list = (processes || []).filter((p) => p.active !== false);
  if (compact) {
    return (
      <div style={{ display: 'inline-flex', gap: 4, padding: 4, borderRadius: 10, background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
        {list.map((p) => (
          <button
            key={p.slug}
            onClick={() => onChange(p.slug)}
            className="btn"
            style={{
              fontSize: 12, padding: '6px 12px',
              background: value === p.slug ? '#fff' : 'transparent',
              color: value === p.slug ? 'var(--accent)' : 'var(--text-muted)',
              boxShadow: value === p.slug ? 'var(--shadow-sm)' : 'none',
              border: value === p.slug ? '1px solid var(--border-primary)' : '1px solid transparent',
            }}
          >
            <span style={{ display: 'inline-flex', width: 16 }}>{ICONS[p.slug]}</span>
            {PROCESS_LABELS[p.slug] || p.name}
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="process-picker" role="radiogroup" aria-label="Process">
      {list.map((p) => (
        <button
          key={p.slug}
          role="radio"
          aria-checked={value === p.slug}
          className={`process-option${value === p.slug ? ' active' : ''}`}
          onClick={() => onChange(p.slug)}
        >
          <span style={{ display: 'inline-flex', color: 'var(--accent)', marginBottom: 8 }}>{ICONS[p.slug]}</span>
          <b>{PROCESS_LABELS[p.slug] || p.name}</b>
          <span>{PROCESS_BLURBS[p.slug] || p.description}</span>
        </button>
      ))}
    </div>
  );
}
