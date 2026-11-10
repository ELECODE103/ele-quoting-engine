import photos from '../data/photos.generated.json';

/**
 * Shop photo with intrinsic width/height (no layout shift), WebP srcset
 * (640 / 1200 px, made by scripts/seo/optimize-photos.js) and a JPEG fallback.
 * Lazy by default; pass loading="eager" for the one above-the-fold image.
 */
export default function Photo({ src, alt, loading = 'lazy', sizes = '(max-width: 768px) 100vw, 50vw', className = 'photo' }) {
  const info = photos[src];
  const eager = loading === 'eager';
  const img = (
    <img
      className={className}
      src={src}
      alt={alt}
      width={info?.w}
      height={info?.h}
      loading={loading}
      decoding="async"
      // lower-case on purpose: React 18 passes it through as the HTML attribute
      fetchpriority={eager ? 'high' : undefined}
    />
  );
  if (!info || !info.webp || info.webp.length === 0) return img;
  return (
    <picture style={{ display: 'contents' }}>
      <source type="image/webp" srcSet={info.webp.map((v) => `${v.src} ${v.w}w`).join(', ')} sizes={sizes} />
      {img}
    </picture>
  );
}
