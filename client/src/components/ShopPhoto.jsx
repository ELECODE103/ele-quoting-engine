import Photo from './Photo';
import { shopPhoto } from '../data/shopPhotos';

/**
 * A framed shop photo. The caption only renders when the owner has confirmed
 * the photo and its caption (shared/shop-facts.json, `photo-<id>`).
 */
export default function ShopPhoto({ id, loading = 'lazy', sizes, style, frameClass = 'photo-frame' }) {
  const p = shopPhoto(id);
  return (
    <div className={frameClass} style={style}>
      <Photo src={p.src} alt={p.alt} loading={loading} sizes={sizes} />
      {p.cap && <div className="cap">{p.cap}</div>}
    </div>
  );
}
