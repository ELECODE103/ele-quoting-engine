import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { getRouteMeta } from './routes';

function setMeta(name, content) {
  let el = document.head.querySelector(`meta[name="${name}"]`);
  if (!content) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('meta'); el.setAttribute('name', name); document.head.appendChild(el); }
  el.setAttribute('content', content);
}

/**
 * Keeps <title>, description, robots, canonical and JSON-LD in step with the
 * router on client-side navigation. The first paint already has the right
 * head from the server (prerendered file or Express head injection), so the
 * first run only fixes things up if they differ.
 */
export default function useHeadSync() {
  const { pathname } = useLocation();
  const first = useRef(true);

  useEffect(() => {
    const m = getRouteMeta(pathname);
    document.title = m.title;
    setMeta('description', m.description);
    setMeta('robots', m.robots);

    let canon = document.head.querySelector('link[rel="canonical"]');
    if (m.canonical) {
      if (!canon) { canon = document.createElement('link'); canon.setAttribute('rel', 'canonical'); document.head.appendChild(canon); }
      canon.setAttribute('href', m.canonical);
    } else if (canon) canon.remove();

    if (!first.current) {
      document.head.querySelectorAll('script[type="application/ld+json"]').forEach((s) => s.remove());
      for (const block of m.jsonLd || []) {
        const s = document.createElement('script');
        s.type = 'application/ld+json';
        s.textContent = JSON.stringify(block);
        document.head.appendChild(s);
      }
    }
    first.current = false;
  }, [pathname]);
}
