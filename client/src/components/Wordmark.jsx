import { Link } from 'react-router-dom';
import brand from '../brand';

/**
 * Straightedge wordmark: a machinist's straightedge glyph + the name.
 * `size` scales the whole mark; `to` makes it a link (default: home).
 */
export default function Wordmark({ size = 20, to = '/', dark = false, showDescriptor = false }) {
  const color = dark ? '#F8FAFC' : 'var(--text-primary)';
  const mark = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: Math.round(size * 0.5) }}>
      <svg width={size * 1.9} height={size * 1.05} viewBox="0 0 38 21" aria-hidden="true">
        {/* the straightedge: a bar with graduations */}
        <rect x="1" y="6" width="36" height="9" rx="1.5" fill="var(--accent)" />
        {[5, 9, 13, 17, 21, 25, 29, 33].map((x, i) => (
          <rect key={x} x={x} y="6" width="1.4" height={i % 2 === 0 ? 5.5 : 3.5} fill="#fff" opacity="0.95" />
        ))}
        {/* true edge */}
        <rect x="1" y="16.5" width="36" height="1.6" rx="0.8" fill={dark ? '#CBD5E1' : '#0F172A'} />
      </svg>
      <span style={{
        fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: size,
        letterSpacing: '0.04em', textTransform: 'uppercase', color, lineHeight: 1,
      }}>
        {brand.name}
      </span>
      {showDescriptor && (
        <span style={{ fontSize: Math.max(10, size * 0.55), color: dark ? '#94A3B8' : 'var(--text-dim)', marginLeft: 4, letterSpacing: '0.02em' }}>
          {brand.descriptor}
        </span>
      )}
    </span>
  );
  if (!to) return mark;
  return <Link to={to} style={{ textDecoration: 'none' }} aria-label={`${brand.name} home`}>{mark}</Link>;
}
