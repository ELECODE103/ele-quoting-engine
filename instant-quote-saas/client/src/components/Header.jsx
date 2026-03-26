import { classNames } from '../utils/format';

export default function Header({ page, onPageChange }) {
  return (
    <header style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '14px 28px', borderBottom: '1px solid var(--border-primary)',
      background: 'var(--bg-secondary)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 6,
          background: 'linear-gradient(135deg, var(--accent-dark), var(--accent))',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round">
            <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
            <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
            <line x1="12" y1="22.08" x2="12" y2="12" />
          </svg>
        </div>
        <span className="font-display" style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.5px', color: 'var(--text-primary)' }}>
          INSTANT QUOTE
        </span>
        <span className="tag tag-info">BETA</span>
      </div>

      <nav style={{ display: 'flex', gap: 4 }}>
        {['quote', 'admin'].map((p) => (
          <button
            key={p}
            className={classNames('btn', page === p ? 'btn-ghost active' : 'btn-ghost')}
            style={{ fontSize: 11, textTransform: 'capitalize' }}
            onClick={() => onPageChange(p)}
          >
            {p === 'quote' ? '⬡ Quote Builder' : '⚙ Admin Panel'}
          </button>
        ))}
      </nav>
    </header>
  );
}
